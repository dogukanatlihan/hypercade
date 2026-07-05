// SPIRALFALL — helix (MECHANICS §10). Box3D + three.js.
// A ball bounces in place at a fixed azimuth; horizontal drag rotates the
// HELIX — each layer is one kinematic compound body (wedge boxes in a ring)
// driven with setTargetTransform, so the rotation is engine-real. Falling
// through a gap descends one layer (+1 score); red wedges kill; passing ≥3
// layers in one fall arms SMASH mode (next safe landing breaks the layer,
// pass-through via explicit collision filters — ENGINE-NOTES #1: Box3D default
// category is all-bits, so BOTH sides get explicit categories).

import * as THREE from 'three';
import type { Game, GameContext } from '@sdk/types';
import type { Physics3D, BodyState3D } from '@sdk/physics3d';
import { BODY_DYNAMIC, BODY_KINEMATIC } from '@sdk/physics3d';
import { gameMeta } from '@shared/registry';

// ---- ring geometry ----
const SLOTS = 12;
const SECTOR = (Math.PI * 2) / SLOTS;
const RING_MID = 1.46; // radial centre of the wedge ring (outer rim ≈ 2.3)
const WEDGE_HX = Math.tan(SECTOR / 2) * RING_MID; // tangential half-width — ring closes at mid radius
const WEDGE_HZ = 0.84; // radial half-length
const LAYER_HALF_H = 0.16;
const SPACING = 2.2; // vertical distance between layer tops
const POLE_R = 0.55;

// ring-sector wedge VISUALS (the physics boxes above are untouched) — annular
// sectors that tile the ring with no overlap or z-fighting: thetaLength =
// SECTOR - WEDGE_GAP, thetaStart = slot index * SECTOR, hole for the pole.
const WEDGE_GAP = 0.05; // angular gap (rad) so adjacent wedges never touch
const WEDGE_R_INNER = 0.46; // inner radius — tucks just behind the pole (POLE_R), no centre seam
const WEDGE_R_OUTER = RING_MID + WEDGE_HZ; // outer rim ≈ 2.3, matches the physics box extent
const WEDGE_CURVE_SEGS = 14; // arc tessellation for the shared sector geometry

// ---- ball / physics tuning ----
const BALL_R = 0.34;
const GRAVITY_Y = -20;
const BALL_RESTITUTION = 0.72;
const BOUNCE_VY = 6.6; // normalised rebound — apex clears the layer above by ~0.1m
const MAX_FALL_SPEED = 28;
const LOCK_GAIN = 10; // lateral velocity gain locking the ball to its bounce column
const SUBSTEPS = 4;

// ---- collision filters (explicit on BOTH sides — ENGINE-NOTES #1) ----
const CAT_BALL = 1;
const CAT_LAYER = 2;
const MASK_ALL = 0xffff;
const SMASH_PASS_TICKS = 3;

// ---- controls ----
const DRAG_SENS = 0.0075; // rad per px
const KEY_ROT_SPEED = 2.8; // rad/s (A/D + arrows parity)

// ---- camera follow ----
const CAM_FOLLOW_BASE = 4; // gentle base follow rate — preserves the normal-bounce feel
const CAM_FOLLOW_VK = 2.0; // extra rate per unit of downward speed — keeps fast smash-falls framed

// ---- streaming / rules ----
const LIVE_BELOW = 7;
const LIVE_ABOVE = 2;
const SMASH_ARM_FALLS = 3;
const SWAY_FALLS = 5;
const GAP = 0;
const SAFE = 1;
const RED = 2;

/** Depth-fog / material hue bands — shifts every 50 layers (juice spec). */
const BAND_HUES = [0.6, 0.76, 0.46, 0.9, 0.08];
const BAND_SIZE = 50;

interface Layer {
  index: number;
  handle: number;
  group: THREE.Group;
  slots: number[]; // GAP | SAFE | RED per slot
  baseAngle: number;
  autoSpeed: number; // rad/s — moving layers from depth 100 (ramp)
  autoAngle: number;
  decals: THREE.Mesh[];
}

interface Shard {
  mesh: THREE.Mesh;
  vx: number;
  vy: number;
  vz: number;
  life: number;
}

export function createGame(): Game {
  const meta = gameMeta('helix')!;
  let ctx: GameContext;
  let phys: Physics3D;

  // three.js
  let renderer: THREE.WebGLRenderer;
  let scene: THREE.Scene;
  let camera: THREE.PerspectiveCamera;
  let sun: THREE.DirectionalLight;
  let wedgeGeo: THREE.ExtrudeGeometry;
  let ballGeo: THREE.SphereGeometry;
  let poleGeo: THREE.CylinderGeometry;
  let ringGeo: THREE.RingGeometry;
  let decalGeo: THREE.CircleGeometry;
  let shardGeo: THREE.BoxGeometry;
  let ballMat: THREE.MeshStandardMaterial;
  let auraMat: THREE.MeshBasicMaterial;
  let redMat: THREE.MeshStandardMaterial;
  let safeMatA: THREE.MeshStandardMaterial;
  let safeMatB: THREE.MeshStandardMaterial;
  let poleMat: THREE.MeshStandardMaterial;
  let decalMat: THREE.MeshBasicMaterial;
  let decalRedMat: THREE.MeshBasicMaterial;
  let shardMat: THREE.MeshBasicMaterial;
  let ballMesh: THREE.Mesh;
  let auraMesh: THREE.Mesh;
  let poleMesh: THREE.Mesh;
  let bgColor: THREE.Color;
  const targetBg = new THREE.Color();
  const targetSafeA = new THREE.Color();
  const targetSafeB = new THREE.Color();
  let curBand = -1;

  // world
  const layers = new Map<number, Layer>();
  const shards: Shard[] = [];
  const rings: THREE.Mesh[] = [];
  let ballHandle = -1;
  const tmp: BodyState3D = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, awake: false, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 };
  const tmp2: BodyState3D = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, awake: false, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 };

  // run state
  let mode: 'idle' | 'play' | 'dying' | 'over' = 'idle';
  let score = 0;
  let depth = 0; // index of the layer the ball currently sits above
  let nextSpawn = 0;
  let towerAngle = 0;
  let fallStreak = 0;
  let smashArmed = false;
  let smashStreak = 0;
  let maxSmashStreak = 0;
  let maxFallStreak = 0;
  let smashedLayers = 0;
  let maskOffTicks = 0;
  let swayness = 0;
  let swayHold = 0;
  let time = 0;
  let dieTimer = 0;
  let camY = 0;
  let shake = 0;
  let quietTicks = 0;
  let taught = false;
  let detachDrag: (() => void) | null = null;

  // cosmetic-only xorshift (particles, camera shake) — never gameplay randomness
  let fxSeed = 1;
  function fxRand(): number {
    fxSeed ^= fxSeed << 13;
    fxSeed ^= fxSeed >>> 17;
    fxSeed ^= fxSeed << 5;
    return (fxSeed >>> 0) / 4294967296;
  }

  const centerYOf = (i: number): number => -i * SPACING - LAYER_HALF_H;
  const layerAngle = (l: Layer): number => towerAngle + l.baseAngle + l.autoAngle;

  function angDiff(a: number, b: number): number {
    let d = (a - b) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  /** Nearest non-gap slot to the ball's layer-local azimuth (deterministic, no raycast). */
  function resolveSlot(l: Layer, localAng: number): number {
    let best = -1;
    let bestD = Infinity;
    for (let k = 0; k < SLOTS; k++) {
      if ((l.slots[k] ?? GAP) === GAP) continue;
      const d = Math.abs(angDiff(localAng, k * SECTOR));
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    return best;
  }

  function setBand(band: number, snap: boolean): void {
    curBand = band;
    const hue = BAND_HUES[band % BAND_HUES.length]!;
    targetBg.setHSL(hue, 0.42, 0.09);
    targetSafeA.setHSL(hue, 0.52, 0.56);
    targetSafeB.setHSL(hue, 0.48, 0.4);
    if (snap) {
      bgColor.copy(targetBg);
      safeMatA.color.copy(targetSafeA);
      safeMatB.color.copy(targetSafeB);
    }
  }

  // ---- juice: rings, decals, shards ----

  function spawnRing(x: number, y: number, z: number, hot: boolean): void {
    if (ctx.settings().reducedMotion) return;
    const mat = new THREE.MeshBasicMaterial({
      color: hot ? ctx.colors().danger : ctx.colors().accent,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(ringGeo, mat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, y, z);
    ring.scale.setScalar(BALL_R);
    ring.userData['life'] = 0;
    scene.add(ring);
    rings.push(ring);
  }

  function updateRings(dt: number): void {
    for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i]!;
      r.userData['life'] = (r.userData['life'] as number) + dt;
      const t = (r.userData['life'] as number) / 0.45;
      r.scale.setScalar(BALL_R + t * 1.6);
      (r.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - t);
      if (t >= 1) {
        scene.remove(r);
        (r.material as THREE.Material).dispose();
        rings.splice(i, 1);
      }
    }
  }

  /** Splat decal on the layer's top face — parented to the layer so it spins with it. */
  function addDecal(layer: Layer, wx: number, wz: number, red: boolean): void {
    layer.group.updateMatrixWorld();
    const local = layer.group.worldToLocal(new THREE.Vector3(wx, centerYOf(layer.index) + LAYER_HALF_H, wz));
    const mesh = new THREE.Mesh(decalGeo, red ? decalRedMat : decalMat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(local.x, LAYER_HALF_H + 0.012, local.z);
    layer.group.add(mesh);
    layer.decals.push(mesh);
    if (layer.decals.length > 8) {
      const old = layer.decals.shift();
      if (old) layer.group.remove(old);
    }
  }

  /** Glass-shatter burst when a layer is smashed (render-side only). */
  function spawnShards(l: Layer): void {
    if (ctx.settings().reducedMotion) return;
    l.group.updateMatrixWorld();
    const p = new THREE.Vector3();
    for (const child of l.group.children) {
      if (!(child instanceof THREE.Mesh) || child.geometry !== wedgeGeo) continue;
      const a = (child.userData['a'] as number) ?? 0;
      p.set(Math.sin(a) * RING_MID, 0, Math.cos(a) * RING_MID); // ring position in layer-local space
      l.group.localToWorld(p);
      const n = 1 + Math.floor(fxRand() * 2);
      for (let i = 0; i < n && shards.length < 70; i++) {
        const isRed = child.material === redMat;
        const mesh = new THREE.Mesh(shardGeo, isRed ? redMat : shardMat);
        mesh.position.set(p.x + (fxRand() - 0.5) * 0.5, p.y + (fxRand() - 0.5) * 0.2, p.z + (fxRand() - 0.5) * 0.5);
        const az = Math.atan2(p.x, p.z);
        const sp = 2.2 + fxRand() * 3;
        shards.push({ mesh, vx: Math.sin(az) * sp, vy: 1 + fxRand() * 3.5, vz: Math.cos(az) * sp, life: 0 });
        scene.add(mesh);
      }
    }
  }

  function updateShards(dt: number): void {
    for (let i = shards.length - 1; i >= 0; i--) {
      const s = shards[i]!;
      s.life += dt;
      if (s.life >= 0.85) {
        scene.remove(s.mesh);
        shards.splice(i, 1);
        continue;
      }
      s.vy -= 22 * dt;
      s.mesh.position.x += s.vx * dt;
      s.mesh.position.y += s.vy * dt;
      s.mesh.position.z += s.vz * dt;
      s.mesh.rotation.x += 6 * dt;
      s.mesh.rotation.z += 4 * dt;
      s.mesh.scale.setScalar(Math.max(1 - s.life / 0.85, 0.01));
    }
  }

  function clearEffects(): void {
    for (const r of rings) {
      scene.remove(r);
      (r.material as THREE.Material).dispose();
    }
    rings.length = 0;
    for (const s of shards) scene.remove(s.mesh);
    shards.length = 0;
  }

  // ---- layer streaming ----

  /**
   * Per-layer arrangement — every draw through ctx.rng, in a fixed order per
   * index so a seed replays identically. Ramp: gap 4→3→2 slots, red 0→1→2→3,
   * auto-rotating layers from depth 100.
   */
  function spawnLayer(index: number, swayX: number): void {
    let gapCount: number;
    if (index < 5) gapCount = 4;
    else if (index < 30) gapCount = 3;
    else if (index < 60) gapCount = ctx.rng.chance(0.5) ? 3 : 2;
    else gapCount = 2;
    const redCount = index < 5 ? 0 : index < 50 ? 1 : index < 120 ? 2 : 3;

    const slots: number[] = new Array<number>(SLOTS).fill(SAFE);
    const gapStart = ctx.rng.int(0, SLOTS - 1);
    for (let g = 0; g < gapCount; g++) slots[(gapStart + g) % SLOTS] = GAP;

    let pool: number[] = [];
    for (let k = 0; k < SLOTS; k++) {
      if ((slots[k] ?? GAP) !== SAFE) continue;
      const nextToGap = (slots[(k + 1) % SLOTS] ?? SAFE) === GAP || (slots[(k + SLOTS - 1) % SLOTS] ?? SAFE) === GAP;
      if (index < 30 && nextToGap) continue; // early fairness: no red hiding at the gap edge
      pool.push(k);
    }
    for (let r = 0; r < redCount && pool.length > 0; r++) {
      const k = pool[ctx.rng.int(0, pool.length - 1)]!;
      slots[k] = RED;
      pool = pool.filter((q) => q !== k && q !== (k + 1) % SLOTS && q !== (k + SLOTS - 1) % SLOTS);
    }

    const baseAngle = ctx.rng.range(0, Math.PI * 2);
    const autoSpeed = index >= 100 && ctx.rng.chance(0.35) ? ctx.rng.range(0.15, 0.45) * (ctx.rng.chance(0.5) ? 1 : -1) : 0;

    const centerY = centerYOf(index);
    const a0 = towerAngle + baseAngle;
    const rot: [number, number, number, number] = [0, Math.sin(a0 / 2), 0, Math.cos(a0 / 2)];
    const handle = phys.createBody({ type: BODY_KINEMATIC, position: [swayX, centerY, 0], rotation: rot, enableSleep: false });

    const group = new THREE.Group();
    for (let k = 0; k < SLOTS; k++) {
      const kind = slots[k] ?? GAP;
      if (kind === GAP) continue;
      const a = k * SECTOR;
      const off: [number, number, number] = [Math.sin(a) * RING_MID, 0, Math.cos(a) * RING_MID];
      // match the ball's restitution so any combine rule (min/avg/max) still
      // rebounds; the rebound speed is normalised in onLanding regardless
      phys.addBoxOffset(handle, WEDGE_HX, LAYER_HALF_H, WEDGE_HZ, off, [0, Math.sin(a / 2), 0, Math.cos(a / 2)], {
        density: 1,
        friction: 0.05,
        restitution: BALL_RESTITUTION,
      });
      const mat = kind === RED ? redMat : k % 2 === 0 ? safeMatA : safeMatB;
      const mesh = new THREE.Mesh(wedgeGeo, mat);
      mesh.rotation.y = a; // shared sector geo is centred on the pole — rotate it onto this slot
      mesh.userData['a'] = a; // slot angle, used to place shatter shards at the ring
      group.add(mesh);
    }
    phys.setFilter(handle, CAT_LAYER, CAT_BALL); // explicit category BOTH sides (ENGINE-NOTES #1)
    phys.setUserData(handle, 1000 + index);
    group.position.set(swayX, centerY, 0);
    group.quaternion.set(rot[0], rot[1], rot[2], rot[3]);
    scene.add(group);
    layers.set(index, { index, handle, group, slots, baseAngle, autoSpeed, autoAngle: 0, decals: [] });
  }

  function destroyLayer(l: Layer, smashed: boolean): void {
    layers.delete(l.index);
    if (smashed) spawnShards(l);
    phys.destroyBody(l.handle);
    scene.remove(l.group);
  }

  function stream(swayX: number): void {
    while (nextSpawn <= depth + LIVE_BELOW) spawnLayer(nextSpawn++, swayX);
    for (const l of [...layers.values()]) {
      if (l.index < depth - LIVE_ABOVE) destroyLayer(l, false);
    }
  }

  // ---- landing resolution ----

  function die(layer: Layer): void {
    mode = 'dying';
    dieTimer = 0;
    smashArmed = false;
    auraMesh.visible = false;
    ballMat.color.set(ctx.colors().danger);
    ballMat.emissiveIntensity = 0;
    addDecal(layer, tmp.x, tmp.z, true);
    ctx.hud.hideCombo();
    ctx.hud.setSub('');
    ctx.audio.womp();
    ctx.audio.buzz(60);
    if (!ctx.settings().reducedMotion) shake = Math.min(shake + 0.3, 0.45);
  }

  function smash(layer: Layer, impactVy: number): void {
    smashedLayers += 1;
    smashStreak += 1;
    maxSmashStreak = Math.max(maxSmashStreak, smashStreak);
    destroyLayer(layer, true);
    // carry the fall momentum through the break; brief filter window guarantees pass-through
    phys.setLinearVelocity(ballHandle, 0, Math.min(impactVy, -6), 0);
    phys.setFilter(ballHandle, CAT_BALL, MASK_ALL & ~CAT_LAYER);
    maskOffTicks = SMASH_PASS_TICKS;
    fallStreak = 0;
    smashArmed = false;
    ctx.hud.showCombo(`SMASH ×${smashStreak}`, smashStreak >= 3);
    ctx.audio.note(110 - Math.min(smashStreak * 10, 50), { dur: 0.3, type: 'sawtooth', vol: 0.2, slideTo: 45 });
    ctx.audio.noise({ dur: 0.28, vol: 0.16, freq: 2600, q: 0.8 });
    ctx.audio.buzz(20);
    if (!ctx.settings().reducedMotion) shake = Math.min(shake + 0.22, 0.4);
  }

  function onLanding(impactVy: number, swayX: number): void {
    const layer = layers.get(depth);
    if (!layer) {
      // layer already gone (smashed edge case) — restore rhythm
      phys.setLinearVelocity(ballHandle, 0, BOUNCE_VY, 0);
      fallStreak = 0;
      return;
    }
    const az = Math.atan2(tmp.x - swayX, tmp.z);
    const slot = resolveSlot(layer, az - layerAngle(layer));
    const kind = slot >= 0 ? (layer.slots[slot] ?? SAFE) : SAFE;

    if (kind === RED) {
      die(layer);
      return;
    }
    if (smashArmed) {
      smash(layer, impactVy);
      return;
    }

    // normal bounce — engine restitution rebounds; normalise speed for a constant rhythm
    phys.setLinearVelocity(ballHandle, 0, BOUNCE_VY, 0);
    const hotFall = fallStreak >= SMASH_ARM_FALLS;
    fallStreak = 0;
    smashStreak = 0;
    ctx.hud.hideCombo();
    ctx.audio.thud(Math.min(-impactVy, 20) * 0.6);
    addDecal(layer, tmp.x, tmp.z, false);
    spawnRing(tmp.x, -depth * SPACING + 0.02, tmp.z, hotFall);
  }

  return {
    meta,

    async init(context: GameContext): Promise<void> {
      ctx = context;
      phys = await ctx.physics3d();
      const pal = ctx.colors();

      renderer = new THREE.WebGLRenderer({ canvas: ctx.canvas, antialias: true });
      renderer.setPixelRatio(ctx.dpr);

      scene = new THREE.Scene();
      bgColor = new THREE.Color(pal.bg);
      scene.background = bgColor;
      const fog = new THREE.Fog(0x000000, 9, 30);
      fog.color = bgColor; // shared instance — band lerp tints bg + fog together
      scene.fog = fog;

      camera = new THREE.PerspectiveCamera(46, 1, 0.1, 200);
      scene.add(new THREE.HemisphereLight('#9fb4ff', '#141021', 0.9));
      sun = new THREE.DirectionalLight('#ffe8c8', 1.6);
      sun.position.set(6, 12, 8);
      scene.add(sun);
      scene.add(sun.target);

      // ring-sector wedge: one shared annular sector centred on the pole axis,
      // spanning SECTOR - WEDGE_GAP so adjacent slots tile the ring without
      // overlapping or z-fighting (replaces the intersecting per-slot boxes).
      const wedgeHalf = (SECTOR - WEDGE_GAP) / 2;
      const wedgeShape = new THREE.Shape();
      wedgeShape.absarc(0, 0, WEDGE_R_OUTER, -wedgeHalf, wedgeHalf, false); // outer arc CCW
      wedgeShape.absarc(0, 0, WEDGE_R_INNER, wedgeHalf, -wedgeHalf, true); // inner arc CW → annulus with a hole
      wedgeShape.closePath();
      wedgeGeo = new THREE.ExtrudeGeometry(wedgeShape, { depth: LAYER_HALF_H * 2, bevelEnabled: false, curveSegments: WEDGE_CURVE_SEGS });
      wedgeGeo.translate(0, 0, -LAYER_HALF_H); // centre the thickness on the layer plane
      wedgeGeo.rotateX(-Math.PI / 2); // lay flat in XZ, thickness along Y
      wedgeGeo.rotateY(-Math.PI / 2); // bisector +X → +Z, so mesh.rotation.y = slot angle orients it
      ballGeo = new THREE.SphereGeometry(BALL_R, 24, 18);
      poleGeo = new THREE.CylinderGeometry(POLE_R, POLE_R, 140, 24);
      ringGeo = new THREE.RingGeometry(1, 1.16, 36);
      decalGeo = new THREE.CircleGeometry(0.17, 12);
      shardGeo = new THREE.BoxGeometry(0.16, 0.05, 0.16);

      ballMat = new THREE.MeshStandardMaterial({ color: pal.accent, roughness: 0.3, metalness: 0.1, emissive: new THREE.Color(pal.glow), emissiveIntensity: 0 });
      auraMat = new THREE.MeshBasicMaterial({ color: pal.glow, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.BackSide });
      redMat = new THREE.MeshStandardMaterial({ color: pal.danger, roughness: 0.5, emissive: new THREE.Color(pal.danger), emissiveIntensity: 0.25 });
      safeMatA = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.08 });
      safeMatB = new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.08 });
      poleMat = new THREE.MeshStandardMaterial({ color: pal.surface, roughness: 0.85 });
      decalMat = new THREE.MeshBasicMaterial({ color: pal.accent, transparent: true, opacity: 0.4, depthWrite: false });
      decalRedMat = new THREE.MeshBasicMaterial({ color: pal.danger, transparent: true, opacity: 0.6, depthWrite: false });
      shardMat = new THREE.MeshBasicMaterial({ color: '#dfe8ff' });

      ballMesh = new THREE.Mesh(ballGeo, ballMat);
      scene.add(ballMesh);
      auraMesh = new THREE.Mesh(ballGeo, auraMat);
      auraMesh.visible = false;
      scene.add(auraMesh);
      poleMesh = new THREE.Mesh(poleGeo, poleMat);
      scene.add(poleMesh);

      const resize = (w: number, h: number): void => {
        renderer.setSize(w, h, true);
        camera.aspect = w / h;
        const BASE_FOV = 46;
        if (camera.aspect < 1) {
          // portrait: hold the horizontal field so the full ring stays in frame
          const hHalf = Math.tan(THREE.MathUtils.degToRad(BASE_FOV / 2));
          camera.fov = Math.min(THREE.MathUtils.radToDeg(2 * Math.atan(hHalf / camera.aspect)), 84);
        } else {
          camera.fov = BASE_FOV;
        }
        camera.updateProjectionMatrix();
      };
      ctx.onResize(resize);
      resize(ctx.width, ctx.height);

      detachDrag = ctx.input.onDrag((e) => {
        if (mode === 'play') towerAngle += e.dx * DRAG_SENS;
      });
    },

    start(seed: number): void {
      for (const l of [...layers.values()]) scene.remove(l.group);
      layers.clear();
      clearEffects();
      phys.init(0, GRAVITY_Y, 0);

      fxSeed = (seed | 0) || 1;
      score = 0;
      depth = 0;
      nextSpawn = 0;
      towerAngle = 0;
      fallStreak = 0;
      smashArmed = false;
      smashStreak = 0;
      maxSmashStreak = 0;
      maxFallStreak = 0;
      smashedLayers = 0;
      maskOffTicks = 0;
      swayness = 0;
      swayHold = 0;
      time = 0;
      dieTimer = 0;
      camY = 0;
      shake = 0;
      quietTicks = 0;
      taught = false;

      ballHandle = phys.createBody({ type: BODY_DYNAMIC, position: [0, 1.6, RING_MID], enableSleep: false, bullet: true });
      phys.addSphere(ballHandle, BALL_R, { density: 1, friction: 0.05, restitution: BALL_RESTITUTION });
      phys.setFilter(ballHandle, CAT_BALL, MASK_ALL);
      phys.setUserData(ballHandle, 1);
      ballMat.color.set(ctx.colors().accent);
      ballMat.emissiveIntensity = 0;
      auraMesh.visible = false;

      setBand(0, true);
      stream(0);

      ctx.hud.setScore(0);
      ctx.hud.setSub('drag to spin · fall through the gap');
      ctx.hud.hideCombo();
      mode = 'play';
    },

    step(dt: number): void {
      if (mode !== 'play' && mode !== 'dying') return;
      time += dt;

      if (mode === 'play') towerAngle += ctx.input.axis() * KEY_ROT_SPEED * dt;

      // TWIST: at high fall streaks the tower sways — kinematic targets shift
      // laterally (the surfaces genuinely move under the ball) + gravity tilts
      // ±0.4. Both disabled under reducedMotion.
      swayHold = Math.max(0, swayHold - dt);
      const swayTarget = swayHold > 0 && !ctx.settings().reducedMotion ? 1 : 0;
      swayness += (swayTarget - swayness) * Math.min(dt * 1.6, 1);
      const swayX = Math.sin(time * 1.5) * 0.35 * swayness;
      phys.setGravity(Math.sin(time * 1.5) * 0.4 * swayness, GRAVITY_Y, 0);

      // drive the helix — the ENGINE rotates the layers (kinematic targets)
      for (const l of layers.values()) {
        l.autoAngle += l.autoSpeed * dt;
        const a = towerAngle + l.baseAngle + l.autoAngle;
        phys.setTargetTransform(l.handle, swayX, centerYOf(l.index), 0, 0, Math.sin(a / 2), 0, Math.cos(a / 2), dt);
      }

      // lock the ball laterally to its bounce column (velocity-space — the
      // engine still resolves all contacts; it bounces in place, the WORLD spins)
      let prevVy = 0;
      if (phys.readBody(ballHandle, tmp)) {
        prevVy = tmp.vy;
        const vy = Math.max(tmp.vy, -MAX_FALL_SPEED);
        phys.setLinearVelocity(ballHandle, (0 - tmp.x) * LOCK_GAIN, vy, (RING_MID - tmp.z) * LOCK_GAIN);
      }

      phys.step(dt, SUBSTEPS);

      if (maskOffTicks > 0 && --maskOffTicks === 0) {
        phys.setFilter(ballHandle, CAT_BALL, MASK_ALL);
      }

      if (phys.readBody(ballHandle, tmp) && mode === 'play') {
        // planes crossed this tick → layers descended (score axis)
        while (tmp.y + BALL_R < -depth * SPACING - LAYER_HALF_H * 2) {
          depth += 1;
          score = depth;
          ctx.hud.setScore(score);
          fallStreak += 1;
          maxFallStreak = Math.max(maxFallStreak, fallStreak);
          ctx.audio.pop(Math.min(fallStreak, 8));
          if (fallStreak === SMASH_ARM_FALLS) ctx.hud.showCombo('SMASH READY', false);
          else if (fallStreak > SMASH_ARM_FALLS) ctx.hud.showCombo(`FALLING ×${fallStreak}`, fallStreak >= SWAY_FALLS);
          if (fallStreak >= SWAY_FALLS) swayHold = 4;
          stream(swayX);
        }
        smashArmed = fallStreak >= SMASH_ARM_FALLS;
        auraMesh.visible = smashArmed;
        ballMat.emissiveIntensity = smashArmed ? 0.85 : 0;

        // landing = the engine flipped vy (restitution rebound)
        if (prevVy < -0.5 && tmp.vy > 0.01) {
          quietTicks = 0;
          onLanding(prevVy, swayX);
        } else if (Math.abs(tmp.vy) < 0.25 && Math.abs(prevVy) < 0.25) {
          // resting watchdog — a dead-stop still resolves as a landing
          quietTicks += 1;
          if (quietTicks > 45) {
            quietTicks = 0;
            onLanding(-BOUNCE_VY, swayX);
          }
        } else {
          quietTicks = 0;
        }

        if (!taught && (score >= 1 || time > 5)) {
          taught = true;
          ctx.hud.setSub('');
        }
      } else if (mode === 'dying') {
        dieTimer += dt;
        if (dieTimer >= 0.9) {
          mode = 'over';
          ctx.endRun({ score, durationMs: 0, seed: 0, stats: { maxSmashStreak, maxFallStreak, smashedLayers } });
          return;
        }
      }

      updateShards(dt);
      updateRings(dt);
      // camera follow: base rate keeps the gentle feel at normal bounce speeds,
      // but accelerates with the ball's downward speed so fast smash-falls don't
      // outrun the camera and drop out the bottom of frame.
      const fallSpeed = Math.max(0, -tmp.vy);
      camY += (-depth * SPACING - camY) * Math.min((CAM_FOLLOW_BASE + fallSpeed * CAM_FOLLOW_VK) * dt, 1);
      shake = Math.max(shake - dt * 1.6, 0);
    },

    render(): void {
      // layers + ball follow the engine state (kinematic bodies included)
      for (const l of layers.values()) {
        if (phys.readBody(l.handle, tmp2)) {
          l.group.position.set(tmp2.x, tmp2.y, tmp2.z);
          l.group.quaternion.set(tmp2.qx, tmp2.qy, tmp2.qz, tmp2.qw);
        }
      }
      if (phys.readBody(ballHandle, tmp2)) {
        ballMesh.position.set(tmp2.x, tmp2.y, tmp2.z);
        auraMesh.position.copy(ballMesh.position);
      }
      auraMesh.scale.setScalar(1.35 + Math.sin(time * 9) * 0.12);

      // depth-fog colour shift every 50 layers
      const band = Math.floor(depth / BAND_SIZE) % BAND_HUES.length;
      if (band !== curBand) setBand(band, false);
      bgColor.lerp(targetBg, 0.03);
      safeMatA.color.lerp(targetSafeA, 0.03);
      safeMatB.color.lerp(targetSafeB, 0.03);

      const sx = (fxRand() - 0.5) * shake;
      const sy = (fxRand() - 0.5) * shake;
      camera.position.set(sx, camY + 4.5 + sy, 8.4);
      camera.lookAt(0, camY + 0.7, 0);
      poleMesh.position.y = camY - 30;
      sun.position.set(6, camY + 12, 8);
      sun.target.position.set(0, camY - 4, 0);

      renderer.render(scene, camera);
    },

    dispose(): void {
      detachDrag?.();
      detachDrag = null;
      clearEffects();
      phys.init(0, GRAVITY_Y, 0);
      renderer.dispose();
      wedgeGeo.dispose();
      ballGeo.dispose();
      poleGeo.dispose();
      ringGeo.dispose();
      decalGeo.dispose();
      shardGeo.dispose();
      ballMat.dispose();
      auraMat.dispose();
      redMat.dispose();
      safeMatA.dispose();
      safeMatB.dispose();
      poleMat.dispose();
      decalMat.dispose();
      decalRedMat.dispose();
      shardMat.dispose();
    },
  };
}
