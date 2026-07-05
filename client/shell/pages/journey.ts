// Journey map — Mechanic City. Four districts, stars gate map REWARDS only;
// every game stays playable from the library (GAMIFICATION §4).

import type { Page } from '../router';
import { GAMES, DISTRICTS, CITY_CORE_STARS } from '@shared/registry';
import { STAR_THRESHOLDS } from '@shared/scoring';
import { progress } from '../progress';
import { settings } from '@sdk/settings';

export const journeyPage: Page = (root, { navigate }) => {
  if (!settings.get().metaEnabled) {
    // journey is an overlay, never a nag — send visitors to settings to opt in
    const page = document.createElement('div');
    page.className = 'page';
    page.innerHTML = `
      <div class="hero"><h1>The journey is off</h1>
      <p>Stars, the city map, XP and badges are an optional lens over the library. Progress accrues silently either way.</p></div>
      <a class="btn" data-link href="/settings" style="display:inline-block">Open settings</a>
    `;
    root.appendChild(page);
    return;
  }

  const total = progress.totalStars();
  const page = document.createElement('div');
  page.className = 'page';
  page.innerHTML = `
    <div class="hero">
      <h1>Mechanic <em>City</em></h1>
      <p>★ ${total} of ${CITY_CORE_STARS} — light every district to open the City Core.</p>
    </div>
    <div class="journey"></div>
  `;
  const wrap = page.querySelector('.journey')!;

  for (const district of DISTRICTS) {
    const unlocked = total >= district.unlockStars;
    const games = GAMES.filter((g) => g.district === district.number);
    const districtStars = games.reduce((a, g) => a + progress.starsForGame(g.id), 0);
    const el = document.createElement('div');
    el.className = 'panel';
    el.style.opacity = unlocked ? '1' : '0.55';
    el.innerHTML = `
      <h2>${district.number} · ${district.name} ${unlocked ? `— ${districtStars}/9 ★` : `<span style="float:right">unlocks at ${district.unlockStars}★</span>`}</h2>
      <div class="grid">
        ${games
          .map((g) => {
            const stars = progress.starsForGame(g.id);
            const best = progress.bestFor(g.id);
            const t = STAR_THRESHOLDS[g.id];
            const next = stars < 3 ? `next ★ ${t[stars as 0 | 1 | 2]}` : 'mastered';
            return unlocked
              ? `<a class="card" data-link href="/play/${g.id}">
                  <span class="engine">${g.engine.toUpperCase()}</span>
                  <h3>${g.title}</h3>
                  <span class="chips"><span class="stars">${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}</span>
                  <span>${best > 0 ? `best ${Math.floor(best)} · ${next}` : 'unplayed'}</span></span>
                </a>`
              : `<div class="card" style="filter:grayscale(1)"><span class="engine">?</span><h3>· · ·</h3>
                  <span class="tagline">silhouette — playable from the library anytime</span></div>`;
          })
          .join('')}
      </div>
    `;
    wrap.appendChild(el);
  }

  const core = document.createElement('div');
  core.className = 'panel';
  core.style.textAlign = 'center';
  core.innerHTML =
    total >= CITY_CORE_STARS
      ? `<h2>City Core</h2><div class="big-score" style="font-size:2.4rem">👑 CURATOR</div><p class="sub">All 36 stars. The golden set is yours.</p>`
      : `<h2>City Core</h2><p class="sub">Opens at ${CITY_CORE_STARS}★ — the Curator title awaits.</p>`;
  wrap.appendChild(core);

  root.appendChild(page);
  void navigate;
};
