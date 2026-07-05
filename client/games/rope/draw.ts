// SNIP — pure geometry + canvas drawing helpers (no game state).

import type { RopeDef, JetDef } from './levels';

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Squared distance between segments p1-p2 and q1-q2 (Ericson, RTCD §5.1.9). */
export function segSegDistSq(
  p1x: number, p1y: number, p2x: number, p2y: number,
  q1x: number, q1y: number, q2x: number, q2y: number,
): number {
  const d1x = p2x - p1x, d1y = p2y - p1y;
  const d2x = q2x - q1x, d2y = q2y - q1y;
  const rx = p1x - q1x, ry = p1y - q1y;
  const a = d1x * d1x + d1y * d1y;
  const e = d2x * d2x + d2y * d2y;
  const f = d2x * rx + d2y * ry;
  let s = 0;
  let t = 0;
  if (a <= 1e-9 && e <= 1e-9) {
    // both degenerate: point-point
  } else if (a <= 1e-9) {
    t = clamp(f / e, 0, 1);
  } else {
    const c = d1x * rx + d1y * ry;
    if (e <= 1e-9) {
      s = clamp(-c / a, 0, 1);
    } else {
      const b = d1x * d2x + d1y * d2y;
      const den = a * e - b * b;
      s = den > 1e-9 ? clamp((b * f - c * e) / den, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp(-c / a, 0, 1);
      } else if (t > 1) {
        t = 1;
        s = clamp((b - c) / a, 0, 1);
      }
    }
  }
  const cx = p1x + d1x * s - (q1x + d2x * t);
  const cy = p1y + d1y * s - (q1y + d2y * t);
  return cx * cx + cy * cy;
}

/** Anchor position at time `time` (kinematic movers follow a sine path). */
export function anchorPos(def: RopeDef, time: number): { x: number; y: number } {
  const m = def.move;
  if (!m) return { x: def.x, y: def.y };
  const k = Math.sin((Math.PI * 2 * time) / m.period + (m.phase ?? 0));
  return { x: def.x + m.ax * k, y: def.y + m.ay * k };
}

/** Four-point star outline used for spark pickups. */
export function starPath(c: CanvasRenderingContext2D, x: number, y: number, r: number, rot: number): void {
  c.beginPath();
  for (let i = 0; i < 8; i++) {
    const rr = i % 2 === 0 ? r : r * 0.45;
    const a = rot + (i * Math.PI) / 4;
    if (i === 0) c.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    else c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  c.closePath();
}

type Project = (n: number) => number;

/** Translucent force-field rect with chevrons drifting along the flow. */
export function drawJetField(
  c: CanvasRenderingContext2D,
  j: JetDef,
  accent: string,
  t: number,
  reduced: boolean,
  s: number,
  sx: Project,
  sy: Project,
): void {
  const jx = sx(j.x - j.hw);
  const jy = sy(j.y + j.hh);
  const jw = j.hw * 2 * s;
  const jh = j.hh * 2 * s;
  c.fillStyle = accent;
  c.globalAlpha = 0.07;
  c.fillRect(jx, jy, jw, jh);
  c.globalAlpha = 0.28;
  c.strokeStyle = accent;
  c.lineWidth = 1.5;
  c.setLineDash([6, 8]);
  c.strokeRect(jx, jy, jw, jh);
  c.setLineDash([]);
  const fl = Math.hypot(j.fx, j.fy) || 1;
  const dx = j.fx / fl;
  const dy = j.fy / fl;
  const extent = 2 * (Math.abs(dx) * j.hw + Math.abs(dy) * j.hh);
  const spacing = 0.9;
  const flow = reduced ? 0 : (t * 2.4) % spacing;
  c.strokeStyle = accent;
  c.lineWidth = 2;
  c.globalAlpha = 0.5;
  for (let lane = -1; lane <= 1; lane++) {
    const lx = j.x - dy * lane * Math.min(j.hw, j.hh) * 0.8;
    const ly = j.y + dx * lane * Math.min(j.hw, j.hh) * 0.8;
    for (let k = 0; k * spacing < extent; k++) {
      const along = -extent / 2 + k * spacing + flow;
      if (along > extent / 2) continue;
      const cxw = lx + dx * along;
      const cyw = ly + dy * along;
      if (Math.abs(cxw - j.x) > j.hw || Math.abs(cyw - j.y) > j.hh) continue;
      c.save();
      c.translate(sx(cxw), sy(cyw));
      c.rotate(Math.atan2(-dy, dx)); // screen-space flow angle
      c.beginPath();
      c.moveTo(-5, -5);
      c.lineTo(3, 0);
      c.lineTo(-5, 5);
      c.stroke();
      c.restore();
    }
  }
  c.globalAlpha = 1;
}

export interface MouthColors {
  surface: string;
  accent: string;
  bg: string;
  text: string;
}

/** Bumper disc with inner ring and a hit-flash halo (anim 0..1). */
export function drawBumper(c: CanvasRenderingContext2D, bx: number, by: number, br: number, anim: number, colors: MouthColors): void {
  c.fillStyle = colors.surface;
  c.beginPath();
  c.arc(bx, by, br, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = colors.accent;
  c.lineWidth = 3;
  c.stroke();
  c.globalAlpha = 0.35;
  c.beginPath();
  c.arc(bx, by, br * 0.55, 0, Math.PI * 2);
  c.stroke();
  if (anim > 0) {
    c.globalAlpha = anim * 0.7;
    c.lineWidth = 2 + anim * 3;
    c.beginPath();
    c.arc(bx, by, br * (1 + (1 - anim) * 0.35), 0, Math.PI * 2);
    c.stroke();
  }
  c.globalAlpha = 1;
}

export interface CandyColors {
  primary: string;
  glow: string;
  bg: string;
}

/** The candy: glossy disc with a little face. Caller passes screen pos/rot. */
export function drawCandy(c: CanvasRenderingContext2D, px: number, py: number, r: number, angle: number, colors: CandyColors): void {
  c.save();
  c.translate(px, py);
  c.rotate(-angle);
  c.fillStyle = colors.primary;
  c.beginPath();
  c.arc(0, 0, r, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = colors.glow;
  c.lineWidth = 2;
  c.globalAlpha = 0.8;
  c.stroke();
  c.globalAlpha = 0.5;
  c.fillStyle = '#ffffff';
  c.beginPath();
  c.arc(-r * 0.35, -r * 0.35, r * 0.28, 0, Math.PI * 2);
  c.fill();
  c.globalAlpha = 1;
  c.fillStyle = colors.bg;
  c.beginPath();
  c.arc(-r * 0.25, -r * 0.05, r * 0.11, 0, Math.PI * 2);
  c.arc(r * 0.25, -r * 0.05, r * 0.11, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = colors.bg;
  c.lineWidth = Math.max(r * 0.09, 1);
  c.beginPath();
  c.arc(0, r * 0.15, r * 0.32, 0.25, Math.PI - 0.25);
  c.stroke();
  c.restore();
}

/** The goal mouth: face plate, jaw (open 0..1), eyes. */
export function drawMouth(c: CanvasRenderingContext2D, gx: number, gy: number, R: number, open: number, colors: MouthColors): void {
  c.fillStyle = colors.surface;
  c.beginPath();
  c.arc(gx, gy, R, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = colors.accent;
  c.lineWidth = 3;
  c.stroke();
  c.fillStyle = colors.bg;
  c.beginPath();
  c.ellipse(gx, gy + R * 0.18, R * 0.62, Math.max(R * 0.62 * open, 1), 0, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = colors.text;
  c.beginPath();
  c.arc(gx - R * 0.34, gy - R * 0.42, Math.max(R * 0.09, 1.5), 0, Math.PI * 2);
  c.arc(gx + R * 0.34, gy - R * 0.42, Math.max(R * 0.09, 1.5), 0, Math.PI * 2);
  c.fill();
}
