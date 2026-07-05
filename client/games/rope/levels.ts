// SNIP — 24 hand-authored levels (MECHANICS §5). Level space is 10×14 world
// units, y-up, origin bottom-left. Ramp: single-rope cuts → multi-rope timing
// → moving anchors → bumper banks → air-jet force fields.
//
// Rope link counts are derived from anchor→candy distance (target link length
// 0.45 m) unless `links` overrides it. Jet fx/fy are accelerations (m/s²)
// applied as engine forces scaled by each body's mass — a uniform wind field.

export interface MoveDef {
  /** Oscillation amplitude (m) on each axis. */
  ax: number;
  ay: number;
  /** Full oscillation period (s). */
  period: number;
  /** Phase offset (radians). */
  phase?: number;
}

export interface RopeDef {
  /** Anchor position (base position for moving anchors). */
  x: number;
  y: number;
  /** Explicit segment count (defaults from distance / 0.45). */
  links?: number;
  /** Kinematic anchor path: pos = base + (ax, ay) · sin(2πt/period + phase). */
  move?: MoveDef;
}

export interface BumperDef {
  x: number;
  y: number;
  r: number;
}

export interface JetDef {
  /** Rect centre + half extents. */
  x: number;
  y: number;
  hw: number;
  hh: number;
  /** Acceleration imparted to bodies inside (m/s²). */
  fx: number;
  fy: number;
}

export interface LevelDef {
  candy: readonly [number, number];
  ropes: readonly RopeDef[];
  goal: readonly [number, number];
  sparks: readonly (readonly [number, number])[];
  bumpers?: readonly BumperDef[];
  jets?: readonly JetDef[];
}

const PI = Math.PI;

export const LEVELS: readonly LevelDef[] = [
  // ---- 1-3: learn the cut, learn the swing ----
  {
    // 1 — straight drop through three sparks
    candy: [5, 9.5],
    ropes: [{ x: 5, y: 13, links: 8 }],
    goal: [5, 3.2],
    sparks: [[5, 8.0], [5, 6.4], [5, 4.8]],
  },
  {
    // 2 — candy starts offset: it swings; cut on the way right
    candy: [2.9, 10.9],
    ropes: [{ x: 5, y: 13 }],
    goal: [7.0, 3.4],
    sparks: [[4.9, 9.7], [6.3, 7.4], [7.0, 5.2]],
  },
  {
    // 3 — bigger pendulum, farther goal
    candy: [1.5, 11.5],
    ropes: [{ x: 3.6, y: 12.9 }],
    goal: [7.6, 3.2],
    sparks: [[3.7, 10.3], [5.6, 7.6], [7.0, 4.8]],
  },
  // ---- 4-8: multi-rope timing ----
  {
    // 4 — V-hold: cut left, swing on the right rope, release
    candy: [5, 10.4],
    ropes: [{ x: 2.5, y: 12.6 }, { x: 7.5, y: 12.6 }],
    goal: [8.5, 4.0],
    sparks: [[6.4, 9.6], [7.9, 8.0], [8.5, 5.8]],
  },
  {
    // 5 — V-slot: slice both near the candy for a clean drop
    candy: [5, 10.8],
    ropes: [{ x: 3, y: 12.5 }, { x: 7, y: 12.5 }],
    goal: [5, 3.0],
    sparks: [[5, 9.2], [5, 6.8], [5, 4.7]],
  },
  {
    // 6 — staggered anchors: order matters
    candy: [4.2, 10.0],
    ropes: [{ x: 2.2, y: 13.0 }, { x: 6.6, y: 12.0 }],
    goal: [8.6, 3.4],
    sparks: [[5.9, 8.7], [7.4, 6.5], [8.3, 4.8]],
  },
  {
    // 7 — triple hold, straight drop with side sparks for the greedy
    candy: [5, 10.2],
    ropes: [{ x: 2, y: 12.4 }, { x: 5, y: 13.2 }, { x: 8, y: 12.4 }],
    goal: [5, 3.0],
    sparks: [[3.4, 8.4], [6.6, 8.4], [5, 4.8]],
  },
  {
    // 8 — tether launch: cut the left tether, ride the long rope left
    candy: [5.2, 9.6],
    ropes: [{ x: 7.8, y: 13.4 }, { x: 2.4, y: 12.8 }],
    goal: [2.2, 4.0],
    sparks: [[7.2, 8.3], [4.6, 7.6], [2.8, 5.6]],
  },
  // ---- 9-14: moving anchors ----
  {
    // 9 — the anchor sways and pumps the swing for you
    candy: [5, 9.6],
    ropes: [{ x: 5, y: 12.8, move: { ax: 2.2, ay: 0, period: 3.0 } }],
    goal: [8.0, 3.6],
    sparks: [[3.4, 8.8], [6.6, 8.8], [7.8, 5.4]],
  },
  {
    // 10 — bobber: vertical mover, release at the drop
    candy: [3, 8.8],
    ropes: [{ x: 3, y: 11.8, move: { ax: 0, ay: 1.3, period: 2.4 } }],
    goal: [3.2, 2.8],
    sparks: [[3, 7.2], [3.1, 5.5], [3.2, 4.0]],
  },
  {
    // 11 — one still rope, one swinging carrier
    candy: [5, 10.5],
    ropes: [{ x: 2.4, y: 12.6 }, { x: 7.6, y: 12.6, move: { ax: 1.6, ay: 0, period: 2.8 } }],
    goal: [8.7, 4.4],
    sparks: [[6.7, 9.4], [8.1, 7.6], [8.6, 5.9]],
  },
  {
    // 12 — wide sweep, elevated goal: release on the up-swing
    candy: [5, 9.8],
    ropes: [{ x: 5, y: 13.0, move: { ax: 3.2, ay: 0, period: 4.0 } }],
    goal: [8.4, 6.2],
    sparks: [[2.6, 9.0], [7.4, 9.0], [8.3, 7.5]],
  },
  {
    // 13 — antiphase pair: ropes trade the load, watch the tension colour
    candy: [5, 10.6],
    ropes: [
      { x: 3, y: 12.5, move: { ax: 1.2, ay: 0, period: 3.0 } },
      { x: 7, y: 12.5, move: { ax: 1.2, ay: 0, period: 3.0, phase: PI } },
    ],
    goal: [5, 3.2],
    sparks: [[4, 8.8], [6, 8.8], [5, 5.0]],
  },
  {
    // 14 — bobbing tether + static swing out to the right
    candy: [4.6, 10.0],
    ropes: [{ x: 2.6, y: 12.2, move: { ax: 0, ay: 1.2, period: 2.2 } }, { x: 7.0, y: 13.0 }],
    goal: [8.8, 3.8],
    sparks: [[5.9, 8.4], [7.5, 6.5], [8.5, 5.0]],
  },
  // ---- 15-19: bumper banks ----
  {
    // 15 — first bumper: drop onto its shoulder, deflect right
    candy: [3, 9.6],
    ropes: [{ x: 3, y: 13 }],
    goal: [6.6, 3.2],
    sparks: [[3, 7.8], [4.6, 6.3], [5.8, 4.6]],
    bumpers: [{ x: 2.55, y: 6.1, r: 0.8 }],
  },
  {
    // 16 — bumper pair playground
    candy: [5, 9.9],
    ropes: [{ x: 5, y: 13.2 }],
    goal: [8.6, 2.8],
    sparks: [[5, 8.1], [6.1, 5.8], [7.9, 4.1]],
    bumpers: [{ x: 4.3, y: 6.4, r: 0.7 }, { x: 7.1, y: 4.9, r: 0.7 }],
  },
  {
    // 17 — swing into a bumper hop
    candy: [4.6, 10.4],
    ropes: [{ x: 2.4, y: 12.8 }],
    goal: [8.8, 3.2],
    sparks: [[2.7, 9.4], [5.8, 8.6], [8.1, 5.3]],
    bumpers: [{ x: 7.0, y: 7.7, r: 0.85 }],
  },
  {
    // 18 — zigzag shaft: two glancing bounces down to the mouth
    candy: [8, 10.1],
    ropes: [{ x: 8, y: 13.2 }],
    goal: [7.9, 2.4],
    sparks: [[8, 8.7], [7.7, 6.4], [8.4, 3.9]],
    bumpers: [{ x: 7.2, y: 7.6, r: 0.7 }, { x: 8.9, y: 5.1, r: 0.7 }],
  },
  {
    // 19 — swing left, bounce back, land centre
    candy: [4.2, 10.6],
    ropes: [{ x: 2.2, y: 12.6 }, { x: 6.4, y: 13.0 }],
    goal: [5.4, 2.8],
    sparks: [[6.1, 9.2], [2.5, 7.7], [4.3, 4.4]],
    bumpers: [{ x: 1.9, y: 6.5, r: 0.75 }],
  },
  // ---- 20-24: air jets (and everything together) ----
  {
    // 20 — crosswind carries the falling candy right
    candy: [3.4, 9.8],
    ropes: [{ x: 3.4, y: 13 }],
    goal: [7.9, 3.8],
    sparks: [[3.4, 7.9], [5.2, 5.6], [6.8, 4.6]],
    jets: [{ x: 5.0, y: 4.6, hw: 2.3, hh: 2.6, fx: 8, fy: 2 }],
  },
  {
    // 21 — updraft arc: fall in, get lofted up-left to a high goal
    candy: [7.4, 9.6],
    ropes: [{ x: 7.4, y: 13 }],
    goal: [2.8, 7.4],
    sparks: [[7.4, 7.5], [5.3, 6.3], [3.8, 7.0]],
    jets: [{ x: 6.8, y: 4.6, hw: 1.3, hh: 2.3, fx: -9, fy: 16 }],
  },
  {
    // 22 — swing through the wind band, let it fling you right
    candy: [5, 9.8],
    ropes: [{ x: 5, y: 12.8, move: { ax: 2.0, ay: 0, period: 3.2 } }],
    goal: [8.8, 3.0],
    sparks: [[7.2, 8.3], [8.4, 6.1], [8.7, 4.3]],
    jets: [{ x: 5.4, y: 8.1, hw: 3.0, hh: 0.9, fx: 10, fy: 0 }],
  },
  {
    // 23 — three forces: bumper centre, jet in the left well, high goal
    candy: [5, 10.8],
    ropes: [{ x: 2.2, y: 13 }, { x: 7.8, y: 13 }],
    goal: [8.5, 6.0],
    sparks: [[3.2, 8.8], [2.4, 4.8], [6.9, 7.3]],
    bumpers: [{ x: 5.4, y: 6.3, r: 0.7 }],
    jets: [{ x: 2.6, y: 4.0, hw: 1.6, hh: 1.6, fx: 8, fy: 14 }],
  },
  {
    // 24 — the fountain finale: drop everything into the updraft,
    //      ride it back up into the floating mouth
    candy: [5, 10.6],
    ropes: [
      { x: 1.8, y: 12.6 },
      { x: 5, y: 13.4, move: { ax: 1.8, ay: 0, period: 2.6 } },
      { x: 8.2, y: 12.6 },
    ],
    goal: [5, 6.6],
    sparks: [[3.0, 9.0], [7.0, 9.0], [5, 4.3]],
    bumpers: [{ x: 2.6, y: 5.6, r: 0.65 }, { x: 7.4, y: 5.6, r: 0.65 }],
    jets: [{ x: 5, y: 3.3, hw: 1.2, hh: 1.5, fx: 0, fy: 21 }],
  },
];

export const LEVEL_COUNT = LEVELS.length;
