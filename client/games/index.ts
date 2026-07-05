// Lazy game loaders — one chunk per game, no cross-imports (TECH-BRIEF §5).

import type { GameId } from '@shared/types';
import type { GameFactory } from '@sdk/types';

export const GAME_LOADERS: Record<GameId, () => Promise<{ createGame: GameFactory }>> = {
  flap: () => import('./flap/game'),
  'merge-drop': () => import('./merge-drop/game'),
  sling: () => import('./sling/game'),
  rope: () => import('./rope/game'),
  bricks: () => import('./bricks/game'),
  draw: () => import('./draw/game'),
  plinko: () => import('./plinko/game'),
  stack: () => import('./stack/game'),
  helix: () => import('./helix/game'),
  hole: () => import('./hole/game'),
  knock: () => import('./knock/game'),
  swerve: () => import('./swerve/game'),
};
