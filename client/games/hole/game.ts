// hole — MAWTOWN (MECHANICS §11). Box3D + three.js. Hole.io-like: drag-steer a
// kinematic ring "maw" through a toy city. Props smaller than the maw get the
// ground bit cleared from their collision mask and physically FALL THROUGH the
// plane into an under-world funnel; a sensor under the plane counts the
// swallow (+mass %, +growth). Too-big props are pushed by the ring — physics
// decides. Twist: swallowed bodies persist in a pit heap; at run end the
// camera dives through the maw and orbits "your meal" before endRun.
//
// Engine workarounds (honesty log, PRD principle 3):
// - Box3D default filter category = ALL bits (ENGINE-NOTES §1) → every body
//   gets an explicit category AND mask on both sides of each intended pair.
// - Swallow sensor sits 1.6 m below the plane (guidance sketched 4 m): at 4 m
//   it would slice through the funnel plates and a prop could come to rest on
//   the funnel above it without ever crossing. Above the funnel top, every
//   fallen prop provably crosses it exactly once.
// - Box3D has no shape rescale → the ring compound is destroyed + recreated
//   when the radius grows > 0.06 m (cheap; noted in ENGINE-NOTES as safe).
// - The ring only collides with props currently too big to eat (props are
//   re-filtered between SMALL/BIG categories as the hole grows); otherwise the
//   ring wall would block edible props from ever entering the maw.

import * as THREE from 'three';
import type { Game, GameContext } from '@sdk/types';
import type { Physics3D, BodyState3D, HitEvent, PairEvent } from '@sdk/physics3d';
import { BODY_STATIC, BODY_KINEMATIC, BODY_DYNAMIC, SHAPE_SENSOR, SHAPE_HIT_EVENTS } from '@sdk/physics3d';
import { gameMeta } from '@shared/registry';

// ---- collision categories (explicit on BOTH sides — ENGINE-NOTES §1) ----
const CAT_GROUND = 2; // plane + border walls: the bit swallowed props stop colliding with
const CAT_SMALL = 4; // props currently edible (pass through the ring)
const CAT_BIG = 8; // props too big (pushed by the ring)
const CAT_RING = 16; // the kinematic maw ring
const CAT_UNDER = 32; // funnel, pit floor, swallow sensor
const MASK_ALL = 0xffffffff;
const MASK_SMALL = MASK_ALL & ~CAT_RING; // edible: everything except the ring
const MASK_FALLING = MASK_SMALL & ~CAT_GROUND; // swallowing: also ignore the ground

// ---- tuning ----
const RUN_TIME = 90;
const REVEAL_TIME = 3.2;
const TEACH_TIME = 5;
const CITY_HALF = 22;
const GROUND_HALF = CITY_HALF + 6;
const HOLE_R0 = 0.62;
const HOLE_R_GAIN = 2.15; // R = R0 + GAIN·(1 − e^(−growth/TAU))
const HOLE_R_TAU = 190;
const MAX_SPEED = 7;
const DRAG_SENS = 0.055; // world units per CSS px of drag
const WAKE_FACTOR = 3; // props wake to dynamic within 3× hole radius
const RING_SEGS = 8;
const RING_T = 0.35;
const RING_HALF_H = 0.6;
const RING_Y = 0.42;
const RING_REBUILD_DELTA = 0.06;
const SENSOR_Y = -1.6;
const FUNNEL_TOP = -2.6;
const FUNNEL_ANGLE = 0.49; // ~28° — steep + slick so nothing rests mid-funnel
const SHAFT_HALF = 3.4;
const SUBSTEPS = 4;
const TREMBLE_PERIOD = 0.12;
const COMBO_WINDOW = 1.15;
const PARTICLE_POOL = 36;

// ---- prop classes (crates → cars → trees → houses → landmark, MECHANICS §11) ----
const CLS_CRATE = 0;
const CLS_CAR = 1;
const CLS_TREE = 2;
const CLS_HOUSE = 3;
const CLS_LANDMARK = 4;
/** mass = score weight (score is % of town mass), growth feeds the radius curve, freq = gulp pitch (bigger = lower). */
const CLASSES = [
  { mass: 0.35, growth: 1.0, freq: 540 },
  { mass: 1.3, growth: 2.2, freq: 360 },
  { mass: 1.6, growth: 2.6, freq: 300 },
  { mass: 7, growth: 6, freq: 210 },
  { mass: 22, growth: 14, freq: 130 },
] as const;
const N_CRATE = 65;
const N_CAR = 24;
const N_TREE = 30;
const N_HOUSE = 22;
const N_LANDMARK = 2;

interface Prop {
  handle: number;
  root: THREE.Group;
  cls: number;
  size: number; // max horizontal footprint (m) — edibility test vs hole diameter
  mass: number;
  growth: number;
  engMass: number; // engine mass once dynamic (for honest force scaling)
  dynamic: boolean;
  big: boolean; // currently in CAT_BIG (collides with the ring)
  swallowing: boolean; // ground bit cleared, falling through
  eaten: boolean; // counted by the under-plane sensor
  x: number;
  z: number;
}

interface Particle {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  active: boolean;
}

function yawQuat(a: number): [number, number, number, number] {
  return [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
}

export function createGame(): Game {
  const meta = gameMeta('hole')!;
  let ctx: GameContext;
  let phys: Physics3D;

  // three.js
  let renderer: THREE.WebGLRenderer;
  let scene: THREE.Scene;
  let camera: THREE.PerspectiveCamera;
  let boxGeo: THREE.BoxGeometry;
  let discGeo: THREE.CircleGeometry;
  let rimGeo: THREE.TorusGeometry;
  let disc: THREE.Mesh;
  let rim: THREE.Mesh;
  let rimMat: THREE.MeshBasicMaterial;
  let cityGroup: THREE.Group;
  let particleGroup: THREE.Group;
  let mats: {
    crate: THREE.Material[];
    car: THREE.Material[];
    trunk: THREE.Material;
    leaf: THREE.Material[];
    wall: THREE.Material[];
    roof: THREE.Material[];
    landmark: THREE.Material;
  };

  // physics/world state
  const props: Prop[] = [];
  let ringHandle = -1;
  let ringBuiltR = 0;
  const tmp: BodyState3D = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, awake: false, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 };
  const hit: HitEvent = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, speed: 0, slotA: 0, userA: 0, slotB: 0, userB: 0 };
  const pair: PairEvent = { slotA: 0, userA: 0, slotB: 0, userB: 0 };

  // run state
  let mode: 'idle' | 'play' | 'reveal' | 'over' = 'idle';
  let time = 0;
  let revealT = 0;
  let holeX = 0;
  let holeZ = 14;
  let holeR = HOLE_R0;
  let rVis = HOLE_R0;
  let velX = 0;
  let velZ = 0;
  let growthAccum = 0;
  let massEaten = 0;
  let totalMass = 1;
  let score = 0;
  let propsEaten = 0;
  let landmarksEaten = 0;
  let combo = 0;
  let comboTimer = 0;
  let maxFeast = 0;
  let trembleClock = 0;
  let swallowGlow = 0;
  let dragDX = 0;
  let dragDY = 0;
  let lastSub = '';
  let lastTickSecond = -1;
  let orbA = Math.PI / 3;
  let ended = false;
  const detachFns: (() => void)[] = [];
  const camTarget = new THREE.Vector3(); // reused — no per-frame allocation

  // visual-only rng (particles) — separate stream so gameplay determinism
  // never depends on visual toggles like reducedMotion.
  let vseed = 1;
  function vrand(): number {
    vseed = (vseed * 1664525 + 1013904223) >>> 0;
    return vseed / 0x100000000;
  }

  const particles: Particle[] = [];

  function radiusFor(growth: number): number {
    return HOLE_R0 + HOLE_R_GAIN * (1 - Math.exp(-growth / HOLE_R_TAU));
  }

  // ---- mesh helpers (shared unit geometry, shared materials — no per-run GPU churn) ----

  function boxMesh(mat: THREE.Material, sx: number, sy: number, sz: number, x = 0, y = 0, z = 0): THREE.Mesh {
    const m = new THREE.Mesh(boxGeo, mat);
    m.scale.set(sx, sy, sz);
    m.position.set(x, y, z);
    return m;
  }

  // ---- static under/over-world (built once per run — bodies; visuals persist across runs) ----

  function buildStaticWorld(): void {
    // ground slab: cat GROUND — the bit swallowed props stop colliding with
    const ground = phys.createBody({ type: BODY_STATIC, position: [0, -0.5, 0] });
    phys.addBox(ground, GROUND_HALF, 0.5, GROUND_HALF, { friction: 0.55 });
    phys.setFilter(ground, CAT_GROUND, MASK_ALL);
    phys.setUserData(ground, 0);

    // border walls keep pushed props inside the city (hole is clamped in code)
    const wallDefs: [number, number, number, number, number, number][] = [
      [0, 2, -(CITY_HALF + 0.5), CITY_HALF + 1, 2, 0.5],
      [0, 2, CITY_HALF + 0.5, CITY_HALF + 1, 2, 0.5],
      [-(CITY_HALF + 0.5), 2, 0, 0.5, 2, CITY_HALF + 1],
      [CITY_HALF + 0.5, 2, 0, 0.5, 2, CITY_HALF + 1],
    ];
    for (const [x, y, z, hx, hy, hz] of wallDefs) {
      const wall = phys.createBody({ type: BODY_STATIC, position: [x, y, z] });
      phys.addBox(wall, hx, hy, hz, { friction: 0.2 });
      phys.setFilter(wall, CAT_GROUND, CAT_SMALL | CAT_BIG);
      phys.setUserData(wall, 0);
    }

    // swallow sensor — a thin slab just under the plane, above the funnel top
    const sensor = phys.createBody({ type: BODY_STATIC, position: [0, SENSOR_Y, 0] });
    phys.addBox(sensor, GROUND_HALF, 0.5, GROUND_HALF, { flags: SHAPE_SENSOR });
    phys.setFilter(sensor, CAT_UNDER, CAT_SMALL | CAT_BIG);
    phys.setUserData(sensor, 0);

    // under-world funnel: 4 slick sloped plates guide every swallowed body to
    // one central heap (the twist needs ONE pile, not scatter)
    const run = GROUND_HALF - SHAFT_HALF;
    const drop = run * Math.tan(FUNNEL_ANGLE);
    const slopeHalf = run / Math.cos(FUNNEL_ANGLE) / 2 + 0.6;
    const midY = FUNNEL_TOP - drop / 2;
    const midR = (SHAFT_HALF + GROUND_HALF) / 2;
    const s = Math.sin(FUNNEL_ANGLE / 2);
    const c = Math.cos(FUNNEL_ANGLE / 2);
    const plates: { p: [number, number, number]; q: [number, number, number, number]; h: [number, number, number] }[] = [
      { p: [midR, midY, 0], q: [0, 0, s, c], h: [slopeHalf, 0.4, GROUND_HALF] },
      { p: [-midR, midY, 0], q: [0, 0, -s, c], h: [slopeHalf, 0.4, GROUND_HALF] },
      { p: [0, midY, midR], q: [-s, 0, 0, c], h: [GROUND_HALF, 0.4, slopeHalf] },
      { p: [0, midY, -midR], q: [s, 0, 0, c], h: [GROUND_HALF, 0.4, slopeHalf] },
    ];
    for (const pl of plates) {
      const b = phys.createBody({ type: BODY_STATIC, position: pl.p, rotation: pl.q });
      phys.addBox(b, pl.h[0], pl.h[1], pl.h[2], { friction: 0.05, restitution: 0 });
      phys.setFilter(b, CAT_UNDER, CAT_SMALL | CAT_BIG);
      phys.setUserData(b, 0);
    }

    // pit floor under the shaft opening — the meal heaps here
    const floorY = FUNNEL_TOP - drop - 0.8;
    const pit = phys.createBody({ type: BODY_STATIC, position: [0, floorY, 0] });
    phys.addBox(pit, SHAFT_HALF + 3, 0.4, SHAFT_HALF + 3, { friction: 0.7 });
    phys.setFilter(pit, CAT_UNDER, CAT_SMALL | CAT_BIG);
    phys.setUserData(pit, 0);
  }

  // ---- the maw ring: kinematic compound of 8 boxes, rebuilt as it grows ----

  function buildRing(): void {
    if (ringHandle >= 0 && phys.isValid(ringHandle)) phys.destroyBody(ringHandle);
    ringHandle = phys.createBody({ type: BODY_KINEMATIC, position: [holeX, 0, holeZ] });
    const rc = holeR + RING_T / 2;
    const halfLen = rc * Math.tan(Math.PI / RING_SEGS) + 0.06;
    for (let i = 0; i < RING_SEGS; i++) {
      const a = (i / RING_SEGS) * Math.PI * 2;
      phys.addBoxOffset(ringHandle, halfLen, RING_HALF_H, RING_T / 2, [Math.cos(a) * rc, RING_Y, Math.sin(a) * rc], yawQuat(-(a + Math.PI / 2)), {
        density: 1,
        friction: 0.25,
      });
    }
    phys.setFilter(ringHandle, CAT_RING, CAT_BIG); // only pushes what the maw can't eat
    phys.setUserData(ringHandle, 0);
    ringBuiltR = holeR;
  }

  // ---- city generation (all layout randomness via ctx.rng — seeded) ----

  function spawnProp(cls: number, x: number, z: number, yaw: number): void {
    const rng = ctx.rng;
    const root = new THREE.Group();
    let size = 1;
    let bodyY = 0.5;
    let handle = -1;

    if (cls === CLS_CRATE) {
      const sBox = rng.range(0.55, 0.85);
      size = sBox;
      bodyY = sBox / 2;
      handle = phys.createBody({ type: BODY_STATIC, position: [x, bodyY, z], rotation: yawQuat(yaw) });
      phys.addBox(handle, sBox / 2, sBox / 2, sBox / 2, { density: 1, friction: 0.45, restitution: 0.05, flags: SHAPE_HIT_EVENTS });
      root.add(boxMesh(ctx.rng.pick(mats.crate), sBox, sBox, sBox));
    } else if (cls === CLS_CAR) {
      const len = rng.range(1.35, 1.55);
      const wid = len * 0.5;
      size = len;
      bodyY = 0.23;
      handle = phys.createBody({ type: BODY_STATIC, position: [x, bodyY, z], rotation: yawQuat(yaw) });
      phys.addBox(handle, len / 2, 0.22, wid / 2, { density: 1, friction: 0.4, restitution: 0.05, flags: SHAPE_HIT_EVENTS });
      phys.addBoxOffset(handle, len * 0.22, 0.15, wid * 0.38, [-len * 0.05, 0.34, 0], [0, 0, 0, 1], { density: 1, friction: 0.4 });
      const mat = ctx.rng.pick(mats.car);
      root.add(boxMesh(mat, len, 0.44, wid));
      root.add(boxMesh(mat, len * 0.44, 0.3, wid * 0.76, -len * 0.05, 0.34, 0));
    } else if (cls === CLS_TREE) {
      const cw = rng.range(1.6, 1.9);
      size = cw;
      bodyY = 0.45;
      handle = phys.createBody({ type: BODY_STATIC, position: [x, bodyY, z], rotation: yawQuat(yaw) });
      phys.addBox(handle, 0.1, 0.45, 0.1, { density: 1, friction: 0.45, flags: SHAPE_HIT_EVENTS });
      phys.addBoxOffset(handle, cw / 2, cw * 0.42, cw / 2, [0, 0.45 + cw * 0.42, 0], [0, 0, 0, 1], { density: 0.4, friction: 0.45 });
      root.add(boxMesh(mats.trunk, 0.2, 0.9, 0.2));
      root.add(boxMesh(ctx.rng.pick(mats.leaf), cw, cw * 0.84, cw, 0, 0.45 + cw * 0.42, 0));
    } else if (cls === CLS_HOUSE) {
      const w = rng.range(2.0, 2.6);
      const d = w * rng.range(0.75, 0.95);
      size = w;
      bodyY = 0.65;
      handle = phys.createBody({ type: BODY_STATIC, position: [x, bodyY, z], rotation: yawQuat(yaw) });
      phys.addBox(handle, w / 2, 0.65, d / 2, { density: 1, friction: 0.5, restitution: 0.02, flags: SHAPE_HIT_EVENTS });
      phys.addBoxOffset(handle, w * 0.44, 0.32, d * 0.44, [0, 0.97, 0], [0, 0, 0, 1], { density: 0.5, friction: 0.5 });
      root.add(boxMesh(ctx.rng.pick(mats.wall), w, 1.3, d));
      root.add(boxMesh(ctx.rng.pick(mats.roof), w * 0.88, 0.64, d * 0.88, 0, 0.97, 0));
    } else {
      const w = rng.range(3.2, 3.6);
      size = w;
      bodyY = 1.1;
      handle = phys.createBody({ type: BODY_STATIC, position: [x, bodyY, z], rotation: yawQuat(yaw) });
      phys.addBox(handle, w / 2, 1.1, w / 2, { density: 1, friction: 0.5, restitution: 0.02, flags: SHAPE_HIT_EVENTS });
      phys.addBoxOffset(handle, w * 0.36, 0.9, w * 0.36, [0, 2.0, 0], [0, 0, 0, 1], { density: 0.8, friction: 0.5 });
      phys.addBoxOffset(handle, w * 0.2, 0.7, w * 0.2, [0, 3.6, 0], [0, 0, 0, 1], { density: 0.6, friction: 0.5 });
      root.add(boxMesh(mats.landmark, w, 2.2, w));
      root.add(boxMesh(mats.landmark, w * 0.72, 1.8, w * 0.72, 0, 2.0, 0));
      root.add(boxMesh(mats.landmark, w * 0.4, 1.4, w * 0.4, 0, 3.6, 0));
    }

    const clsDef = CLASSES[cls]!;
    // everything starts too big to eat until proven otherwise by reclassify()
    phys.setFilter(handle, CAT_BIG, MASK_ALL);
    phys.setUserData(handle, props.length + 1); // 1-based; 0 = world
    root.position.set(x, bodyY, z);
    root.quaternion.set(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
    cityGroup.add(root);
    props.push({
      handle,
      root,
      cls,
      size,
      mass: clsDef.mass,
      growth: clsDef.growth,
      engMass: clsDef.mass,
      dynamic: false,
      big: true,
      swallowing: false,
      eaten: false,
      x,
      z,
    });
  }

  function buildCity(): void {
    const spots: { x: number; z: number; r: number }[] = [];
    const place = (minX: number, maxX: number, minZ: number, maxZ: number, r: number): { x: number; z: number } | null => {
      for (let attempt = 0; attempt < 40; attempt++) {
        const x = ctx.rng.range(minX, maxX);
        const z = ctx.rng.range(minZ, maxZ);
        if (Math.hypot(x - holeX, z - holeZ) < r + 1.2) continue; // keep the spawn clear (first food nearby)
        let ok = true;
        for (const p of spots) {
          if (Math.hypot(x - p.x, z - p.z) < r + p.r + 0.3) {
            ok = false;
            break;
          }
        }
        if (ok) {
          spots.push({ x, z, r });
          return { x, z };
        }
      }
      return null;
    };

    // landmarks first (they anchor the route: streets → suburbs → landmark)
    for (let i = 0; i < N_LANDMARK; i++) {
      const bx = i === 0 ? -10 : 11;
      const bz = i === 0 ? -14 : -15;
      const p = place(bx - 2, bx + 2, bz - 2, bz + 2, 2.6) ?? { x: bx, z: bz };
      spawnProp(CLS_LANDMARK, p.x, p.z, ctx.rng.range(-0.2, 0.2));
    }
    // houses: north suburbs, off the main street
    for (let i = 0; i < N_HOUSE; i++) {
      const side = ctx.rng.chance(0.5) ? 1 : -1;
      const p = place(side > 0 ? 4.5 : -19, side > 0 ? 19 : -4.5, -17, 3, 1.7);
      if (p) spawnProp(CLS_HOUSE, p.x, p.z, ctx.rng.range(-0.25, 0.25));
    }
    // trees: side avenues
    for (let i = 0; i < N_TREE; i++) {
      const side = ctx.rng.chance(0.5) ? 1 : -1;
      const p = place(side > 0 ? 11 : -19.5, side > 0 ? 19.5 : -11, -18, 18, 1.2);
      if (p) spawnProp(CLS_TREE, p.x, p.z, ctx.rng.range(0, Math.PI));
    }
    // cars: the main street (north-south) + one cross street
    for (let i = 0; i < N_CAR; i++) {
      const cross = i >= N_CAR - 6;
      const p = cross ? place(-16, 16, 6.5, 9.5, 1.0) : place(-3, 3, -18, 18, 1.0);
      if (p) spawnProp(CLS_CAR, p.x, p.z, (cross ? 0 : Math.PI / 2) + ctx.rng.range(-0.15, 0.15));
    }
    // crates: heavy cluster around the spawn (first food), some scattered mid-city
    for (let i = 0; i < N_CRATE; i++) {
      const south = i < 45;
      const p = south ? place(-17, 17, 4, 19, 0.6) : place(-17, 17, -8, 4, 0.6);
      if (p) spawnProp(CLS_CRATE, p.x, p.z, ctx.rng.range(0, Math.PI));
    }

    totalMass = 0;
    for (const p of props) totalMass += p.mass;
    reclassify();
  }

  /** Move props across the SMALL/BIG ring-collision boundary as the hole grows. */
  function reclassify(): void {
    const edible = holeR * 2 * 0.98;
    for (const p of props) {
      if (p.eaten || p.swallowing) continue;
      const shouldBeBig = p.size >= edible;
      if (shouldBeBig !== p.big) {
        p.big = shouldBeBig;
        phys.setFilter(p.handle, shouldBeBig ? CAT_BIG : CAT_SMALL, shouldBeBig ? MASK_ALL : MASK_SMALL);
      }
    }
  }

  // ---- juice ----

  function gulpAudio(cls: number): void {
    const def = CLASSES[cls]!;
    ctx.audio.note(def.freq, { dur: 0.22, type: 'sine', vol: 0.2, slideTo: def.freq * 0.42 });
    ctx.audio.noise({ dur: 0.1, vol: 0.07, freq: def.freq * 1.8, q: 1.2 });
    ctx.audio.buzz(cls >= CLS_HOUSE ? 25 : 12);
  }

  function spawnRimBurst(count: number): void {
    if (ctx.settings().reducedMotion) return;
    let spawned = 0;
    for (const p of particles) {
      if (p.active) continue;
      const a = vrand() * Math.PI * 2;
      const r = holeR * (0.85 + vrand() * 0.25);
      p.mesh.position.set(holeX + Math.cos(a) * r, 0.25 + vrand() * 0.3, holeZ + Math.sin(a) * r);
      p.vx = -Math.cos(a) * (1.5 + vrand() * 2);
      p.vz = -Math.sin(a) * (1.5 + vrand() * 2);
      p.vy = 0.4 + vrand() * 1.2;
      p.life = 0;
      p.active = true;
      p.mesh.visible = true;
      p.mat.opacity = 0.9;
      if (++spawned >= count) break;
    }
  }

  function updateParticles(dt: number): void {
    for (const p of particles) {
      if (!p.active) continue;
      p.life += dt;
      const t = p.life / 0.45;
      if (t >= 1) {
        p.active = false;
        p.mesh.visible = false;
        continue;
      }
      p.vy -= 9 * dt;
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;
      p.mat.opacity = 0.9 * (1 - t);
    }
  }

  function onSwallowCounted(p: Prop): void {
    p.eaten = true;
    propsEaten += 1;
    massEaten += p.mass;
    growthAccum += p.growth;
    holeR = radiusFor(growthAccum);
    score = Math.min(100, Math.round((massEaten / totalMass) * 100));
    ctx.hud.setScore(score);
    swallowGlow = 1;

    combo = comboTimer > 0 ? combo + 1 : 1;
    comboTimer = COMBO_WINDOW;
    maxFeast = Math.max(maxFeast, combo);
    if (combo >= 3) {
      ctx.hud.showCombo(`FEAST ×${combo}`, combo >= 6);
      ctx.audio.pop(Math.min(combo, 8));
    }

    gulpAudio(p.cls);
    spawnRimBurst(p.cls >= CLS_HOUSE ? 8 : 5);
    if (p.cls === CLS_LANDMARK) {
      landmarksEaten += 1;
      ctx.hud.flash('LANDMARK DEVOURED', 1100);
      ctx.audio.fanfare();
      ctx.audio.buzz(40);
    }
    reclassify();
  }

  function finalize(): void {
    if (ended) return;
    ended = true;
    mode = 'over';
    ctx.endRun({
      score,
      durationMs: 0,
      seed: 0,
      stats: { landmarks: landmarksEaten, props: propsEaten, feast: maxFeast },
    });
  }

  function setSub(text: string): void {
    if (text !== lastSub) {
      lastSub = text;
      ctx.hud.setSub(text);
    }
  }

  return {
    meta,

    async init(context: GameContext): Promise<void> {
      ctx = context;
      phys = await ctx.physics3d();
      const colors = ctx.colors();

      renderer = new THREE.WebGLRenderer({ canvas: ctx.canvas, antialias: true });
      renderer.setPixelRatio(ctx.dpr);

      scene = new THREE.Scene();
      scene.background = new THREE.Color(colors.bg);
      scene.fog = new THREE.Fog(colors.bg, 55, 130);

      camera = new THREE.PerspectiveCamera(46, 1, 0.1, 300);
      scene.add(new THREE.HemisphereLight('#cfe0ff', '#40324a', 0.95));
      const sun = new THREE.DirectionalLight('#fff1d6', 1.6);
      sun.position.set(12, 24, 8);
      scene.add(sun);
      const pitLight = new THREE.PointLight('#ffb47a', 60, 60);
      pitLight.position.set(0, FUNNEL_TOP - 6, 0);
      scene.add(pitLight);

      boxGeo = new THREE.BoxGeometry(1, 1, 1);
      discGeo = new THREE.CircleGeometry(1, 48);
      rimGeo = new THREE.TorusGeometry(1, 0.045, 8, 48);

      // ground slab (a box, so the run-end dive reads as an under-world cross-section)
      const groundMat = new THREE.MeshLambertMaterial({ color: colors.surface });
      const groundMesh = boxMesh(groundMat, GROUND_HALF * 2, 1, GROUND_HALF * 2, 0, -0.5, 0);
      scene.add(groundMesh);
      // street decals guide the route
      const streetMat = new THREE.MeshLambertMaterial({ color: colors.bg });
      const street = boxMesh(streetMat, 7, 0.04, CITY_HALF * 2, 0, 0.02, 0);
      scene.add(street);
      const cross = boxMesh(streetMat, CITY_HALF * 2, 0.04, 3.4, 0, 0.02, 8);
      scene.add(cross);

      // funnel + pit visuals mirror the physics plates
      const underMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(colors.bg).multiplyScalar(0.55) });
      const run = GROUND_HALF - SHAFT_HALF;
      const drop = run * Math.tan(FUNNEL_ANGLE);
      const slopeHalf = run / Math.cos(FUNNEL_ANGLE) / 2 + 0.6;
      const midY = FUNNEL_TOP - drop / 2;
      const midR = (SHAFT_HALF + GROUND_HALF) / 2;
      const mk = (px: number, py: number, pz: number, qx: number, qy: number, qz: number, qw: number, hx: number, hy: number, hz: number): void => {
        const m = boxMesh(underMat, hx * 2, hy * 2, hz * 2, px, py, pz);
        m.quaternion.set(qx, qy, qz, qw);
        scene.add(m);
      };
      const fs = Math.sin(FUNNEL_ANGLE / 2);
      const fc = Math.cos(FUNNEL_ANGLE / 2);
      mk(midR, midY, 0, 0, 0, fs, fc, slopeHalf, 0.4, GROUND_HALF);
      mk(-midR, midY, 0, 0, 0, -fs, fc, slopeHalf, 0.4, GROUND_HALF);
      mk(0, midY, midR, -fs, 0, 0, fc, GROUND_HALF, 0.4, slopeHalf);
      mk(0, midY, -midR, fs, 0, 0, fc, GROUND_HALF, 0.4, slopeHalf);
      mk(0, FUNNEL_TOP - drop - 0.8, 0, 0, 0, 0, 1, SHAFT_HALF + 3, 0.4, SHAFT_HALF + 3);

      // the maw: black disc + glowing rim
      disc = new THREE.Mesh(discGeo, new THREE.MeshBasicMaterial({ color: '#05060a' }));
      disc.rotation.x = -Math.PI / 2;
      disc.position.y = 0.05;
      scene.add(disc);
      rimMat = new THREE.MeshBasicMaterial({ color: colors.glow, transparent: true, opacity: 0.85 });
      rim = new THREE.Mesh(rimGeo, rimMat);
      rim.rotation.x = -Math.PI / 2;
      rim.position.y = 0.08;
      scene.add(rim);

      // toy-city material sets (deliberate material colors; landmark uses the palette accent)
      const lam = (color: string): THREE.MeshLambertMaterial => new THREE.MeshLambertMaterial({ color });
      mats = {
        crate: [lam('#c98a4b'), lam('#b9793d'), lam('#d9a05e')],
        car: [lam('#e0524d'), lam('#4d9de0'), lam('#e0b34d'), lam('#7bc96f')],
        trunk: lam('#7a5230'),
        leaf: [lam('#4e9a51'), lam('#3d8a46'), lam('#63b06a')],
        wall: [lam('#e8d8c3'), lam('#d9c2a7'), lam('#e6cfd5'), lam('#cfd8e6')],
        roof: [lam('#a8524d'), lam('#8a5a44')],
        landmark: new THREE.MeshLambertMaterial({ color: colors.accent, emissive: new THREE.Color(colors.glow).multiplyScalar(0.25) }),
      };

      cityGroup = new THREE.Group();
      scene.add(cityGroup);
      particleGroup = new THREE.Group();
      scene.add(particleGroup);
      const pGeo = new THREE.BoxGeometry(0.14, 0.14, 0.14);
      for (let i = 0; i < PARTICLE_POOL; i++) {
        const mat = new THREE.MeshBasicMaterial({ color: colors.glow, transparent: true, opacity: 0.9 });
        const mesh = new THREE.Mesh(pGeo, mat);
        mesh.visible = false;
        particleGroup.add(mesh);
        particles.push({ mesh, mat, vx: 0, vy: 0, vz: 0, life: 0, active: false });
      }

      const resize = (w: number, h: number): void => {
        renderer.setSize(w, h, true);
        camera.aspect = w / h;
        const BASE_FOV = 46;
        if (camera.aspect < 1) {
          const hHalf = Math.tan(THREE.MathUtils.degToRad(BASE_FOV / 2));
          camera.fov = Math.min(THREE.MathUtils.radToDeg(2 * Math.atan(hHalf / camera.aspect)), 84);
        } else {
          camera.fov = BASE_FOV;
        }
        camera.updateProjectionMatrix();
      };
      ctx.onResize(resize);
      resize(ctx.width, ctx.height);

      detachFns.push(
        ctx.input.onDrag((e) => {
          dragDX += e.dx;
          dragDY += e.dy;
        }),
      );
    },

    start(seed: number): void {
      // full reset: world rebuild, meshes cleared (shared geo/mats survive)
      for (const p of props) cityGroup.remove(p.root);
      props.length = 0;
      for (const p of particles) {
        p.active = false;
        p.mesh.visible = false;
      }
      phys.init(0, -10, 0);
      phys.setHitEventThreshold(1.5);
      ringHandle = -1;

      vseed = (seed >>> 0) || 1;
      mode = 'play';
      time = 0;
      revealT = 0;
      holeX = 0;
      holeZ = 14;
      holeR = HOLE_R0;
      rVis = HOLE_R0;
      velX = 0;
      velZ = 0;
      growthAccum = 0;
      massEaten = 0;
      score = 0;
      propsEaten = 0;
      landmarksEaten = 0;
      combo = 0;
      comboTimer = 0;
      maxFeast = 0;
      trembleClock = 0;
      swallowGlow = 0;
      dragDX = 0;
      dragDY = 0;
      lastSub = '';
      lastTickSecond = -1;
      orbA = Math.PI / 3;
      ended = false;

      buildStaticWorld();
      buildCity();
      buildRing();

      camera.position.set(holeX, 9.5 + HOLE_R0 * 5.2, holeZ + 7 + HOLE_R0 * 3.4);
      camera.lookAt(holeX, 0, holeZ - 1.2);

      ctx.hud.setScore(0);
      setSub('drag to steer — eat the small stuff');

      if (import.meta.env.DEV) {
        (window as unknown as Record<string, unknown>)['__holeDbg'] = () => {
          let nearest = Infinity;
          let nearestInfo = '';
          let nearestDx = 0;
          let nearestDz = 0;
          let dyn = 0;
          let swallowingN = 0;
          let eatenN = 0;
          for (const pr of props) {
            if (pr.eaten) {
              eatenN++;
              continue;
            }
            if (pr.dynamic) dyn++;
            if (pr.swallowing) swallowingN++;
            if (pr.big) continue; // aim at edible prey only
            const d = Math.hypot(pr.x - holeX, pr.z - holeZ);
            if (d < nearest) {
              nearest = d;
              nearestDx = pr.x - holeX;
              nearestDz = pr.z - holeZ;
              nearestInfo = `cls=${pr.cls} size=${pr.size.toFixed(2)} big=${pr.big} dyn=${pr.dynamic}`;
            }
          }
          return { mode, holeX, holeZ, holeR, velX, velZ, nearest, nearestDx, nearestDz, nearestInfo, dyn, swallowingN, eatenN, score };
        };
      }
    },

    step(dt: number): void {
      if (mode === 'idle' || mode === 'over') return;
      time += dt;

      // ---- steering (drag = relative velocity; hold still = stop; keys for desktop) ----
      if (mode === 'play') {
        let tvx = 0;
        let tvz = 0;
        const dragMag = Math.abs(dragDX) + Math.abs(dragDY);
        if (dragMag > 0) {
          // mouse pointers cover far more px per gesture than thumbs — tone it down
          const sens = ctx.input.pointerType === 'mouse' ? DRAG_SENS * 0.45 : DRAG_SENS;
          tvx = (dragDX * sens) / dt;
          tvz = (dragDY * sens) / dt;
        } else if (!ctx.input.pointerDown) {
          let kx = ctx.input.axis();
          let kz = 0;
          if (ctx.input.keys.has('ArrowUp') || ctx.input.keys.has('KeyW')) kz -= 1;
          if (ctx.input.keys.has('ArrowDown') || ctx.input.keys.has('KeyS')) kz += 1;
          if (kx !== 0 && kz !== 0) {
            kx *= Math.SQRT1_2;
            kz *= Math.SQRT1_2;
          }
          tvx = kx * MAX_SPEED;
          tvz = kz * MAX_SPEED;
        }
        const tMag = Math.hypot(tvx, tvz);
        if (tMag > MAX_SPEED) {
          tvx = (tvx / tMag) * MAX_SPEED;
          tvz = (tvz / tMag) * MAX_SPEED;
        }
        // snappy toward a fresh drag; glide between drag samples (a held-but-still
        // finger keeps momentum instead of parking the hole every gap between events)
        const blend = dragMag > 0 ? 0.55 : ctx.input.pointerDown ? 0.06 : 0.25;
        velX += (tvx - velX) * blend;
        velZ += (tvz - velZ) * blend;
        dragDX = 0;
        dragDY = 0;

        const lim = CITY_HALF - holeR - 0.5;
        holeX = Math.max(-lim, Math.min(lim, holeX + velX * dt));
        holeZ = Math.max(-lim, Math.min(lim, holeZ + velZ * dt));
      }
      // kinematic target every tick (zero velocity when stationary / during reveal)
      phys.setTargetTransform(ringHandle, holeX, 0, holeZ, 0, 0, 0, 1, dt);

      phys.step(dt, SUBSTEPS);

      // ---- prop pass: wake, swallow-filter, suction, sync ----
      const wakeR = holeR * WAKE_FACTOR;
      const eatR = holeR * 1.05;
      const edible = holeR * 2 * 0.98;
      trembleClock += dt;
      const doTremble = trembleClock >= TREMBLE_PERIOD;
      if (doTremble) trembleClock = 0;
      let trembled = 0;

      for (const p of props) {
        if (p.dynamic) {
          if (phys.readBody(p.handle, tmp)) {
            p.root.position.set(tmp.x, tmp.y, tmp.z);
            p.root.quaternion.set(tmp.qx, tmp.qy, tmp.qz, tmp.qw);
            p.x = tmp.x;
            p.z = tmp.z;
          }
        }
        if (p.eaten) continue;
        const dx = p.x - holeX;
        const dz = p.z - holeZ;
        const dist = Math.hypot(dx, dz);

        if (!p.dynamic) {
          if (dist < wakeR) {
            phys.setBodyType(p.handle, BODY_DYNAMIC);
            phys.setAwake(p.handle, true);
            p.dynamic = true;
            const m = phys.getMass(p.handle);
            if (m > 0) p.engMass = m;
          }
          continue;
        }

        if (p.swallowing) {
          // fell in — pull to center so it clears the rim; count happens at the sensor
          if (p.root.position.y > -1.5 && dist > 0.05) {
            const f = (p.engMass * 8) / dist;
            phys.applyForce(p.handle, -dx * f, 0, -dz * f);
          }
          // escaped sideways while still above the plane → restore the ground bit (visible workaround)
          if (p.root.position.y > -0.1 && dist > holeR * 1.1) {
            p.swallowing = false;
            phys.setFilter(p.handle, CAT_SMALL, MASK_SMALL);
          }
          continue;
        }

        if (!p.big && p.size < edible && dist < eatR) {
          // THE filter trick: clear the ground bit → the engine drops it through the plane
          p.swallowing = true;
          phys.setFilter(p.handle, CAT_SMALL, MASK_FALLING);
          ctx.audio.noise({ dur: 0.08, vol: 0.05, freq: 900, q: 0.8 });
          continue;
        }

        // suction on edible prey near the rim (an applied force, engine integrates)
        if (!p.big && dist < holeR * 2.4 && dist > 0.05) {
          const pull = (p.engMass * 11 * (1 - dist / (holeR * 2.4))) / dist;
          phys.applyForce(p.handle, -dx * pull, 0, -dz * pull);
        }

        // near-swallow-size props tremble (tiny real impulses — the "almost" telegraph)
        if (doTremble && trembled < 8 && p.big && p.size < edible * 1.5 && dist < holeR * 3) {
          const j = p.engMass * 0.22;
          phys.applyImpulse(p.handle, (ctx.rng.float() - 0.5) * j, 0, (ctx.rng.float() - 0.5) * j);
          trembled += 1;
        }
      }

      // ---- swallow counting: the under-plane sensor is the referee ----
      const sensorEvents = phys.sensorBeginCount();
      for (let i = 0; i < sensorEvents; i++) {
        phys.readSensorBegin(i, pair);
        const idx = Math.round(pair.userB) - 1; // visitor user data is 1-based prop index (stored as float)
        if (idx >= 0 && idx < props.length) {
          const p = props[idx]!;
          if (!p.eaten) onSwallowCounted(p);
        }
      }

      // ---- impact thuds (capped) ----
      const hits = phys.hitCount();
      for (let i = 0; i < Math.min(hits, 2); i++) {
        phys.readHit(i, hit);
        ctx.audio.thud(Math.min(hit.speed, 6) * 0.6);
      }

      // ---- ring growth rebuild ----
      if (holeR - ringBuiltR > RING_REBUILD_DELTA) buildRing();

      comboTimer = Math.max(0, comboTimer - dt);
      if (comboTimer === 0 && combo > 0) {
        combo = 0;
        ctx.hud.hideCombo();
      }
      swallowGlow = Math.max(0, swallowGlow - dt * 2.2);
      updateParticles(dt);

      // ---- clock & phases ----
      if (mode === 'play') {
        const remaining = Math.max(0, RUN_TIME - time);
        if (time < TEACH_TIME) {
          setSub('drag to steer — eat the small stuff');
        } else {
          const secs = Math.ceil(remaining);
          const m = Math.floor(secs / 60);
          const ss = String(secs % 60).padStart(2, '0');
          setSub(`${m}:${ss}`);
          if (secs <= 5 && secs !== lastTickSecond) {
            lastTickSecond = secs;
            ctx.audio.tick();
          }
        }
        if (time >= RUN_TIME) {
          mode = 'reveal';
          revealT = 0;
          velX = 0;
          velZ = 0;
          ctx.hud.flash('YOUR MEAL', 1400);
          setSub(`your meal — ${propsEaten} props`);
          ctx.audio.whoosh();
          ctx.audio.note(90, { dur: 0.6, type: 'sine', vol: 0.2, slideTo: 45 });
        }
      } else if (mode === 'reveal') {
        revealT += dt;
        orbA += dt * 0.8;
        if (revealT >= REVEAL_TIME) finalize();
      }
    },

    render(): void {
      const dt = 1 / 60;
      rVis += (holeR - rVis) * Math.min(dt * 6, 1);
      disc.position.set(holeX, 0.05, holeZ);
      disc.scale.setScalar(rVis + RING_T * 0.6);
      rim.position.set(holeX, 0.08, holeZ);
      rim.scale.setScalar(rVis + RING_T * 0.5);
      rimMat.opacity = ctx.settings().reducedMotion ? 0.85 : 0.65 + swallowGlow * 0.35;

      if (mode === 'reveal' || mode === 'over') {
        // the twist: dive through the maw, then orbit the heap
        const heapY = FUNNEL_TOP - (GROUND_HALF - SHAFT_HALF) * Math.tan(FUNNEL_ANGLE) + 1.5;
        if (ctx.settings().reducedMotion) {
          camera.position.set(Math.sin(0.9) * 15, -7, Math.cos(0.9) * 15);
        } else if (revealT < 0.9) {
          camTarget.set(holeX, -3, holeZ);
          camera.position.lerp(camTarget, Math.min(dt * 3.2, 1));
        } else {
          camTarget.set(Math.sin(orbA) * 15, -7 - Math.min(revealT - 0.9, 1) * 2, Math.cos(orbA) * 15);
          camera.position.lerp(camTarget, Math.min(dt * 2.6, 1));
        }
        camera.lookAt(0, heapY, 0);
      } else {
        camTarget.set(holeX, 9.5 + rVis * 5.2, holeZ + 7 + rVis * 3.4);
        camera.position.lerp(camTarget, Math.min(dt * 4.5, 1));
        camera.lookAt(holeX, 0, holeZ - 1.2);
      }

      renderer.render(scene, camera);
    },

    dispose(): void {
      detachFns.forEach((d) => d());
      detachFns.length = 0;
      phys.init(0, -10, 0);
      renderer.dispose();
      boxGeo.dispose();
      discGeo.dispose();
      rimGeo.dispose();
    },
  };
}
