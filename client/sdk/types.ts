// Game SDK contract (TECH-BRIEF §4). Every game exports createGame(): Game.

import type { GameMeta, RunStats } from '@shared/types';
import type { Physics2D } from './physics2d';
import type { Physics3D } from './physics3d';
import type { Input } from './input';
import type { AudioBus } from './audio';
import type { Rng } from './rng';
import type { GameStorage } from './storage';
import type { Hud } from './hud';
import type { Settings } from './settings';

export interface Palette {
  bg: string;
  surface: string;
  primary: string;
  accent: string;
  danger: string;
  text: string;
  glow: string;
}

export interface GameContext {
  /** The render canvas — 2D games take a '2d' context, 3D games attach three.js. */
  canvas: HTMLCanvasElement;
  /** CSS pixel size of the canvas (already DPR-scaled internally). */
  width: number;
  height: number;
  dpr: number;
  /** Lazy engine access — WASM loads once per session, world resets per game. */
  physics2d(): Promise<Physics2D>;
  physics3d(): Promise<Physics3D>;
  input: Input;
  audio: AudioBus;
  /** Seeded PCG32 — ALL game randomness goes through this. */
  rng: Rng;
  storage: GameStorage;
  hud: Hud;
  settings(): Settings;
  colors(): Palette;
  /** Signal the shell that the current run ended. */
  endRun(stats: RunStats): void;
  /** Called by games when the canvas resizes (shell keeps width/height current). */
  onResize(handler: (w: number, h: number) => void): void;
}

export interface Game {
  meta: GameMeta;
  /** Load assets, build world. Called once per mount. */
  init(ctx: GameContext): Promise<void>;
  /** (Re)start a run. Seed comes from the shell (rng already reseeded). */
  start(seed: number): void;
  /** Fixed-tick simulation, dt = 1/60. Lives in the SDK loop, not the game. */
  step(dt: number): void;
  /** Interpolated draw. */
  render(alpha: number): void;
  /** Free bodies, pools, GL resources. */
  dispose(): void;
}

export type GameFactory = () => Game;
