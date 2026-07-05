// Site-wide settings — localStorage-backed, observed by SDK services.
// Reduced motion is enforced by the SDK (audio/hud/games read it live).

import { Emitter } from './events';

export interface Settings {
  audio: boolean;
  volume: number; // 0..1
  haptics: boolean;
  reducedMotion: boolean;
  palette: 'ember' | 'aurora' | 'paper';
  metaEnabled: boolean;
  metaPromptSeen: boolean;
  nickname: string;
}

const KEY = 'hypercade:settings';

const defaults: Settings = {
  audio: true,
  volume: 0.8,
  haptics: true,
  reducedMotion: typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  palette: 'ember',
  metaEnabled: false,
  metaPromptSeen: false,
  nickname: '',
};

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...defaults };
    return { ...defaults, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    return { ...defaults };
  }
}

class SettingsStore {
  private state = load();
  readonly changed = new Emitter<{ change: Settings }>();

  get(): Settings {
    return this.state;
  }

  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    this.state = { ...this.state, [key]: value };
    try {
      localStorage.setItem(KEY, JSON.stringify(this.state));
    } catch {
      // storage full/blocked — settings stay session-local
    }
    this.changed.emit('change', this.state);
    if (key === 'palette') applyPalette(this.state.palette);
  }
}

export const settings = new SettingsStore();

export function applyPalette(palette: Settings['palette']): void {
  document.documentElement.dataset['palette'] = palette;
}
