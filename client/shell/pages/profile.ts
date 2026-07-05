// Profile — level ring, star constellation, badge shelf, streak.

import type { Page } from '../router';
import { progress } from '../progress';
import { levelFromXp } from '@shared/scoring';
import { BADGES } from '@shared/badges';
import { GAMES } from '@shared/registry';
import { settings } from '@sdk/settings';

const TITLES: [number, string][] = [
  [30, 'Grandmaster'],
  [20, 'Physicist'],
  [10, 'Machinist'],
  [5, 'Tinkerer'],
  [1, 'Visitor'],
];

export const profilePage: Page = (root) => {
  const s = progress.get();
  const { level, intoLevel, forNext } = levelFromXp(s.xp);
  const title = TITLES.find(([n]) => level >= n)?.[1] ?? 'Visitor';
  const nickname = settings.get().nickname || 'Guest';

  const page = document.createElement('div');
  page.className = 'page';
  page.innerHTML = `
    <div class="hero">
      <h1>${nickname} <em>· ${title}</em></h1>
      <p>Level ${level} — ${intoLevel}/${forNext} XP · streak ${s.streak.current} (best ${s.streak.best}${s.streak.shields > 0 ? ` · 🛡×${s.streak.shields}` : ''})</p>
    </div>
    <div class="panel">
      <h2>Nickname</h2>
      <div class="setting-row">
        <input type="text" maxlength="16" minlength="2" value="${nickname === 'Guest' ? '' : nickname}" placeholder="2–16 characters"
          style="background:var(--c-surface-2); border:none; border-radius:10px; padding:10px 14px; color:var(--c-text); font:inherit; width:100%" />
        <button class="btn ghost save-nick" style="padding:9px 16px">Save</button>
      </div>
    </div>
    <div class="panel">
      <h2>Star constellation — ${progress.totalStars()}/36</h2>
      <div class="grid">
        ${GAMES.map((g) => {
          const st = progress.starsForGame(g.id);
          return `<div class="card"><span class="engine">${g.title}</span>
            <span class="stars" style="color:var(--c-star); font-size:1.2rem">${'★'.repeat(st)}<span style="opacity:.25">${'★'.repeat(3 - st)}</span></span>
            <span class="tagline">best ${Math.floor(progress.bestFor(g.id))}</span></div>`;
        }).join('')}
      </div>
    </div>
    <div class="panel">
      <h2>Badge shelf — ${s.badges.length}/${BADGES.length}</h2>
      <div class="grid">
        ${BADGES.filter((b) => !b.secret || s.badges.includes(b.id))
          .map((b) => {
            const earned = s.badges.includes(b.id);
            return `<div class="card" style="${earned ? '' : 'opacity:.45; filter:grayscale(1)'}">
              <span class="engine">${earned ? '🏅 EARNED' : 'LOCKED'}</span><h3 style="font-size:.9rem">${b.name}</h3>
              <span class="tagline">${b.description}</span></div>`;
          })
          .join('')}
      </div>
    </div>
  `;

  const input = page.querySelector<HTMLInputElement>('input')!;
  page.querySelector('.save-nick')!.addEventListener('click', () => {
    const v = input.value.trim().slice(0, 16);
    if (v.length >= 2) settings.set('nickname', v);
    location.reload();
  });

  root.appendChild(page);
};
