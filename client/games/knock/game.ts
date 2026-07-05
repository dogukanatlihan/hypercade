// knock — TOPPLE RANGE (MECHANICS §12). Box3D + three.js.
// Drag back to aim, pull down for power, release to hurl light balls at fairground
// structures; clear every can with a limited ball budget across 20 scenes. Balls are
// cheap but LIGHT — the smart play is toppling one structure into another. Demolition
// chains (structure A disturbing structure B within a rolling 3s window) pay the bonus.
// Score axis (shared/scoring.ts): scenes cleared + demolition bonuses (max 40).

import * as THREE from 'three';
import type { Game, GameContext } from '@sdk/types';
import type { Physics3D, BodyState3D, HitEvent } from '@sdk/physics3d';
import { BODY_STATIC, BODY_DYNAMIC, SHAPE_HIT_EVENTS, slotOf } from '@sdk/physics3d';
import { gameMeta } from '@shared/registry';

// ---- tuning ----
const SUBSTEPS = 4;
const SCENE_COUNT = 20;
const LAUNCH_X = 0;
const LAUNCH_Y = 1.7;
const LAUNCH_Z = 6.8;
const BALL_R = 0.38;
const BALL_DENSITY = 0.4; // light on purpose — momentum must come from structures
const FWD_MIN = 9;
const FWD_MAX = 30;
const LAT_MAX = 8;
// drag-to-aim (slingshot): horizontal drag = azimuth, downward drag = pull-back power
const AIM_LAT_SPAN_PX = 220; // horizontal drag (CSS px) for full lateral aim
const AIM_PULL_SPAN_PX = 260; // downward drag (CSS px) for full power
const AIM_CANCEL_PX = 15; // total drag below this cancels instead of throwing
const AIM_SLOWMO_SCALE = 0.35; // physics timescale while aiming (always on — it's gameplay)
const KB_LAT_RATE = 12; // keyboard azimuth sweep (m/s per second of hold)
const KB_FWD_RATE = 18; // keyboard pitch/power sweep
const KB_FWD_DEFAULT = 17; // Space throws at this power when pitch is untouched
const CRATE_HALF = 0.42;
const CAN_HX = 0.2;
const CAN_HY = 0.3;
const ARMOR_HX = 0.24;
const ARMOR_HY = 0.34;
const DESTROY_SPEED = 3.0; // hit approach speed that pops a can
const ARMOR_SPEED = 4.2; // non-ball hit speed that cracks an armored can
const CHAIN_SEED_SPEED = 1.8; // ball → structure activation
const CHAIN_LINK_SPEED = 1.3; // structure → structure demolition link
const CHAIN_WINDOW_S = 3;
const TIP_UP_Y = 0.5; // cos 60° — tipped past 60° counts as knocked down
const SETTLE_GUARD_S = 0.6; // no destruction while the fresh scene settles
const BALL_LIFE_S = 6;
const FAIL_QUIET_S = 3.5;
const FAIL_HARD_S = 12;
const SLOWMO_S = 1;
const SLOWMO_SCALE = 0.3;
const AIM_DOTS = 14;
const DUST_POOL = 40;
const BASE_FOV = 48;

// body user-data: kind | (structure id << 4). Structure id 0 = world/static.
const KIND_BALL = 1;
const KIND_BLOCK = 2;
const KIND_TARGET = 3;
const KIND_ARMOR = 4;
const KIND_GROUND = 5;

interface Rec {
  handle: number;
  mesh: THREE.Object3D;
  kind: number;
  sid: number;
  alive: boolean;
  dynamic: boolean;
}

interface Ball {
  handle: number;
  mesh: THREE.Mesh;
  age: number;
}

interface CartRec {
  joint: number;
  handle: number;
  x0: number;
  dir: number;
  speed: number;
}

interface Dust {
  sprite: THREE.Sprite;
  mat: THREE.SpriteMaterial;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  max: number;
  active: boolean;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function xSlots(count: number): number[] {
  if (count === 2) return [-2.4, 2.4];
  if (count === 3) return [-3.4, 0, 3.4];
  return [-4.8, -1.6, 1.6, 4.8];
}

export function createGame(): Game {
  const meta = gameMeta('knock')!;
  let ctx: GameContext;
  let phys: Physics3D;

  // three
  let renderer: THREE.WebGLRenderer;
  let scene: THREE.Scene;
  let camera: THREE.PerspectiveCamera;
  let worldGroup: THREE.Group;
  const geos: THREE.BufferGeometry[] = [];
  const trackedMats: THREE.Material[] = [];
  const trackGeo = <T extends THREE.BufferGeometry>(g: T): T => {
    geos.push(g);
    return g;
  };
  const trackMat = <T extends THREE.Material>(m: T): T => {
    trackedMats.push(m);
    return m;
  };

  let crateGeo: THREE.BoxGeometry;
  let crateEdgesGeo: THREE.EdgesGeometry;
  let canGeo: THREE.BoxGeometry;
  let lidGeo: THREE.BoxGeometry;
  let armorGeo: THREE.BoxGeometry;
  let armorEdgesGeo: THREE.EdgesGeometry;
  let ballGeo: THREE.SphereGeometry;
  let plankGeo: THREE.BoxGeometry;
  let counterGeo: THREE.BoxGeometry;
  let postGeo: THREE.BoxGeometry;
  let cartGeo: THREE.BoxGeometry;
  let dotGeo: THREE.SphereGeometry;
  let woodMats: THREE.MeshStandardMaterial[] = [];
  let edgeMat: THREE.LineBasicMaterial;
  let canMat: THREE.MeshStandardMaterial;
  let lidMat: THREE.MeshStandardMaterial;
  let armorMat: THREE.MeshStandardMaterial;
  let ballMat: THREE.MeshStandardMaterial;
  let plankMat: THREE.MeshStandardMaterial;
  let counterMat: THREE.MeshStandardMaterial;
  let postMat: THREE.MeshStandardMaterial;
  let cartMat: THREE.MeshStandardMaterial;
  let dotMat: THREE.MeshBasicMaterial;

  // world records
  const recs: Rec[] = [];
  const balls: Ball[] = [];
  const carts: CartRec[] = [];
  const bySlot = new Map<number, Rec>();
  const dust: Dust[] = [];
  const aimDots: THREE.Mesh[] = [];
  const wobbleAt = new Map<number, number>();
  const tmp: BodyState3D = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, awake: false, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 };
  const hit: HitEvent = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, speed: 0, slotA: 0, userA: 0, slotB: 0, userB: 0 };

  // run state
  let mode: 'idle' | 'play' | 'clearing' | 'over' = 'idle';
  let sceneNo = 1;
  let score = 0;
  let ballsTotal = 6;
  let ballsLeft = 6;
  let targetsLeft = 0;
  let groundHandle = -1;
  let sceneClock = 0;
  let runClock = 0;
  let slowMo = 0;
  let clearTimer = 0;
  let failTimer = 0;
  let hardTimer = 0;
  let shake = 0;
  let hintActive = false;
  let hasThrown = false;
  let armorHintShown = false;
  // demolition chain (the twist + 'Chain Reaction' badge)
  const chainSet = new Set<number>();
  let chainExpires = 0;
  let sceneBestChain = 0;
  // stats
  let maxChain = 0;
  let scenesCleared = 0;
  let ballsThrown = 0;
  let demoBonuses = 0;
  let ballsSpared = 0;
  let bests: number[] = [];
  // input / aim — explicit drag-to-aim (pointer) + arrow-key parity
  let aiming = false; // pointer drag-aim in progress
  let aimForward = FWD_MIN; // launch speed from vertical pull-back
  let aimLat = 0; // lateral aim from horizontal drag
  let kbForward = KB_FWD_DEFAULT; // keyboard aim (persistent across throws)
  let kbLat = 0;
  let kbActive = false; // an arrow/WASD key is steering this frame
  const detachFns: (() => void)[] = [];

  const reduced = (): boolean => ctx.settings().reducedMotion;

  // ---- mesh factories (shared geometry + materials, GC-light) ----

  function crateMesh(i: number): THREE.Mesh {
    const mesh = new THREE.Mesh(crateGeo, woodMats[i % woodMats.length]!);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.add(new THREE.LineSegments(crateEdgesGeo, edgeMat));
    return mesh;
  }

  function canMesh(): THREE.Mesh {
    const mesh = new THREE.Mesh(canGeo, canMat);
    mesh.castShadow = true;
    const lid = new THREE.Mesh(lidGeo, lidMat);
    lid.position.y = CAN_HY - 0.03;
    mesh.add(lid);
    return mesh;
  }

  function armorMesh(): THREE.Mesh {
    const mesh = new THREE.Mesh(armorGeo, armorMat);
    mesh.castShadow = true;
    mesh.add(new THREE.LineSegments(armorEdgesGeo, edgeMat));
    return mesh;
  }

  function simpleMesh(geo: THREE.BufferGeometry, mat: THREE.Material): THREE.Mesh {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  // ---- world building ----

  function addBody(
    px: number,
    py: number,
    pz: number,
    hx: number,
    hy: number,
    hz: number,
    opts: { kind: number; sid: number; density: number; friction: number; mesh: THREE.Mesh; isStatic?: boolean },
  ): number {
    const handle = phys.createBody({ type: opts.isStatic ? BODY_STATIC : BODY_DYNAMIC, position: [px, py, pz] });
    phys.addBox(handle, hx, hy, hz, { density: opts.density, friction: opts.friction, restitution: 0.05, flags: SHAPE_HIT_EVENTS });
    phys.setUserData(handle, opts.kind | (opts.sid << 4));
    opts.mesh.position.set(px, py, pz);
    worldGroup.add(opts.mesh);
    const rec: Rec = { handle, mesh: opts.mesh, kind: opts.kind, sid: opts.sid, alive: true, dynamic: !opts.isStatic };
    recs.push(rec);
    bySlot.set(slotOf(handle), rec);
    return handle;
  }

  function addTargetCan(px: number, py: number, pz: number, sid: number): void {
    addBody(px, py, pz, CAN_HX, CAN_HY, CAN_HX, { kind: KIND_TARGET, sid, density: 0.5, friction: 0.6, mesh: canMesh() });
    targetsLeft += 1;
  }

  function buildStack(x: number, z: number, rows: number, sid: number): void {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < 2; c++) {
        const px = x + (c === 0 ? -1 : 1) * (CRATE_HALF + 0.01) + ctx.rng.range(-0.015, 0.015);
        const py = CRATE_HALF + r * (CRATE_HALF * 2 + 0.012);
        const pz = z + ctx.rng.range(-0.015, 0.015);
        addBody(px, py, pz, CRATE_HALF, CRATE_HALF, CRATE_HALF, { kind: KIND_BLOCK, sid, density: 0.8, friction: 0.6, mesh: crateMesh(r * 2 + c) });
      }
    }
    const topY = rows * (CRATE_HALF * 2 + 0.012);
    for (let c = 0; c < 2; c++) {
      addTargetCan(x + (c === 0 ? -1 : 1) * (CRATE_HALF + 0.01), topY + CAN_HY + 0.01, z, sid);
    }
  }

  /** Revolute plank + heavy counterweight (from scene 5). Knock the weight off to spring the cans. */
  function buildSeesaw(x: number, z: number, sid: number): void {
    const post = addBody(x, 0.75, z, 0.16, 0.75, 0.16, { kind: KIND_GROUND, sid: 0, density: 1, friction: 0.6, mesh: simpleMesh(postGeo, postMat), isStatic: true });
    const plankY = 1.58;
    const plank = addBody(x, plankY, z, 1.7, 0.07, 0.45, { kind: KIND_BLOCK, sid, density: 0.7, friction: 0.75, mesh: simpleMesh(plankGeo, plankMat) });
    phys.createRevoluteJoint(post, plank, [x, plankY, z], [0, 0, 1], { lower: -0.38, upper: 0.38, enableLimit: true });
    addBody(x - 1.3, plankY + 0.07 + 0.28, z, 0.28, 0.28, 0.28, { kind: KIND_BLOCK, sid, density: 5, friction: 0.8, mesh: simpleMesh(counterGeo, counterMat) });
    addTargetCan(x + 1.05, plankY + 0.07 + CAN_HY + 0.01, z, sid);
    addTargetCan(x + 1.45, plankY + 0.07 + CAN_HY + 0.01, z, sid);
  }

  /** Prismatic-motor cart shuttling behind the range (from scene 10). */
  function buildCart(x: number, z: number, sid: number, n: number): void {
    const y = 0.45;
    const cart = addBody(x, y, z, 1.05, 0.18, 0.65, { kind: KIND_BLOCK, sid, density: 2, friction: 0.85, mesh: simpleMesh(cartGeo, cartMat) });
    const speed = 1.1 + n * 0.035;
    const joint = phys.createPrismaticJoint(groundHandle, cart, [x, y, z], [1, 0, 0], {
      lower: -2.1,
      upper: 2.1,
      enableLimit: true,
      motorSpeed: speed,
      maxMotorForce: 90,
      enableMotor: true,
    });
    carts.push({ joint, handle: cart, x0: x, dir: 1, speed });
    const deckY = y + 0.18;
    addBody(x, deckY + CRATE_HALF + 0.01, z, CRATE_HALF, CRATE_HALF, CRATE_HALF, { kind: KIND_BLOCK, sid, density: 0.8, friction: 0.6, mesh: crateMesh(1) });
    addTargetCan(x, deckY + CRATE_HALF * 2 + CAN_HY + 0.03, z, sid);
    addTargetCan(x - 0.72, deckY + CAN_HY + 0.01, z, sid);
    addTargetCan(x + 0.72, deckY + CAN_HY + 0.01, z, sid);
  }

  /** Armored can (from scene 15): only breaks under a heavy NON-ball impact — drop a structure on it. */
  function buildArmored(x: number, z: number, sid: number): void {
    addBody(x, ARMOR_HY, z, ARMOR_HX, ARMOR_HY, ARMOR_HX, { kind: KIND_ARMOR, sid, density: 1.2, friction: 0.7, mesh: armorMesh() });
    targetsLeft += 1;
  }

  function buildScene(n: number): void {
    worldGroup.clear();
    recs.length = 0;
    balls.length = 0;
    carts.length = 0;
    bySlot.clear();
    wobbleAt.clear();
    for (const d of dust) {
      d.active = false;
      d.sprite.visible = false;
    }
    hideAim();

    phys.init(0, -10, 0);
    phys.setHitEventThreshold(1.0);

    // statics — ground + backstop wall (visual meshes are permanent, built in init)
    groundHandle = phys.createBody({ type: BODY_STATIC, position: [0, -0.5, 0] });
    phys.addBox(groundHandle, 30, 0.5, 30, { friction: 0.7, flags: SHAPE_HIT_EVENTS });
    phys.setUserData(groundHandle, KIND_GROUND);
    const wall = phys.createBody({ type: BODY_STATIC, position: [0, 3, -16.5] });
    phys.addBox(wall, 14, 3, 0.4, { friction: 0.5, restitution: 0.2 });
    phys.setUserData(wall, KIND_GROUND);

    sceneClock = 0;
    chainSet.clear();
    chainExpires = 0;
    sceneBestChain = 0;
    failTimer = 0;
    hardTimer = 0;
    armorHintShown = false;
    targetsLeft = 0;
    slowMo = 0;

    // compact data-driven layout — ramp per MECHANICS §12
    const structCount = n < 5 ? 2 : n < 12 ? 3 : 4;
    const slots = xSlots(structCount);
    const rows = 3 + Math.min(Math.floor(n / 7), 2);
    const types: ('stack' | 'seesaw' | 'cart')[] = new Array<'stack' | 'seesaw' | 'cart'>(structCount).fill('stack');
    if (n >= 5) types[Math.min(1, structCount - 1)] = 'seesaw';
    if (n >= 10) types[structCount - 1] = 'cart';
    const zBase = -8;
    let sid = 1;
    for (let i = 0; i < structCount; i++) {
      const t = types[i]!;
      const x = slots[i]! + ctx.rng.range(-0.25, 0.25);
      const z = zBase + ctx.rng.range(-0.8, 0.8);
      if (t === 'stack') buildStack(x, z, rows, sid);
      else if (t === 'seesaw') buildSeesaw(x, z, sid);
      else buildCart(slots[i]!, zBase - 2.5, sid, n);
      sid += 1;
    }
    if (n >= 15) {
      const armored = n >= 18 ? 2 : 1;
      for (let a = 0; a < armored; a++) {
        const gi = a % (structCount - 1);
        const gx = (slots[gi]! + slots[gi + 1]!) / 2 + ctx.rng.range(-0.2, 0.2);
        buildArmored(gx, zBase + ctx.rng.range(-0.5, 0.5), sid);
        sid += 1;
      }
    }

    ballsTotal = n < 5 ? 6 : n < 13 ? 5 : 4;
    ballsLeft = ballsTotal;
    updateSub();
  }

  // ---- throwing ----

  /** Map a drag (CSS px, measured from the press point) to launch speed + azimuth. */
  function aimFromDrag(totalX: number, totalY: number): void {
    aimLat = clamp((totalX / AIM_LAT_SPAN_PX) * LAT_MAX, -LAT_MAX, LAT_MAX);
    const pull = Math.max(totalY, 0); // drag DOWN = pull back = more power
    aimForward = clamp(FWD_MIN + (pull / AIM_PULL_SPAN_PX) * (FWD_MAX - FWD_MIN), FWD_MIN, FWD_MAX);
  }

  /** The aim currently driving the trajectory preview + slow-mo, or null when idle. */
  function activeAim(): [number, number] | null {
    if (aiming) return [aimForward, aimLat];
    if (kbActive) return [kbForward, kbLat];
    return null;
  }

  function throwBall(fwd: number, lat: number): void {
    if (mode !== 'play' || ballsLeft <= 0) return;
    const up = 3.4 + fwd * 0.11;
    const handle = phys.createBody({ type: BODY_DYNAMIC, position: [LAUNCH_X, LAUNCH_Y, LAUNCH_Z], bullet: true });
    phys.addSphere(handle, BALL_R, { density: BALL_DENSITY, friction: 0.5, restitution: 0.3, flags: SHAPE_HIT_EVENTS });
    phys.setUserData(handle, KIND_BALL);
    phys.setLinearVelocity(handle, lat, up, -fwd);
    phys.setAngularVelocity(handle, (-fwd / BALL_R) * 0.4, 0, 0);
    const mesh = new THREE.Mesh(ballGeo, ballMat);
    mesh.castShadow = true;
    mesh.position.set(LAUNCH_X, LAUNCH_Y, LAUNCH_Z);
    worldGroup.add(mesh);
    balls.push({ handle, mesh, age: 0 });
    ballsLeft -= 1;
    ballsThrown += 1;
    hasThrown = true;
    hintActive = false;
    ctx.audio.whoosh();
    ctx.audio.buzz(8);
    updateSub();
  }

  /** Keyboard parity: Space/Enter throws at the current keyboard aim
   *  (default power + whatever azimuth/pitch the arrows have set). */
  function keyboardThrow(): void {
    if (mode !== 'play' || ballsLeft <= 0) return;
    throwBall(kbForward, kbLat);
  }

  // ---- demolition chain (twist) ----

  function seedChain(sid: number): void {
    if (sceneClock > chainExpires) chainSet.clear();
    chainSet.add(sid);
    chainExpires = sceneClock + CHAIN_WINDOW_S;
  }

  function linkChain(a: number, b: number): void {
    const hasA = chainSet.has(a);
    const hasB = chainSet.has(b);
    if (!hasA && !hasB) return;
    chainExpires = sceneClock + CHAIN_WINDOW_S;
    if (hasA && hasB) return;
    chainSet.add(hasA ? b : a);
    const size = chainSet.size;
    if (size < 2) return;
    sceneBestChain = Math.max(sceneBestChain, size);
    maxChain = Math.max(maxChain, size);
    failTimer = 0;
    ctx.hud.showCombo(`CHAIN ×${size}`, size >= 3);
    crowd(size);
    ctx.audio.buzz(20);
  }

  /** Crowd "ooooh" — layered low notes scaled to chain length. */
  function crowd(size: number): void {
    const layers = Math.min(1 + size, 5);
    for (let l = 0; l < layers; l++) {
      ctx.audio.note(70 + l * 24 + size * 4, { dur: 0.55, type: 'sawtooth', vol: 0.04 + size * 0.012, delay: l * 0.045, slideTo: 100 + l * 30 });
    }
  }

  // ---- destruction ----

  function destroyTarget(rec: Rec | undefined): void {
    if (!rec || !rec.alive || (rec.kind !== KIND_TARGET && rec.kind !== KIND_ARMOR)) return;
    rec.alive = false;
    bySlot.delete(slotOf(rec.handle));
    phys.destroyBody(rec.handle);
    const p = rec.mesh.position;
    spawnDust(p.x, p.y, p.z, rec.kind === KIND_ARMOR ? 8 : 5, 2.2);
    worldGroup.remove(rec.mesh);
    targetsLeft -= 1;
    failTimer = 0;
    if (rec.kind === KIND_ARMOR) {
      ctx.audio.note(160, { dur: 0.25, type: 'square', vol: 0.14, slideTo: 60 });
      ctx.audio.noise({ dur: 0.2, vol: 0.14, freq: 2600, q: 2 });
    } else {
      ctx.audio.pop(Math.min(chainSet.size, 6));
    }
    ctx.audio.buzz(12);
    if (targetsLeft <= 0 && mode === 'play') onSceneCleared();
  }

  function tryBreak(slot: number, kind: number, otherKind: number, speed: number): void {
    if (sceneClock < SETTLE_GUARD_S) return;
    if (kind === KIND_TARGET) {
      if (speed >= DESTROY_SPEED) destroyTarget(bySlot.get(slot));
    } else if (kind === KIND_ARMOR) {
      if (otherKind !== KIND_BALL && speed >= ARMOR_SPEED) {
        destroyTarget(bySlot.get(slot));
      } else if (otherKind === KIND_BALL && speed >= DESTROY_SPEED && !armorHintShown) {
        // ball bounced off armor — teach the counter visibly, once per scene
        armorHintShown = true;
        ctx.audio.note(1400, { dur: 0.08, type: 'square', vol: 0.08, slideTo: 900 });
        ctx.hud.flash('ARMORED — drop a structure on it', 1200);
      }
    }
  }

  function processHits(dt: number): void {
    void dt;
    const n = phys.hitCount();
    let thuds = 0;
    for (let i = 0; i < n; i++) {
      phys.readHit(i, hit);
      const ua = hit.userA | 0;
      const ub = hit.userB | 0;
      const ka = ua & 15;
      const sa = ua >> 4;
      const kb = ub & 15;
      const sb = ub >> 4;
      const sp = hit.speed;
      if (sp > 1.6 && thuds < 3) {
        ctx.audio.thud(sp * 0.8);
        thuds += 1;
      }
      if (sp > 2.2) {
        spawnDust(hit.x, hit.y, hit.z, sp > 5 ? 5 : 3, sp * 0.25);
        if (!reduced()) shake = Math.min(shake + sp * 0.008, 0.3);
      }
      if (sp > 2.4) failTimer = 0; // debris still working — hold the fail clock
      // chain: ball hits seed a structure; structure↔structure hits extend the chain
      if (ka === KIND_BALL && sb > 0 && sp >= CHAIN_SEED_SPEED) seedChain(sb);
      else if (kb === KIND_BALL && sa > 0 && sp >= CHAIN_SEED_SPEED) seedChain(sa);
      else if (sa > 0 && sb > 0 && sa !== sb && sp >= CHAIN_LINK_SPEED) linkChain(sa, sb);
      tryBreak(hit.slotA | 0, ka, kb, sp);
      tryBreak(hit.slotB | 0, kb, ka, sp);
    }
  }

  // ---- scene flow ----

  function onSceneCleared(): void {
    mode = 'clearing';
    clearTimer = 0;
    if (!reduced()) slowMo = SLOWMO_S; // slow-mo on the final target
    const demo = sceneBestChain >= 2 ? 1 : 0;
    score += 1 + demo;
    scenesCleared += 1;
    demoBonuses += demo;
    ballsSpared += ballsLeft;
    ctx.hud.setScore(score);
    ctx.hud.flash('SCENE CLEAR', 1200);
    if (demo) ctx.hud.showCombo('FULL DEMOLITION +2', true);
    ctx.audio.fanfare();
    ctx.audio.buzz(30);
    bests[sceneNo - 1] = Math.max(bests[sceneNo - 1] ?? 0, 1 + demo);
    ctx.storage.set('bests', bests);
  }

  function finish(won: boolean): void {
    if (mode === 'over') return;
    mode = 'over';
    hideAim();
    if (!won) ctx.audio.womp();
    ctx.endRun({ score, durationMs: 0, seed: 0, stats: { maxChain, scenesCleared, ballsThrown, demoBonuses, ballsSpared } });
  }

  function updateSub(): void {
    if (hintActive) return;
    const filled = '●'.repeat(ballsLeft);
    const empty = '○'.repeat(Math.max(ballsTotal - ballsLeft, 0));
    ctx.hud.setSub(`scene ${sceneNo}/${SCENE_COUNT} · ${filled}${empty}`);
  }

  // ---- juice: dust + aim preview ----

  function spawnDust(x: number, y: number, z: number, count: number, speed: number): void {
    if (reduced()) return;
    let spawned = 0;
    for (const d of dust) {
      if (d.active) continue;
      d.active = true;
      d.sprite.visible = true;
      d.sprite.position.set(x, y, z);
      d.sprite.scale.setScalar(ctx.rng.range(0.22, 0.5));
      d.vx = ctx.rng.range(-1, 1) * speed;
      d.vy = ctx.rng.range(0.4, 1.4) * speed * 0.7;
      d.vz = ctx.rng.range(-1, 1) * speed;
      d.life = 0;
      d.max = ctx.rng.range(0.35, 0.6);
      d.mat.opacity = 0.75;
      spawned += 1;
      if (spawned >= count) break;
    }
  }

  function updateDust(dt: number): void {
    for (const d of dust) {
      if (!d.active) continue;
      d.life += dt;
      if (d.life >= d.max) {
        d.active = false;
        d.sprite.visible = false;
        continue;
      }
      d.sprite.position.x += d.vx * dt;
      d.sprite.position.y += d.vy * dt;
      d.sprite.position.z += d.vz * dt;
      d.vy -= 5 * dt;
      d.mat.opacity = 0.75 * (1 - d.life / d.max);
      d.sprite.scale.multiplyScalar(1 + dt * 1.6);
    }
  }

  function hideAim(): void {
    for (const d of aimDots) d.visible = false;
  }

  function updateAim(): void {
    const aim = activeAim();
    if (!aim || mode !== 'play' || ballsLeft <= 0) {
      hideAim();
      return;
    }
    const [fwd, lat] = aim;
    const up = 3.4 + fwd * 0.11;
    // ballistic preview: pure kinematics under the world's gravity (no engine calls)
    for (let i = 0; i < aimDots.length; i++) {
      const d = aimDots[i]!;
      const t = (i + 1) * 0.085;
      const y = LAUNCH_Y + up * t - 5 * t * t;
      if (y < 0.06) {
        d.visible = false;
        continue;
      }
      d.visible = true;
      d.position.set(LAUNCH_X + lat * t, y, LAUNCH_Z - fwd * t);
      d.scale.setScalar(1 - i * 0.045);
    }
  }

  return {
    meta,

    async init(context: GameContext): Promise<void> {
      ctx = context;
      phys = await ctx.physics3d();

      renderer = new THREE.WebGLRenderer({ canvas: ctx.canvas, antialias: true });
      renderer.setPixelRatio(ctx.dpr);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;

      scene = new THREE.Scene();
      const bg = ctx.colors().bg;
      scene.background = new THREE.Color(bg);
      scene.fog = new THREE.Fog(bg, 26, 60);
      worldGroup = new THREE.Group();
      scene.add(worldGroup);

      camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.1, 200);
      scene.add(new THREE.HemisphereLight('#8fa3ff', '#1a1030', 0.8));
      const sun = new THREE.DirectionalLight('#ffe3b8', 2.0);
      sun.position.set(8, 14, 9);
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      sun.shadow.camera.near = 1;
      sun.shadow.camera.far = 60;
      sun.shadow.camera.left = -13;
      sun.shadow.camera.right = 13;
      sun.shadow.camera.top = 18;
      sun.shadow.camera.bottom = -14;
      sun.target.position.set(0, 0, -8);
      scene.add(sun);
      scene.add(sun.target);

      // permanent scenery (physics statics are rebuilt per scene at the same spots)
      const groundMesh = new THREE.Mesh(trackGeo(new THREE.CircleGeometry(55, 40)), trackMat(new THREE.MeshStandardMaterial({ color: '#1d2547', roughness: 1 })));
      groundMesh.rotation.x = -Math.PI / 2;
      groundMesh.position.y = 0.001;
      groundMesh.receiveShadow = true;
      scene.add(groundMesh);
      const strip = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(13, 0.04, 9.5)), trackMat(new THREE.MeshStandardMaterial({ color: '#27305c', roughness: 0.9 })));
      strip.position.set(0, 0.02, -8.6);
      strip.receiveShadow = true;
      scene.add(strip);
      const wallMesh = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(28, 6, 0.8)), trackMat(new THREE.MeshStandardMaterial({ color: '#232b52', roughness: 0.85 })));
      wallMesh.position.set(0, 3, -16.5);
      wallMesh.receiveShadow = true;
      scene.add(wallMesh);
      const launchRing = new THREE.Mesh(
        trackGeo(new THREE.TorusGeometry(0.55, 0.05, 8, 32)),
        trackMat(new THREE.MeshBasicMaterial({ color: ctx.colors().accent, transparent: true, opacity: 0.4, depthWrite: false })),
      );
      launchRing.rotation.x = -Math.PI / 2;
      launchRing.position.set(LAUNCH_X, 0.03, LAUNCH_Z);
      scene.add(launchRing);

      // shared geometry + materials
      crateGeo = trackGeo(new THREE.BoxGeometry(CRATE_HALF * 2, CRATE_HALF * 2, CRATE_HALF * 2));
      crateEdgesGeo = trackGeo(new THREE.EdgesGeometry(crateGeo));
      canGeo = trackGeo(new THREE.BoxGeometry(CAN_HX * 2, CAN_HY * 2, CAN_HX * 2));
      lidGeo = trackGeo(new THREE.BoxGeometry(CAN_HX * 2.1, 0.06, CAN_HX * 2.1));
      armorGeo = trackGeo(new THREE.BoxGeometry(ARMOR_HX * 2, ARMOR_HY * 2, ARMOR_HX * 2));
      armorEdgesGeo = trackGeo(new THREE.EdgesGeometry(armorGeo));
      ballGeo = trackGeo(new THREE.SphereGeometry(BALL_R, 20, 14));
      plankGeo = trackGeo(new THREE.BoxGeometry(3.4, 0.14, 0.9));
      counterGeo = trackGeo(new THREE.BoxGeometry(0.56, 0.56, 0.56));
      postGeo = trackGeo(new THREE.BoxGeometry(0.32, 1.5, 0.32));
      cartGeo = trackGeo(new THREE.BoxGeometry(2.1, 0.36, 1.3));
      dotGeo = trackGeo(new THREE.SphereGeometry(0.09, 8, 6));
      woodMats = ['#c98a4b', '#b87a3e', '#d69a5c'].map((c) => trackMat(new THREE.MeshStandardMaterial({ color: c, roughness: 0.65, metalness: 0.05 })));
      edgeMat = trackMat(new THREE.LineBasicMaterial({ color: '#141a2e', transparent: true, opacity: 0.35 }));
      canMat = trackMat(new THREE.MeshStandardMaterial({ color: '#ff4d63', roughness: 0.5, emissive: '#5a0f1c', emissiveIntensity: 0.35 }));
      lidMat = trackMat(new THREE.MeshStandardMaterial({ color: '#f2e7d6', roughness: 0.4 }));
      armorMat = trackMat(new THREE.MeshStandardMaterial({ color: '#8a93a6', roughness: 0.35, metalness: 0.75 }));
      ballMat = trackMat(new THREE.MeshStandardMaterial({ color: '#ffd75e', roughness: 0.45, emissive: '#5a4310', emissiveIntensity: 0.25 }));
      plankMat = trackMat(new THREE.MeshStandardMaterial({ color: '#a06a35', roughness: 0.7 }));
      counterMat = trackMat(new THREE.MeshStandardMaterial({ color: '#39415f', roughness: 0.5, metalness: 0.4 }));
      postMat = trackMat(new THREE.MeshStandardMaterial({ color: '#5a6070', roughness: 0.7 }));
      cartMat = trackMat(new THREE.MeshStandardMaterial({ color: '#4a5578', roughness: 0.6, metalness: 0.2 }));
      dotMat = trackMat(new THREE.MeshBasicMaterial({ color: ctx.colors().accent, transparent: true, opacity: 0.85, depthWrite: false }));

      for (let i = 0; i < AIM_DOTS; i++) {
        const d = new THREE.Mesh(dotGeo, dotMat);
        d.visible = false;
        scene.add(d);
        aimDots.push(d);
      }
      for (let i = 0; i < DUST_POOL; i++) {
        const mat = trackMat(new THREE.SpriteMaterial({ color: '#d8c5a3', transparent: true, opacity: 0, depthWrite: false }));
        const sprite = new THREE.Sprite(mat);
        sprite.visible = false;
        scene.add(sprite);
        dust.push({ sprite, mat, vx: 0, vy: 0, vz: 0, life: 0, max: 1, active: false });
      }

      const resize = (w: number, h: number): void => {
        renderer.setSize(w, h, true);
        camera.aspect = w / h;
        if (camera.aspect < 1) {
          // portrait: hold the horizontal field so the whole range stays in frame
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
        // explicit drag-to-aim: press to start, drag to set azimuth + power, release to fire
        ctx.input.onDown(() => {
          if (mode !== 'play' || ballsLeft <= 0) return;
          aiming = true;
          aimLat = 0;
          aimForward = FWD_MIN;
        }),
        ctx.input.onDrag((e) => {
          if (!aiming) return;
          aimFromDrag(e.totalX, e.totalY);
        }),
        ctx.input.onRelease((e) => {
          const wasAiming = aiming;
          aiming = false;
          hideAim();
          if (!wasAiming || mode !== 'play' || ballsLeft <= 0) return;
          if (Math.hypot(e.totalX, e.totalY) < AIM_CANCEL_PX) return; // tiny drag = cancel
          aimFromDrag(e.totalX, e.totalY);
          throwBall(aimForward, aimLat);
        }),
        // keyboard parity: Space/Enter throws at the current aim (arrows steer it in step())
        ctx.input.onKey((code, down) => {
          if (!down || mode !== 'play') return;
          if (code === 'Space' || code === 'Enter') keyboardThrow();
        }),
      );
    },

    start(): void {
      sceneNo = 1;
      score = 0;
      maxChain = 0;
      scenesCleared = 0;
      ballsThrown = 0;
      demoBonuses = 0;
      ballsSpared = 0;
      runClock = 0;
      shake = 0;
      slowMo = 0;
      clearTimer = 0;
      hasThrown = false;
      aiming = false;
      kbActive = false;
      kbLat = 0;
      kbForward = KB_FWD_DEFAULT;
      aimLat = 0;
      aimForward = FWD_MIN;
      bests = ctx.storage.get<number[]>('bests', []);
      buildScene(1);
      mode = 'play';
      ctx.hud.setScore(0);
      hintActive = true;
      ctx.hud.setSub('drag back to aim · pull down for power · topple towers together');
    },

    step(dt: number): void {
      if (mode === 'idle' || mode === 'over') return;
      runClock += dt;
      sceneClock += dt;

      // keyboard aim: arrows/WASD steer azimuth (lat) + pitch (power); Space throws via onKey
      kbActive = false;
      if (mode === 'play' && ballsLeft > 0) {
        const keys = ctx.input.keys;
        const lat = (keys.has('ArrowRight') || keys.has('KeyD') ? 1 : 0) - (keys.has('ArrowLeft') || keys.has('KeyA') ? 1 : 0);
        const pit = (keys.has('ArrowUp') || keys.has('KeyW') ? 1 : 0) - (keys.has('ArrowDown') || keys.has('KeyS') ? 1 : 0);
        if (lat !== 0) {
          kbLat = clamp(kbLat + lat * KB_LAT_RATE * dt, -LAT_MAX, LAT_MAX);
          kbActive = true;
        }
        if (pit !== 0) {
          kbForward = clamp(kbForward + pit * KB_FWD_RATE * dt, FWD_MIN, FWD_MAX);
          kbActive = true;
        }
      }

      // slow-mo while aiming is ALWAYS on (it is the aiming mechanic); the scene-clear
      // celebration slow-mo (slowMo) stays gated by reducedMotion at its source.
      const aimingNow = mode === 'play' && (aiming || kbActive);
      const eff = aimingNow ? dt * AIM_SLOWMO_SCALE : slowMo > 0 ? dt * SLOWMO_SCALE : dt;
      slowMo = Math.max(slowMo - dt, 0);
      phys.step(eff, SUBSTEPS);

      // prismatic carts shuttle: flip motor at travel edges
      for (const c of carts) {
        if (!phys.readBody(c.handle, tmp)) continue;
        if (c.dir > 0 && tmp.x > c.x0 + 1.9) {
          c.dir = -1;
          phys.setMotorSpeed(c.joint, -c.speed);
        } else if (c.dir < 0 && tmp.x < c.x0 - 1.9) {
          c.dir = 1;
          phys.setMotorSpeed(c.joint, c.speed);
        }
      }

      // sync meshes, tip checks, wobble anticipation
      for (const r of recs) {
        if (!r.dynamic || !r.alive) continue;
        if (!phys.readBody(r.handle, tmp)) continue;
        r.mesh.position.set(tmp.x, tmp.y, tmp.z);
        r.mesh.quaternion.set(tmp.qx, tmp.qy, tmp.qz, tmp.qw);
        const upY = 1 - 2 * (tmp.qx * tmp.qx + tmp.qz * tmp.qz);
        if (r.kind === KIND_TARGET && sceneClock > SETTLE_GUARD_S && upY < TIP_UP_Y) {
          destroyTarget(r);
          continue;
        }
        if (r.kind === KIND_BLOCK && sceneClock > SETTLE_GUARD_S) {
          const w = Math.abs(tmp.wx) + Math.abs(tmp.wy) + Math.abs(tmp.wz);
          if (w > 1.3 && upY > 0.86) {
            const last = wobbleAt.get(r.sid) ?? -10;
            if (sceneClock - last > 0.8) {
              wobbleAt.set(r.sid, sceneClock);
              ctx.audio.tick();
            }
          }
        }
      }

      // balls: sync, age, cull spent ones (visible cleanup, never mid-flight gameplay)
      for (let i = balls.length - 1; i >= 0; i--) {
        const b = balls[i]!;
        b.age += eff;
        const ok = phys.readBody(b.handle, tmp);
        if (ok) {
          b.mesh.position.set(tmp.x, tmp.y, tmp.z);
          b.mesh.quaternion.set(tmp.qx, tmp.qy, tmp.qz, tmp.qw);
        }
        const spent = !ok || b.age > BALL_LIFE_S || tmp.y < -4 || tmp.z < -30 || (!tmp.awake && b.age > 1.2);
        if (spent) {
          if (ok) phys.destroyBody(b.handle);
          worldGroup.remove(b.mesh);
          balls.splice(i, 1);
        }
      }

      processHits(eff);
      if (chainSet.size > 0 && sceneClock > chainExpires) chainSet.clear();
      updateDust(eff);
      updateAim();
      shake = Math.max(shake - dt * 1.5, 0);

      if (hintActive && (runClock > 5 || hasThrown)) {
        hintActive = false;
        updateSub();
      }

      if (mode === 'play' && targetsLeft > 0 && ballsLeft === 0) {
        failTimer += dt;
        hardTimer += dt;
        if (failTimer > FAIL_QUIET_S || hardTimer > FAIL_HARD_S) {
          finish(false);
          return;
        }
      }

      if (mode === 'clearing') {
        clearTimer += dt;
        if (clearTimer > 1.4) {
          if (sceneNo >= SCENE_COUNT) {
            finish(true); // all 20 scenes cleared → run ends (win)
          } else {
            sceneNo += 1;
            buildScene(sceneNo); // load the next scene in-place, no endRun
            mode = 'play';
          }
        }
      }
    },

    render(): void {
      const sx = Math.sin(runClock * 53.3) * shake;
      const sy = Math.cos(runClock * 61.7) * shake * 0.6;
      camera.position.set(LAUNCH_X + sx, 5.0 + sy, 10.8);
      camera.lookAt(0, 1.1, -6);
      renderer.render(scene, camera);
    },

    dispose(): void {
      for (const d of detachFns) d();
      detachFns.length = 0;
      phys.init(0, -10, 0);
      renderer.dispose();
      for (const g of geos) g.dispose();
      for (const m of trackedMats) m.dispose();
    },
  };
}
