// INKLINE visual-effect helpers — pure canvas drawing, no game state.

import type { WindZone } from './levels';

export interface Confetti {
  x: number;
  y: number;
  vx: number;
  vy: number;
  spin: number;
  life: number;
  ci: number;
}

export function hash01(n: number): number {
  const s = Math.sin(n) * 43758.5453;
  return s - Math.floor(s);
}

type ToScreen = (v: number) => number;

/** Tinted wind field + streak lines drifting along the force direction. */
export function drawWindZone(c: CanvasRenderingContext2D, z: WindZone, zi: number, simT: number, s: number, X: ToScreen, Y: ToScreen, glow: string): void {
  c.fillStyle = glow;
  c.globalAlpha = 0.07;
  c.fillRect(X(z.cx - z.hx), Y(z.cy + z.hy), z.hx * 2 * s, z.hy * 2 * s);
  const mag = Math.hypot(z.fx, z.fy) || 1;
  const dx = z.fx / mag;
  const dy = z.fy / mag;
  const span = Math.abs(dx) * z.hx * 2 + Math.abs(dy) * z.hy * 2;
  const n = Math.min(14, Math.ceil(z.hx * z.hy * 2) + 4);
  c.strokeStyle = glow;
  c.lineWidth = 1.5;
  for (let i = 0; i < n; i++) {
    const u = hash01(zi * 31.7 + i * 7.3);
    const v = hash01(zi * 17.9 + i * 13.1);
    const prog = (simT * 0.9 + u) % 1;
    const px = z.cx + -dy * (v - 0.5) * 2 * (Math.abs(dy) * z.hx + Math.abs(dx) * z.hx * 0.9) + dx * (prog - 0.5) * span;
    const py = z.cy + dx * (v - 0.5) * 2 * (Math.abs(dx) * z.hy + Math.abs(dy) * z.hy * 0.9) + dy * (prog - 0.5) * span;
    c.globalAlpha = Math.sin(prog * Math.PI) * 0.35;
    c.beginPath();
    c.moveTo(X(px), Y(py));
    c.lineTo(X(px + dx * 0.45), Y(py + dy * 0.45));
    c.stroke();
  }
  c.globalAlpha = 1;
}

/**
 * A ball with two eyes gazing along the (world-space) unit vector (ux, uy)
 * toward its partner; `closed` renders the blink frame.
 */
export function drawBallFace(c: CanvasRenderingContext2D, px: number, py: number, r: number, ux: number, uy: number, closed: boolean, fill: string, eyeColor: string, pupilColor: string): void {
  c.save();
  c.translate(px, py);
  c.fillStyle = fill;
  c.beginPath();
  c.arc(0, 0, r, 0, Math.PI * 2);
  c.fill();
  for (const side of [-1, 1]) {
    const ex = (ux * 0.34 + -uy * 0.3 * side) * r;
    const ey = -(uy * 0.34 + ux * 0.3 * side) * r;
    if (closed) {
      c.strokeStyle = eyeColor;
      c.lineWidth = Math.max(1.5, r * 0.08);
      c.beginPath();
      c.moveTo(ex - r * 0.16, ey);
      c.lineTo(ex + r * 0.16, ey);
      c.stroke();
    } else {
      c.fillStyle = eyeColor;
      c.beginPath();
      c.arc(ex, ey, r * 0.2, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = pupilColor;
      c.beginPath();
      c.arc(ex + ux * r * 0.08, ey - uy * r * 0.08, r * 0.09, 0, Math.PI * 2);
      c.fill();
    }
  }
  c.restore();
}

export function drawHeart(c: CanvasRenderingContext2D, x: number, y: number, size: number, color: string, alpha: number): void {
  c.save();
  c.translate(x, y);
  c.globalAlpha = alpha;
  c.fillStyle = color;
  c.beginPath();
  c.moveTo(0, size * 0.35);
  c.bezierCurveTo(-size, -size * 0.35, -size * 0.5, -size, 0, -size * 0.35);
  c.bezierCurveTo(size * 0.5, -size, size, -size * 0.35, 0, size * 0.35);
  c.fill();
  c.restore();
}
