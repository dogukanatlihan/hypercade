// Generated cover art — zero image assets. Each game's tile/spotlight background
// is a stack of CSS gradients derived from its hue + motif (DESIGN-BRIEF).
// One string per game, set as inline `background` on the tile <a> (decorative,
// aria-hidden-friendly — the <a>'s accessible name comes from its title text).

import type { Motif } from '@shared/types';

/** color-mix helper: `mix(52)` → the hue at 52% over transparent. */
function mixer(hue: string): (p: number) => string {
  return (p: number) => `color-mix(in srgb, ${hue} ${p}%, transparent)`;
}

/** The base wash under every motif (deep surface + two hue pools). */
function baseLayers(hue: string): string {
  const mix = mixer(hue);
  return [
    `radial-gradient(ellipse at 28% 20%, ${mix(52)}, transparent 58%)`,
    `radial-gradient(ellipse at 84% 92%, ${mix(30)}, transparent 56%)`,
    `linear-gradient(155deg, var(--c-surface-2), var(--c-bg))`,
  ].join(', ');
}

/** The per-game signature laid ON TOP of the base wash. */
function motifLayers(hue: string, motif: Motif): string {
  const mix = mixer(hue);
  switch (motif) {
    case 'rings':
      return `repeating-radial-gradient(circle at 50% 38%, ${mix(52)} 0 2px, transparent 2px 16px)`;
    case 'bars':
      return `repeating-linear-gradient(90deg, ${mix(40)} 0 7px, transparent 7px 22px)`;
    case 'orbs':
      return [
        `radial-gradient(circle at 36% 44%, ${mix(52)} 0 13%, transparent 15%)`,
        `radial-gradient(circle at 62% 56%, ${mix(42)} 0 10%, transparent 12%)`,
        `radial-gradient(circle at 52% 30%, ${mix(34)} 0 8%, transparent 10%)`,
      ].join(', ');
    case 'burst':
      return `repeating-conic-gradient(from 208deg at 50% 34%, ${mix(46)} 0 5deg, transparent 5deg 24deg)`;
    case 'spiral':
      return `repeating-linear-gradient(58deg, ${mix(44)} 0 3px, transparent 3px 18px)`;
    case 'net':
      return [
        `repeating-linear-gradient(45deg, ${mix(38)} 0 2px, transparent 2px 15px)`,
        `repeating-linear-gradient(-45deg, ${mix(38)} 0 2px, transparent 2px 15px)`,
      ].join(', ');
    case 'blob':
      return [
        `radial-gradient(circle at 50% 46%, var(--c-bg) 0 19%, transparent 42%)`,
        `radial-gradient(circle at 50% 46%, ${mix(56)} 22%, transparent 56%)`,
      ].join(', ');
    case 'dots':
      return `repeating-radial-gradient(circle at 24% 26%, ${mix(46)} 0 2px, transparent 2px 19px)`;
    case 'trace':
      return `repeating-linear-gradient(24deg, ${mix(44)} 0 3px, transparent 3px 22px)`;
    case 'streaks':
      return `repeating-linear-gradient(115deg, ${mix(50)} 0 3px, transparent 3px 14px)`;
  }
}

/** Full `background` value for a game's cover: motif layers over the base wash. */
export function coverBackground(hue: string, motif: Motif): string {
  return `${motifLayers(hue, motif)}, ${baseLayers(hue)}`;
}
