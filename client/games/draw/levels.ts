// INKLINE level catalog + level-element types (MECHANICS §7).
// Ramp: flat ground → gaps → pivots/see-saws → moving platforms → wind fields.
// Level box is 10m × 12m, world y up. Ball spawns sit 0.36m above surfaces.

export const LEVEL_W = 10;
export const LEVEL_H = 12;
export const LEVEL_COUNT = 24;

export interface LevelDef {
  readonly a: readonly [number, number];
  readonly b: readonly [number, number];
  /** static boxes: [cx, cy, hx, hy, angle?] */
  readonly boxes?: readonly (readonly [number, number, number, number, number?])[];
  /** see-saws (revolute pivot boards): [cx, cy, halfLen] */
  readonly saws?: readonly (readonly [number, number, number])[];
  /** kinematic movers: [cx, cy, hx, hy, dx, dy, period] */
  readonly movers?: readonly (readonly [number, number, number, number, number, number, number])[];
  /** wind force zones: [cx, cy, hx, hy, fx, fy] */
  readonly wind?: readonly (readonly [number, number, number, number, number, number])[];
  readonly ink: number; // budget = total polyline metres
  readonly par: number; // under-par ink target
}

export const LEVELS: readonly LevelDef[] = [
  { a: [3, 2.16], b: [7, 2.16], boxes: [[5, 0.9, 5, 0.9]], ink: 12, par: 5 },
  { a: [2, 2.16], b: [8, 2.16], boxes: [[5, 0.9, 5, 0.9], [5, 2.15, 0.3, 0.35]], ink: 13, par: 6 },
  { a: [1.2, 2.16], b: [8.8, 2.16], boxes: [[2.1, 0.9, 2.1, 0.9], [7.9, 0.9, 2.1, 0.9]], ink: 15, par: 7 },
  { a: [0.9, 4.11], b: [8.6, 2.16], boxes: [[1.9, 3.4, 1.9, 0.35], [6.9, 0.9, 3.1, 0.9]], ink: 15, par: 7 },
  { a: [0.9, 4.76], b: [9.1, 4.76], boxes: [[1.6, 2.2, 1.3, 2.2], [8.4, 2.2, 1.3, 2.2]], ink: 18, par: 8 },
  { a: [1.4, 1.76], b: [7.9, 3.48], boxes: [[5, 0.7, 5, 0.7]], saws: [[6.5, 3, 1.7]], ink: 17, par: 7 },
  { a: [1, 2.16], b: [9, 2.16], boxes: [[1.9, 0.9, 1.9, 0.9], [8.1, 0.9, 1.9, 0.9]], saws: [[5, 2.6, 1.6]], ink: 18, par: 8 },
  { a: [0.9, 4.5], b: [9.1, 4.5], boxes: [[2.6, 2.9, 2.5, 0.28, -0.42], [7.4, 2.9, 2.5, 0.28, 0.42], [4.7, 1.8, 0.15, 0.4], [5.3, 1.8, 0.15, 0.4]], ink: 14, par: 4 },
  { a: [1.5, 4.36], b: [8, 2.68], boxes: [[5, 0.7, 5, 0.7], [1.5, 2.7, 1.2, 1.3]], saws: [[6.8, 2.2, 1.7]], ink: 18, par: 8 },
  { a: [1.7, 2.68], b: [8.3, 2.68], boxes: [[5, 0.6, 5, 0.6]], saws: [[3, 2.2, 1.5], [7, 2.2, 1.5]], ink: 20, par: 9 },
  { a: [1, 2.16], b: [9, 2.16], boxes: [[1.7, 0.9, 1.7, 0.9], [8.3, 0.9, 1.7, 0.9]], movers: [[5, 1.55, 1, 0.25, 1.6, 0, 4]], ink: 16, par: 6 },
  { a: [0.9, 4.36], b: [9.1, 4.36], boxes: [[1.6, 2, 1.3, 2], [8.4, 2, 1.3, 2]], movers: [[5, 3, 0.9, 0.25, 0, 1.2, 3.5]], ink: 18, par: 8 },
  { a: [2, 1.76], b: [8, 1.76], boxes: [[5, 0.7, 5, 0.7]], movers: [[5, 2.6, 0.3, 0.9, 0, 1.3, 3]], ink: 15, par: 6 },
  { a: [1, 2.16], b: [9, 2.16], boxes: [[1.9, 0.9, 1.9, 0.9], [8.1, 0.9, 1.9, 0.9]], saws: [[5, 3.6, 1.6]], movers: [[5, 1.2, 0.9, 0.22, 1.6, 0, 4.5]], ink: 20, par: 9 },
  { a: [0.8, 3.76], b: [9.2, 3.76], boxes: [[1.4, 1.7, 1.1, 1.7], [8.6, 1.7, 1.1, 1.7]], movers: [[3.9, 2.5, 0.75, 0.22, 0, 0.9, 3.2], [6.1, 2.5, 0.75, 0.22, 0, 0.9, 3.2]], ink: 20, par: 9 },
  { a: [1, 2.16], b: [8.5, 5.16], boxes: [[2.4, 0.9, 2.4, 0.9], [8.5, 2.4, 1.2, 2.4]], movers: [[6, 2.8, 0.8, 0.22, 0, 1.8, 4]], ink: 21, par: 10 },
  { a: [2, 2.16], b: [8, 2.16], boxes: [[5, 0.9, 5, 0.9], [3.2, 2.1, 0.2, 0.3], [6.8, 2.1, 0.2, 0.3]], wind: [[5, 3, 3.2, 1.1, 2.4, 0]], ink: 14, par: 6 },
  { a: [1, 2.16], b: [9, 2.16], boxes: [[1.9, 0.9, 1.9, 0.9], [8.1, 0.9, 1.9, 0.9]], wind: [[5, 3.4, 1.2, 2.6, 0, 7]], ink: 18, par: 8 },
  { a: [0.9, 4.36], b: [9, 2.16], boxes: [[1.6, 2, 1.3, 2], [7, 0.9, 3, 0.9]], wind: [[5.6, 3.2, 2.4, 1.3, -2, 0]], ink: 20, par: 9 },
  { a: [2.1, 2.88], b: [8.6, 1.76], boxes: [[5, 0.7, 5, 0.7]], saws: [[3.4, 2.4, 1.5]], wind: [[6.9, 3.6, 1.5, 2, 2, 4.5]], ink: 20, par: 9 },
  { a: [1, 2.16], b: [9, 2.16], boxes: [[1.7, 0.9, 1.7, 0.9], [8.3, 0.9, 1.7, 0.9]], movers: [[5, 1.5, 0.9, 0.22, 1.5, 0, 4]], wind: [[5, 3.2, 1.3, 1.6, -2.6, 0]], ink: 21, par: 10 },
  { a: [0.8, 4.56], b: [9.2, 4.56], boxes: [[1.5, 2.1, 1.2, 2.1], [8.5, 2.1, 1.2, 2.1]], wind: [[3.8, 4.9, 1.3, 1.6, 3, 0], [6.2, 4.9, 1.3, 1.6, -3, 0]], ink: 22, par: 10 },
  { a: [0.7, 2.16], b: [9.1, 5.56], boxes: [[1.6, 0.9, 1.6, 0.9], [9.1, 2.6, 0.9, 2.6]], saws: [[4.4, 2.2, 1.3]], movers: [[6.6, 2.6, 0.7, 0.22, 0, 1.5, 3.6]], wind: [[4.4, 4.6, 1.6, 1.3, 1.8, 1]], ink: 24, par: 11 },
  { a: [0.8, 5.86], b: [9.2, 5.86], boxes: [[1.4, 2.75, 1.1, 2.75], [8.6, 2.75, 1.1, 2.75], [5, 1.4, 0.5, 1.4]], saws: [[5, 3.2, 1.4]], wind: [[3.3, 3.6, 0.8, 2.4, 0, 6], [6.7, 3.6, 0.8, 2.4, 0, 6]], ink: 26, par: 12 },
];

// runtime shapes of the live level elements

export interface Saw {
  board: number;
  cx: number;
  cy: number;
  halfLen: number;
}

export interface Mover {
  h: number;
  cx: number;
  cy: number;
  hx: number;
  hy: number;
  dx: number;
  dy: number;
  period: number;
  phase: number;
}

export interface WindZone {
  cx: number;
  cy: number;
  hx: number;
  hy: number;
  fx: number;
  fy: number;
}

export interface InkBody {
  h: number;
  pts: ReadonlyArray<readonly [number, number]>; // local coords (body origin = centroid)
  r: number;
  age: number;
}

/** Oscillating kinematic platform position at time t. */
export function moverPos(m: Mover, t: number): [number, number] {
  const p = Math.sin((Math.PI * 2 * t) / m.period + m.phase);
  return [m.cx + m.dx * p, m.cy + m.dy * p];
}
