// merge-drop — placeholder until M2. Replaced by the real implementation.
import type { Game, GameContext } from '@sdk/types';
import { gameMeta } from '@shared/registry';

export function createGame(): Game {
  const meta = gameMeta('merge-drop')!;
  let ctx: GameContext;
  let detach: (() => void) | null = null;
  let t = 0;
  return {
    meta,
    async init(context: GameContext): Promise<void> {
      ctx = context;
      detach = ctx.input.onAction(() => ctx.endRun({ score: 0, durationMs: 0, seed: 0, stats: {} }));
    },
    start(): void {
      ctx.hud.setScore(0);
      ctx.hud.setSub('under construction — tap to exit');
    },
    step(dt: number): void {
      t += dt;
    },
    render(): void {
      const c = ctx.canvas.getContext('2d');
      if (!c) return;
      c.setTransform(ctx.dpr, 0, 0, ctx.dpr, 0, 0);
      c.clearRect(0, 0, ctx.width, ctx.height);
      c.fillStyle = ctx.colors().surface;
      c.fillRect(0, 0, ctx.width, ctx.height);
      c.fillStyle = ctx.colors().text;
      c.font = '900 28px system-ui';
      c.textAlign = 'center';
      c.fillText(meta.title, ctx.width / 2, ctx.height / 2 + Math.sin(t * 2) * 6);
    },
    dispose(): void {
      detach?.();
    },
  };
}
