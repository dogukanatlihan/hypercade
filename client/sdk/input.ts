// Unified input — tap / drag / swipe / keys with mouse-keyboard parity.
// Coordinates are canvas-local CSS pixels.

export interface DragEvent {
  x: number;
  y: number;
  dx: number; // delta since last move
  dy: number;
  totalX: number; // delta since drag start
  totalY: number;
  prevX: number;
  prevY: number;
}

export interface ReleaseEvent {
  x: number;
  y: number;
  vx: number; // px/s release velocity (flicks)
  vy: number;
  totalX: number;
  totalY: number;
  durationMs: number;
}

interface Handlers {
  action: Set<() => void>; // tap OR Space/Enter — the universal one-touch verb
  actionDown: Set<() => void>; // pointerdown OR Space/Enter — zero-latency verb for one-touch games
  tap: Set<(x: number, y: number) => void>;
  down: Set<(x: number, y: number) => void>;
  drag: Set<(e: DragEvent) => void>;
  release: Set<(e: ReleaseEvent) => void>;
  key: Set<(code: string, down: boolean) => void>;
}

const TAP_MS = 250;
const TAP_SLOP = 12;

export class Input {
  readonly keys = new Set<string>();
  pointerDown = false;
  /** 'mouse' | 'touch' | 'pen' — last pointer seen; games can scale sensitivities. */
  pointerType = 'mouse';
  x = 0;
  y = 0;

  private handlers: Handlers = { action: new Set(), actionDown: new Set(), tap: new Set(), down: new Set(), drag: new Set(), release: new Set(), key: new Set() };
  private startX = 0;
  private startY = 0;
  private startT = 0;
  private lastX = 0;
  private lastY = 0;
  private lastT = 0;
  private vx = 0;
  private vy = 0;
  private detach: (() => void)[] = [];

  constructor(private readonly el: HTMLElement) {
    const opts = { passive: false } as const;

    const toLocal = (e: PointerEvent): [number, number] => {
      const r = this.el.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };

    const onDown = (e: PointerEvent): void => {
      e.preventDefault();
      try {
        this.el.setPointerCapture?.(e.pointerId);
      } catch {
        // synthetic events (tests) carry pointerIds the browser doesn't know
      }
      const [x, y] = toLocal(e);
      if (e.pointerType) this.pointerType = e.pointerType;
      this.pointerDown = true;
      this.x = this.lastX = this.startX = x;
      this.y = this.lastY = this.startY = y;
      this.startT = this.lastT = performance.now();
      this.vx = this.vy = 0;
      this.handlers.down.forEach((h) => h(x, y));
      this.handlers.actionDown.forEach((h) => h());
    };

    const onMove = (e: PointerEvent): void => {
      if (!this.pointerDown) {
        const [px, py] = toLocal(e);
        this.x = px;
        this.y = py;
        return;
      }
      e.preventDefault();
      const [x, y] = toLocal(e);
      const now = performance.now();
      const dt = Math.max(now - this.lastT, 1) / 1000;
      // exponential smoothing keeps flick velocity stable across jittery events
      this.vx = 0.6 * ((x - this.lastX) / dt) + 0.4 * this.vx;
      this.vy = 0.6 * ((y - this.lastY) / dt) + 0.4 * this.vy;
      const ev: DragEvent = { x, y, dx: x - this.lastX, dy: y - this.lastY, totalX: x - this.startX, totalY: y - this.startY, prevX: this.lastX, prevY: this.lastY };
      this.lastX = x;
      this.lastY = y;
      this.lastT = now;
      this.x = x;
      this.y = y;
      this.handlers.drag.forEach((h) => h(ev));
    };

    const onUp = (e: PointerEvent): void => {
      if (!this.pointerDown) return;
      e.preventDefault();
      this.pointerDown = false;
      const [x, y] = toLocal(e);
      const durationMs = performance.now() - this.startT;
      const totalX = x - this.startX;
      const totalY = y - this.startY;
      if (durationMs < TAP_MS && Math.hypot(totalX, totalY) < TAP_SLOP) {
        this.handlers.tap.forEach((h) => h(x, y));
        this.handlers.action.forEach((h) => h());
      }
      const ev: ReleaseEvent = { x, y, vx: this.vx, vy: this.vy, totalX, totalY, durationMs };
      this.handlers.release.forEach((h) => h(ev));
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.handlers.key.forEach((h) => h(e.code, true));
      if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        this.handlers.action.forEach((h) => h());
        this.handlers.actionDown.forEach((h) => h());
      }
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      this.keys.delete(e.code);
      this.handlers.key.forEach((h) => h(e.code, false));
    };

    el.addEventListener('pointerdown', onDown, opts);
    el.addEventListener('pointermove', onMove, opts);
    el.addEventListener('pointerup', onUp, opts);
    el.addEventListener('pointercancel', onUp, opts);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    this.detach.push(
      () => el.removeEventListener('pointerdown', onDown),
      () => el.removeEventListener('pointermove', onMove),
      () => el.removeEventListener('pointerup', onUp),
      () => el.removeEventListener('pointercancel', onUp),
      () => window.removeEventListener('keydown', onKeyDown),
      () => window.removeEventListener('keyup', onKeyUp),
    );
  }

  /** Universal one-touch verb: tap, click, Space, Enter. Fires on tap-UP (qualified). */
  onAction(h: () => void): () => void {
    this.handlers.action.add(h);
    return () => this.handlers.action.delete(h);
  }

  /** Zero-latency one-touch verb: fires on pointerDOWN (any press) or Space/Enter.
   *  Use for flap/drop games — frantic clicking must never be eaten by tap slop. */
  onActionDown(h: () => void): () => void {
    this.handlers.actionDown.add(h);
    return () => this.handlers.actionDown.delete(h);
  }

  onTap(h: (x: number, y: number) => void): () => void {
    this.handlers.tap.add(h);
    return () => this.handlers.tap.delete(h);
  }

  onDown(h: (x: number, y: number) => void): () => void {
    this.handlers.down.add(h);
    return () => this.handlers.down.delete(h);
  }

  onDrag(h: (e: DragEvent) => void): () => void {
    this.handlers.drag.add(h);
    return () => this.handlers.drag.delete(h);
  }

  onRelease(h: (e: ReleaseEvent) => void): () => void {
    this.handlers.release.add(h);
    return () => this.handlers.release.delete(h);
  }

  onKey(h: (code: string, down: boolean) => void): () => void {
    this.handlers.key.add(h);
    return () => this.handlers.key.delete(h);
  }

  /** Held lateral axis for steer games: A/D, arrows → -1..1. */
  axis(): number {
    let a = 0;
    if (this.keys.has('ArrowLeft') || this.keys.has('KeyA')) a -= 1;
    if (this.keys.has('ArrowRight') || this.keys.has('KeyD')) a += 1;
    return a;
  }

  clearHandlers(): void {
    this.handlers = { action: new Set(), actionDown: new Set(), tap: new Set(), down: new Set(), drag: new Set(), release: new Set(), key: new Set() };
  }

  dispose(): void {
    this.clearHandlers();
    this.detach.forEach((d) => d());
    this.detach = [];
  }
}
