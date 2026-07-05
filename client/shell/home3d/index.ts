// THE FIELD — public mount API (HOME-SCREEN §6). Owns the renderer, the GPGPU
// sim, the instanced draw, the render-on-demand scheduler, pointer/scroll force,
// the hero wordmark intro, and the dissolve-through transition. The canvas is a
// FIXED full-viewport element behind the DOM grid: aria-hidden, pointer-events
// none, z-index below .page — the grid's keyboard/focus is never touched.

import * as THREE from 'three';
import { Simulation, type SimUniforms } from './sim';
import { FieldRenderer, type RenderColors } from './render';
import { wordmarkTargets, braidTargets } from './formations';
import { SIGNATURE_INDEX, AMBIENT_SIGNATURE, SIGNATURE_NAMES } from './signatures';
import type { GameId } from '@shared/types';

export interface MountOptions {
  tier: 1 | 2;
  halfFloat: boolean;
  bgColor: string;
  /** Additive glow reads best on dark palettes; light palettes use normal blend. */
  additive: boolean;
  hueFor: (id: GameId) => string;
  /** 0..1 luminance boost for a game's signature from its earned stars. */
  starWeightFor?: (id: GameId) => number;
}

export interface FieldHandle {
  /** gameId → its signature, 'wordmark'/'city-core' → formation, null → ambient. */
  setActiveSignature(id: GameId | 'wordmark' | 'city-core' | null): void;
  setScroll(y: number, velocity: number): void;
  wake(): void;
  transitionOut(hue: string, done: () => void): void;
  dispose(): void;
}

type Active =
  | { kind: 'game'; idx: number; id: GameId }
  | { kind: 'ambient' }
  | { kind: 'formation'; which: 'wordmark' | 'city-core' };

const CAM_DIST = 62;
const IDLE_MS = 8000;
const CALM_MS = 1500;

function approach(cur: number, target: number, dt: number, tau: number): number {
  return cur + (target - cur) * (1 - Math.exp(-dt / tau));
}

export function mountField(host: HTMLElement, opts: MountOptions): FieldHandle {
  void host; // canvas is body-fixed; host kept for API symmetry / future anchoring

  const canvas = document.createElement('canvas');
  canvas.className = 'field-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.appendChild(canvas);

  const dprCap = opts.tier === 2 ? 1.5 : 2;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: false,
    powerPreference: 'low-power',
    premultipliedAlpha: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));
  renderer.autoClear = false;

  const count = opts.tier === 2 ? 256 * 256 : 128 * 128;
  const sim = new Simulation(renderer, count, opts.halfFloat);
  const field = new FieldRenderer(sim.size, sim.count, opts.bgColor, opts.additive, opts.tier === 2);

  const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 200);
  camera.position.set(0, 0, CAM_DIST);
  camera.lookAt(0, 0, 0);

  const resize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    field.resize(w, h, Math.min(window.devicePixelRatio || 1, dprCap));
  };
  resize();
  window.addEventListener('resize', resize);

  // ---- animated state -------------------------------------------------------
  const uni: SimUniforms = {
    sigA: AMBIENT_SIGNATURE,
    sigB: AMBIENT_SIGNATURE,
    blend: 1,
    sigStrength: 0,
    ambient: 1,
    formation: 0,
    turbulence: 0,
    pointer: new THREE.Vector3(),
    pointerVel: new THREE.Vector3(),
    pointerActive: 0,
  };

  const hueCol = new THREE.Color('#ffffff');
  const ambientCol = new THREE.Color(opts.additive ? '#7a86c8' : '#3a4066');
  const transColor = new THREE.Color('#ffffff');
  const collapse = new THREE.Vector3(0, 0, CAM_DIST - 6);
  let hueBlend = 0;
  let lum = 0;
  let alpha = 0;
  let transition = 0;

  let active: Active = { kind: 'formation', which: 'wordmark' };
  let pendingActive: Active | null = null;
  let loadedFormation: 'wordmark' | 'city-core' | null = null;

  // load wordmark for the intro condense
  sim.setTarget(wordmarkTargets(sim.count, 'HYPERCADE'));
  loadedFormation = 'wordmark';

  const state = {
    tier: opts.tier,
    activeId: null as GameId | 'wordmark' | 'city-core' | null,
    activeIndex: AMBIENT_SIGNATURE,
    signature: SIGNATURE_NAMES[AMBIENT_SIGNATURE] ?? 'ambient',
  };

  // ---- intro timeline (hero condense → hold → release) ----------------------
  let introStart = performance.now();
  let intro = true;

  function applyActive(a: Active): void {
    active = a;
    if (a.kind === 'game') {
      state.activeId = a.id;
      state.activeIndex = a.idx;
      hueCol.set(opts.hueFor(a.id));
    } else if (a.kind === 'formation') {
      state.activeId = a.which;
      state.activeIndex = AMBIENT_SIGNATURE;
      if (loadedFormation !== a.which) {
        sim.setTarget(a.which === 'wordmark' ? wordmarkTargets(sim.count, 'HYPERCADE') : braidTargets(sim.count));
        loadedFormation = a.which;
      }
    } else {
      state.activeId = null;
      state.activeIndex = AMBIENT_SIGNATURE;
    }
    state.signature = SIGNATURE_NAMES[state.activeIndex] ?? 'ambient';
    if (import.meta.env.DEV) syncHook();
  }

  function requestSignature(idx: number): void {
    // crossfade: retire the in-flight blend, aim at the new signature
    if (idx === uni.sigB && uni.blend > 0.5) return;
    uni.sigA = uni.sigB; // snapshot whatever is dominant, dissolve toward the new one
    uni.sigB = idx;
    uni.blend = 0;
  }

  // ---- render-on-demand scheduler ------------------------------------------
  let running = false;
  let disposed = false;
  let lastActive = performance.now();
  let lastFrame = performance.now();
  let rafId = 0;

  function wake(): void {
    lastActive = performance.now();
    if (!running && !disposed && document.visibilityState !== 'hidden') {
      running = true;
      lastFrame = performance.now();
      rafId = requestAnimationFrame(frame);
    }
  }

  const trans = { active: false, t0: 0, dur: 450, done: null as null | (() => void), overlay: null as null | HTMLElement };

  function frame(now: number): void {
    if (disposed) return;
    const dt = Math.min((now - lastFrame) / 1000, 1 / 30);
    lastFrame = now;

    // intro state machine
    if (intro) {
      const e = (now - introStart) / 1000;
      if (e < 1.5) uni.formation = approach(uni.formation, 1, dt, 0.4);
      else if (e < 2.3) uni.formation = 1;
      else if (e < 3.1) uni.formation = approach(uni.formation, 0, dt, 0.3);
      else {
        intro = false;
        applyActive(pendingActive ?? { kind: 'ambient' });
        pendingActive = null;
      }
      uni.sigStrength = approach(uni.sigStrength, 0, dt, 0.4);
      hueBlend = approach(hueBlend, 0.2, dt, 0.5);
    } else {
      // resolve active → target uniforms
      const wantSig = active.kind === 'game';
      const wantForm = active.kind === 'formation';
      if (wantSig) requestSignature((active as { idx: number }).idx);
      else requestSignature(AMBIENT_SIGNATURE);
      uni.sigStrength = approach(uni.sigStrength, wantSig ? 1 : 0, dt, 0.4);
      uni.formation = approach(uni.formation, wantForm ? 1 : 0, dt, 0.5);
      hueBlend = approach(hueBlend, wantSig ? 1 : wantForm ? 0.35 : 0.15, dt, 0.5);
    }

    // blend crossfade + ambient/turbulence relax
    uni.blend = Math.min(1, uni.blend + dt / 0.5);
    uni.ambient = 0.35 + (1 - uni.sigStrength) * 0.65;
    uni.turbulence = approach(uni.turbulence, 0, dt, 0.5);
    uni.pointerActive = uni.pointerActive > 0.5 ? (performance.now() - pointerStamp < 260 ? 1 : 0) : 0;
    uni.pointerVel.multiplyScalar(Math.exp(-dt / 0.15));

    // luminance from stars on the active game
    let wantLum = 0;
    if (active.kind === 'game' && opts.starWeightFor) wantLum = opts.starWeightFor(active.id);
    lum = approach(lum, wantLum, dt, 0.4);

    // hue color easing toward active hue
    if (active.kind === 'game') hueCol.lerp(new THREE.Color(opts.hueFor(active.id)), 1 - Math.exp(-dt / 0.3));

    // transition
    if (trans.active) {
      const tt = Math.min(1, (now - trans.t0) / trans.dur);
      transition = tt;
      if (trans.overlay) trans.overlay.style.opacity = String(Math.min(1, tt * 1.15));
      if (tt >= 1 && trans.done) {
        const cb = trans.done;
        trans.done = null;
        cb();
      }
    } else {
      transition = approach(transition, 0, dt, 0.2);
    }

    // idle ease-to-stillness
    let calm = 1;
    if (!trans.active) {
      const idleFor = now - lastActive;
      if (idleFor > IDLE_MS) calm = Math.max(0, 1 - (idleFor - IDLE_MS) / CALM_MS);
    }
    alpha = approach(alpha, 1, dt, 0.6);

    const simU: SimUniforms = {
      ...uni,
      sigStrength: uni.sigStrength * calm,
      ambient: uni.ambient * (0.15 + 0.85 * calm),
      turbulence: uni.turbulence * calm,
    };
    const tex = sim.step(dt, simU);

    const colors: RenderColors = {
      hue: hueCol,
      ambient: ambientCol,
      hueBlend,
      lum,
      alpha,
      transition,
      transColor,
      collapse,
    };
    field.setColors(colors);
    field.render(renderer, camera, tex.position, tex.velocity, dt);

    if (!trans.active && calm <= 0) {
      // eased to stillness → freeze on this final frame, stop the loop
      running = false;
      return;
    }
    rafId = requestAnimationFrame(frame);
  }

  // ---- pointer force --------------------------------------------------------
  let pointerStamp = 0;
  let lastPx = 0;
  let lastPy = 0;
  function pointerToWorld(clientX: number, clientY: number): void {
    const ndcX = (clientX / window.innerWidth) * 2 - 1;
    const ndcY = -((clientY / window.innerHeight) * 2 - 1);
    const halfH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * CAM_DIST;
    const halfW = halfH * camera.aspect;
    const wx = ndcX * halfW;
    const wy = ndcY * halfH;
    const vx = (wx - lastPx) * 40;
    const vy = (wy - lastPy) * 40;
    lastPx = wx;
    lastPy = wy;
    uni.pointer.set(wx, wy, 0);
    uni.pointerVel.set(THREE.MathUtils.clamp(vx, -60, 60), THREE.MathUtils.clamp(vy, -60, 60), 0);
    uni.pointerActive = 1;
    pointerStamp = performance.now();
    wake();
  }
  const onPointerMove = (e: PointerEvent): void => pointerToWorld(e.clientX, e.clientY);
  const onTouchMove = (e: TouchEvent): void => {
    const t = e.touches[0];
    if (t) pointerToWorld(t.clientX, t.clientY);
  };
  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('touchmove', onTouchMove, { passive: true });

  // ---- visibility (pause all simulation on tab blur, §2.5) ------------------
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') {
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
    } else {
      wake();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  // ---- context loss → degrade silently to Tier 0 ---------------------------
  const onContextLost = (e: Event): void => {
    e.preventDefault();
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
  };
  canvas.addEventListener('webglcontextlost', onContextLost);

  function syncHook(): void {
    (window as unknown as { __hypercadeField?: unknown }).__hypercadeField = {
      tier: state.tier,
      activeId: state.activeId,
      activeIndex: state.activeIndex,
      signature: state.signature,
    };
  }
  if (import.meta.env.DEV) syncHook();

  // fade the canvas in under the grid once the first frame is scheduled
  requestAnimationFrame(() => {
    canvas.classList.add('visible');
  });
  wake();

  return {
    setActiveSignature(id): void {
      let a: Active;
      if (id === null) a = { kind: 'ambient' };
      else if (id === 'wordmark' || id === 'city-core') a = { kind: 'formation', which: id };
      else a = { kind: 'game', idx: SIGNATURE_INDEX[id], id };
      if (intro) {
        // let the hero intro finish; a game scroll cancels it early
        if (a.kind === 'game') {
          intro = false;
          uni.formation = 0;
        } else {
          pendingActive = a;
          return;
        }
      }
      applyActive(a);
      wake();
    },
    setScroll(_y, velocity): void {
      uni.turbulence = Math.min(1.4, uni.turbulence + Math.abs(velocity) * 0.02);
      wake();
    },
    wake,
    transitionOut(hue, done): void {
      transColor.set(hue);
      const overlay = document.createElement('div');
      overlay.className = 'field-veil';
      overlay.style.background = hue;
      document.body.appendChild(overlay);
      trans.overlay = overlay;
      trans.active = true;
      trans.t0 = performance.now();
      trans.done = done;
      wake();
    },
    dispose(): void {
      disposed = true;
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      trans.overlay?.remove();
      sim.dispose();
      field.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
      if (import.meta.env.DEV) delete (window as unknown as { __hypercadeField?: unknown }).__hypercadeField;
    },
  };
}
