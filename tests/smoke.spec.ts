// Per-game smoke gate (TECH-BRIEF §9): route loads, canvas paints, ~10s of
// scripted input, the run can end or keep simulating, restart works, and the
// console stays clean. Runs against the Vite dev server.

import { test, expect, type Page } from '@playwright/test';
import { GAMES } from '../shared/registry';

const INPUT_SCRIPTS: Record<string, (page: Page) => Promise<void>> = {};

async function tapCenter(page: Page, times: number, intervalMs: number): Promise<void> {
  const canvas = page.locator('.game-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('no canvas box');
  for (let i = 0; i < times; i++) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.55);
    await page.waitForTimeout(intervalMs);
  }
}

async function dragAround(page: Page, times: number): Promise<void> {
  const canvas = page.locator('.game-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('no canvas box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  for (let i = 0; i < times; i++) {
    const dx = (i % 2 === 0 ? 1 : -1) * box.width * 0.3;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + dx, cy + (i % 3 === 0 ? -60 : 40), { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(700);
  }
}

for (const game of GAMES) {
  test(`${game.id} smoke`, async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !msg.text().includes('favicon')) errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(String(err)));

    await page.goto(`/play/${game.id}`);
    const start = page.locator('.start-btn');
    await expect(start).toBeVisible({ timeout: 30_000 });
    await start.click();

    // canvas paints
    const canvas = page.locator('.game-canvas');
    await expect(canvas).toBeVisible();
    await page.waitForTimeout(600);
    const painted = await page.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>('.game-canvas');
      if (!c) return false;
      // 3D contexts can't be re-read; a non-zero size + no throw is enough there
      try {
        const g = c.getContext('2d');
        if (!g) return c.width > 0;
        // sample three patches — games legitimately leave parts of the frame empty
        const patches: [number, number][] = [
          [c.width / 2 - 25, c.height / 2 - 25],
          [c.width / 2 - 25, c.height - 60],
          [10, c.height / 2 - 25],
          [c.width * 0.3 - 25, c.height * 0.6 - 25],
        ];
        return patches.some(([x, y]) => {
          const d = g.getImageData(Math.max(0, x), Math.max(0, y), 50, 50).data;
          return d.some((v) => v !== 0);
        });
      } catch {
        return c.width > 0;
      }
    });
    expect(painted).toBe(true);

    // ~10s of scripted input (both verbs; games ignore what they don't use)
    const script = INPUT_SCRIPTS[game.id];
    if (script) await script(page);
    else {
      await tapCenter(page, 6, 350);
      await dragAround(page, 5);
      await tapCenter(page, 6, 350);
    }

    // either the run ended (overlay) or the sim is still healthy — both fine
    const ended = await page.locator('.play-stage > .overlay:not(.start-overlay)').isVisible();
    if (ended) {
      // restart path must work without reload
      await page.keyboard.press('KeyR');
      await page.waitForTimeout(400);
      await expect(page.locator('.play-stage > .overlay:not(.start-overlay)')).toBeHidden();
    }

    expect(errors, `console errors in ${game.id}:\n${errors.join('\n')}`).toHaveLength(0);
  });
}

test('library grid lists all 12 games', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.card')).toHaveCount(12);
});

test('settings toggles persist', async ({ page }) => {
  await page.goto('/settings');
  await page.locator('[data-toggle="reducedMotion"]').click();
  await page.reload();
  const on = await page.locator('[data-toggle="reducedMotion"]').getAttribute('aria-checked');
  expect(on).toBe('true');
});
