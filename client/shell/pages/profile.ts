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
      <h2>Last 12 weeks</h2>
      <div style="display:grid; grid-template-rows:repeat(7,12px); grid-auto-flow:column; gap:3px; overflow-x:auto; padding-bottom:6px">
        ${heatmap(s.runDays)}
      </div>
    </div>
    <div class="panel">
      <h2>Locker — level rewards</h2>
      <div class="grid">
        ${[
          { name: 'Aurora palette', at: 2, note: 'switch in settings' },
          { name: 'Tinkerer title', at: 5, note: '' },
          { name: 'Paper palette', at: 7, note: 'high-contrast' },
          { name: 'Machinist title', at: 10, note: '' },
          { name: 'Physicist title', at: 20, note: '' },
          { name: 'Grandmaster title', at: 30, note: '' },
        ]
          .map(
            (c) => `<div class="card" style="${level >= c.at ? '' : 'opacity:.45'}">
              <span class="engine">${level >= c.at ? 'UNLOCKED' : `LEVEL ${c.at}`}</span>
              <h3 style="font-size:.9rem">${c.name}</h3><span class="tagline">${c.note}</span></div>`,
          )
          .join('')}
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

  function heatmap(runDays: Record<string, number>): string {
    const cells: string[] = [];
    const now = Date.now();
    for (let i = 83; i >= 0; i--) {
      const day = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
      const n = runDays[day] ?? 0;
      const alpha = n === 0 ? 0.08 : Math.min(0.25 + n * 0.15, 1);
      cells.push(`<span title="${day}: ${n} runs" style="width:12px;height:12px;border-radius:3px;background:color-mix(in srgb, var(--c-glow) ${Math.round(alpha * 100)}%, var(--c-surface-2))"></span>`);
    }
    return cells.join('');
  }

  const input = page.querySelector<HTMLInputElement>('input')!;
  page.querySelector('.save-nick')!.addEventListener('click', () => {
    const v = input.value.trim().slice(0, 16);
    if (v.length >= 2) settings.set('nickname', v);
    location.reload();
  });

  root.appendChild(page);
};
