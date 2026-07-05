// Runtime-generated formations (HOME-SCREEN §6). No asset downloads: the
// wordmark is rasterized to an offscreen canvas and sampled to points; the City
// Core braid is parametric. Everything returns a Float32Array laid out RGBA per
// particle (xyz + w), sized to the GPGPU state texture. w=1 means "has a target"
// so the sim can pull toward it; w=0 means "drift".

/** Shared field half-extents. sim, render and formations must agree. */
export const FIELD = { x: 26, y: 34, z: 14 } as const;

/** Deterministic PRNG so the field looks the same on every load. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface InitialState {
  pos: Float32Array; // xyz + per-particle seed in w
  vel: Float32Array; // xyz + 0
}

/** Diffuse starting cloud filling the field box, with a stable per-particle seed. */
export function initialState(count: number): InitialState {
  const pos = new Float32Array(count * 4);
  const vel = new Float32Array(count * 4);
  const rnd = mulberry32(0x9e3779b1);
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    pos[o] = (rnd() * 2 - 1) * FIELD.x;
    pos[o + 1] = (rnd() * 2 - 1) * FIELD.y;
    pos[o + 2] = (rnd() * 2 - 1) * FIELD.z;
    pos[o + 3] = rnd(); // seed, read as the `seed` term in signature shaders
    vel[o] = 0;
    vel[o + 1] = 0;
    vel[o + 2] = 0;
    vel[o + 3] = 0;
  }
  return { pos, vel };
}

/**
 * Rasterize `text` to an offscreen canvas and sample opaque pixels into `count`
 * world-space target points. Falls back to a flat band if 2D canvas is
 * unavailable (never throws — the field just skips the wordmark).
 */
export function wordmarkTargets(count: number, text: string): Float32Array {
  const out = new Float32Array(count * 4);
  const W = 640;
  const H = 160;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');
  const rnd = mulberry32(0x1234abcd);

  if (!g) {
    for (let i = 0; i < count; i++) {
      const o = i * 4;
      out[o] = (rnd() * 2 - 1) * FIELD.x * 0.8;
      out[o + 1] = (rnd() * 2 - 1) * 6;
      out[o + 2] = (rnd() * 2 - 1) * 2;
      out[o + 3] = 1;
    }
    return out;
  }

  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = '900 112px ui-rounded, system-ui, sans-serif';
  g.fillText(text, W / 2, H / 2 + 4);

  const data = g.getImageData(0, 0, W, H).data;
  const pts: number[] = [];
  // Sample on a stride so we don't collect every pixel — plenty of coverage.
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      if ((data[(y * W + x) * 4] ?? 0) > 128) pts.push(x, y);
    }
  }

  const n = pts.length / 2;
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    if (n === 0) {
      out[o] = (rnd() * 2 - 1) * FIELD.x * 0.8;
      out[o + 1] = (rnd() * 2 - 1) * 6;
      out[o + 2] = 0;
      out[o + 3] = 1;
      continue;
    }
    const k = Math.floor(rnd() * n) * 2;
    const px = pts[k] ?? W / 2;
    const py = pts[k + 1] ?? H / 2;
    out[o] = ((px / W) * 2 - 1) * FIELD.x * 0.86;
    out[o + 1] = -((py / H) * 2 - 1) * 9;
    out[o + 2] = (rnd() * 2 - 1) * 1.6;
    out[o + 3] = 1;
  }
  return out;
}

/**
 * City Core braid (HOME-SCREEN §4): several strands wind together and converge
 * toward a glowing point low in the field — the ★ n/36 tease.
 */
export function braidTargets(count: number): Float32Array {
  const out = new Float32Array(count * 4);
  const strands = 6;
  const rnd = mulberry32(0x0badf00d);
  const coreY = -FIELD.y * 0.55;
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    const strand = i % strands;
    const u = (Math.floor(i / strands) / (count / strands)) % 1; // 0 top → 1 core
    const angle = u * Math.PI * 5 + (strand / strands) * Math.PI * 2 + rnd() * 0.15;
    const radius = (1 - u) * 9 + 0.4; // converge as it descends
    out[o] = Math.cos(angle) * radius * (1 - u * 0.7);
    out[o + 1] = FIELD.y * 0.7 - u * (FIELD.y * 0.7 - coreY);
    out[o + 2] = Math.sin(angle) * radius * (1 - u * 0.7);
    out[o + 3] = 1;
  }
  return out;
}
