// Settings — audio, haptics, reduced motion, palette, meta toggle, data.

import type { Page } from '../router';
import { settings, type Settings } from '@sdk/settings';
import { progress } from '../progress';

export const settingsPage: Page = (root) => {
  const page = document.createElement('div');
  page.className = 'page';

  const render = (): void => {
    const s = settings.get();
    page.innerHTML = `
      <div class="hero"><h1>Settings</h1></div>
      <div class="panel">
        <h2>Feel</h2>
        ${toggleRow('audio', 'Sound', 'Synth effects, no assets', s.audio)}
        <div class="setting-row">
          <div><div class="label">Volume</div></div>
          <input type="range" min="0" max="1" step="0.05" value="${s.volume}" data-key="volume" />
        </div>
        ${toggleRow('haptics', 'Haptics', 'Vibration on impacts (mobile)', s.haptics)}
        ${toggleRow('reducedMotion', 'Reduced motion', 'No shake, no flashes, calmer everything', s.reducedMotion)}
      </div>
      <div class="panel">
        <h2>Palette</h2>
        <div class="seg" role="radiogroup" aria-label="palette">
          ${(['ember', 'aurora', 'paper'] as const).map((p) => `<button data-palette-opt="${p}" class="${s.palette === p ? 'active' : ''}">${p}</button>`).join('')}
        </div>
        <p class="desc" style="margin-top:8px">paper is the high-contrast, colorblind-safe option</p>
      </div>
      <div class="panel">
        <h2>Journey</h2>
        ${toggleRow('metaEnabled', 'Journey layer', 'Stars, map, XP, badges. Progress accrues silently either way — flip back anytime and find it honored.', s.metaEnabled)}
      </div>
      <div class="panel">
        <h2>Data</h2>
        <div class="setting-row">
          <div><div class="label">Export progress</div><div class="desc">JSON download of everything stored</div></div>
          <button class="btn ghost" data-action="export" style="padding:9px 16px">Export</button>
        </div>
        <div class="setting-row">
          <div><div class="label">Wipe progress</div><div class="desc">Deletes local bests, stars, XP, badges</div></div>
          <button class="btn ghost" data-action="wipe" style="padding:9px 16px; color:var(--c-danger)">Wipe</button>
        </div>
      </div>
    `;

    page.querySelectorAll<HTMLElement>('[data-toggle]').forEach((el) => {
      el.addEventListener('click', () => {
        const key = el.dataset['toggle'] as keyof Settings;
        settings.set(key, !settings.get()[key] as never);
        if (key === 'reducedMotion') {
          document.documentElement.dataset['reducedMotion'] = String(settings.get().reducedMotion);
        }
        render();
      });
    });
    page.querySelector<HTMLInputElement>('[data-key="volume"]')!.addEventListener('input', (e) => {
      settings.set('volume', Number((e.target as HTMLInputElement).value));
    });
    page.querySelectorAll<HTMLElement>('[data-palette-opt]').forEach((el) => {
      el.addEventListener('click', () => {
        settings.set('palette', el.dataset['paletteOpt'] as Settings['palette']);
        render();
      });
    });
    page.querySelector('[data-action="export"]')!.addEventListener('click', () => {
      const blob = new Blob([progress.exportJson()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'hypercade-progress.json';
      a.click();
      URL.revokeObjectURL(a.href);
    });
    page.querySelector('[data-action="wipe"]')!.addEventListener('click', () => {
      if (confirm('Wipe all local progress? Best scores, stars, XP and badges will be deleted.')) {
        progress.wipe();
        render();
      }
    });
  };

  const toggleRow = (key: string, label: string, desc: string, on: boolean): string => `
    <div class="setting-row">
      <div><div class="label">${label}</div><div class="desc">${desc}</div></div>
      <button class="toggle ${on ? 'on' : ''}" data-toggle="${key}" role="switch" aria-checked="${on}" aria-label="${label}"></button>
    </div>
  `;

  render();
  root.appendChild(page);
};
