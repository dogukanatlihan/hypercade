// Journey — the meta/progression view (M7 redesign): a featured-unit spotlight,
// the 12 games grouped into four district rails, and the City Core tease. Stars
// gate map framing only; every game stays playable from the library (GAMIFICATION §4).

import type { Page } from '../router';
import type { GameMeta } from '@shared/types';
import { GAMES, DISTRICTS, CITY_CORE_STARS } from '@shared/registry';
import { progress } from '../progress';
import { settings } from '@sdk/settings';
import { coverBackground } from '../coverart';

function hueOf(g: GameMeta): string {
  return settings.get().chroma === 'unified' ? 'var(--c-primary)' : g.hue;
}

function starStr(stars: number): string {
  return `${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}`;
}

/** One cover tile as an HTML string (identical anatomy to the Home grid). */
function tileHTML(g: GameMeta, meta: boolean): string {
  const idx = GAMES.findIndex((x) => x.id === g.id) + 1;
  const stars = meta ? progress.starsForGame(g.id) : 0;
  const best = progress.bestFor(g.id);
  const hue = hueOf(g);
  const stat = best > 0 ? `<span class="ct-stat">BEST ${Math.floor(best)}</span>` : `<span class="ct-stat play">PLAY ▸</span>`;
  return `
    <a class="cover-tile" data-link href="/play/${g.id}" data-game="${g.id}" style="background:${coverBackground(hue, g.motif)};--hue:${hue}">
      <span class="ct-index" aria-hidden="true">${String(idx).padStart(2, '0')}</span>
      <span class="ct-scrim"></span>
      <span class="ct-top">
        <span class="ct-engine">${g.engine === '2d' ? 'BOX2D V3' : 'BOX3D'}</span>
        ${meta ? `<span class="ct-stars">${starStr(stars)}</span>` : ''}
      </span>
      <span class="ct-body">
        <span class="ct-title">${g.title}</span>
        <span class="ct-foot"><span class="ct-family">${g.family}</span>${stat}</span>
      </span>
    </a>`;
}

export const journeyPage: Page = (root, { navigate }) => {
  if (!settings.get().metaEnabled) {
    const page = document.createElement('div');
    page.className = 'page';
    page.innerHTML = `
      <div class="hero"><span class="hero-kicker">// META OFFLINE</span><h1>The journey is <em>off</em></h1>
      <p>Stars, the city map, XP and badges are an optional lens over the library. Progress accrues silently either way.</p></div>
      <a class="btn" data-link href="/settings" style="display:inline-block">Open settings</a>
    `;
    root.appendChild(page);
    return;
  }

  const total = progress.totalStars();

  // Featured = the game you've scored highest in; before any play, the curated
  // pick is MAWTOWN (matches the design handoff).
  const top = GAMES.reduce<{ g: GameMeta; best: number } | null>((acc, g) => {
    const b = progress.bestFor(g.id);
    return !acc || b > acc.best ? { g, best: b } : acc;
  }, null);
  const featured = (top && top.best > 0 ? top.g : null) ?? GAMES.find((g) => g.id === 'hole')!;
  const fBest = progress.bestFor(featured.id);
  const fStars = progress.starsForGame(featured.id);
  const fHue = hueOf(featured);
  const fIdx = GAMES.findIndex((x) => x.id === featured.id) + 1;
  const fDistrict = DISTRICTS.find((d) => d.number === featured.district)!;
  const fStarSpan = [1, 2, 3].map((i) => `<span class="${i <= fStars ? 'lit' : ''}">★</span>`).join('');

  const braid = `linear-gradient(90deg, ${GAMES.map((g) => g.hue).join(', ')})`;

  const page = document.createElement('div');
  page.className = 'page';
  page.innerHTML = `
    <div class="hero">
      <span class="hero-kicker">// NOW ON THE FLOOR — ${total}/${CITY_CORE_STARS}★</span>
      <h1>Mechanic <em>City</em></h1>
      <p>Light every district to open the City Core. Every cabinet stays playable — the map is just the lens.</p>
    </div>

    <div class="section-label"><span class="sl-tag">// FEATURED UNIT</span><span class="sl-rule"></span><span>12 CABINETS</span></div>
    <a class="spotlight" data-link href="/play/${featured.id}" style="background:${coverBackground(fHue, featured.motif)};--hue:${fHue}">
      <span class="sp-index" aria-hidden="true">${String(fIdx).padStart(2, '0')}</span>
      <span class="sp-scrim"></span>
      <span class="sp-top"><span class="sp-featured">★ FEATURED</span><span class="sp-district">D${fDistrict.number} · ${fDistrict.name.toUpperCase()}</span></span>
      <span class="sp-body">
        <span class="sp-verb">${featured.verb}</span>
        <div class="sp-title">${featured.title}</div>
        <p class="sp-tagline">${featured.tagline}</p>
        <div class="sp-row">
          <span class="sp-play">PLAY ▸</span>
          <span class="sp-stars">${fStarSpan}</span>
          <span class="sp-meta">${featured.engine === '2d' ? 'BOX2D V3' : 'BOX3D'} // WASM · BEST <b>${fBest > 0 ? Math.floor(fBest) : '—'}</b></span>
        </div>
      </span>
    </a>

    <div class="rails"></div>

    <a class="tease-bar" data-link href="/journey">
      <div>
        <span class="tb-tag">// CITY CORE</span>
        <h2>${total >= CITY_CORE_STARS ? '👑 Curator — all 36 stars' : 'Light all four districts'}</h2>
        <p class="tb-sub">${total >= CITY_CORE_STARS ? 'The golden set is yours.' : `${CITY_CORE_STARS - total} stars from the Curator title.`}</p>
      </div>
      <div class="tb-right">
        <span class="tb-stars">★ ${total}/${CITY_CORE_STARS}</span>
        <span class="tb-braid" style="background:${braid}"></span>
        <span class="tb-cta">${total >= CITY_CORE_STARS ? 'CORE ONLINE' : 'KEEP CLIMBING'}</span>
      </div>
    </a>
  `;

  const rails = page.querySelector<HTMLElement>('.rails')!;
  for (const district of DISTRICTS) {
    const unlocked = total >= district.unlockStars;
    const games = GAMES.filter((g) => g.district === district.number);
    const districtStars = games.reduce((a, g) => a + progress.starsForGame(g.id), 0);
    const rail = document.createElement('section');
    rail.className = `rail${unlocked ? '' : ' locked'}`;
    const status = unlocked ? `${districtStars}/9 ★` : `LOCKED · ${district.unlockStars}★`;
    rail.innerHTML = `
      <div class="rail-label">
        <span>D${district.number} · <span class="rl-name">${district.name.toUpperCase()}</span></span>
        <span class="rl-rule"></span>
        <span>[ ${status} ]</span>
      </div>
      <div class="rail-grid">${games.map((g) => tileHTML(g, true)).join('')}</div>
    `;
    rails.appendChild(rail);
  }

  root.appendChild(page);
  void navigate;

  // secret: idle on the map for 2 minutes → Daydreamer (banked into the next run)
  const idleTimer = window.setTimeout(() => {
    try {
      localStorage.setItem('hypercade:mapIdle', '1');
    } catch {
      // storage blocked
    }
  }, 120_000);
  return () => window.clearTimeout(idleTimer);
};
