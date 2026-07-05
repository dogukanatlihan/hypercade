// GPGPU particle simulation (HOME-SCREEN §6). Position + velocity live in float
// (or half-float) textures advanced entirely on the GPU via FBO ping-pong: a
// fullscreen fragment pass = curl noise + the active signature's attractor +
// formation pull + pointer force + boundary spring. Two draw passes per frame
// (velocity, then position). One code path, two quality knobs (particle count +
// DPR) — the Tier-1 fallback is the same shader at 16k.

import * as THREE from 'three';
import { FIELD } from './formations';
import { initialState } from './formations';
import { GLSL_NOISE, GLSL_SIGNATURES } from './signatures';

/** Runtime-tunable simulation inputs, mutated by index.ts each frame. */
export interface SimUniforms {
  sigA: number;
  sigB: number;
  blend: number; // 0 → sigA, 1 → sigB
  sigStrength: number; // 0 ambient .. 1 full signature
  ambient: number; // curl-drift weight
  formation: number; // pull toward the target texture (wordmark / braid)
  turbulence: number; // scroll-velocity global stir
  pointer: THREE.Vector3;
  pointerVel: THREE.Vector3;
  pointerActive: number;
}

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

function fragHeader(res: number): string {
  return `
#define RES ${res.toFixed(1)}
#define FX ${FIELD.x.toFixed(1)}
#define FY ${FIELD.y.toFixed(1)}
#define FZ ${FIELD.z.toFixed(1)}
#define PI 3.14159265359
`;
}

/** IEEE-754 float → half-float bits, for half-float-only devices. */
function toHalf(val: number): number {
  const f = new Float32Array(1);
  const i = new Int32Array(f.buffer);
  f[0] = val;
  const x = i[0] ?? 0;
  const sign = (x >> 16) & 0x8000;
  let exp = ((x >> 23) & 0xff) - 127 + 15;
  const mant = x & 0x7fffff;
  if (exp <= 0) return sign;
  if (exp >= 0x1f) return sign | 0x7c00;
  return sign | (exp << 10) | (mant >> 13);
}

function dataTexture(data: Float32Array, size: number, half: boolean): THREE.DataTexture {
  let tex: THREE.DataTexture;
  if (half) {
    const buf = new Uint16Array(data.length);
    for (let i = 0; i < data.length; i++) buf[i] = toHalf(data[i] ?? 0);
    tex = new THREE.DataTexture(buf as Uint16Array<ArrayBuffer>, size, size, THREE.RGBAFormat, THREE.HalfFloatType);
  } else {
    tex = new THREE.DataTexture(data as Float32Array<ArrayBuffer>, size, size, THREE.RGBAFormat, THREE.FloatType);
  }
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

export class Simulation {
  readonly size: number;
  readonly count: number;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: THREE.Mesh;
  private readonly posRT: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private readonly velRT: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private readonly velMat: THREE.ShaderMaterial;
  private readonly posMat: THREE.ShaderMaterial;
  private readonly copyMat: THREE.ShaderMaterial;
  private readonly targetTex: THREE.DataTexture;
  private read: 0 | 1 = 0;
  private write: 0 | 1 = 1;
  private time = 0;

  constructor(renderer: THREE.WebGLRenderer, requested: number, half: boolean) {
    this.renderer = renderer;
    this.size = Math.ceil(Math.sqrt(requested));
    this.count = this.size * this.size;

    const type = half ? THREE.HalfFloatType : THREE.FloatType;
    const rtOpts: THREE.RenderTargetOptions = {
      type,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
    };
    this.posRT = [
      new THREE.WebGLRenderTarget(this.size, this.size, rtOpts),
      new THREE.WebGLRenderTarget(this.size, this.size, rtOpts),
    ];
    this.velRT = [
      new THREE.WebGLRenderTarget(this.size, this.size, rtOpts),
      new THREE.WebGLRenderTarget(this.size, this.size, rtOpts),
    ];

    const header = fragHeader(this.size);
    this.velMat = new THREE.ShaderMaterial({
      uniforms: {
        uPos: { value: null },
        uVel: { value: null },
        uTarget: { value: null },
        uTime: { value: 0 },
        uDt: { value: 1 / 60 },
        uBlend: { value: 0 },
        uSigStrength: { value: 0 },
        uAmbient: { value: 1 },
        uFormation: { value: 0 },
        uTurb: { value: 0 },
        uSigA: { value: 12 },
        uSigB: { value: 12 },
        uPointer: { value: new THREE.Vector3() },
        uPointerVel: { value: new THREE.Vector3() },
        uPointerActive: { value: 0 },
      },
      vertexShader: QUAD_VERT,
      fragmentShader:
        header +
        GLSL_NOISE +
        GLSL_SIGNATURES +
        /* glsl */ `
        uniform sampler2D uPos, uVel, uTarget;
        uniform float uTime, uDt, uBlend, uSigStrength, uAmbient, uFormation, uTurb, uPointerActive;
        uniform int uSigA, uSigB;
        uniform vec3 uPointer, uPointerVel;
        varying vec2 vUv;
        void main(){
          vec4 P = texture2D(uPos, vUv); vec3 p = P.xyz; float seed = P.w;
          vec3 vel = texture2D(uVel, vUv).xyz;
          float id = floor(vUv.y * RES) * RES + floor(vUv.x * RES);
          vec3 curl = curlNoise(p * 0.045 + vec3(uTime * 0.05));
          vec3 fA = sigForce(uSigA, p, vel, id, seed, uTime, curl);
          vec3 fB = sigForce(uSigB, p, vel, id, seed, uTime, curl);
          vec3 sig = mix(fA, fB, uBlend) * uSigStrength;
          vec3 amb = curl * (6.0 * uAmbient + uTurb * 10.0);
          vec4 T = texture2D(uTarget, vUv);
          vec3 form = (T.xyz - p) * T.w * uFormation * 5.0;
          vec3 ptr = vec3(0.0);
          if (uPointerActive > 0.5) {
            vec3 pd = p - uPointer; float pr = length(pd) + 0.6;
            ptr = (pd / pr) * (150.0 / (pr * pr)) + uPointerVel * exp(-pr * 0.12);
          }
          vec3 b = vec3(0.0);
          b.x = -max(abs(p.x) - FX, 0.0) * sign(p.x) * 8.0;
          b.y = -max(abs(p.y) - FY, 0.0) * sign(p.y) * 8.0;
          b.z = -max(abs(p.z) - FZ, 0.0) * sign(p.z) * 8.0;
          vec3 acc = sig + amb + form + ptr + b;
          vel = vel * 0.90 + acc * uDt;
          float sp = length(vel);
          if (sp > 34.0) vel *= 34.0 / sp;
          gl_FragColor = vec4(vel, 1.0);
        }
        `,
    });

    this.posMat = new THREE.ShaderMaterial({
      uniforms: {
        uPos: { value: null },
        uVel: { value: null },
        uDt: { value: 1 / 60 },
      },
      vertexShader: QUAD_VERT,
      fragmentShader:
        header +
        /* glsl */ `
        uniform sampler2D uPos, uVel; uniform float uDt;
        varying vec2 vUv;
        void main(){
          vec4 P = texture2D(uPos, vUv);
          vec3 vel = texture2D(uVel, vUv).xyz;
          vec3 p = P.xyz + vel * uDt;
          gl_FragColor = vec4(p, P.w); // keep the per-particle seed in .w
        }
        `,
    });

    this.copyMat = new THREE.ShaderMaterial({
      uniforms: { uSrc: { value: null } },
      vertexShader: QUAD_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D uSrc; varying vec2 vUv;
        void main(){ gl_FragColor = texture2D(uSrc, vUv); }
      `,
    });

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.copyMat);
    this.scene.add(this.quad);

    // Seed both read targets from the initial cloud, then release the seeds.
    const init = initialState(this.count);
    const seedPos = dataTexture(init.pos, this.size, half);
    const seedVel = dataTexture(init.vel, this.size, half);
    this.blit(seedPos, this.posRT[this.read]);
    this.blit(seedVel, this.velRT[this.read]);
    seedPos.dispose();
    seedVel.dispose();

    // Target texture starts empty (w=0 ⇒ no pull), updated by setTarget().
    this.targetTex = dataTexture(new Float32Array(this.count * 4), this.size, half);
    this.velMat.uniforms['uTarget']!.value = this.targetTex;
  }

  private blit(src: THREE.Texture, dst: THREE.WebGLRenderTarget): void {
    this.copyMat.uniforms['uSrc']!.value = src;
    this.quad.material = this.copyMat;
    this.renderer.setRenderTarget(dst);
    this.renderer.render(this.scene, this.camera);
  }

  /** Replace the formation target points (RGBA-per-particle, xyz + w). */
  setTarget(points: Float32Array): void {
    const img = this.targetTex.image.data as unknown as Uint16Array | Float32Array;
    if (img instanceof Float32Array) {
      img.set(points);
    } else {
      for (let i = 0; i < points.length; i++) img[i] = toHalf(points[i] ?? 0);
    }
    this.targetTex.needsUpdate = true;
  }

  /** Advance one fixed step; returns the current position + velocity textures. */
  step(dt: number, u: SimUniforms): { position: THREE.Texture; velocity: THREE.Texture } {
    this.time += dt;
    const vu = this.velMat.uniforms;
    vu['uTime']!.value = this.time;
    vu['uDt']!.value = dt;
    vu['uBlend']!.value = u.blend;
    vu['uSigStrength']!.value = u.sigStrength;
    vu['uAmbient']!.value = u.ambient;
    vu['uFormation']!.value = u.formation;
    vu['uTurb']!.value = u.turbulence;
    vu['uSigA']!.value = u.sigA;
    vu['uSigB']!.value = u.sigB;
    (vu['uPointer']!.value as THREE.Vector3).copy(u.pointer);
    (vu['uPointerVel']!.value as THREE.Vector3).copy(u.pointerVel);
    vu['uPointerActive']!.value = u.pointerActive;

    // Velocity pass: read current pos+vel → write next vel.
    vu['uPos']!.value = this.posRT[this.read].texture;
    vu['uVel']!.value = this.velRT[this.read].texture;
    this.quad.material = this.velMat;
    this.renderer.setRenderTarget(this.velRT[this.write]);
    this.renderer.render(this.scene, this.camera);

    // Position pass: integrate with the freshly-written velocity.
    const pu = this.posMat.uniforms;
    pu['uPos']!.value = this.posRT[this.read].texture;
    pu['uVel']!.value = this.velRT[this.write].texture;
    pu['uDt']!.value = dt;
    this.quad.material = this.posMat;
    this.renderer.setRenderTarget(this.posRT[this.write]);
    this.renderer.render(this.scene, this.camera);

    this.renderer.setRenderTarget(null);
    this.read = this.read === 0 ? 1 : 0;
    this.write = this.write === 0 ? 1 : 0;
    return { position: this.posRT[this.read].texture, velocity: this.velRT[this.read].texture };
  }

  /** Current textures without stepping (for the first render before step). */
  current(): { position: THREE.Texture; velocity: THREE.Texture } {
    return { position: this.posRT[this.read].texture, velocity: this.velRT[this.read].texture };
  }

  dispose(): void {
    this.posRT.forEach((rt) => rt.dispose());
    this.velRT.forEach((rt) => rt.dispose());
    this.velMat.dispose();
    this.posMat.dispose();
    this.copyMat.dispose();
    this.targetTex.dispose();
    (this.quad.geometry as THREE.BufferGeometry).dispose();
  }
}
