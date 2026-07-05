// Local-first progress service. Records every completed run, computes
// stars/XP/badges/streak with /shared math (silent accrual — GAMIFICATION §1),
// keeps personal bests, and queues submissions for server sync (M4 wires the
// network layer; the queue is durable either way).

import type { GameId, ProgressState, RunStats, RunSubmission } from '@shared/types';
import { starsFor, runXp, levelFromXp, type XpBreakdown } from '@shared/scoring';
import { advanceStreak, evaluateBadges, utcDay, type StreakState } from '@shared/badges';
import { GAMES } from '@shared/registry';
import { Emitter } from '@sdk/events';

interface LocalProgress {
  bests: Partial<Record<GameId, number>>;
  stars: Partial<Record<GameId, number>>;
  xp: number;
  badges: string[];
  streak: StreakState;
  playedGames: GameId[];
  runsCompleted: number;
  lastRunDay: string | null;
  gamesPlayedToday: GameId[];
  pendingRuns: RunSubmission[];
  /** UTC day → completed runs that day (heatmap; last ~120 days kept). */
  runDays: Record<string, number>;
}

const KEY = 'hypercade:progress';

const empty: LocalProgress = {
  bests: {},
  stars: {},
  xp: 0,
  badges: [],
  streak: { current: 0, best: 0, shields: 0, lastDay: null },
  playedGames: [],
  runsCompleted: 0,
  lastRunDay: null,
  gamesPlayedToday: [],
  pendingRuns: [],
  runDays: {},
};

function load(): LocalProgress {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...empty, ...(JSON.parse(raw) as Partial<LocalProgress>) } : { ...empty };
  } catch {
    return { ...empty };
  }
}

export interface RunResult {
  score: number;
  best: number;
  isNewBest: boolean;
  starsBefore: number;
  starsAfter: number;
  xp: XpBreakdown;
  level: number;
  levelUp: boolean;
  newBadges: string[];
  totalStars: number;
  runsCompleted: number;
}

class ProgressService {
  private state = load();
  readonly changed = new Emitter<{ change: LocalProgress }>();

  get(): LocalProgress {
    return this.state;
  }

  totalStars(): number {
    return Object.values(this.state.stars).reduce((a, b) => a + (b ?? 0), 0);
  }

  bestFor(id: GameId): number {
    return this.state.bests[id] ?? 0;
  }

  starsForGame(id: GameId): number {
    return this.state.stars[id] ?? 0;
  }

  /** Record a completed run. Pure /shared math; persists locally; queues sync. */
  recordRun(gameId: GameId, run: RunStats): RunResult {
    const s = this.state;
    const today = utcDay(Date.now());
    const firstRunOfDay = s.lastRunDay !== today;
    const firstRunOfGame = !s.playedGames.includes(gameId);
    const starsBefore = s.stars[gameId] ?? 0;
    const starsAfter = Math.max(starsBefore, starsFor(gameId, run.score));
    const bestBefore = s.bests[gameId] ?? 0;
    const best = Math.max(bestBefore, run.score);

    const streak = advanceStreak(s.streak, Date.now());
    const gamesPlayedToday = firstRunOfDay ? [gameId] : Array.from(new Set([...s.gamesPlayedToday, gameId]));

    const nextStars = { ...s.stars, [gameId]: starsAfter };
    const totalStars = Object.values(nextStars).reduce<number>((a, b) => a + (b ?? 0), 0);
    const starredGames = GAMES.filter((g) => (nextStars[g.id] ?? 0) >= 1).length;

    // secret Daydreamer badge: the journey page banks 2min of map idling here
    let stats = run.stats;
    try {
      if (localStorage.getItem('hypercade:mapIdle') === '1') {
        stats = { ...stats, mapIdle: 1 };
        localStorage.removeItem('hypercade:mapIdle');
      }
    } catch {
      // storage blocked
    }
    const submission: RunSubmission = { ...run, stats, gameId, runId: crypto.randomUUID() };
    const progressForBadges: ProgressState = {
      xp: s.xp,
      level: levelFromXp(s.xp).level,
      stars: nextStars,
      badges: s.badges,
      streak: { current: streak.current, best: streak.best, shields: streak.shields, lastDay: streak.lastDay },
      metaEnabled: true,
    };
    const newBadges = evaluateBadges(submission, progressForBadges, {
      gamesPlayedToday,
      starredGames,
      totalStars,
      streakDays: streak.current,
    });

    const xp = runXp({
      gameId,
      score: run.score,
      newStarCount: starsAfter - starsBefore,
      newBadgeCount: newBadges.length,
      firstRunOfDay,
      firstRunOfGame,
    });

    const levelBefore = levelFromXp(s.xp).level;
    const xpTotal = s.xp + xp.total;
    const level = levelFromXp(xpTotal).level;

    this.state = {
      ...s,
      bests: { ...s.bests, [gameId]: best },
      stars: nextStars,
      xp: xpTotal,
      badges: [...s.badges, ...newBadges],
      streak,
      playedGames: firstRunOfGame ? [...s.playedGames, gameId] : s.playedGames,
      runsCompleted: s.runsCompleted + 1,
      lastRunDay: today,
      gamesPlayedToday,
      pendingRuns: [...s.pendingRuns, submission].slice(-200),
      runDays: trimDays({ ...s.runDays, [today]: (s.runDays[today] ?? 0) + 1 }),
    };
    this.persist();

    return {
      score: run.score,
      best,
      isNewBest: run.score > bestBefore && run.score > 0,
      starsBefore,
      starsAfter,
      xp,
      level,
      levelUp: level > levelBefore,
      newBadges,
      totalStars,
      runsCompleted: this.state.runsCompleted,
    };
  }

  /** Runs waiting for server sync (drained by the API layer in M4). */
  takePendingRuns(): RunSubmission[] {
    const runs = this.state.pendingRuns;
    return runs;
  }

  clearPending(ids: string[]): void {
    this.state = { ...this.state, pendingRuns: this.state.pendingRuns.filter((r) => !ids.includes(r.runId)) };
    this.persist();
  }

  exportJson(): string {
    return JSON.stringify(this.state, null, 2);
  }

  wipe(): void {
    this.state = { ...empty };
    this.persist();
  }

  private persist(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.state));
    } catch {
      // quota — keep in memory
    }
    this.changed.emit('change', this.state);
  }
}

function trimDays(days: Record<string, number>): Record<string, number> {
  const keys = Object.keys(days).sort();
  if (keys.length <= 120) return days;
  const trimmed: Record<string, number> = {};
  for (const k of keys.slice(-120)) trimmed[k] = days[k]!;
  return trimmed;
}

export const progress = new ProgressService();
