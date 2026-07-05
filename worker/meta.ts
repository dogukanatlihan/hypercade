// Server-side meta engine — async D1 port of server/meta.ts.
// Same /shared math. Runs are recorded even when implausible (quarantined,
// hidden from boards, recoverable). Stars/XP/badges accrue regardless of meta.
//
// Ordering vs. the sync (better-sqlite3) original:
//   1. insertRun first — its `changes` count gates every branch, so it must
//      resolve before we read progress.
//   2. All reads (progress, best, all-bests, badges) happen next. getAllBests
//      is read before the writes here; in the original it ran *after* upsertBest,
//      but starsMap[run.gameId] is overwritten with starsAfter anyway and the
//      upsert never touches other games' rows, so the computed map is identical.
//   3. The happy-path writes (best upsert, badge inserts, progress update) are
//      committed together via env.DB.batch([...]) — one atomic transaction,
//      preserving the ordering the synchronous version relied on.
//   4. rankFor runs after the batch so alltime rank sees the fresh best (matches
//      the original, where rankFor followed updateProgress).

import type { Env } from './env';
import type { GameId, ProgressState, RunSubmission } from '../shared/types.ts';
import { starsFor, runXp, levelFromXp, isPlausible } from '../shared/scoring.ts';
import { GAMES } from '../shared/registry.ts';
import { advanceStreak, evaluateBadges, utcDay, type StreakState } from '../shared/badges.ts';

export interface RunOutcome {
  accepted: boolean;
  quarantined: boolean;
  stars: number;
  newStars: number;
  newBadges: string[];
  xp: number;
  xpTotal: number;
  level: number;
  ranks: { daily: number | null; alltime: number | null };
  best: number;
}

interface ProgressRow {
  xp: number;
  level: number;
  streak_json: string;
  played_games: string;
  last_run_day: string | null;
  games_played_today: string;
  meta_enabled: number;
}

interface BestRow {
  score: number;
  stars: number;
}

async function getBest(db: D1Database, profileId: string, gameId: GameId): Promise<BestRow | null> {
  return db.prepare('SELECT score, stars FROM bests WHERE profile_id = ? AND game_id = ?').bind(profileId, gameId).first<BestRow>();
}

async function rankFor(db: D1Database, gameId: GameId, score: number, day: string): Promise<{ daily: number | null; alltime: number | null }> {
  const d = await db
    .prepare(
      `SELECT COUNT(*) + 1 AS rank FROM (
        SELECT profile_id, MAX(score) AS s FROM runs WHERE game_id = ? AND day = ? AND quarantined = 0 GROUP BY profile_id
      ) WHERE s > ?`,
    )
    .bind(gameId, day, score)
    .first<{ rank: number }>();
  const a = await db.prepare('SELECT COUNT(*) + 1 AS rank FROM bests WHERE game_id = ? AND score > ?').bind(gameId, score).first<{ rank: number }>();
  return { daily: d?.rank ?? null, alltime: a?.rank ?? null };
}

export async function submitRun(env: Env, profileId: string, run: RunSubmission, now = Date.now()): Promise<RunOutcome> {
  const db = env.DB;
  const day = utcDay(now);
  const plausible = isPlausible(run.gameId, run);

  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO runs (id, profile_id, game_id, score, duration_ms, seed, stats_json, quarantined, created_at, day)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(run.runId, profileId, run.gameId, run.score, run.durationMs, run.seed, JSON.stringify(run.stats ?? {}), plausible ? 0 : 1, now, day)
    .run();

  const p = await db.prepare('SELECT * FROM progress WHERE profile_id = ?').bind(profileId).first<ProgressRow>();
  if (!p) throw new Error('no progress row');
  const level0 = levelFromXp(p.xp).level;

  // idempotent replay of an already-recorded run: report state, grant nothing
  if ((inserted.meta.changes ?? 0) === 0) {
    const best = (await getBest(db, profileId, run.gameId)) ?? { score: 0, stars: 0 };
    return {
      accepted: true, quarantined: !plausible, stars: best.stars, newStars: 0, newBadges: [],
      xp: 0, xpTotal: p.xp, level: level0, best: best.score,
      ranks: await rankFor(db, run.gameId, best.score, day),
    };
  }

  if (!plausible) {
    await db
      .prepare('INSERT INTO anomalies (profile_id, game_id, reason, payload, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(profileId, run.gameId, 'plausibility', JSON.stringify(run), now)
      .run();
    const best = (await getBest(db, profileId, run.gameId)) ?? { score: 0, stars: 0 };
    return {
      accepted: true, quarantined: true, stars: best.stars, newStars: 0, newBadges: [],
      xp: 0, xpTotal: p.xp, level: level0, best: best.score, ranks: { daily: null, alltime: null },
    };
  }

  const prevBest = (await getBest(db, profileId, run.gameId)) ?? { score: 0, stars: 0 };
  const starsAfter = Math.max(prevBest.stars, starsFor(run.gameId, run.score));

  const playedGames = JSON.parse(p.played_games) as GameId[];
  const firstRunOfGame = !playedGames.includes(run.gameId);
  const firstRunOfDay = p.last_run_day !== day;
  const gamesPlayedToday = firstRunOfDay
    ? [run.gameId]
    : Array.from(new Set([...(JSON.parse(p.games_played_today) as GameId[]), run.gameId]));
  const streak = advanceStreak(JSON.parse(p.streak_json) as StreakState, now);

  const bestRows = (await db.prepare('SELECT game_id, stars FROM bests WHERE profile_id = ?').bind(profileId).all<{ game_id: GameId; stars: number }>()).results;
  const starsMap: Partial<Record<GameId, number>> = {};
  for (const row of bestRows) starsMap[row.game_id] = row.stars;
  starsMap[run.gameId] = starsAfter;
  const totalStars = Object.values(starsMap).reduce<number>((a, b) => a + (b ?? 0), 0);
  const starredGames = GAMES.filter((g) => (starsMap[g.id] ?? 0) >= 1).length;

  const ownedBadges = (await db.prepare('SELECT badge_id FROM badges WHERE profile_id = ?').bind(profileId).all<{ badge_id: string }>()).results.map((r) => r.badge_id);
  const progressState: ProgressState = {
    xp: p.xp, level: level0, stars: starsMap, badges: ownedBadges,
    streak: { current: streak.current, best: streak.best, shields: streak.shields, lastDay: streak.lastDay },
    metaEnabled: p.meta_enabled === 1,
  };
  const newBadges = evaluateBadges(run, progressState, { gamesPlayedToday, starredGames, totalStars, streakDays: streak.current });

  const xp = runXp({
    gameId: run.gameId, score: run.score,
    newStarCount: starsAfter - prevBest.stars, newBadgeCount: newBadges.length,
    firstRunOfDay, firstRunOfGame,
  });
  const xpTotal = p.xp + xp.total;
  const level = levelFromXp(xpTotal).level;

  const writes = [
    db
      .prepare(
        `INSERT INTO bests (profile_id, game_id, score, stars, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(profile_id, game_id) DO UPDATE SET score = excluded.score, stars = excluded.stars, updated_at = excluded.updated_at
         WHERE excluded.score > bests.score`,
      )
      .bind(profileId, run.gameId, Math.max(prevBest.score, run.score), starsAfter, now),
    ...newBadges.map((b) =>
      db.prepare('INSERT OR IGNORE INTO badges (profile_id, badge_id, earned_at) VALUES (?, ?, ?)').bind(profileId, b, now),
    ),
    db
      .prepare('UPDATE progress SET xp = ?, level = ?, streak_json = ?, played_games = ?, last_run_day = ?, games_played_today = ? WHERE profile_id = ?')
      .bind(
        xpTotal, level, JSON.stringify(streak),
        JSON.stringify(firstRunOfGame ? [...playedGames, run.gameId] : playedGames),
        day, JSON.stringify(gamesPlayedToday), profileId,
      ),
  ];
  await db.batch(writes);

  return {
    accepted: true, quarantined: false, stars: starsAfter, newStars: starsAfter - prevBest.stars,
    newBadges, xp: xp.total, xpTotal, level,
    best: Math.max(prevBest.score, run.score),
    ranks: await rankFor(db, run.gameId, Math.max(prevBest.score, run.score), day),
  };
}
