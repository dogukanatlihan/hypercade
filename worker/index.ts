// HYPERCADE Cloudflare Worker — API + static dist/ + SPA fallback in one Worker.
// Mirrors server/index.ts (Fastify) exactly for every /api route, then serves
// the built client via the ASSETS binding. One origin => relative /api paths,
// zero CORS (client/shell/api.ts calls /api/... directly).

import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { Env } from './env';
import { createProfile, authenticate } from './auth';
import { submitRun } from './meta';
import { GAME_IDS } from '../shared/registry.ts';
import type { GameId } from '../shared/types.ts';
import { utcDay } from '../shared/badges.ts';

// ---- rate limiting ----
// Best-effort, per-isolate in-memory buckets (same limits/keys as the Fastify
// server). NOTE: a Worker runs many short-lived isolates, so this is softer than
// the single-process Node limiter — it throttles a hot isolate, not the account
// globally. Deliberately no KV (would add a binding + latency + cost for a
// non-critical abuse guard). If strict global limits are ever needed, move to
// Durable Objects or the Cloudflare rate-limiting binding — TODO, not now.
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

// ---- schemas (identical to server/index.ts) ----

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

const clientIp = (c: Context<{ Bindings: Env }>): string => c.req.header('CF-Connecting-IP') ?? 'local';
const auth = (c: Context<{ Bindings: Env }>) => authenticate(c.env, c.req.header('Authorization'));

const app = new Hono<{ Bindings: Env }>();

// ---- routes ----

app.get('/healthz', (c) => c.json({ ok: true }));

app.post('/api/profiles', async (c) => {
  if (!rateLimit(`mint:${clientIp(c)}`, 10)) return c.json({ error: 'rate limited' }, 429);
  return c.json(await createProfile(c.env));
});

app.get('/api/profiles/me', async (c) => {
  const p = await auth(c);
  if (!p) return c.json({ error: 'unauthorized' }, 401);
  return c.json({ profileId: p.id, nickname: p.nickname, settings: JSON.parse(p.settings) as unknown });
});

app.patch('/api/profiles/me', async (c) => {
  const p = await auth(c);
  if (!p) return c.json({ error: 'unauthorized' }, 401);
  const parsed = patchProfileSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body' }, 400);
  const body = parsed.data;
  if (body.nickname !== undefined) {
    if (BLOCKED.test(body.nickname)) return c.json({ error: 'nickname rejected' }, 400);
    await c.env.DB.prepare('UPDATE profiles SET nickname = ? WHERE id = ?').bind(body.nickname, p.id).run();
  }
  if (body.settings !== undefined) {
    await c.env.DB.prepare('UPDATE profiles SET settings = ? WHERE id = ?').bind(JSON.stringify(body.settings), p.id).run();
  }
  if (body.metaEnabled !== undefined) {
    await c.env.DB.prepare('UPDATE progress SET meta_enabled = ? WHERE profile_id = ?').bind(body.metaEnabled ? 1 : 0, p.id).run();
  }
  return c.json({ ok: true });
});

app.post('/api/runs', async (c) => {
  const p = await auth(c);
  if (!p) return c.json({ error: 'unauthorized' }, 401);
  if (!rateLimit(`runs:${p.id}`, 30) || !rateLimit(`runs-ip:${clientIp(c)}`, 90)) {
    return c.json({ error: 'rate limited' }, 429);
  }
  const parsed = runSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid run' }, 400);
  return c.json(await submitRun(c.env, p.id, parsed.data));
});

app.post('/api/progress/sync', async (c) => {
  const p = await auth(c);
  if (!p) return c.json({ error: 'unauthorized' }, 401);
  if (!rateLimit(`sync:${p.id}`, 10)) return c.json({ error: 'rate limited' }, 429);
  const parsed = z.object({ runs: z.array(runSchema).max(200) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid body' }, 400);
  const results: { runId: string; outcome: Awaited<ReturnType<typeof submitRun>> }[] = [];
  for (const run of parsed.data.runs) {
    results.push({ runId: run.runId, outcome: await submitRun(c.env, p.id, run) });
  }
  return c.json({ synced: results.length, results });
});

app.get('/api/progress/me', async (c) => {
  const p = await auth(c);
  if (!p) return c.json({ error: 'unauthorized' }, 401);
  const prog = await c.env.DB.prepare('SELECT * FROM progress WHERE profile_id = ?').bind(p.id).first<Record<string, unknown>>();
  if (!prog) return c.json({ error: 'not found' }, 404);
  const bests = (await c.env.DB.prepare('SELECT game_id, score, stars FROM bests WHERE profile_id = ?').bind(p.id).all()).results;
  const badges = (await c.env.DB.prepare('SELECT badge_id FROM badges WHERE profile_id = ?').bind(p.id).all<{ badge_id: string }>()).results.map((r) => r.badge_id);
  return c.json({
    xp: prog['xp'],
    level: prog['level'],
    streak: JSON.parse(prog['streak_json'] as string) as unknown,
    metaEnabled: prog['meta_enabled'] === 1,
    bests,
    badges,
  });
});

app.get('/api/leaderboards/:gameId', async (c) => {
  const gameId = c.req.param('gameId');
  if (!GAME_IDS.includes(gameId as GameId)) return c.json({ error: 'unknown game' }, 404);
  const windowKind = c.req.query('window') === 'daily' ? 'daily' : 'alltime';
  const db = c.env.DB;

  let rows: { profile_id: string; score: number }[];
  if (windowKind === 'daily') {
    rows = (
      await db
        .prepare(
          `SELECT profile_id, MAX(score) AS score FROM runs
           WHERE game_id = ? AND day = ? AND quarantined = 0
           GROUP BY profile_id ORDER BY score DESC LIMIT 100`,
        )
        .bind(gameId, utcDay(Date.now()))
        .all<{ profile_id: string; score: number }>()
    ).results;
  } else {
    rows = (
      await db.prepare('SELECT profile_id, score FROM bests WHERE game_id = ? ORDER BY score DESC LIMIT 100').bind(gameId).all<{ profile_id: string; score: number }>()
    ).results;
  }

  const placeholders = rows.map(() => '?').join(',') || "''";
  const nameRows = (
    await db
      .prepare(`SELECT id, nickname FROM profiles WHERE id IN (${placeholders})`)
      .bind(...rows.map((r) => r.profile_id))
      .all<{ id: string; nickname: string }>()
  ).results;
  const names = new Map(nameRows.map((r) => [r.id, r.nickname]));

  const board = rows.map((r, i) => ({
    rank: i + 1,
    nickname: names.get(r.profile_id) || `Guest-${r.profile_id.slice(2, 6).toUpperCase()}`,
    score: Math.floor(r.score),
  }));

  // "your rank" window when authenticated and asked for
  let me: { rank: number; score: number } | null = null;
  if (c.req.query('around') === 'me') {
    const profile = await authenticate(c.env, c.req.header('Authorization'));
    if (profile) {
      const mine =
        windowKind === 'daily'
          ? await db.prepare('SELECT MAX(score) AS score FROM runs WHERE game_id = ? AND day = ? AND profile_id = ? AND quarantined = 0').bind(gameId, utcDay(Date.now()), profile.id).first<{ score: number | null }>()
          : (await db.prepare('SELECT score FROM bests WHERE game_id = ? AND profile_id = ?').bind(gameId, profile.id).first<{ score: number }>()) ?? { score: null };
      if (mine && mine.score !== null && mine.score !== undefined) {
        const better =
          windowKind === 'daily'
            ? await db.prepare('SELECT COUNT(*) AS n FROM (SELECT profile_id, MAX(score) s FROM runs WHERE game_id = ? AND day = ? AND quarantined = 0 GROUP BY profile_id) WHERE s > ?').bind(gameId, utcDay(Date.now()), mine.score).first<{ n: number }>()
            : await db.prepare('SELECT COUNT(*) AS n FROM bests WHERE game_id = ? AND score > ?').bind(gameId, mine.score).first<{ n: number }>();
        me = { rank: (better?.n ?? 0) + 1, score: Math.floor(mine.score) };
      }
    }
  }

  return c.json({ window: windowKind, rows: board, me });
});

// ---- static site + SPA fallback (mirror of Fastify setNotFoundHandler) ----
// GET non-/api  -> ASSETS.fetch (SPA: unmatched paths resolve to index.html via
//                  not_found_handling in wrangler.toml), immutable cache for
//                  content-hashed assets.
// GET /api/*    -> 404 JSON (never fall through to the SPA shell).
// non-GET       -> 404 JSON.

app.get('*', async (c) => {
  const url = new URL(c.req.url);
  if (url.pathname.startsWith('/api/')) return c.json({ error: 'not found' }, 404);
  const res = await c.env.ASSETS.fetch(c.req.raw);
  if (/\.(js|css|wasm|woff2?)$/.test(url.pathname) && /-[\w-]{8,}\./.test(url.pathname)) {
    const cached = new Response(res.body, res);
    cached.headers.set('cache-control', 'public, max-age=31536000, immutable');
    return cached;
  }
  return res;
});
app.all('*', (c) => c.json({ error: 'not found' }, 404));

export default app;
