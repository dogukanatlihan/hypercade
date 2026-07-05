// Single source of truth for scoring math: star thresholds, XP, levels,
// plausibility caps. Client displays these; server validates with them.
// Never duplicate these numbers anywhere else (TECH-BRIEF §2).

import type { GameId, RunStats } from './types';

/** Star thresholds per game: score needed for ★1 / ★2 / ★3 (MECHANICS.md, per-game). */
export const STAR_THRESHOLDS: Record<GameId, readonly [number, number, number]> = {
  flap: [5, 15, 40],
  'merge-drop': [1500, 6000, 20000],
  sling: [2, 5, 9], // waves cleared
  rope: [20, 45, 65], // sparks of 72
  bricks: [10, 25, 50], // turns survived
  draw: [12, 24, 36], // levels solved; 36 = all 24 with ≤ half ink-par (score = levels + bonus)
  plinko: [10_000, 1_000_000, 100_000_000], // lifetime earnings
  stack: [10, 25, 45], // height
  helix: [25, 75, 200], // layers descended
  hole: [40, 70, 96], // % of town swallowed
  knock: [8, 20, 40], // scenes cleared; 40 = 20 with all demolition bonuses (score = scenes + bonuses)
  swerve: [300, 900, 2000], // metres
};

export function starsFor(gameId: GameId, score: number): 0 | 1 | 2 | 3 {
  const t = STAR_THRESHOLDS[gameId];
  if (score >= t[2]) return 3;
  if (score >= t[1]) return 2;
  if (score >= t[0]) return 1;
  return 0;
}

export const TOTAL_STARS = 36;

// ---- XP (GAMIFICATION §5) ----

export const XP = {
  completedRun: 10,
  scoreQualityMax: 40, // 40 × min(score/★3, 1.25)
  newStar: 100,
  newBadge: 150,
  firstRunOfDay: 25,
  firstRunOfGame: 50,
} as const;

export function scoreQualityXp(gameId: GameId, score: number): number {
  const t3 = STAR_THRESHOLDS[gameId][2];
  return Math.round(XP.scoreQualityMax * Math.min(score / t3, 1.25));
}

export interface XpBreakdown {
  run: number;
  quality: number;
  newStars: number;
  badges: number;
  firstOfDay: number;
  firstOfGame: number;
  total: number;
}

export function runXp(opts: {
  gameId: GameId;
  score: number;
  newStarCount: number;
  newBadgeCount: number;
  firstRunOfDay: boolean;
  firstRunOfGame: boolean;
}): XpBreakdown {
  const run = XP.completedRun;
  const quality = scoreQualityXp(opts.gameId, opts.score);
  const newStars = opts.newStarCount * XP.newStar;
  const badges = opts.newBadgeCount * XP.newBadge;
  const firstOfDay = opts.firstRunOfDay ? XP.firstRunOfDay : 0;
  const firstOfGame = opts.firstRunOfGame ? XP.firstRunOfGame : 0;
  return { run, quality, newStars, badges, firstOfDay, firstOfGame, total: run + quality + newStars + badges + firstOfDay + firstOfGame };
}

/** XP required to go from level n to n+1: ceil(100 × n^1.5). */
export function levelCost(n: number): number {
  return Math.ceil(100 * Math.pow(n, 1.5));
}

/** Level for a total XP amount (level 1 at 0 XP). */
export function levelFromXp(totalXp: number): { level: number; intoLevel: number; forNext: number } {
  let level = 1;
  let remaining = totalXp;
  while (remaining >= levelCost(level) && level < 99) {
    remaining -= levelCost(level);
    level += 1;
  }
  return { level, intoLevel: remaining, forNext: levelCost(level) };
}

// ---- Plausibility caps (TECH-BRIEF §7 — quarantine, don't delete) ----

export interface PlausibilityCaps {
  /** Absolute score ceiling — nothing legitimate exceeds this. */
  absMax: number;
  /** Max sustainable score per second of play. */
  maxScorePerSec: number;
  /** A real run takes at least this long (ms). */
  minDurationMs: number;
  /** Stats-vs-score coherence check; return false to quarantine. */
  coherent?: (run: RunStats) => boolean;
}

export const PLAUSIBILITY: Record<GameId, PlausibilityCaps> = {
  flap: { absMax: 1000, maxScorePerSec: 1.5, minDurationMs: 3000 },
  'merge-drop': { absMax: 200_000, maxScorePerSec: 400, minDurationMs: 10_000 },
  sling: { absMax: 60, maxScorePerSec: 0.15, minDurationMs: 20_000 },
  rope: { absMax: 72, maxScorePerSec: 0.4, minDurationMs: 15_000 },
  bricks: { absMax: 500, maxScorePerSec: 0.4, minDurationMs: 20_000, coherent: (r) => (r.stats['ballsFired'] ?? 0) >= r.score },
  draw: { absMax: 48, maxScorePerSec: 0.2, minDurationMs: 20_000 },
  plinko: { absMax: 10_000_000_000, maxScorePerSec: 2_000_000, minDurationMs: 30_000 },
  stack: { absMax: 300, maxScorePerSec: 1.2, minDurationMs: 5000 },
  helix: { absMax: 3000, maxScorePerSec: 12, minDurationMs: 5000 },
  hole: { absMax: 100, maxScorePerSec: 4, minDurationMs: 30_000 },
  knock: { absMax: 60, maxScorePerSec: 0.12, minDurationMs: 30_000 },
  swerve: { absMax: 20_000, maxScorePerSec: 45, minDurationMs: 8000 },
};

export function isPlausible(gameId: GameId, run: RunStats): boolean {
  const caps = PLAUSIBILITY[gameId];
  if (run.score < 0 || run.score > caps.absMax) return false;
  if (run.durationMs < caps.minDurationMs) return false;
  if (run.score > (run.durationMs / 1000) * caps.maxScorePerSec + 10) return false;
  if (caps.coherent && !caps.coherent(run)) return false;
  return true;
}
