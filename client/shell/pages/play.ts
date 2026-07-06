// /play/:gameId — mounts the GameRunner, owns start/end/restart overlays and
// the opt-in journey card after the second completed run (GAMIFICATION §2).

import type { GameId } from '@shared/types';
import { GAMES, gameMeta } from '@shared/registry';
import { STAR_THRESHOLDS } from '@shared/scoring';
import type { Page } from '../router';
import { GAME_LOADERS } from '../../games/index';
import { GameRunner } from '@sdk/loop';
import { randomSeed } from '@sdk/rng';
import { audio } from '@sdk/audio';
import { progress, type RunResult } from '../progress';
import { settings } from '@sdk/settings';
import { BADGES } from '@shared/badges';

export const playPage: Page = (root, { params, navigate }) => {
  const id = params['gameId'] as GameId;
  const meta = gameMeta(id ?? '');
  if (!meta) {
    navigate('/');
    return;
  }

  const engineLabel = meta.engine === '2d' ? 'BOX2D V3' : 'BOX3D';
  const unitNo = String(GAMES.findIndex((g) => g.id === id) + 1).padStart(2, '0');

  const wrap = document.createElement('div');
  wrap.className = 'play-wrap';
  wrap.innerHTML = `
    <div class="play-stage">
      <div class="play-bar">
        <button class="icon-btn back" aria-label="back to library">←</button>
        <button class="icon-btn restart hidden" aria-label="restart">↻</button>
      </div>
      <div class="overlay start-overlay" style="--ov-hue:${meta.hue}">
        <p class="ov-line">UNIT ${unitNo} // <b>LOADED</b></p>
        <p class="ov-line">▸ ${engineLabel} // ${meta.verb}</p>
        <h2>${meta.title}</h2>
        <p class="sub">${meta.tagline}</p>
        <p class="sub loading-note">loading physics…</p>
        <button class="btn start-btn hidden">Play ▸</button>
        <p class="hint">WASM · SEEDED RUN</p>
      </div>
    </div>
  `;
  root.appendChild(wrap);

  const stage = wrap.querySelector<HTMLElement>('.play-stage')!;
  const startOverlay = wrap.querySelector<HTMLElement>('.start-overlay')!;
  const startBtn = wrap.querySelector<HTMLElement>('.start-btn')!;
  const loadingNote = wrap.querySelector<HTMLElement>('.loading-note')!;
  const restartBtn = wrap.querySelector<HTMLElement>('.restart')!;

  let runner: GameRunner | null = null;
  let disposed = false;
  let endOverlay: HTMLElement | null = null;

  const begin = (): void => {
    startOverlay.classList.add('hidden');
    endOverlay?.remove();
    endOverlay = null;
    restartBtn.classList.remove('hidden');
    runner?.start(randomSeed());
  };

  const showEnd = (result: RunResult): void => {
    endOverlay?.remove();
    const el = document.createElement('div');
    el.className = 'overlay';
    el.style.setProperty('--ov-hue', meta.hue);
    const starSpan = [1, 2, 3].map((i) => `<span class="${i <= result.starsAfter ? 'lit' : ''}">★</span>`).join('');
    const newBadgeNames = result.newBadges
      .map((b) => BADGES.find((d) => d.id === b)?.name ?? b)
      .map((n) => `<span class="xp-line">🏅 ${n}</span>`)
      .join('');
    const t = STAR_THRESHOLDS[meta.id];
    const nextStar = result.starsAfter < 3 ? `next ★ at ${t[result.starsAfter as 0 | 1 | 2]}` : 'all stars earned';
    el.innerHTML = `
      <p class="ov-line">▸ RUN COMPLETE</p>
      <div class="big-score">${Math.floor(result.score)}</div>
      <div class="end-stars">${starSpan}</div>
      <p class="sub">${result.isNewBest ? 'NEW BEST' : `BEST ${Math.floor(result.best)}`} · ${nextStar.toUpperCase()}</p>
      ${settings.get().metaEnabled ? `<p class="xp-line">+${result.xp.total} XP${result.levelUp ? ` · LVL ${result.level}` : ''}</p>` : ''}
      ${newBadgeNames}
      <button class="btn again">Again ▸</button>
      <button class="btn ghost home">Library</button>
      <p class="hint">R TO RESTART</p>
    `;
    el.querySelector('.again')!.addEventListener('click', begin);
    el.querySelector('.home')!.addEventListener('click', () => navigate('/'));
    stage.appendChild(el);
    endOverlay = el;
    maybeShowOptIn(el, result);
  };

  const maybeShowOptIn = (parent: HTMLElement, result: RunResult): void => {
    const s = settings.get();
    if (s.metaPromptSeen || s.metaEnabled || result.runsCompleted < 2) return;
    settings.set('metaPromptSeen', true);
    const card = document.createElement('div');
    card.className = 'panel';
    card.style.maxWidth = '340px';
    card.innerHTML = `
      <h2>Want a journey?</h2>
      <p class="sub" style="margin-bottom:12px">Stars, unlocks, a map — or keep it clean. You can flip this anytime in settings.</p>
      <div style="display:flex; gap:10px; justify-content:center">
        <button class="btn yes" style="padding:10px 18px">Start the journey</button>
        <button class="btn ghost no" style="padding:10px 18px">Just play</button>
      </div>
    `;
    card.querySelector('.yes')!.addEventListener('click', () => {
      settings.set('metaEnabled', true);
      card.remove();
    });
    card.querySelector('.no')!.addEventListener('click', () => card.remove());
    parent.appendChild(card);
  };

  const boot = async (): Promise<void> => {
    try {
      const module = await GAME_LOADERS[meta.id]();
      if (disposed) return;
      const game = module.createGame();
      runner = new GameRunner(stage);
      await runner.mount(game, (stats) => {
        const result = progress.recordRun(meta.id, stats);
        if (result.isNewBest) audio.fanfare();
        showEnd(result);
      });
      if (disposed) {
        runner.dispose();
        return;
      }
      loadingNote.classList.add('hidden');
      startBtn.classList.remove('hidden');
    } catch (err) {
      loadingNote.textContent = 'failed to load — check that the WASM engines are built (npm run wasm)';
      console.error(err);
    }
  };

  startBtn.addEventListener('click', begin);
  restartBtn.addEventListener('click', begin);
  wrap.querySelector('.back')!.addEventListener('click', () => navigate('/'));
  const onKey = (e: KeyboardEvent): void => {
    if (e.code === 'KeyR') begin();
    if (e.code === 'Escape') navigate('/');
    if ((e.code === 'Space' || e.code === 'Enter') && !startBtn.classList.contains('hidden') && !startOverlay.classList.contains('hidden')) begin();
    if ((e.code === 'Space' || e.code === 'Enter') && endOverlay) begin();
  };
  window.addEventListener('keydown', onKey);

  void boot();

  return () => {
    disposed = true;
    window.removeEventListener('keydown', onKey);
    runner?.dispose();
    wrap.remove();
  };
};
