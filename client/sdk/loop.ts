// GameRunner — owns the canvas, the fixed 60Hz accumulator loop with render
// interpolation, pause-on-blur, and the run lifecycle. Games only ever see
// step(1/60) and render(alpha) (TECH-BRIEF §4).

import type { RunStats } from '@shared/types';
import type { Game, GameContext, Palette } from './types';
import { Input } from './input';
import { audio } from './audio';
import { Rng, randomSeed } from './rng';
import { GameStorage } from './storage';
import { Hud } from './hud';
import { settings } from './settings';
import { Physics2D, loadBox2d } from './physics2d';
import { Physics3D, loadBox3d } from './physics3d';

const FIXED_DT = 1 / 60;
const MAX_FRAME = 0.1;

export type RunEndHandler = (stats: RunStats) => void;

function readPalette(): Palette {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string): string => s.getPropertyValue(name).trim();
  return {
    bg: v('--c-bg'),
    surface: v('--c-surface'),
    primary: v('--c-primary'),
    accent: v('--c-accent'),
    danger: v('--c-danger'),
    text: v('--c-text'),
    glow: v('--c-glow'),
  };
}

export class GameRunner {
  readonly canvas: HTMLCanvasElement;
  private readonly input: Input;
  private readonly hud: Hud;
  private readonly rng = new Rng(1);
  private game: Game | null = null;
  private ctx: GameContext | null = null;
  private raf = 0;
  private accumulator = 0;
  private lastTime = 0;
  private running = false; // stepping enabled (false in menus / after run end)
  private mounted = false;
  private runStart = 0;
  private seed = 0;
  private paletteCache: Palette | null = null;
  private resizeHandlers: ((w: number, h: number) => void)[] = [];
  private onRunEnd: RunEndHandler | null = null;
  private resizeObserver: ResizeObserver;
  private onVisibility = (): void => {
    if (document.hidden) {
      this.pause();
    } else {
      this.lastTime = performance.now();
      audio.resume();
    }
  };

  constructor(private readonly container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'game-canvas';
    container.appendChild(this.canvas);
    this.input = new Input(this.canvas);
    this.hud = new Hud(container);
    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    document.addEventListener('visibilitychange', this.onVisibility);
    settings.changed.on('change', () => {
      this.paletteCache = null;
    });
  }

  get width(): number {
    return this.container.clientWidth;
  }

  get height(): number {
    return this.container.clientHeight;
  }

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    if (this.ctx) {
      this.ctx.width = w;
      this.ctx.height = h;
      this.ctx.dpr = dpr;
    }
    this.resizeHandlers.forEach((fn) => fn(w, h));
  }

  async mount(game: Game, onRunEnd: RunEndHandler): Promise<void> {
    this.game = game;
    this.onRunEnd = onRunEnd;
    this.hud.bind(game.meta.id);

    const runner = this;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.ctx = {
      canvas: this.canvas,
      width: this.width,
      height: this.height,
      dpr,
      physics2d: async (): Promise<Physics2D> => {
        const mod = await loadBox2d();
        return new Physics2D(mod as never, [0, -10]);
      },
      physics3d: async (): Promise<Physics3D> => {
        const mod = await loadBox3d();
        return new Physics3D(mod as never, [0, -10, 0]);
      },
      input: this.input,
      audio,
      rng: this.rng,
      storage: new GameStorage(game.meta.id),
      hud: this.hud,
      settings: () => settings.get(),
      colors: (): Palette => {
        if (!runner.paletteCache) runner.paletteCache = readPalette();
        return runner.paletteCache;
      },
      endRun: (stats: RunStats) => this.handleRunEnd(stats),
      onResize: (handler) => this.resizeHandlers.push(handler),
    };

    await game.init(this.ctx);
    this.mounted = true;
    this.lastTime = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  /** (Re)start a run — restart must be < 1s, no reload (MECHANICS §14). */
  start(seed = randomSeed()): void {
    if (!this.game) return;
    this.seed = seed;
    this.rng.reseed(seed);
    this.hud.bind(this.game.meta.id);
    this.game.start(seed);
    this.running = true;
    this.runStart = performance.now();
    this.accumulator = 0;
    this.lastTime = performance.now();
    audio.resume();
  }

  pause(): void {
    this.running = false;
    audio.suspend();
  }

  resume(): void {
    if (!this.game) return;
    this.running = true;
    this.lastTime = performance.now();
    audio.resume();
  }

  get isRunning(): boolean {
    return this.running;
  }

  private handleRunEnd(stats: RunStats): void {
    this.running = false;
    const full: RunStats = { ...stats, durationMs: Math.round(performance.now() - this.runStart), seed: this.seed };
    this.onRunEnd?.(full);
  }

  private frame = (now: number): void => {
    if (!this.mounted) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min((now - this.lastTime) / 1000, MAX_FRAME);
    this.lastTime = now;

    if (this.running && this.game && !document.hidden) {
      this.accumulator += dt;
      while (this.accumulator >= FIXED_DT) {
        this.game.step(FIXED_DT);
        this.accumulator -= FIXED_DT;
        if (!this.running) break; // run ended mid-step
      }
    }
    this.game?.render(this.running ? this.accumulator / FIXED_DT : 1);
  };

  dispose(): void {
    this.mounted = false;
    cancelAnimationFrame(this.raf);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.resizeObserver.disconnect();
    this.game?.dispose();
    this.game = null;
    this.input.dispose();
    this.hud.dispose();
    this.canvas.remove();
    this.resizeHandlers = [];
  }
}
