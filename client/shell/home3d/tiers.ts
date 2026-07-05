// Runtime capability gate for THE FIELD (HOME-SCREEN §2, §6). Pure detection,
// no side effects, no WebGL context kept alive. Returns the tier the device
// earns plus the float-texture flavor the GPGPU sim must use.
//
//   Tier 0 — DOM grid only. No canvas. (reduced-motion / save-data / no WebGL2 /
//            no float render target / low memory.)
//   Tier 1 — the field at 16k particles, DPR ≤ 2, no post.
//   Tier 2 — desktop: 65k particles, DPR ≤ 1.5, bloom + grain + pointer force.

export type Tier = 0 | 1 | 2;

export interface Capability {
  tier: Tier;
  /** GPGPU state textures: true ⇒ half-float only (no full-float color buffer). */
  halfFloat: boolean;
}

interface NavigatorMemory {
  deviceMemory?: number;
  hardwareConcurrency?: number;
}

interface NetworkInfo {
  saveData?: boolean;
}

function saveDataOn(): boolean {
  const conn = (navigator as Navigator & { connection?: NetworkInfo }).connection;
  return conn?.saveData === true;
}

/**
 * Probe WebGL2 + float-renderable color buffer once, then discard the context.
 * Returns null when the device cannot render to any float target ⇒ Tier 0.
 */
function probeFloat(): { halfFloat: boolean } | null {
  let canvas: HTMLCanvasElement | null = document.createElement('canvas');
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: false });
    if (!gl) return null;
    // Full float render target (EXT_color_buffer_float) is preferred for
    // position precision; half-float is the documented old-mobile fallback
    // (HOME-SCREEN §6 engineering note). Either is enough for the sim.
    const full = gl.getExtension('EXT_color_buffer_float');
    if (full) return { halfFloat: false };
    const half = gl.getExtension('EXT_color_buffer_half_float');
    if (half) return { halfFloat: true };
    return null;
  } catch {
    return null;
  } finally {
    // Free the probe context deterministically so we never leak one.
    try {
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      /* ignore */
    }
    canvas = null;
  }
}

function wantsTier2(): boolean {
  // Desktop-class: a fine hover-capable pointer and enough cores/memory to
  // absorb 65k particles + a post pass. Touch phones stay on Tier 1.
  const fine =
    typeof matchMedia !== 'undefined' && matchMedia('(hover: hover) and (pointer: fine)').matches;
  const nav = navigator as Navigator & NavigatorMemory;
  const cores = nav.hardwareConcurrency ?? 4;
  const mem = nav.deviceMemory ?? 8;
  return fine && cores >= 8 && mem >= 8;
}

export function detectCapability(reducedMotion: boolean): Capability {
  const off: Capability = { tier: 0, halfFloat: false };
  if (reducedMotion) return off;
  if (saveDataOn()) return off;

  // deviceMemory is undefined on desktop Safari/Firefox — treat unknown as
  // capable (8) rather than locking those browsers out entirely.
  const mem = (navigator as Navigator & NavigatorMemory).deviceMemory ?? 8;
  if (mem < 4) return off;

  const float = probeFloat();
  if (!float) return off;

  return { tier: wantsTier2() ? 2 : 1, halfFloat: float.halfFloat };
}
