// Synth audio bus — zero assets, WebAudio primitives games compose into juice.
// Respects settings (mute/volume) live; suspends with the page.

import { settings } from './settings';

export class AudioBus {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;

  private ensure(): AudioContext | null {
    if (!settings.get().audio) return null;
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    if (this.master) this.master.gain.value = settings.get().volume;
    return this.ctx;
  }

  suspend(): void {
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend();
  }

  resume(): void {
    this.ensure();
  }

  /** One-shot oscillator note. */
  note(freq: number, opts: { dur?: number; type?: OscillatorType; vol?: number; slideTo?: number; delay?: number } = {}): void {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const { dur = 0.15, type = 'sine', vol = 0.15, slideTo, delay = 0 } = opts;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(slideTo, 1), t + dur);
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** Filtered noise burst — impacts, debris, dust. */
  noise(opts: { dur?: number; vol?: number; freq?: number; q?: number; delay?: number } = {}): void {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const { dur = 0.12, vol = 0.12, freq = 800, q = 1, delay = 0 } = opts;
    const t = ctx.currentTime + delay;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(t);
  }

  /** Impact thud scaled by approach speed. */
  thud(speed: number): void {
    const vol = Math.min(0.05 + speed * 0.03, 0.45);
    this.note(120 + Math.min(speed * 8, 60), { dur: 0.16, type: 'sine', vol, slideTo: 38 });
    this.noise({ dur: 0.06, vol: vol * 0.5, freq: 300 });
  }

  /** Rising two-tone chime — combos, perfects. Pitch climbs with `step`. */
  chime(step = 0): void {
    const base = 520 + Math.min(step, 8) * 70;
    this.note(base, { dur: 0.3, type: 'triangle', vol: 0.16 });
    this.note(base * 1.5, { dur: 0.32, type: 'triangle', vol: 0.14, delay: 0.07 });
  }

  /** Short pop — merges, pickups. Pitch ladder via `step`. */
  pop(step = 0): void {
    this.note(300 + step * 55, { dur: 0.09, type: 'square', vol: 0.09, slideTo: 500 + step * 70 });
  }

  /** UI tick. */
  tick(): void {
    this.note(900, { dur: 0.04, type: 'square', vol: 0.05 });
  }

  /** Failure sting. */
  womp(): void {
    this.note(220, { dur: 0.4, type: 'sawtooth', vol: 0.12, slideTo: 80 });
  }

  /** Celebration arpeggio. */
  fanfare(): void {
    [523, 659, 784, 1047].forEach((f, i) => this.note(f, { dur: 0.22, type: 'triangle', vol: 0.13, delay: i * 0.09 }));
  }

  /** Whoosh — launches, dashes. */
  whoosh(): void {
    this.noise({ dur: 0.25, vol: 0.1, freq: 1200, q: 0.7 });
  }

  /** Haptic pulse (no-op when disabled or unsupported). */
  buzz(ms = 15): void {
    if (!settings.get().haptics) return;
    navigator.vibrate?.(ms);
  }
}

export const audio = new AudioBus();
