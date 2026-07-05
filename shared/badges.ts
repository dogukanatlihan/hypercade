// Badge catalog (GAMIFICATION §6) — 20 at launch. Grants are computed
// server-side from RunSubmission.stats; the same code runs client-side for
// offline display. Per-game feat keys are part of each game's contract.

import type { GameId, ProgressState, RunSubmission } from './types';
import { starsFor, TOTAL_STARS } from './scoring';

export interface BadgeDef {
  id: string;
  name: string;
  description: string;
  /** Evaluate against the run that was just submitted + resulting progress. */
  earned: (run: RunSubmission, progress: ProgressState, context: BadgeContext) => boolean;
  secret?: boolean;
}

export interface BadgeContext {
  /** Games played today (UTC), including this run. */
  gamesPlayedToday: GameId[];
  /** Distinct games with ≥1 star. */
  starredGames: number;
  totalStars: number;
  streakDays: number;
}

const stat = (run: RunSubmission, key: string): number => run.stats[key] ?? 0;

export const BADGES: readonly BadgeDef[] = [
  // cross-game
  {
    id: 'renaissance', name: 'Renaissance', description: '★1 in all 12 games',
    earned: (_r, _p, c) => c.starredGames >= 12,
  },
  {
    id: 'constellation', name: 'Constellation', description: 'All 36 stars',
    earned: (_r, _p, c) => c.totalStars >= TOTAL_STARS,
  },
  {
    id: 'polyglot', name: 'Polyglot', description: 'Play a 2D and a 3D game in one day',
    earned: (_r, _p, c) => {
      const twoD: GameId[] = ['flap', 'merge-drop', 'sling', 'rope', 'bricks', 'draw', 'plinko'];
      const has2d = c.gamesPlayedToday.some((g) => twoD.includes(g));
      const has3d = c.gamesPlayedToday.some((g) => !twoD.includes(g));
      return has2d && has3d;
    },
  },
  // per-game feats (stats keys are each game's contract)
  { id: 'dead-center', name: 'Dead Center', description: '10 consecutive PERFECTs in BOXSTACK', earned: (r) => r.gameId === 'stack' && stat(r, 'maxPerfectStreak') >= 10 },
  { id: 'chain-reaction', name: 'Chain Reaction', description: 'Demolition chain of 3 structures in TOPPLE RANGE', earned: (r) => r.gameId === 'knock' && stat(r, 'maxChain') >= 3 },
  { id: 'freefall', name: 'Freefall', description: '10-layer smash streak in SPIRALFALL', earned: (r) => r.gameId === 'helix' && stat(r, 'maxSmashStreak') >= 10 },
  { id: 'gourmand', name: 'Gourmand', description: 'Swallow a landmark in MAWTOWN', earned: (r) => r.gameId === 'hole' && stat(r, 'landmarks') >= 1 },
  { id: 'minimalist', name: 'Minimalist', description: 'Solve any INKLINE level with one stroke', earned: (r) => r.gameId === 'draw' && stat(r, 'oneStrokeSolves') >= 1 },
  { id: 'sniper', name: 'Sniper', description: 'Clear a SIEGE SLING wave with one shot', earned: (r) => r.gameId === 'sling' && stat(r, 'oneShotWaves') >= 1 },
  { id: 'full-volley', name: 'Full Volley', description: 'Break 12 bricks with one volley in VOLLEY', earned: (r) => r.gameId === 'bricks' && stat(r, 'maxVolleyBreaks') >= 12 },
  { id: 'threadbare', name: 'Threadbare', description: 'Pass a ONE-WING pillar via graze', earned: (r) => r.gameId === 'flap' && stat(r, 'grazes') >= 1 },
  { id: 'overripe', name: 'Overripe', description: 'Reach max tier in MERGE CRATER', earned: (r) => r.gameId === 'merge-drop' && stat(r, 'maxTier') >= 11 },
  { id: 'perpetual-motion', name: 'Perpetual Motion', description: 'First PEGWORKS prestige', earned: (r) => r.gameId === 'plinko' && stat(r, 'prestiges') >= 1 },
  { id: 'marathon', name: 'Marathon', description: '2,000m in GUTTERBALL RUN', earned: (r) => r.gameId === 'swerve' && r.score >= 2000 },
  { id: 'snip-snap', name: 'Snip Snap', description: 'Finish a SNIP level with one cut', earned: (r) => r.gameId === 'rope' && stat(r, 'oneCutSolves') >= 1 },
  // streaks
  { id: 'regular', name: 'Regular', description: '3-day streak', earned: (_r, _p, c) => c.streakDays >= 3 },
  { id: 'devoted', name: 'Devoted', description: '7-day streak', earned: (_r, _p, c) => c.streakDays >= 7 },
  { id: 'resident', name: 'Resident', description: '30-day streak', earned: (_r, _p, c) => c.streakDays >= 30 },
  // secret
  { id: 'daydreamer', name: 'Daydreamer', description: 'Idle on the map for 2 minutes', secret: true, earned: (r) => stat(r, 'mapIdle') >= 1 },
  { id: 'speedrun', name: 'Speedrun?', description: 'Lose within 2 seconds', secret: true, earned: (r) => r.durationMs <= 2000 && r.durationMs > 0 },
];

export function evaluateBadges(run: RunSubmission, progress: ProgressState, context: BadgeContext): string[] {
  const earned: string[] = [];
  for (const badge of BADGES) {
    if (progress.badges.includes(badge.id)) continue;
    if (badge.earned(run, progress, context)) earned.push(badge.id);
  }
  return earned;
}

// ---- streak math (GAMIFICATION §7) ----

export interface StreakState {
  current: number;
  best: number;
  shields: number;
  lastDay: string | null; // 'YYYY-MM-DD' UTC
}

export function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Advance the streak for a completed run at `ts`. Pure — returns a new state. */
export function advanceStreak(s: StreakState, ts: number): StreakState {
  const today = utcDay(ts);
  if (s.lastDay === today) return s;
  const next = { ...s, lastDay: today };
  if (s.lastDay === null) {
    next.current = 1;
  } else {
    const gap = Math.round((Date.parse(today) - Date.parse(s.lastDay)) / 86_400_000);
    if (gap === 1) {
      next.current = s.current + 1;
    } else if (gap === 2 && s.shields > 0) {
      // a banked shield auto-covers one missed day
      next.shields = s.shields - 1;
      next.current = s.current + 1;
    } else {
      next.current = 1; // fresh start — best streak stays on the shelf
    }
  }
  // every 7th day grants a shield, max 2 banked
  if (next.current > 0 && next.current % 7 === 0) {
    next.shields = Math.min(next.shields + 1, 2);
  }
  next.best = Math.max(next.current, s.best);
  return next;
}
