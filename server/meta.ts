// Server-side meta engine — the same /shared math the client runs locally.
// Runs are recorded even when implausible (quarantined, hidden from boards,
// recoverable). Stars/XP/badges accrue silently regardless of the meta toggle.

import { db } from './db.ts';
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

const getProgress = db.prepare('SELECT * FROM progress WHERE profile_id = ?');
const getBest = db.prepare('SELECT score, stars FROM bests WHERE profile_id = ? AND game_id = ?');
const upsertBest = db.prepare(`
  INSERT INTO bests (profile_id, game_id, score, stars, updated_at) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(profile_id, game_id) DO UPDATE SET score = excluded.score, stars = excluded.stars, updated_at = excluded.updated_at
  WHERE excluded.score > bests.score
`);
const getAllBests = db.prepare('SELECT game_id, stars FROM bests WHERE profile_id = ?');
const getBadges = db.prepare('SELECT badge_id FROM badges WHERE profile_id = ?');
const insertBadge = db.prepare('INSERT OR IGNORE INTO badges (profile_id, badge_id, earned_at) VALUES (?, ?, ?)');
const updateProgress = db.prepare(`
  UPDATE progress SET xp = ?, level = ?, streak_json = ?, played_games = ?, last_run_day = ?, games_played_today = ?
  WHERE profile_id = ?
`);
const insertRun = db.prepare(`
  INSERT OR IGNORE INTO runs (id, profile_id, game_id, score, duration_ms, seed, stats_json, quarantined, created_at, day)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const logAnomaly = db.prepare('INSERT INTO anomalies (profile_id, game_id, reason, payload, created_at) VALUES (?, ?, ?, ?, ?)');
const dailyRank = db.prepare(`
  SELECT COUNT(*) + 1 AS rank FROM (
    SELECT profile_id, MAX(score) AS s FROM runs WHERE game_id = ? AND day = ? AND quarantined = 0 GROUP BY profile_id
  ) WHERE s > ?
`);
const alltimeRank = db.prepare('SELECT COUNT(*) + 1 AS rank FROM bests WHERE game_id = ? AND score > ?');

export function submitRun(profileId: string, run: RunSubmission, now = Date.now()): RunOutcome {
  const day = utcDay(now);
  const plausible = isPlausible(run.gameId, run);
  const inserted = insertRun.run(
    run.runId, profileId, run.gameId, run.score, run.durationMs, run.seed,
    JSON.stringify(run.stats ?? {}), plausible ? 0 : 1, now, day,
  );

  const p = getProgress.get(profileId) as ProgressRow | undefined;
  if (!p) throw new Error('no progress row');
  const level0 = levelFromXp(p.xp).level;

  // idempotent replay of an already-recorded run: report state, grant nothing
  if (inserted.changes === 0) {
    const best = (getBest.get(profileId, run.gameId) as { score: number; stars: number } | undefined) ?? { score: 0, stars: 0 };
    return {
      accepted: true, quarantined: !plausible, stars: best.stars, newStars: 0, newBadges: [],
      xp: 0, xpTotal: p.xp, level: level0, best: best.score,
      ranks: rankFor(run.gameId, best.score, day),
    };
  }

  if (!plausible) {
    logAnomaly.run(profileId, run.gameId, 'plausibility', JSON.stringify(run), now);
    const best = (getBest.get(profileId, run.gameId) as { score: number; stars: number } | undefined) ?? { score: 0, stars: 0 };
    return {
      accepted: true, quarantined: true, stars: best.stars, newStars: 0, newBadges: [],
      xp: 0, xpTotal: p.xp, level: level0, best: best.score, ranks: { daily: null, alltime: null },
    };
  }

  const prevBest = (getBest.get(profileId, run.gameId) as { score: number; stars: number } | undefined) ?? { score: 0, stars: 0 };
  const starsAfter = Math.max(prevBest.stars, starsFor(run.gameId, run.score));
  upsertBest.run(profileId, run.gameId, Math.max(prevBest.score, run.score), starsAfter, now);

  const playedGames = JSON.parse(p.played_games) as GameId[];
  const firstRunOfGame = !playedGames.includes(run.gameId);
  const firstRunOfDay = p.last_run_day !== day;
  const gamesPlayedToday = firstRunOfDay ? [run.gameId] : Array.from(new Set([...(JSON.parse(p.games_played_today) as GameId[]), run.gameId]));
  const streak = advanceStreak(JSON.parse(p.streak_json) as StreakState, now);

  const bestRows = getAllBests.all(profileId) as { game_id: GameId; stars: number }[];
  const starsMap: Partial<Record<GameId, number>> = {};
  for (const row of bestRows) starsMap[row.game_id] = row.stars;
  starsMap[run.gameId] = starsAfter;
  const totalStars = Object.values(starsMap).reduce<number>((a, b) => a + (b ?? 0), 0);
  const starredGames = GAMES.filter((g) => (starsMap[g.id] ?? 0) >= 1).length;

  const ownedBadges = (getBadges.all(profileId) as { badge_id: string }[]).map((r) => r.badge_id);
  const progressState: ProgressState = {
    xp: p.xp, level: level0, stars: starsMap, badges: ownedBadges,
    streak: { current: streak.current, best: streak.best, shields: streak.shields, lastDay: streak.lastDay },
    metaEnabled: p.meta_enabled === 1,
  };
  const newBadges = evaluateBadges(run, progressState, { gamesPlayedToday, starredGames, totalStars, streakDays: streak.current });
  for (const b of newBadges) insertBadge.run(profileId, b, now);

  const xp = runXp({
    gameId: run.gameId, score: run.score,
    newStarCount: starsAfter - prevBest.stars, newBadgeCount: newBadges.length,
    firstRunOfDay, firstRunOfGame,
  });
  const xpTotal = p.xp + xp.total;
  const level = levelFromXp(xpTotal).level;
  updateProgress.run(
    xpTotal, level, JSON.stringify(streak),
    JSON.stringify(firstRunOfGame ? [...playedGames, run.gameId] : playedGames),
    day, JSON.stringify(gamesPlayedToday), profileId,
  );

  return {
    accepted: true, quarantined: false, stars: starsAfter, newStars: starsAfter - prevBest.stars,
    newBadges, xp: xp.total, xpTotal, level,
    best: Math.max(prevBest.score, run.score),
    ranks: rankFor(run.gameId, Math.max(prevBest.score, run.score), day),
  };
}

function rankFor(gameId: GameId, score: number, day: string): { daily: number | null; alltime: number | null } {
  const d = dailyRank.get(gameId, day, score) as { rank: number } | undefined;
  const a = alltimeRank.get(gameId, score) as { rank: number } | undefined;
  return { daily: d?.rank ?? null, alltime: a?.rank ?? null };
}
