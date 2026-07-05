// Unit tests for the single-source-of-truth math (TECH-BRIEF §9).
// The same module is imported by client and server — one test suite covers both.

import { describe, it, expect } from 'vitest';
import { starsFor, levelCost, levelFromXp, runXp, scoreQualityXp, isPlausible, STAR_THRESHOLDS } from './scoring';
import { advanceStreak, evaluateBadges, utcDay, BADGES, type StreakState } from './badges';
import { GAMES, gameMeta, DISTRICTS } from './registry';
import type { GameId, ProgressState, RunSubmission } from './types';

describe('registry', () => {
  it('has exactly 12 games with unique permanent ids', () => {
    expect(GAMES).toHaveLength(12);
    expect(new Set(GAMES.map((g) => g.id)).size).toBe(12);
  });

  it('splits 7 × 2D and 5 × 3D per PRD scope', () => {
    expect(GAMES.filter((g) => g.engine === '2d')).toHaveLength(7);
    expect(GAMES.filter((g) => g.engine === '3d')).toHaveLength(5);
  });

  it('assigns 3 games to each of the 4 districts', () => {
    for (const d of DISTRICTS) {
      expect(GAMES.filter((g) => g.district === d.number)).toHaveLength(3);
    }
  });

  it('looks up game meta by id', () => {
    expect(gameMeta('flap')?.title).toBe('ONE-WING');
    expect(gameMeta('nope')).toBeUndefined();
  });
});

describe('stars', () => {
  it('maps scores to stars at documented thresholds', () => {
    expect(starsFor('flap', 0)).toBe(0);
    expect(starsFor('flap', 5)).toBe(1);
    expect(starsFor('flap', 15)).toBe(2);
    expect(starsFor('flap', 40)).toBe(3);
    expect(starsFor('flap', 39)).toBe(2);
  });

  it('defines thresholds for every game, strictly ascending', () => {
    for (const g of GAMES) {
      const [a, b, c] = STAR_THRESHOLDS[g.id];
      expect(a).toBeGreaterThan(0);
      expect(b).toBeGreaterThan(a);
      expect(c).toBeGreaterThan(b);
    }
  });
});

describe('xp & levels', () => {
  it('matches the documented level curve: L1→2 = 100, L9→10 = 2700', () => {
    expect(levelCost(1)).toBe(100);
    expect(levelCost(9)).toBe(2700);
  });

  it('accumulates levels from total xp', () => {
    expect(levelFromXp(0).level).toBe(1);
    expect(levelFromXp(99).level).toBe(1);
    expect(levelFromXp(100).level).toBe(2);
    const l3 = levelFromXp(100 + Math.ceil(100 * Math.pow(2, 1.5)));
    expect(l3.level).toBe(3);
  });

  it('caps score-quality xp at 1.25× of the ★3 threshold', () => {
    expect(scoreQualityXp('flap', 40)).toBe(40);
    expect(scoreQualityXp('flap', 4000)).toBe(50);
  });

  it('sums the documented xp sources', () => {
    const xp = runXp({ gameId: 'flap', score: 40, newStarCount: 1, newBadgeCount: 1, firstRunOfDay: true, firstRunOfGame: true });
    expect(xp.total).toBe(10 + 40 + 100 + 150 + 25 + 50);
  });
});

describe('plausibility caps', () => {
  const base = { durationMs: 60_000, seed: 1, stats: {} };
  it('accepts a normal run', () => {
    expect(isPlausible('flap', { ...base, score: 20 })).toBe(true);
  });
  it('rejects absolute-max violations', () => {
    expect(isPlausible('flap', { ...base, score: 5000 })).toBe(false);
  });
  it('rejects impossible score rates', () => {
    expect(isPlausible('flap', { score: 100, durationMs: 4000, seed: 1, stats: {} })).toBe(false);
  });
  it('rejects too-short runs', () => {
    expect(isPlausible('flap', { score: 3, durationMs: 500, seed: 1, stats: {} })).toBe(false);
  });
  it('enforces stats-vs-score coherence for bricks', () => {
    expect(isPlausible('bricks', { score: 30, durationMs: 400_000, seed: 1, stats: { ballsFired: 5 } })).toBe(false);
    expect(isPlausible('bricks', { score: 30, durationMs: 400_000, seed: 1, stats: { ballsFired: 400 } })).toBe(true);
  });
});

describe('streak', () => {
  const day = (s: string): number => Date.parse(`${s}T12:00:00Z`);

  it('starts at 1 and increments on consecutive days', () => {
    let s = advanceStreak({ current: 0, best: 0, shields: 0, lastDay: null }, day('2026-07-01'));
    expect(s.current).toBe(1);
    s = advanceStreak(s, day('2026-07-02'));
    expect(s.current).toBe(2);
  });

  it('is idempotent within one day', () => {
    let s = advanceStreak({ current: 0, best: 0, shields: 0, lastDay: null }, day('2026-07-01'));
    s = advanceStreak(s, day('2026-07-01'));
    expect(s.current).toBe(1);
  });

  it('grants a shield every 7th day (max 2) and a shield covers one missed day', () => {
    let s = { current: 0, best: 0, shields: 0, lastDay: null as string | null };
    for (let d = 1; d <= 7; d++) s = advanceStreak(s, day(`2026-07-0${d}`));
    expect(s.current).toBe(7);
    expect(s.shields).toBe(1);
    // miss the 8th, play the 9th — shield eats the gap
    s = advanceStreak(s, day('2026-07-09'));
    expect(s.current).toBe(8);
    expect(s.shields).toBe(0);
  });

  it('resets kindly (best preserved) after an uncovered gap', () => {
    let s: StreakState = { current: 5, best: 5, shields: 0, lastDay: '2026-07-01' };
    s = advanceStreak(s, day('2026-07-05'));
    expect(s.current).toBe(1);
    expect(s.best).toBe(5);
  });
});

describe('badges', () => {
  const progress: ProgressState = { xp: 0, level: 1, stars: {}, badges: [], streak: { current: 1, best: 1, shields: 0, lastDay: null }, metaEnabled: true };
  const ctx = { gamesPlayedToday: ['flap'] as GameId[], starredGames: 0, totalStars: 0, streakDays: 1 };
  const run = (gameId: GameId, score: number, stats: Record<string, number>): RunSubmission => ({ gameId, score, stats, durationMs: 60_000, seed: 1, runId: 'r' });

  it('ships exactly 20 launch badges', () => {
    expect(BADGES).toHaveLength(20);
  });

  it('grants per-game feat badges from stats keys', () => {
    expect(evaluateBadges(run('flap', 10, { grazes: 1 }), progress, ctx)).toContain('threadbare');
    expect(evaluateBadges(run('stack', 12, { maxPerfectStreak: 10 }), progress, ctx)).toContain('dead-center');
    expect(evaluateBadges(run('merge-drop', 500, { maxTier: 11 }), progress, ctx)).toContain('overripe');
  });

  it('never regrants an owned badge', () => {
    const owned = { ...progress, badges: ['threadbare'] };
    expect(evaluateBadges(run('flap', 10, { grazes: 1 }), owned, ctx)).not.toContain('threadbare');
  });

  it('grants polyglot for a 2D+3D day', () => {
    const both = { ...ctx, gamesPlayedToday: ['flap', 'stack'] as GameId[] };
    expect(evaluateBadges(run('stack', 1, {}), progress, both)).toContain('polyglot');
  });

  it('grants speedrun? for a sub-2s loss', () => {
    const quick: RunSubmission = { gameId: 'flap', score: 0, stats: {}, durationMs: 1500, seed: 1, runId: 'r' };
    expect(evaluateBadges(quick, progress, ctx)).toContain('speedrun');
  });
});

describe('utcDay', () => {
  it('formats UTC days', () => {
    expect(utcDay(Date.parse('2026-07-05T23:59:00Z'))).toBe('2026-07-05');
    expect(utcDay(Date.parse('2026-07-06T00:01:00Z'))).toBe('2026-07-06');
  });
});
