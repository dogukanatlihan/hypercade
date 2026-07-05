// Shared types — client displays them, server validates with them.

export type GameId =
  | 'flap'
  | 'merge-drop'
  | 'sling'
  | 'rope'
  | 'bricks'
  | 'draw'
  | 'plinko'
  | 'stack'
  | 'helix'
  | 'hole'
  | 'knock'
  | 'swerve';

export type Engine = '2d' | '3d';

export interface GameMeta {
  id: GameId;
  title: string;
  engine: Engine;
  tagline: string;
  /** Mechanic family, shown on cards and the tech page. */
  family: string;
  /** Journey map district (1-4), see GAMIFICATION §4. */
  district: 1 | 2 | 3 | 4;
}

/** Payload a game hands to the shell when a run ends. */
export interface RunStats {
  score: number;
  durationMs: number;
  seed: number;
  /** Per-game feats consumed by the badge engine (combo counts, chains, …). */
  stats: Record<string, number>;
}

/** A run as submitted to the server (client adds identity + idempotency). */
export interface RunSubmission extends RunStats {
  gameId: GameId;
  /** Client-generated UUID for idempotent offline sync. */
  runId: string;
}

export interface ProgressState {
  xp: number;
  level: number;
  stars: Partial<Record<GameId, number>>;
  badges: string[];
  streak: { current: number; best: number; shields: number; lastDay: string | null };
  metaEnabled: boolean;
}
