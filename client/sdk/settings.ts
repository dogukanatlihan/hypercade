// Site-wide settings — localStorage-backed, observed by SDK services.
// Reduced motion is enforced by the SDK (audio/hud/games read it live).

import { Emitter } from './events';

export interface Settings {
  audio: boolean;
  volume: number; // 0..1
  haptics: boolean;
  reducedMotion: boolean;
  palette: 'ember' | 'aurora' | 'paper';
  /** Neon-arcade "feel" tweaks (M7 redesign). */
  intensity: 'minimal' | 'standard' | 'overclocked';
  chroma: 'spectrum' | 'unified';
  edges: 'notched' | 'soft';
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
  intensity: 'standard',
  chroma: 'spectrum',
  edges: 'notched',
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
    if (key === 'intensity' || key === 'chroma' || key === 'edges') applyFeel(this.state);
  }
}

export const settings = new SettingsStore();

export function applyPalette(palette: Settings['palette']): void {
  document.documentElement.dataset['palette'] = palette;
}

/** Stamp the M7 "feel" tweaks onto :root as data-attributes the CSS keys off. */
export function applyFeel(s: Pick<Settings, 'intensity' | 'chroma' | 'edges'>): void {
  const root = document.documentElement;
  root.dataset['intensity'] = s.intensity;
  root.dataset['chroma'] = s.chroma;
  root.dataset['edges'] = s.edges;
}
