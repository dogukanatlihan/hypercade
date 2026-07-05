// Landing — the library grid. Every game reachable in ≤2 taps, forever.
// The grid renders and is clickable with ZERO WebGL (Tier 0). After first paint
// + idle, THE FIELD (M6) lazily enhances the background on capable devices —
// progressive enhancement only; the grid never waits on it (HOME-SCREEN §2).

import { GAMES } from '@shared/registry';
import type { GameId } from '@shared/types';
import type { Page } from '../router';
import { progress } from '../progress';
import { settings } from '@sdk/settings';
import type { FieldHandle } from '../home3d';

const HUES: Record<string, string> = {
  flap: '#ffb454',
  stack: '#ff5d5d',
  'merge-drop': '#c77dff',
  sling: '#ff8b3d',
  helix: '#3fd8d4',
  bricks: '#55d6ff',
  hole: '#8bd450',
  plinko: '#ffd75e',
  knock: '#ff7a9e',
  rope: '#f78c6b',
  draw: '#b287ff',
  swerve: '#64f0c8',
};

/** Perceived luminance of a #rrggbb color, 0..1 — picks additive vs normal blend. */
function isLight(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return false;
  const n = parseInt(m[1]!, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5;
}

export const libraryPage: Page = (root, ctx) => {
  const meta = settings.get().metaEnabled;
  const page = document.createElement('div');
  page.className = 'page';
  page.innerHTML = `
    <div class="hero">
      <h1>Twelve mechanics.<br /><em>Real physics.</em></h1>
      <p>A playable museum of hyper-casual game design — every genre-defining mechanic, perfected, running on Box2D&nbsp;v3 and Box3D compiled to WebAssembly.</p>
    </div>
    <div class="grid"></div>
    <a class="city-core-tease" data-link href="/journey" aria-label="City Core">
      <span class="cc-glyph">★ ${meta ? progress.totalStars() : 0}/36</span>
    </a>
  `;
  const grid = page.querySelector<HTMLElement>('.grid')!;
  const hero = page.querySelector<HTMLElement>('.hero')!;
  const sentinel = page.querySelector<HTMLElement>('.city-core-tease')!;
  if (!meta) sentinel.setAttribute('hidden', '');

  for (const game of GAMES) {
    const stars = progress.starsForGame(game.id);
    const best = progress.bestFor(game.id);
    const card = document.createElement('a');
    card.className = 'card';
    card.href = `/play/${game.id}`;
    card.setAttribute('data-link', '');
    card.dataset['game'] = game.id;
    card.style.setProperty('--card-hue', HUES[game.id] ?? 'var(--c-primary)');
    card.innerHTML = `
      <span class="engine">${game.engine === '2d' ? 'BOX2D V3' : 'BOX3D'} · ${game.family.toUpperCase()}</span>
      <h3>${game.title}</h3>
      <span class="tagline">${game.tagline}</span>
      <span class="chips">
        ${meta ? `<span class="stars">${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}</span>` : ''}
        ${best > 0 ? `<span>best ${Math.floor(best)}</span>` : '<span>play →</span>'}
      </span>
    `;
    grid.appendChild(card);
  }

  root.appendChild(page);

  // ------------------------------------------------------------------------
  // Progressive enhancement: mount THE FIELD after first paint + idle. Nothing
  // below runs on Tier 0 / reduced-motion; the grid above already works.
  // ------------------------------------------------------------------------
  let field: FieldHandle | null = null;
  let disposed = false;
  let tier = 0;
  const cards = Array.from(grid.querySelectorAll<HTMLElement>('.card'));

  const pickTargets: Array<{ el: HTMLElement; sig: GameId | 'city-core' | null }> = [
    { el: hero, sig: null },
    ...cards.map((el) => ({ el, sig: (el.dataset['game'] as GameId) })),
    { el: sentinel, sig: 'city-core' as const },
  ];

  let pickScheduled = false;
  const pick = (): void => {
    pickScheduled = false;
    if (!field) return;
    const vpCenter = window.innerHeight / 2;
    let best: (typeof pickTargets)[number] | null = null;
    let bestDist = Infinity;
    for (const item of pickTargets) {
      if (item.el.hasAttribute('hidden')) continue;
      const r = item.el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) continue;
      const d = Math.abs(r.top + r.height / 2 - vpCenter);
      if (d < bestDist) {
        bestDist = d;
        best = item;
      }
    }
    if (best) field.setActiveSignature(best.sig);
  };
  const schedulePick = (): void => {
    if (pickScheduled) return;
    pickScheduled = true;
    requestAnimationFrame(pick);
  };

  let lastY = window.scrollY;
  let lastT = performance.now();
  const onScroll = (): void => {
    const now = performance.now();
    const y = window.scrollY;
    const dt = Math.max(now - lastT, 1);
    const vel = ((y - lastY) / dt) * 16; // px per ~frame
    lastY = y;
    lastT = now;
    field?.setScroll(y, vel);
    schedulePick();
  };

  let observer: IntersectionObserver | null = null;

  // Click → dissolve-through (Tier 2 only). Capture phase so the router's own
  // document-level data-link handler never fires; we navigate after the veil.
  const onGridClick = (e: MouseEvent): void => {
    if (!field || tier !== 2 || settings.get().reducedMotion) return; // let normal nav proceed
    const a = (e.target as HTMLElement).closest('a.card');
    if (!(a instanceof HTMLAnchorElement)) return;
    const id = a.dataset['game'] as GameId | undefined;
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    void import('../../games/index').then((m) => m.GAME_LOADERS[id]?.()).catch(() => {});
    const path = a.pathname;
    field.transitionOut(HUES[id] ?? '#ffffff', () => ctx.navigate(path));
  };
  grid.addEventListener('click', onGridClick, true);

  const enhance = async (): Promise<void> => {
    try {
      const { detectCapability } = await import('../home3d/tiers');
      if (disposed) return;
      const cap = detectCapability(settings.get().reducedMotion);
      tier = cap.tier;
      if (cap.tier === 0) return; // Tier 0 stays DOM-only — no canvas at all
      const { mountField } = await import('../home3d');
      if (disposed) return;

      const cssBg = getComputedStyle(document.documentElement).getPropertyValue('--c-bg') || '#0c0a12';
      field = mountField(page, {
        tier: cap.tier,
        halfFloat: cap.halfFloat,
        bgColor: cssBg.trim(),
        additive: !isLight(cssBg),
        hueFor: (id) => HUES[id] ?? '#ffffff',
        starWeightFor: (id) => (settings.get().metaEnabled ? progress.starsForGame(id) / 3 : 0),
      });
      document.body.classList.add('field-on');

      observer = new IntersectionObserver(() => schedulePick(), {
        rootMargin: '-20% 0px -20% 0px',
        threshold: [0, 0.5, 1],
      });
      for (const t of pickTargets) observer.observe(t.el);

      window.addEventListener('scroll', onScroll, { passive: true });
      schedulePick();
    } catch (err) {
      // Field is decoration — never let it break the landing page.
      console.error('[field] enhance failed', err);
    }
  };

  const useIdle = typeof window.requestIdleCallback === 'function';
  const idleId: number = useIdle
    ? window.requestIdleCallback(() => void enhance(), { timeout: 2500 })
    : window.setTimeout(() => void enhance(), 400);

  return () => {
    disposed = true;
    if (useIdle && typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(idleId);
    } else {
      clearTimeout(idleId);
    }
    grid.removeEventListener('click', onGridClick, true);
    window.removeEventListener('scroll', onScroll);
    observer?.disconnect();
    field?.dispose();
    field = null;
    document.body.classList.remove('field-on');
  };
};
