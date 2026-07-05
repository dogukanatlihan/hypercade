// GUTTERBALL RUN — swerve / steer (MECHANICS §13). Box3D + three.js.
// An endless banked gutter is streamed as static bodies: one body per 12 m
// segment carrying three offset shapes (floor + two angled banks), yawed so
// mild rng curves join smoothly. A real dynamic sphere rolls on engine
// friction; a forward force chases a target speed that ramps +2%/100 m
// (capped at 2.5× base). Obstacles are live dynamic boxes — glancing hits
// deflect (physics decides), head-on kills (impact normal vs travel
// direction), and knocked obstacles STAY knocked, caroming into obstacles
// ahead (the twist). Gates / gems / near-miss shells are sensors; a near miss
// = entering and leaving an obstacle's shell sensor without touching it →
// +5% bonus and an 80 ms time-dilation blip (5 ticks at 0.2×, skipped under
// reduced motion). Score = metres travelled × (1 + accumulated bonus).

import * as THREE from 'three';
import type { Game, GameContext } from '@sdk/types';
import type { Physics3D, BodyState3D, HitEvent, PairEvent, RayHit } from '@sdk/physics3d';
import { BODY_STATIC, BODY_DYNAMIC, SHAPE_SENSOR, SHAPE_CONTACT_EVENTS, SHAPE_HIT_EVENTS } from '@sdk/physics3d';
import { gameMeta } from '@shared/registry';

// ---- track ----
const SEG_LEN = 12;
const TRACK_HALF_W = 3.2;
const FLOOR_HALF_Y = 0.6;
const BANK_HALF_LEN = 1.6;
const BANK_HALF_THICK = 0.28;
const BANK_ANGLE = 0.62; // rad ≈ 35°
const BANK_SINK = 0.26; // banks tuck under the floor top so there is no lip
const BANK_TUCK = 0.3;
const SEG_OVERLAP = 0.42; // z overhang per segment end covers curve wedges
const AHEAD_M = 170;
const BEHIND_M = 20;

// ---- ball & speed ----
const BALL_R = 0.45;
const SPAWN_Z = -2;
const BASE_SPEED = 12; // m/s
const SPEED_CAP_MULT = 3.6;
const RAMP_PER_100M = 0.055; // +5.5% per 100 m — it must keep getting scarier
const LAT_ACCEL = 26; // m/s² at full steer, grounded
const AIR_STEER = 0.35;
const KILL_Y = -5;
const SUBSTEPS = 4;
const CAT_BALL = 2; // explicit category (ENGINE-NOTES: set BOTH sides when filtering; here only the ray mask needs it)
const MASK_NOT_BALL = 0xfffffffd;

// ---- scoring ----
const GEM_BONUS = 0.01;
const GATE_BONUS = 0.03;
const NEAR_MISS_BONUS = 0.05;
const BONUS_CAP = 0.5; // keeps score ≤ plausibility cap of 45/s at max speed

// ---- feel ----
const SHELL_R = 1.35;
const BLIP_TICKS = 5; // ≈ 80 ms
const BLIP_SCALE = 0.2;
const HINT_SECONDS = 5;
const MAGNET_HEAT = 3;
const MAGNET_RADIUS = 3;
const HEADON_DOT = 0.62; // |impact normal · travel dir| above this = head-on
const HEADON_MIN_SPEED = 4.5;
const SPARK_N = 56;

// ---- user data ----
const UD_BALL = 1;
const UD_TRACK = 2;
const FIRST_ID = 16;

interface Obstacle {
  id: number;
  handle: number;
  mesh: THREE.Mesh;
  inShell: boolean;
  touched: boolean;
  knocked: boolean;
  fxDone: boolean;
}

interface Pickup {
  id: number;
  handle: number;
  mesh: THREE.Object3D;
  kind: 'gem' | 'gate';
  x: number;
  y: number;
  z: number;
}

interface Segment {
  index: number;
  body: number;
  group: THREE.Group;
}

export function createGame(): Game {
  const meta = gameMeta('swerve')!;
  let ctx: GameContext;
  let phys: Physics3D;

  let renderer: THREE.WebGLRenderer;
  let scene: THREE.Scene;
  let camera: THREE.PerspectiveCamera;
  let sun: THREE.DirectionalLight;
  let aspect = 1;

  // shared geometry / materials (created once, disposed once)
  let floorGeo: THREE.BoxGeometry;
  let bankGeo: THREE.BoxGeometry;
  let rimGeo: THREE.BoxGeometry;
  let ballGeo: THREE.IcosahedronGeometry;
  let ballEdges: THREE.EdgesGeometry;
  let obsGeo: THREE.BoxGeometry;
  let obsTallGeo: THREE.BoxGeometry;
  let obsEdges: THREE.EdgesGeometry;
  let obsTallEdges: THREE.EdgesGeometry;
  let gemGeo: THREE.OctahedronGeometry;
  let gateGeo: THREE.TorusGeometry;
  let floorMat: THREE.MeshStandardMaterial;
  let bankMat: THREE.MeshStandardMaterial;
  let rimMat: THREE.MeshBasicMaterial;
  let ballMat: THREE.MeshStandardMaterial;
  let obsMatA: THREE.MeshStandardMaterial;
  let obsMatB: THREE.MeshStandardMaterial;
  let gemMat: THREE.MeshBasicMaterial;
  let gateMat: THREE.MeshBasicMaterial;
  let lineMat: THREE.LineBasicMaterial;
  let sparkMat: THREE.PointsMaterial;
  let sparkGeo: THREE.BufferGeometry;
  let sparkPts: THREE.Points;
  const sparkPos = new Float32Array(SPARK_N * 3);
  const sparkVel = new Float32Array(SPARK_N * 3);
  const sparkLife = new Float32Array(SPARK_N);
  let sparkCursor = 0;

  const FLOOR_BASE_HALF_LEN = SEG_LEN / 2 + SEG_OVERLAP;

  // world state
  let ballHandle = -1;
  let ballMass = 1;
  let ballMesh: THREE.Mesh;
  const segments: Segment[] = [];
  const obstacles = new Map<number, Obstacle>();
  const pickups = new Map<number, Pickup>();
  let offsets: number[] = [0, 0, 0];
  let nextSeg = 0;
  let nextId = FIRST_ID;

  // run state
  let mode: 'idle' | 'run' | 'dying' | 'over' = 'idle';
  let time = 0;
  let distance = 0;
  let bonus = 0;
  let score = 0;
  let speed = 0;
  let comboHeat = 0;
  let heatTimer = 0;
  let blipTicks = 0;
  let dieTicks = 0;
  let dragSteer = 0;
  let steerSmooth = 0;
  let steered = false;
  let grounded = false;
  let prevVx = 0;
  let prevVz = 0;
  let stateValid = false;
  let subShown = '';
  let windAcc = 0;
  let grindAcc = 0;
  let grindTick = 0;
  let nearMisses = 0;
  let gems = 0;
  let gates = 0;
  let caroms = 0;
  let deflects = 0;
  let fovCur = 60;
  const detachFns: Array<() => void> = [];

  // scratch (no per-tick allocation)
  const tmp: BodyState3D = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, awake: false, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 };
  const tmpO: BodyState3D = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, awake: false, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 };
  const pair: PairEvent = { slotA: 0, userA: 0, slotB: 0, userB: 0 };
  const hit: HitEvent = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, speed: 0, slotA: 0, userA: 0, slotB: 0, userB: 0 };
  let ray: RayHit = { hit: false, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, fraction: 0, slot: -1 };
  const camPos = new THREE.Vector3(0, 3.6, 4.2);
  const camLook = new THREE.Vector3(0, 1, -10);
  const v3a = new THREE.Vector3();
  const v3b = new THREE.Vector3();

  function clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
  }

  /** Lateral centreline offset per segment index (rng random walk, ramping amplitude). */
  function offsetAt(i: number): number {
    while (offsets.length <= i) {
      const prev = offsets[offsets.length - 1]!;
      const dist = (offsets.length - 1) * SEG_LEN;
      const amp = Math.min(0.5 + dist / 700, 1.4);
      offsets.push(clamp(prev + ctx.rng.range(-amp, amp), -8, 8));
    }
    return offsets[i]!;
  }

  // ---- particles (render-only; Math.random like stack's shake — keeps the seeded gameplay stream pure) ----

  function spawnSparks(x: number, y: number, z: number, n: number): void {
    for (let k = 0; k < n; k++) {
      const i = sparkCursor;
      sparkCursor = (sparkCursor + 1) % SPARK_N;
      sparkPos[i * 3] = x;
      sparkPos[i * 3 + 1] = y;
      sparkPos[i * 3 + 2] = z;
      sparkVel[i * 3] = (Math.random() - 0.5) * 5;
      sparkVel[i * 3 + 1] = 1.5 + Math.random() * 3.5;
      sparkVel[i * 3 + 2] = (Math.random() - 0.5) * 5;
      sparkLife[i] = 0.3 + Math.random() * 0.25;
    }
    sparkGeo.attributes['position']!.needsUpdate = true;
  }

  function updateSparks(dt: number): void {
    let any = false;
    for (let i = 0; i < SPARK_N; i++) {
      if (sparkLife[i]! <= 0) continue;
      any = true;
      sparkLife[i]! -= dt;
      sparkVel[i * 3 + 1]! -= 14 * dt;
      sparkPos[i * 3]! += sparkVel[i * 3]! * dt;
      sparkPos[i * 3 + 1]! += sparkVel[i * 3 + 1]! * dt;
      sparkPos[i * 3 + 2]! += sparkVel[i * 3 + 2]! * dt;
      if (sparkLife[i]! <= 0) sparkPos[i * 3 + 1] = -999;
    }
    if (any) sparkGeo.attributes['position']!.needsUpdate = true;
  }

  // ---- world building ----

  function buildSegmentGroup(halfLen: number): THREE.Group {
    const g = new THREE.Group();
    const zScale = halfLen / FLOOR_BASE_HALF_LEN;
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.position.set(0, -FLOOR_HALF_Y, 0);
    floor.scale.z = zScale;
    g.add(floor);
    const bx = TRACK_HALF_W + BANK_HALF_LEN * Math.cos(BANK_ANGLE) - BANK_TUCK;
    const by = BANK_HALF_LEN * Math.sin(BANK_ANGLE) - BANK_SINK;
    for (const side of [-1, 1] as const) {
      const bank = new THREE.Mesh(bankGeo, bankMat);
      bank.position.set(side * bx, by, 0);
      bank.rotation.z = side * BANK_ANGLE;
      bank.scale.z = zScale;
      g.add(bank);
      const rim = new THREE.Mesh(rimGeo, rimMat);
      rim.position.set(side * (TRACK_HALF_W - 0.1), 0.02, 0);
      rim.scale.z = zScale;
      g.add(rim);
    }
    return g;
  }

  function spawnObstacles(i: number, x0: number, x1: number, zStart: number): void {
    const dist = i * SEG_LEN;
    const maxN = 1 + Math.min(Math.floor(dist / 450), 2);
    for (let k = 0; k < maxN; k++) {
      if (!ctx.rng.chance(Math.min(0.32 + dist / 2600, 0.8))) continue;
      const z = zStart - ctx.rng.range(1.5, SEG_LEN - 1.5);
      const frac = (zStart - z) / SEG_LEN;
      const cx = x0 + (x1 - x0) * frac;
      const x = cx + ctx.rng.range(-(TRACK_HALF_W - 1.1), TRACK_HALF_W - 1.1);
      const tall = ctx.rng.chance(0.35);
      const hx = tall ? 0.42 : 0.55;
      const hy = tall ? 0.78 : 0.5;
      const hz = tall ? 0.42 : 0.55;
      const yawO = ctx.rng.range(0, Math.PI);
      const qy = Math.sin(yawO / 2);
      const qw = Math.cos(yawO / 2);
      const handle = phys.createBody({ type: BODY_DYNAMIC, position: [x, hy + 0.03, z], rotation: [0, qy, 0, qw], angularDamping: 0.05 });
      phys.addBox(handle, hx, hy, hz, { density: 0.4, friction: 0.45, restitution: 0.12, flags: SHAPE_CONTACT_EVENTS | SHAPE_HIT_EVENTS });
      // near-miss shell: sensor sphere on the same body (massless)
      phys.addSphere(handle, SHELL_R, { density: 0, flags: SHAPE_SENSOR });
      const id = nextId++;
      phys.setUserData(handle, id);
      const mesh = new THREE.Mesh(tall ? obsTallGeo : obsGeo, ctx.rng.chance(0.5) ? obsMatA : obsMatB);
      mesh.add(new THREE.LineSegments(tall ? obsTallEdges : obsEdges, lineMat));
      mesh.position.set(x, hy + 0.03, z);
      mesh.quaternion.set(0, qy, 0, qw);
      scene.add(mesh);
      obstacles.set(id, { id, handle, mesh, inShell: false, touched: false, knocked: false, fxDone: false });
    }
  }

  function spawnGems(_i: number, x0: number, x1: number, zStart: number): void {
    if (!ctx.rng.chance(0.55)) return;
    const laneOff = ctx.rng.range(-(TRACK_HALF_W - 1.2), TRACK_HALF_W - 1.2);
    const t0 = ctx.rng.range(2, 6.4);
    for (let j = 0; j < 3; j++) {
      const z = zStart - (t0 + j * 1.4);
      const frac = (zStart - z) / SEG_LEN;
      const x = x0 + (x1 - x0) * frac + laneOff;
      const y = 0.55;
      const handle = phys.createBody({ type: BODY_STATIC, position: [x, y, z] });
      phys.addSphere(handle, 0.38, { flags: SHAPE_SENSOR });
      const id = nextId++;
      phys.setUserData(handle, id);
      const mesh = new THREE.Mesh(gemGeo, gemMat);
      mesh.position.set(x, y, z);
      scene.add(mesh);
      pickups.set(id, { id, handle, mesh, kind: 'gem', x, y, z });
    }
  }

  function spawnGate(_i: number, x0: number, x1: number, zStart: number): void {
    const z = zStart - SEG_LEN / 2;
    const gx = (x0 + x1) / 2 + ctx.rng.range(-1.2, 1.2);
    const y = 1.05;
    const dxSeg = x1 - x0;
    const yaw = Math.atan2(-dxSeg, SEG_LEN);
    const qy = Math.sin(yaw / 2);
    const qw = Math.cos(yaw / 2);
    const handle = phys.createBody({ type: BODY_STATIC, position: [gx, y, z], rotation: [0, qy, 0, qw] });
    phys.addBox(handle, 1.15, 1.05, 0.18, { flags: SHAPE_SENSOR });
    const id = nextId++;
    phys.setUserData(handle, id);
    const mesh = new THREE.Mesh(gateGeo, gateMat);
    mesh.position.set(gx, y, z);
    mesh.quaternion.set(0, qy, 0, qw);
    scene.add(mesh);
    pickups.set(id, { id, handle, mesh, kind: 'gate', x: gx, y, z });
  }

  function spawnSegment(i: number): void {
    const x0 = offsetAt(i);
    const x1 = offsetAt(i + 1);
    const dx = x1 - x0;
    const zStart = -i * SEG_LEN;
    const mid: [number, number, number] = [(x0 + x1) / 2, 0, zStart - SEG_LEN / 2];
    const runLen = Math.hypot(dx, SEG_LEN);
    const halfLen = runLen / 2 + SEG_OVERLAP;
    const yaw = Math.atan2(-dx, SEG_LEN);
    const ys = Math.sin(yaw / 2);
    const yc = Math.cos(yaw / 2);
    const body = phys.createBody({ type: BODY_STATIC, position: mid, rotation: [0, ys, 0, yc] });
    phys.setUserData(body, UD_TRACK);
    phys.addBoxOffset(body, TRACK_HALF_W, FLOOR_HALF_Y, halfLen, [0, -FLOOR_HALF_Y, 0], [0, 0, 0, 1], { friction: 0.85, flags: SHAPE_HIT_EVENTS });
    const rs = Math.sin(BANK_ANGLE / 2);
    const rc = Math.cos(BANK_ANGLE / 2);
    const bx = TRACK_HALF_W + BANK_HALF_LEN * Math.cos(BANK_ANGLE) - BANK_TUCK;
    const by = BANK_HALF_LEN * Math.sin(BANK_ANGLE) - BANK_SINK;
    phys.addBoxOffset(body, BANK_HALF_LEN, BANK_HALF_THICK, halfLen, [-bx, by, 0], [0, 0, -rs, rc], { friction: 0.5, flags: SHAPE_HIT_EVENTS });
    phys.addBoxOffset(body, BANK_HALF_LEN, BANK_HALF_THICK, halfLen, [bx, by, 0], [0, 0, rs, rc], { friction: 0.5, flags: SHAPE_HIT_EVENTS });
    const group = buildSegmentGroup(halfLen);
    group.position.set(mid[0], mid[1], mid[2]);
    group.quaternion.set(0, ys, 0, yc);
    scene.add(group);
    segments.push({ index: i, body, group });
    // first 5 segments stay clean — the first 5 seconds teach by doing
    if (i >= 5) spawnObstacles(i, x0, x1, zStart);
    if (i >= 2) spawnGems(i, x0, x1, zStart);
    if (i >= 4 && ctx.rng.chance(0.2)) spawnGate(i, x0, x1, zStart);
  }

  function streamSegments(ballZ: number): void {
    while (nextSeg * SEG_LEN < -ballZ + AHEAD_M) spawnSegment(nextSeg++);
    while (segments.length > 0 && -(segments[0]!.index + 1) * SEG_LEN > ballZ + BEHIND_M) {
      const s = segments.shift()!;
      phys.destroyBody(s.body);
      scene.remove(s.group);
    }
  }

  function removeObstacle(o: Obstacle): void {
    if (phys.isValid(o.handle)) phys.destroyBody(o.handle);
    scene.remove(o.mesh);
    obstacles.delete(o.id);
  }

  function removePickup(p: Pickup): void {
    if (phys.isValid(p.handle)) phys.destroyBody(p.handle);
    scene.remove(p.mesh);
    pickups.delete(p.id);
  }

  // ---- scoring / feedback ----

  function addBonus(v: number): void {
    bonus = Math.min(bonus + v, BONUS_CAP);
  }

  function heatUp(): void {
    comboHeat += 1;
    heatTimer = 0;
  }

  function collect(p: Pickup): void {
    removePickup(p);
    spawnSparks(p.x, p.y, p.z, 6);
    if (p.kind === 'gem') {
      gems += 1;
      addBonus(GEM_BONUS);
      heatUp();
      ctx.audio.pop(Math.min(comboHeat, 8));
    } else {
      gates += 1;
      addBonus(GATE_BONUS);
      heatUp();
      ctx.audio.chime(2);
      ctx.hud.showCombo('GATE +3%');
    }
  }

  function nearMiss(): void {
    nearMisses += 1;
    addBonus(NEAR_MISS_BONUS);
    heatUp();
    ctx.hud.showCombo('NEAR MISS +5%', comboHeat >= 4);
    ctx.audio.whoosh();
    ctx.audio.note(1400, { dur: 0.12, type: 'sine', vol: 0.1, slideTo: 1900 });
    ctx.audio.buzz(10);
    if (!ctx.settings().reducedMotion) blipTicks = BLIP_TICKS;
  }

  function die(reason: 'fell' | 'headon'): void {
    if (mode !== 'run') return;
    mode = 'dying';
    dieTicks = ctx.settings().reducedMotion ? 20 : 42;
    ctx.audio.womp();
    ctx.audio.noise({ dur: 0.3, vol: 0.25, freq: 250, q: 0.8 });
    ctx.audio.buzz(60);
    ctx.hud.flash(reason === 'fell' ? 'GUTTERED' : 'WIPEOUT');
    ctx.hud.setSub('');
    subShown = '';
  }

  function otherOf(a: number, b: number): number {
    if (a === UD_BALL) return b;
    if (b === UD_BALL) return a;
    return -1;
  }

  // ---- event pumps ----

  function pumpContacts(): void {
    const n = phys.contactBeginCount();
    for (let i = 0; i < n; i++) {
      phys.readContactBegin(i, pair);
      const other = otherOf(pair.userA, pair.userB);
      if (other < 0) continue;
      const o = obstacles.get(other);
      if (o) {
        o.touched = true;
        o.inShell = false;
        o.knocked = true; // stays knocked — the engine keeps it live from here
      }
    }
  }

  function pumpSensors(): void {
    const nb = phys.sensorBeginCount();
    for (let i = 0; i < nb; i++) {
      phys.readSensorBegin(i, pair);
      const other = otherOf(pair.userA, pair.userB);
      if (other < 0) continue;
      const o = obstacles.get(other);
      if (o) {
        if (!o.touched) o.inShell = true;
        continue;
      }
      const p = pickups.get(other);
      if (p && mode === 'run') collect(p);
    }
    const ne = phys.sensorEndCount();
    for (let i = 0; i < ne; i++) {
      phys.readSensorEnd(i, pair);
      const other = otherOf(pair.userA, pair.userB);
      if (other < 0) continue;
      const o = obstacles.get(other);
      if (o && o.inShell) {
        o.inShell = false;
        if (!o.touched && mode === 'run') nearMiss();
      }
    }
  }

  function pumpHits(): void {
    const n = phys.hitCount();
    let thuds = 0;
    for (let i = 0; i < n; i++) {
      phys.readHit(i, hit);
      const other = otherOf(hit.userA, hit.userB);
      if (other >= 0) {
        const o = obstacles.get(other);
        if (o) {
          // ball ↔ obstacle impact — head-on vs glancing, engine-measured
          spawnSparks(hit.x, hit.y, hit.z, 8);
          if (thuds++ < 3) ctx.audio.thud(hit.speed);
          ctx.audio.buzz(12);
          if (mode === 'run') {
            const ps = Math.hypot(prevVx, prevVz);
            if (ps > 3) {
              const dot = Math.abs((hit.nx * prevVx + hit.nz * prevVz) / ps);
              if (hit.speed > Math.max(HEADON_MIN_SPEED, ps * 0.5) && dot > HEADON_DOT) {
                die('headon');
              } else if (!o.fxDone && hit.speed > 3) {
                o.fxDone = true;
                deflects += 1;
                ctx.hud.showCombo('DEFLECT');
              }
            }
          }
        } else if (hit.userA === UD_TRACK || hit.userB === UD_TRACK) {
          // ball landing back on the gutter after a hop
          if (hit.speed > 3 && thuds++ < 3) ctx.audio.thud(hit.speed * 0.6);
        }
      } else {
        const oa = obstacles.get(hit.userA);
        const ob = obstacles.get(hit.userB);
        if (oa && ob) {
          // the twist paying off: a knocked obstacle caroms into another
          if ((oa.knocked || ob.knocked) && hit.speed > 3) {
            caroms += 1;
            oa.knocked = true;
            ob.knocked = true;
            spawnSparks(hit.x, hit.y, hit.z, 10);
            if (thuds++ < 3) ctx.audio.thud(hit.speed * 0.8);
            ctx.hud.showCombo('CAROM!', true);
            ctx.audio.pop(6);
          }
        } else if ((oa || ob) && (hit.userA === UD_TRACK || hit.userB === UD_TRACK)) {
          if (hit.speed > 4 && thuds++ < 3) ctx.audio.thud(hit.speed * 0.4); // tumbling
        }
      }
    }
  }

  // ---- housekeeping per tick ----

  function updateObstacles(): void {
    for (const o of obstacles.values()) {
      if (!phys.readBody(o.handle, tmpO)) {
        removeObstacle(o);
        continue;
      }
      o.mesh.position.set(tmpO.x, tmpO.y, tmpO.z);
      o.mesh.quaternion.set(tmpO.qx, tmpO.qy, tmpO.qz, tmpO.qw);
      if (tmpO.z > tmp.z + BEHIND_M || tmpO.y < -12) removeObstacle(o);
    }
  }

  function updatePickups(dt: number): void {
    const magnet = comboHeat >= MAGNET_HEAT;
    for (const p of pickups.values()) {
      if (p.z > tmp.z + BEHIND_M) {
        removePickup(p);
        continue;
      }
      if (magnet && p.kind === 'gem') {
        const dx = tmp.x - p.x;
        const dy = tmp.y - p.y;
        const dz = tmp.z - p.z;
        const d = Math.hypot(dx, dy, dz);
        if (d < MAGNET_RADIUS && d > 0.001) {
          // gem magnet trail: sensors only (no collision response) slide toward the ball
          const t = Math.min((10 * dt) / d, 1);
          p.x += dx * t;
          p.y += dy * t;
          p.z += dz * t;
          phys.setTransform(p.handle, p.x, p.y, p.z);
          p.mesh.position.set(p.x, p.y, p.z);
        }
      }
    }
  }

  function updateGrind(dt: number): void {
    if (mode !== 'run' || !grounded || speed < 8) return;
    const idx = Math.max(Math.floor(-tmp.z / SEG_LEN), 0);
    const frac = clamp((-tmp.z - idx * SEG_LEN) / SEG_LEN, 0, 1);
    const cx = offsetAt(idx) + (offsetAt(idx + 1) - offsetAt(idx)) * frac;
    const lat = tmp.x - cx;
    if (Math.abs(lat) < TRACK_HALF_W - 0.45) return;
    grindTick += 1;
    if (grindTick % 3 === 0) spawnSparks(tmp.x + Math.sign(lat) * 0.3, tmp.y - 0.2, tmp.z, 3);
    grindAcc += dt;
    if (grindAcc > 0.18) {
      grindAcc = 0;
      ctx.audio.noise({ dur: 0.08, vol: 0.05, freq: 2200, q: 2 });
    }
  }

  function updateSub(): void {
    let wanted = '';
    if (mode === 'run') {
      if (!steered && time < HINT_SECONDS) wanted = 'drag or ← → to steer';
      else if (bonus > 0) wanted = `bonus ×${(1 + bonus).toFixed(2)}`;
    }
    if (wanted !== subShown) {
      subShown = wanted;
      ctx.hud.setSub(wanted);
    }
  }

  function fovFor(base: number): number {
    if (aspect >= 1) return base;
    const h = Math.tan(THREE.MathUtils.degToRad(base / 2));
    return Math.min(THREE.MathUtils.radToDeg(2 * Math.atan(h / aspect)), 100);
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
      scene.background = new THREE.Color(pal.bg);
      scene.fog = new THREE.Fog(pal.bg, 24, 95);

      camera = new THREE.PerspectiveCamera(60, 1, 0.1, 160);
      scene.add(new THREE.HemisphereLight('#7f95ff', '#141028', 0.95));
      sun = new THREE.DirectionalLight('#ffe3b8', 1.7);
      sun.position.set(8, 14, 6);
      scene.add(sun);
      scene.add(sun.target);

      // shared geometry
      floorGeo = new THREE.BoxGeometry(TRACK_HALF_W * 2, FLOOR_HALF_Y * 2, FLOOR_BASE_HALF_LEN * 2);
      bankGeo = new THREE.BoxGeometry(BANK_HALF_LEN * 2, BANK_HALF_THICK * 2, FLOOR_BASE_HALF_LEN * 2);
      rimGeo = new THREE.BoxGeometry(0.1, 0.06, FLOOR_BASE_HALF_LEN * 2);
      ballGeo = new THREE.IcosahedronGeometry(BALL_R, 1);
      ballEdges = new THREE.EdgesGeometry(ballGeo);
      obsGeo = new THREE.BoxGeometry(1.1, 1.0, 1.1);
      obsTallGeo = new THREE.BoxGeometry(0.84, 1.56, 0.84);
      obsEdges = new THREE.EdgesGeometry(obsGeo);
      obsTallEdges = new THREE.EdgesGeometry(obsTallGeo);
      gemGeo = new THREE.OctahedronGeometry(0.3);
      gateGeo = new THREE.TorusGeometry(1.25, 0.07, 10, 36);

      // materials — track/obstacle tones are deliberate material colors;
      // UI-facing tints (ball, rims, sparks) come from the palette
      floorMat = new THREE.MeshStandardMaterial({ color: '#141b3c', roughness: 0.95 });
      bankMat = new THREE.MeshStandardMaterial({ color: '#1e2a58', roughness: 0.85 });
      rimMat = new THREE.MeshBasicMaterial({ color: pal.glow });
      ballMat = new THREE.MeshStandardMaterial({ color: pal.accent, flatShading: true, roughness: 0.35, metalness: 0.15 });
      obsMatA = new THREE.MeshStandardMaterial({ color: '#e0653c', roughness: 0.6 });
      obsMatB = new THREE.MeshStandardMaterial({ color: '#c93b52', roughness: 0.6 });
      gemMat = new THREE.MeshBasicMaterial({ color: '#43ffd9' });
      gateMat = new THREE.MeshBasicMaterial({ color: '#ffd75e' });
      lineMat = new THREE.LineBasicMaterial({ color: '#0b0e1a', transparent: true, opacity: 0.4 });
      sparkMat = new THREE.PointsMaterial({ color: pal.glow, size: 0.12, transparent: true, opacity: 0.95, depthWrite: false });

      sparkGeo = new THREE.BufferGeometry();
      sparkPos.fill(0);
      for (let i = 0; i < SPARK_N; i++) sparkPos[i * 3 + 1] = -999;
      sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3));
      sparkPts = new THREE.Points(sparkGeo, sparkMat);
      sparkPts.frustumCulled = false;
      scene.add(sparkPts);

      ballMesh = new THREE.Mesh(ballGeo, ballMat);
      ballMesh.add(new THREE.LineSegments(ballEdges, lineMat));
      scene.add(ballMesh);

      const resize = (w: number, h: number): void => {
        renderer.setSize(w, h, true);
        aspect = w / Math.max(h, 1);
        camera.aspect = aspect;
        camera.updateProjectionMatrix();
      };
      ctx.onResize(resize);
      resize(ctx.width, ctx.height);

      detachFns.push(
        ctx.input.onDrag((e) => {
          dragSteer = clamp(dragSteer + e.dx * (2.4 / Math.max(ctx.width, 1)), -1, 1);
          steered = true;
        }),
      );
    },

    start(): void {
      // full rebuild — phys.init clears every body/joint in one call
      for (const s of segments) scene.remove(s.group);
      segments.length = 0;
      for (const o of obstacles.values()) scene.remove(o.mesh);
      obstacles.clear();
      for (const p of pickups.values()) scene.remove(p.mesh);
      pickups.clear();
      for (let i = 0; i < SPARK_N; i++) {
        sparkLife[i] = 0;
        sparkPos[i * 3 + 1] = -999;
      }
      sparkGeo.attributes['position']!.needsUpdate = true;

      phys.init(0, -24, 0);
      phys.setHitEventThreshold(1.2);

      offsets = [0, 0, 0];
      nextSeg = 0;
      nextId = FIRST_ID;
      streamSegments(0);

      ballHandle = phys.createBody({
        type: BODY_DYNAMIC,
        position: [0, BALL_R + 0.6, SPAWN_Z],
        angularDamping: 0.08,
        enableSleep: false,
        bullet: true,
      });
      phys.addSphere(ballHandle, BALL_R, { density: 2, friction: 0.9, restitution: 0.05, flags: SHAPE_CONTACT_EVENTS | SHAPE_HIT_EVENTS });
      phys.setUserData(ballHandle, UD_BALL);
      phys.setFilter(ballHandle, CAT_BALL, 0xffffffff); // explicit category so the ground ray can mask the ball out
      phys.setLinearVelocity(ballHandle, 0, 0, -BASE_SPEED * 0.6);
      ballMass = phys.getMass(ballHandle);
      stateValid = phys.readBody(ballHandle, tmp);
      ballMesh.position.set(0, BALL_R + 0.6, SPAWN_Z);

      mode = 'run';
      time = 0;
      distance = 0;
      bonus = 0;
      score = 0;
      speed = 0;
      comboHeat = 0;
      heatTimer = 0;
      blipTicks = 0;
      dieTicks = 0;
      dragSteer = 0;
      steerSmooth = 0;
      steered = false;
      grounded = true;
      prevVx = 0;
      prevVz = -BASE_SPEED * 0.6;
      windAcc = 0;
      grindAcc = 0;
      grindTick = 0;
      nearMisses = 0;
      gems = 0;
      gates = 0;
      caroms = 0;
      deflects = 0;
      subShown = '';
      camPos.set(0, 3.6, SPAWN_Z + 6.4);
      camLook.set(0, 1, SPAWN_Z - 8);
      fovCur = fovFor(55);
      ctx.hud.setScore(0);
      ctx.hud.setSub('drag or ← → to steer');
      subShown = 'drag or ← → to steer';
    },

    step(dt: number): void {
      if (mode !== 'run' && mode !== 'dying') return;
      time += dt;

      let simDt = dt;
      if (mode === 'dying') {
        if (!ctx.settings().reducedMotion) simDt = dt * 0.3; // death slow-mo (skipped under reduced motion)
      } else if (blipTicks > 0) {
        simDt = dt * BLIP_SCALE; // near-miss time-dilation blip
        blipTicks -= 1;
      }

      if (mode === 'run' && stateValid) {
        const kb = ctx.input.axis();
        if (kb !== 0) steered = true;
        if (!ctx.input.pointerDown) dragSteer -= dragSteer * Math.min(5 * dt, 1);
        const steer = clamp(kb + dragSteer, -1, 1);
        steerSmooth += (steer - steerSmooth) * Math.min(10 * dt, 1);

        // ground-stick ray (mask excludes the ball's own category)
        ray = phys.castRayClosest([tmp.x, tmp.y, tmp.z], [0, -(BALL_R + 0.35), 0], 0xffffffff, MASK_NOT_BALL, ray);
        grounded = ray.hit;

        const fwd = -tmp.vz;
        const target = BASE_SPEED * Math.min(1 + RAMP_PER_100M * (distance / 100), SPEED_CAP_MULT);
        const accel = clamp((target - fwd) * 2.6, -4, 6);
        phys.applyForce(ballHandle, steer * LAT_ACCEL * (grounded ? 1 : AIR_STEER) * ballMass, 0, -accel * ballMass);
        prevVx = tmp.vx;
        prevVz = tmp.vz;
      }

      phys.step(simDt, SUBSTEPS);
      stateValid = phys.readBody(ballHandle, tmp);

      if (stateValid) {
        ballMesh.position.set(tmp.x, tmp.y, tmp.z);
        ballMesh.quaternion.set(tmp.qx, tmp.qy, tmp.qz, tmp.qw);
        speed = Math.hypot(tmp.vx, tmp.vz);
        if (mode === 'run') {
          distance = Math.max(distance, SPAWN_Z - tmp.z);
          score = distance * (1 + bonus);
          ctx.hud.setScore(Math.floor(score));
          if (tmp.y < KILL_Y) die('fell');
        }
        streamSegments(tmp.z);
      }

      pumpHits();
      pumpContacts();
      pumpSensors();
      updateObstacles();
      updatePickups(simDt);
      updateGrind(dt);
      updateSparks(dt);
      updateSub();

      // combo heat decays — magnet + hot combos need sustained pickups
      heatTimer += dt;
      if (heatTimer > 3.5 && comboHeat > 0) {
        comboHeat -= 1;
        heatTimer = 0;
      }

      // wind — filtered noise, volume scaled by speed
      windAcc += dt;
      if (mode === 'run' && windAcc > 0.11 && speed > 7) {
        windAcc = 0;
        const f = clamp((speed - BASE_SPEED) / (BASE_SPEED * (SPEED_CAP_MULT - 1)), 0, 1);
        ctx.audio.noise({ dur: 0.22, vol: 0.015 + f * 0.055, freq: 900 + f * 900, q: 0.5 });
      }

      if (mode === 'dying') {
        dieTicks -= 1;
        if (dieTicks <= 0) {
          mode = 'over';
          ctx.endRun({
            score: Math.floor(score),
            durationMs: 0,
            seed: 0,
            stats: {
              nearMisses,
              gems,
              gates,
              caroms,
              deflects,
              distance: Math.floor(distance),
            },
          });
        }
      }
    },

    render(): void {
      const dt = 1 / 60;

      // gem spin/bob + gate presence (visual only)
      for (const p of pickups.values()) {
        if (p.kind === 'gem') {
          p.mesh.rotation.y += 0.05;
          p.mesh.position.y = p.y + Math.sin(time * 3 + p.id) * 0.08;
        }
      }

      // chase cam — position lags the ball, FOV widens with speed
      v3a.set(tmp.x, tmp.y + 3.0, tmp.z + 6.2);
      camPos.lerp(v3a, Math.min(dt * 7, 1));
      v3b.set(tmp.x, tmp.y + 0.9, tmp.z - 8);
      camLook.lerp(v3b, Math.min(dt * 9, 1));
      camera.position.copy(camPos);
      camera.up.set(Math.sin(-steerSmooth * 0.06), 1, 0).normalize();
      camera.lookAt(camLook);

      const f = clamp((speed - BASE_SPEED) / (BASE_SPEED * (SPEED_CAP_MULT - 1)), 0, 1);
      const targetFov = fovFor(55 + f * 16);
      fovCur += (targetFov - fovCur) * Math.min(dt * 5, 1);
      camera.fov = fovCur;
      camera.updateProjectionMatrix();

      sun.position.set(tmp.x + 8, tmp.y + 14, tmp.z + 6);
      sun.target.position.set(tmp.x, tmp.y, tmp.z - 6);

      renderer.render(scene, camera);
    },

    dispose(): void {
      for (const d of detachFns) d();
      detachFns.length = 0;
      phys.init(0, -10, 0);
      renderer.dispose();
      floorGeo.dispose();
      bankGeo.dispose();
      rimGeo.dispose();
      ballGeo.dispose();
      ballEdges.dispose();
      obsGeo.dispose();
      obsTallGeo.dispose();
      obsEdges.dispose();
      obsTallEdges.dispose();
      gemGeo.dispose();
      gateGeo.dispose();
      sparkGeo.dispose();
      floorMat.dispose();
      bankMat.dispose();
      rimMat.dispose();
      ballMat.dispose();
      obsMatA.dispose();
      obsMatB.dispose();
      gemMat.dispose();
      gateMat.dispose();
      lineMat.dispose();
      sparkMat.dispose();
    },
  };
}
