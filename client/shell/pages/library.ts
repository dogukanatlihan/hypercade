// Landing — the library grid. Every game reachable in ≤2 taps, forever.

import { GAMES } from '@shared/registry';
import type { Page } from '../router';
import { progress } from '../progress';
import { settings } from '@sdk/settings';

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

export const libraryPage: Page = (root) => {
  const meta = settings.get().metaEnabled;
  const page = document.createElement('div');
  page.className = 'page';
  page.innerHTML = `
    <div class="hero">
      <h1>Twelve mechanics.<br /><em>Real physics.</em></h1>
      <p>A playable museum of hyper-casual game design — every genre-defining mechanic, perfected, running on Box2D&nbsp;v3 and Box3D compiled to WebAssembly.</p>
    </div>
    <div class="grid"></div>
  `;
  const grid = page.querySelector('.grid')!;

  for (const game of GAMES) {
    const stars = progress.starsForGame(game.id);
    const best = progress.bestFor(game.id);
    const card = document.createElement('a');
    card.className = 'card';
    card.href = `/play/${game.id}`;
    card.setAttribute('data-link', '');
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
};
