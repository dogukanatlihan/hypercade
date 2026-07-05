// HYPERCADE server — Fastify: API + static dist/ in one process (TECH-BRIEF §6/§10).

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { db } from './db.ts';
import { createProfile, authenticate, type Profile } from './auth.ts';
import { submitRun } from './meta.ts';
import { GAME_IDS } from '../shared/registry.ts';
import type { GameId } from '../shared/types.ts';
import { utcDay } from '../shared/badges.ts';

const here = dirname(fileURLToPath(import.meta.url));
const app = Fastify({ logger: process.env['NODE_ENV'] !== 'test' });

// ---- naive in-memory rate limiting (per profile + per IP) ----

const buckets = new Map<string, { count: number; reset: number }>();
function rateLimit(key: string, limit: number, windowMs = 60_000): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.reset) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    return true;
  }
  b.count += 1;
  return b.count <= limit;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k);
}, 120_000).unref();

function requireAuth(authorization: string | undefined): Profile {
  const profile = authenticate(authorization);
  if (!profile) {
    const err = new Error('unauthorized') as Error & { statusCode: number };
    err.statusCode = 401;
    throw err;
  }
  return profile;
}

// ---- schemas ----

const runSchema = z.object({
  runId: z.string().uuid(),
  gameId: z.enum(GAME_IDS as [GameId, ...GameId[]]),
  score: z.number().finite().min(0),
  durationMs: z.number().int().min(0).max(24 * 3600 * 1000),
  seed: z.number().int(),
  stats: z.record(z.number().finite()).default({}),
});

const patchProfileSchema = z.object({
  nickname: z.string().min(2).max(16).regex(/^[\w\- .]+$/u).optional(),
  settings: z.record(z.unknown()).optional(),
  metaEnabled: z.boolean().optional(),
});

// a tiny profanity net for public boards — not a moral firewall, just hygiene
const BLOCKED = /fuck|shit|cunt|nigg|fag|rape/i;

// ---- routes ----

app.get('/healthz', async () => ({ ok: true }));

app.post('/api/profiles', async (req, reply) => {
  if (!rateLimit(`mint:${req.ip}`, 10)) return reply.code(429).send({ error: 'rate limited' });
  return createProfile();
});

app.get('/api/profiles/me', async (req) => {
  const p = requireAuth(req.headers.authorization);
  return { profileId: p.id, nickname: p.nickname, settings: JSON.parse(p.settings) as unknown };
});

app.patch('/api/profiles/me', async (req, reply) => {
  const p = requireAuth(req.headers.authorization);
  const body = patchProfileSchema.parse(req.body);
  if (body.nickname !== undefined) {
    if (BLOCKED.test(body.nickname)) return reply.code(400).send({ error: 'nickname rejected' });
    db.prepare('UPDATE profiles SET nickname = ? WHERE id = ?').run(body.nickname, p.id);
  }
  if (body.settings !== undefined) {
    db.prepare('UPDATE profiles SET settings = ? WHERE id = ?').run(JSON.stringify(body.settings), p.id);
  }
  if (body.metaEnabled !== undefined) {
    db.prepare('UPDATE progress SET meta_enabled = ? WHERE profile_id = ?').run(body.metaEnabled ? 1 : 0, p.id);
  }
  return { ok: true };
});

app.post('/api/runs', async (req, reply) => {
  const p = requireAuth(req.headers.authorization);
  if (!rateLimit(`runs:${p.id}`, 30) || !rateLimit(`runs-ip:${req.ip}`, 90)) {
    return reply.code(429).send({ error: 'rate limited' });
  }
  const run = runSchema.parse(req.body);
  return submitRun(p.id, run);
});

app.post('/api/progress/sync', async (req, reply) => {
  const p = requireAuth(req.headers.authorization);
  if (!rateLimit(`sync:${p.id}`, 10)) return reply.code(429).send({ error: 'rate limited' });
  const body = z.object({ runs: z.array(runSchema).max(200) }).parse(req.body);
  const results = body.runs.map((run) => ({ runId: run.runId, outcome: submitRun(p.id, run) }));
  return { synced: results.length, results };
});

app.get('/api/progress/me', async (req) => {
  const p = requireAuth(req.headers.authorization);
  const prog = db.prepare('SELECT * FROM progress WHERE profile_id = ?').get(p.id) as Record<string, unknown>;
  const bests = db.prepare('SELECT game_id, score, stars FROM bests WHERE profile_id = ?').all(p.id);
  const badges = (db.prepare('SELECT badge_id FROM badges WHERE profile_id = ?').all(p.id) as { badge_id: string }[]).map((r) => r.badge_id);
  return {
    xp: prog['xp'],
    level: prog['level'],
    streak: JSON.parse(prog['streak_json'] as string) as unknown,
    metaEnabled: prog['meta_enabled'] === 1,
    bests,
    badges,
  };
});

app.get('/api/leaderboards/:gameId', async (req, reply) => {
  const { gameId } = req.params as { gameId: string };
  if (!GAME_IDS.includes(gameId as GameId)) return reply.code(404).send({ error: 'unknown game' });
  const query = req.query as { window?: string; around?: string };
  const windowKind = query.window === 'daily' ? 'daily' : 'alltime';

  let rows: { profile_id: string; score: number }[];
  if (windowKind === 'daily') {
    rows = db.prepare(`
      SELECT profile_id, MAX(score) AS score FROM runs
      WHERE game_id = ? AND day = ? AND quarantined = 0
      GROUP BY profile_id ORDER BY score DESC LIMIT 100
    `).all(gameId, utcDay(Date.now())) as { profile_id: string; score: number }[];
  } else {
    rows = db.prepare('SELECT profile_id, score FROM bests WHERE game_id = ? ORDER BY score DESC LIMIT 100').all(gameId) as { profile_id: string; score: number }[];
  }

  const names = new Map(
    (db.prepare(`SELECT id, nickname FROM profiles WHERE id IN (${rows.map(() => '?').join(',') || "''"})`)
      .all(...rows.map((r) => r.profile_id)) as { id: string; nickname: string }[]).map((r) => [r.id, r.nickname]),
  );

  const board = rows.map((r, i) => ({
    rank: i + 1,
    nickname: names.get(r.profile_id) || `Guest-${r.profile_id.slice(2, 6).toUpperCase()}`,
    score: Math.floor(r.score),
  }));

  // "your rank" window (±3 rows) when authenticated and asked for
  let me: { rank: number; score: number } | null = null;
  if (query.around === 'me') {
    const profile = authenticate(req.headers.authorization);
    if (profile) {
      const mine = windowKind === 'daily'
        ? (db.prepare('SELECT MAX(score) AS score FROM runs WHERE game_id = ? AND day = ? AND profile_id = ? AND quarantined = 0').get(gameId, utcDay(Date.now()), profile.id) as { score: number | null })
        : (db.prepare('SELECT score FROM bests WHERE game_id = ? AND profile_id = ?').get(gameId, profile.id) as { score: number } | undefined) ?? { score: null };
      if (mine.score !== null && mine.score !== undefined) {
        const better = windowKind === 'daily'
          ? (db.prepare('SELECT COUNT(*) AS n FROM (SELECT profile_id, MAX(score) s FROM runs WHERE game_id = ? AND day = ? AND quarantined = 0 GROUP BY profile_id) WHERE s > ?').get(gameId, utcDay(Date.now()), mine.score) as { n: number })
          : (db.prepare('SELECT COUNT(*) AS n FROM bests WHERE game_id = ? AND score > ?').get(gameId, mine.score) as { n: number });
        me = { rank: better.n + 1, score: Math.floor(mine.score) };
      }
    }
  }

  return { window: windowKind, rows: board, me };
});

// ---- static site (production) ----

const dist = join(here, '..', 'dist');
if (existsSync(dist)) {
  await app.register(fastifyStatic, {
    root: dist,
    setHeaders(res, path) {
      if (/\.(js|css|wasm|woff2?)$/.test(path) && /-[\w-]{8,}\./.test(path)) {
        res.setHeader('cache-control', 'public, max-age=31536000, immutable');
      }
    },
  });
  // SPA fallback for client routes
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/')) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not found' });
  });
}

const port = Number(process.env['PORT'] ?? 8787);
app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
