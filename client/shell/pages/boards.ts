// /boards/:gameId — leaderboards. Server-backed in M4; until the API is
// reachable this shows the local best honestly.

import type { Page } from '../router';
import type { GameId } from '@shared/types';
import { gameMeta } from '@shared/registry';
import { progress } from '../progress';

export const boardsPage: Page = (root, { params, navigate }) => {
  const meta = gameMeta(params['gameId'] ?? '');
  if (!meta) {
    navigate('/');
    return;
  }
  const id = meta.id as GameId;

  const page = document.createElement('div');
  page.className = 'page';
  page.innerHTML = `
    <div class="hero"><h1>${meta.title} <em>boards</em></h1></div>
    <div class="panel boards-panel"><h2>All-time</h2><p class="sub">connecting…</p></div>
  `;
  root.appendChild(page);
  const panel = page.querySelector('.boards-panel')!;

  fetch(`/api/leaderboards/${id}?window=alltime`)
    .then(async (r) => (r.ok ? ((await r.json()) as { rows: { rank: number; nickname: string; score: number }[] }) : Promise.reject(new Error(String(r.status)))))
    .then((data) => {
      panel.innerHTML =
        `<h2>All-time · top ${data.rows.length}</h2>` +
        data.rows
          .map((row) => `<div class="setting-row"><span>#${row.rank} ${row.nickname}</span><strong>${row.score}</strong></div>`)
          .join('');
    })
    .catch(() => {
      panel.innerHTML = `<h2>All-time</h2>
        <div class="setting-row"><span>Your local best</span><strong>${Math.floor(progress.bestFor(id))}</strong></div>
        <p class="sub" style="margin-top:8px">Global boards appear when the server is reachable.</p>`;
    });
};
