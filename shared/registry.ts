// The game catalog — permanent IDs (URLs, DB keys). MECHANICS.md is the spec.

import type { GameMeta } from './types';

export const GAMES: readonly GameMeta[] = [
  { id: 'flap', title: 'ONE-WING', engine: '2d', tagline: 'One tap. Stay airborne.', family: 'Tap / Timing', district: 1 },
  { id: 'stack', title: 'BOXSTACK', engine: '3d', tagline: 'Drop crates. Build high.', family: 'Stacking', district: 1 },
  { id: 'merge-drop', title: 'MERGE CRATER', engine: '2d', tagline: 'Same meets same. Bigger.', family: 'Merge', district: 1 },
  { id: 'sling', title: 'SIEGE SLING', engine: '2d', tagline: 'Pull back. Let physics argue.', family: 'Launch / Destroy', district: 2 },
  { id: 'helix', title: 'SPIRALFALL', engine: '3d', tagline: 'Find the gap. Fall forever.', family: 'Rise & Fall', district: 2 },
  { id: 'bricks', title: 'VOLLEY', engine: '2d', tagline: 'Aim once. Bounce a hundred times.', family: 'Aim / Bounce', district: 2 },
  { id: 'hole', title: 'MAWTOWN', engine: '3d', tagline: 'Eat the city. Grow.', family: 'Grow / Consume', district: 3 },
  { id: 'plinko', title: 'PEGWORKS', engine: '2d', tagline: 'Numbers go up. Physics stays honest.', family: 'Idle / Drop', district: 3 },
  { id: 'knock', title: 'TOPPLE RANGE', engine: '3d', tagline: 'One ball. Whole structure.', family: 'Throw / Destroy', district: 3 },
  { id: 'rope', title: 'SNIP', engine: '2d', tagline: 'Cut smart. Swing true.', family: 'Physics Puzzle / Cut', district: 4 },
  { id: 'draw', title: 'INKLINE', engine: '2d', tagline: 'Draw it. Drop it. Solve it.', family: 'Draw / Dexterity', district: 4 },
  { id: 'swerve', title: 'GUTTERBALL RUN', engine: '3d', tagline: 'Faster forever. Steer or die.', family: 'Swerve / Steer', district: 4 },
] as const;

export const GAME_IDS = GAMES.map((g) => g.id);

export function gameMeta(id: string): GameMeta | undefined {
  return GAMES.find((g) => g.id === id);
}

/** Journey map districts, GAMIFICATION §4. Unlock gates apply to map rewards only. */
export const DISTRICTS = [
  { number: 1 as const, name: 'First Taps', unlockStars: 0 },
  { number: 2 as const, name: 'Launch Pad', unlockStars: 4 },
  { number: 3 as const, name: 'Toy City', unlockStars: 12 },
  { number: 4 as const, name: 'Master Works', unlockStars: 21 },
] as const;

export const CITY_CORE_STARS = 36;
