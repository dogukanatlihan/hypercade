// Home — the master library (M7 neon-arcade redesign). Every game is a bold
// generated cover-art tile; ≤2 taps to any of the 12. The DOM grid is the source
// of truth: it renders + is clickable with ZERO WebGL. After first paint + idle,
// THE FIELD (M6) lazily enhances the background on capable devices (HOME-SCREEN §2).

import { GAMES, gameMeta } from '@shared/registry';
import type { GameId } from '@shared/types';
import type { Page } from '../router';
import { progress } from '../progress';
import { settings } from '@sdk/settings';
import { coverBackground } from '../coverart';
import type { FieldHandle } from '../home3d';

/** Per-chroma display hue: Spectrum = each game's own hue, Unified = the primary. */
function hueOf(id: GameId): string {
  return settings.get().chroma === 'unified' ? 'var(--c-primary)' : (gameMeta(id)?.hue ?? 'var(--c-primary)');
}

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
  const total = meta ? progress.totalStars() : 0;
  const braid = `linear-gradient(90deg, ${GAMES.map((g) => g.hue).join(', ')})`;

  const page = document.createElement('div');
  page.className = 'page';
  page.innerHTML = `
    <div class="hero">
      <span class="hero-kicker">// PLAYABLE MUSEUM — 12 UNITS ONLINE</span>
      <h1>Twelve mechanics.<br /><em>Real physics.</em></h1>
      <p>Not fakes. Twelve genre-defining mechanics, each on genuine rigid-body simulation — pick a cabinet and play.</p>
      <a class="hero-credit" href="https://dogukanatlihan.com" target="_blank" rel="noopener noreferrer">Made by Doğukan Atlıhan ↗</a>
    </div>
    <div class="section-label"><span class="sl-tag">// ALL CABINETS</span><span class="sl-rule"></span><span>12 · ≤2 TAPS TO PLAY</span></div>
    <div class="cabinet-grid"></div>
    <a class="tease-bar" data-link href="/journey" data-cc>
      <div>
        <span class="tb-tag">// THE JOURNEY</span>
        <h2>Track mastery across four districts</h2>
        <p class="tb-sub">Stars, unlocks, a city map — an optional lens over the library.</p>
      </div>
      <div class="tb-right">
        <span class="tb-stars">★ ${total}/36</span>
        <span class="tb-braid" style="background:${braid}"></span>
        <span class="tb-cta">ENTER THE JOURNEY →</span>
      </div>
    </a>
  `;
  const grid = page.querySelector<HTMLElement>('.cabinet-grid')!;
  const hero = page.querySelector<HTMLElement>('.hero')!;
  const sentinel = page.querySelector<HTMLElement>('.tease-bar')!;
  if (!meta) sentinel.setAttribute('hidden', '');

  GAMES.forEach((game, i) => {
    const stars = meta ? progress.starsForGame(game.id) : 0;
    const best = progress.bestFor(game.id);
    const hue = hueOf(game.id);
    const tile = document.createElement('a');
    tile.className = 'cover-tile';
    tile.href = `/play/${game.id}`;
    tile.setAttribute('data-link', '');
    tile.dataset['game'] = game.id;
    tile.style.background = coverBackground(hue, game.motif);
    tile.style.setProperty('--hue', hue);
    const stat = best > 0 ? `<span class="ct-stat">BEST ${Math.floor(best)}</span>` : `<span class="ct-stat play">PLAY ▸</span>`;
    tile.innerHTML = `
      <span class="ct-index" aria-hidden="true">${String(i + 1).padStart(2, '0')}</span>
      <span class="ct-scrim"></span>
      <span class="ct-top">
        <span class="ct-engine">${game.engine === '2d' ? 'BOX2D V3' : 'BOX3D'}</span>
        ${meta ? `<span class="ct-stars">${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}</span>` : ''}
      </span>
      <span class="ct-body">
        <span class="ct-title">${game.title}</span>
        <span class="ct-foot"><span class="ct-family">${game.family}</span>${stat}</span>
      </span>
    `;
    grid.appendChild(tile);
  });

  root.appendChild(page);

  // ------------------------------------------------------------------------
  // Progressive enhancement: mount THE FIELD after first paint + idle. Nothing
  // below runs on Tier 0 / reduced-motion; the grid above already works.
  // ------------------------------------------------------------------------
  let field: FieldHandle | null = null;
  let disposed = false;
  let tier = 0;
  const tiles = Array.from(grid.querySelectorAll<HTMLElement>('.cover-tile'));

  const pickTargets: Array<{ el: HTMLElement; sig: GameId | 'city-core' | null }> = [
    { el: hero, sig: null },
    ...tiles.map((el) => ({ el, sig: el.dataset['game'] as GameId })),
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
    const a = (e.target as HTMLElement).closest('a.cover-tile');
    if (!(a instanceof HTMLAnchorElement)) return;
    const id = a.dataset['game'] as GameId | undefined;
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    void import('../../games/index').then((m) => m.GAME_LOADERS[id]?.()).catch(() => {});
    const path = a.pathname;
    field.transitionOut(gameMeta(id)?.hue ?? '#ffffff', () => ctx.navigate(path));
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
        hueFor: (id) => gameMeta(id)?.hue ?? '#ffffff',
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
