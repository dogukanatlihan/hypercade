// HUD overlay — score, star beacon, combo popups, messages. DOM over canvas so
// games never re-implement chrome. The star beacon celebrates thresholds
// DURING play (GAMIFICATION §3: the player should see ★2 coming).

import { starsFor, STAR_THRESHOLDS } from '@shared/scoring';
import type { GameId } from '@shared/types';
import { settings } from './settings';
import { audio } from './audio';

export class Hud {
  readonly root: HTMLElement;
  private scoreEl: HTMLElement;
  private subEl: HTMLElement;
  private starsEl: HTMLElement;
  private comboEl: HTMLElement;
  private flashEl: HTMLElement;
  private gameId: GameId | null = null;
  private lastStars = 0;
  private score = 0;

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="hud-top">
        <div class="hud-score">0</div>
        <div class="hud-stars" aria-label="star progress"></div>
      </div>
      <div class="hud-sub"></div>
      <div class="hud-combo hidden"></div>
      <div class="hud-flash hidden"></div>
    `;
    container.appendChild(this.root);
    this.scoreEl = this.root.querySelector('.hud-score')!;
    this.subEl = this.root.querySelector('.hud-sub')!;
    this.starsEl = this.root.querySelector('.hud-stars')!;
    this.comboEl = this.root.querySelector('.hud-combo')!;
    this.flashEl = this.root.querySelector('.hud-flash')!;
  }

  /** Bind star thresholds for this game and reset run-local state. */
  bind(gameId: GameId): void {
    this.gameId = gameId;
    this.lastStars = 0;
    this.score = 0;
    this.scoreEl.textContent = '0';
    this.subEl.textContent = '';
    this.comboEl.classList.add('hidden');
    this.flashEl.classList.add('hidden');
    this.renderStars(0);
  }

  setScore(value: number): void {
    if (value === this.score) return;
    this.score = value;
    this.scoreEl.textContent = String(Math.floor(value));
    if (!this.gameId) return;
    const stars = starsFor(this.gameId, value);
    if (stars > this.lastStars) {
      this.lastStars = stars;
      this.renderStars(stars);
      this.starBurst(stars);
    }
  }

  /** Secondary line: wave counter, balls left, timer… */
  setSub(text: string): void {
    this.subEl.textContent = text;
  }

  showCombo(text: string, hot = false): void {
    this.comboEl.textContent = text;
    this.comboEl.classList.remove('hidden', 'hot');
    if (hot) this.comboEl.classList.add('hot');
    if (!settings.get().reducedMotion) {
      this.comboEl.style.animation = 'none';
      void this.comboEl.offsetWidth;
      this.comboEl.style.animation = '';
    }
  }

  hideCombo(): void {
    this.comboEl.classList.add('hidden');
  }

  /** Large center message (fades out). */
  flash(text: string, ms = 900): void {
    this.flashEl.textContent = text;
    this.flashEl.classList.remove('hidden');
    if (!settings.get().reducedMotion) {
      this.flashEl.style.animation = 'none';
      void this.flashEl.offsetWidth;
      this.flashEl.style.animation = '';
    }
    window.setTimeout(() => this.flashEl.classList.add('hidden'), ms);
  }

  private renderStars(current: number): void {
    if (!this.gameId) return;
    const t = STAR_THRESHOLDS[this.gameId];
    const next = current < 3 ? t[current as 0 | 1 | 2] : null;
    this.starsEl.innerHTML =
      [0, 1, 2].map((i) => `<span class="star ${i < current ? 'lit' : ''}">★</span>`).join('') +
      (next !== null ? `<span class="star-next">${next}</span>` : '');
  }

  private starBurst(stars: number): void {
    audio.fanfare();
    audio.buzz(30);
    this.flash(`★${stars}`, 1100);
    if (!settings.get().reducedMotion) {
      this.starsEl.classList.remove('burst');
      void (this.starsEl as HTMLElement).offsetWidth;
      this.starsEl.classList.add('burst');
    }
  }

  dispose(): void {
    this.root.remove();
  }
}
