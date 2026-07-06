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

/** Cover-art motif key (drives the generated CSS gradient art). */
export type Motif = 'rings' | 'bars' | 'orbs' | 'burst' | 'spiral' | 'net' | 'blob' | 'dots' | 'trace' | 'streaks';

export interface GameMeta {
  id: GameId;
  title: string;
  engine: Engine;
  tagline: string;
  /** Mechanic family, shown on cards and the tech page. */
  family: string;
  /** Journey map district (1-4), see GAMIFICATION §4. */
  district: 1 | 2 | 3 | 4;
  /** Accent hue (hex) — one constant per game; drives cover art, badges, chips. */
  hue: string;
  /** Motion-verb, shown as a chip on tiles and the spotlight. */
  verb: string;
  /** Cover-art motif — the generated-gradient signature for this game. */
  motif: Motif;
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
