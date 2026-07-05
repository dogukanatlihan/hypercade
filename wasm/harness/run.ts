// M0 shim conformance harness — headless Node (npm run harness).
// Exercises every shim call per engine, soaks for NaN/explosions, stress-times
// 500 bodies, and runs the determinism audit (same seed + inputs twice ⇒
// identical state buffers). TECH-BRIEF §9.

import { Physics2D, BODY_STATIC as S2, BODY_KINEMATIC as K2, SHAPE_SENSOR as SEN2, SHAPE_CONTACT_EVENTS as CE2, SHAPE_HIT_EVENTS as HE2 } from '../../client/sdk/physics2d.ts';
import { Physics3D, BODY_STATIC as S3, BODY_KINEMATIC as K3, SHAPE_SENSOR as SEN3, SHAPE_CONTACT_EVENTS as CE3, SHAPE_HIT_EVENTS as HE3 } from '../../client/sdk/physics3d.ts';

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail = ''): void {
  checks++;
  if (cond) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function assertFinite(buf: Float32Array, label: string): boolean {
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i]!;
    if (!Number.isFinite(v)) {
      console.error(`  NaN/Inf at ${label}[${i}] = ${v}`);
      return false;
    }
  }
  return true;
}

function hashStates(buf: Float32Array): string {
  // FNV-1a over the raw bytes — bit-exact state comparison.
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

// ---------------- 2D ----------------

async function test2d(): Promise<void> {
  console.log('\n== Box2D v3 (w2_) ==');
  const p = await Physics2D.create([0, -10]);

  // ground + shapes of every type
  const ground = p.createBody({ type: S2, position: [0, -1] });
  p.addBox(ground, 50, 1, { friction: 0.8 });
  const wall = p.createBody({ type: S2, position: [-20, 10] });
  p.addSegment(wall, [0, -10], [0, 10]);

  const box = p.createBody({ position: [0, 4] });
  p.addBox(box, 0.5, 0.5, { flags: CE2 | HE2 });
  const ball = p.createBody({ position: [2, 6] });
  p.addCircle(ball, 0.5, { restitution: 0.4, flags: HE2 });
  const cap = p.createBody({ position: [-2, 5] });
  p.addCapsule(cap, [-0.4, 0], [0.4, 0], 0.3);
  const compound = p.createBody({ position: [4, 5] });
  p.addBoxOffset(compound, 0.3, 0.3, -0.5, 0, 0);
  p.addBoxOffset(compound, 0.3, 0.3, 0.5, 0, 0);

  // sensor plate
  const sensor = p.createBody({ type: S2, position: [0, 1] });
  p.addBox(sensor, 3, 0.2, { flags: SEN2 });
  p.setUserData(sensor, 77);
  p.setUserData(box, 42);

  let sawContact = false;
  let sawHit = false;
  let sawSensor = false;
  let sensorUserOk = false;
  const pair = { slotA: 0, userA: 0, slotB: 0, userB: 0 };
  const hit = { x: 0, y: 0, nx: 0, ny: 0, speed: 0, slotA: 0, userA: 0, slotB: 0, userB: 0 };

  for (let i = 0; i < 240; i++) {
    p.step(1 / 60, 4);
    if (p.contactBeginCount() > 0) sawContact = true;
    for (let h = 0; h < p.hitCount(); h++) {
      p.readHit(h, hit);
      if (hit.speed > 0) sawHit = true;
    }
    for (let s = 0; s < p.sensorBeginCount(); s++) {
      p.readSensorBegin(s, pair);
      sawSensor = true;
      if (pair.userA === 77 || pair.userB === 77) sensorUserOk = true;
    }
  }
  check('2d contact begin events', sawContact);
  check('2d hit events with speed', sawHit);
  check('2d sensor begin events', sawSensor);
  check('2d sensor event carries user data', sensorUserOk);
  check('2d soak finite', assertFinite(p.states(), 'states2d'));

  const st = { x: 0, y: 0, angle: 0, awake: false, vx: 0, vy: 0, w: 0 };
  check('2d readBody valid', p.readBody(box, st));
  check('2d box rests on ground', st.y > -0.6 && st.y < 1.2, `y=${st.y}`);

  // raycast down onto ground
  const ray = p.castRayClosest([10, 5], [0, -20]);
  check('2d raycast hit', ray.hit && Math.abs(ray.y - 0) < 0.05, `y=${ray.y}`);

  // filters: ground category 1, ghost masks only category 4 — never collide.
  // (Box3D's default shape category is ALL bits, so the ground filter must be explicit.)
  p.setFilter(ground, 0x1, 0xffffffff);
  const ghost = p.createBody({ position: [8, 3] });
  p.addCircle(ghost, 0.3);
  p.setFilter(ghost, 0x2, 0x4);
  for (let i = 0; i < 120; i++) p.step(1 / 60, 4);
  p.readBody(ghost, st);
  check('2d filter falls through ground', st.y < -2, `y=${st.y}`);

  // kinematic target motion
  const kin = p.createBody({ type: K2, position: [0, 8] });
  p.addBox(kin, 1, 0.2);
  for (let i = 0; i < 60; i++) {
    p.setTargetTransform(kin, i * 0.05, 8, 0, 1 / 60);
    p.step(1 / 60, 4);
  }
  p.readBody(kin, st);
  check('2d kinematic target transform', Math.abs(st.x - 59 * 0.05) < 0.2, `x=${st.x}`);

  // revolute pendulum
  const pivot = p.createBody({ type: S2, position: [12, 8] });
  p.addBox(pivot, 0.1, 0.1);
  const bob = p.createBody({ position: [14, 8] });
  p.addBox(bob, 0.4, 0.1);
  const rj = p.createRevoluteJoint(pivot, bob, [12, 8]);
  check('2d revolute created', rj >= 0);
  let minY = 8;
  for (let i = 0; i < 120; i++) {
    p.step(1 / 60, 4);
    p.readBody(bob, st);
    minY = Math.min(minY, st.y);
  }
  check('2d pendulum swings down', minY < 7, `minY=${minY}`);

  // distance joint holds length
  const anchor = p.createBody({ type: S2, position: [18, 10] });
  p.addBox(anchor, 0.1, 0.1);
  const weight = p.createBody({ position: [18, 8] });
  p.addCircle(weight, 0.2);
  p.createDistanceJoint(anchor, weight, [18, 10], [18, 8], 2);
  for (let i = 0; i < 120; i++) p.step(1 / 60, 4);
  p.readBody(weight, st);
  const dist = Math.hypot(st.x - 18, st.y - 10);
  check('2d distance joint holds', Math.abs(dist - 2) < 0.1, `d=${dist}`);

  // prismatic with motor
  const rail = p.createBody({ type: S2, position: [24, 5] });
  p.addBox(rail, 0.1, 0.1);
  const slider = p.createBody({ position: [24, 5] });
  p.addBox(slider, 0.3, 0.3);
  const pj = p.createPrismaticJoint(rail, slider, [24, 5], [1, 0], { enableMotor: true, motorSpeed: 2, maxMotorForce: 500, enableLimit: true, lower: -3, upper: 3 });
  for (let i = 0; i < 90; i++) p.step(1 / 60, 4);
  p.readBody(slider, st);
  check('2d prismatic motor drives +x', st.x > 24.5, `x=${st.x}`);
  p.setMotorSpeed(pj, -2);
  for (let i = 0; i < 30; i++) p.step(1 / 60, 4);
  const xAfter = st.x;
  p.readBody(slider, st);
  check('2d motor speed reversal', st.x < xAfter, `x=${st.x}`);

  // mouse joint pulls body to target
  const mground = p.createBody({ type: S2, position: [30, 20] });
  p.addBox(mground, 0.1, 0.1);
  const dragged = p.createBody({ position: [30, 5], gravityScale: 0 });
  p.addCircle(dragged, 0.3);
  // grab at the body's current position, then drag the target to 33
  const mj = p.createMouseJoint(mground, dragged, [30, 5], { hertz: 8, maxForce: 200 });
  for (let i = 0; i < 120; i++) {
    p.setMouseTarget(mj, Math.min(30 + i * 0.1, 33), 5);
    p.step(1 / 60, 4);
  }
  p.readBody(dragged, st);
  check('2d mouse joint pulls to target', Math.abs(st.x - 33) < 0.3, `x=${st.x}`);
  p.destroyJoint(mj);

  // generation-checked handles: destroy, recreate (slot reuse), stale handle rejected
  const tmp = p.createBody({ position: [0, 20] });
  p.addCircle(tmp, 0.1);
  p.destroyBody(tmp);
  const reused = p.createBody({ position: [0, 21] });
  p.addCircle(reused, 0.1);
  check('2d slot reused', (tmp & 0xffff) === (reused & 0xffff));
  check('2d stale handle invalid', !p.isValid(tmp) && p.isValid(reused));
  p.setLinearVelocity(tmp, 99, 99); // must no-op
  p.step(1 / 60, 4);
  p.readBody(reused, st);
  check('2d stale handle no-op', Math.abs(st.vx) < 1, `vx=${st.vx}`);

  // body type swap: static becomes dynamic and falls
  const swap = p.createBody({ type: S2, position: [40, 5] });
  p.addBox(swap, 0.3, 0.3);
  for (let i = 0; i < 30; i++) p.step(1 / 60, 4);
  p.readBody(swap, st);
  const yStatic = st.y;
  p.setBodyType(swap, 2);
  for (let i = 0; i < 60; i++) p.step(1 / 60, 4);
  p.readBody(swap, st);
  check('2d body type swap falls', st.y < yStatic - 1, `y=${st.y}`);

  // per-step force + impulses + sleep control
  p.applyForce(reused, 50, 0);
  p.applyImpulse(reused, 0, 2);
  p.applyImpulseAt(reused, 0.1, 0, 0, 21);
  p.applyTorque(reused, 1);
  p.setAwake(reused, true);
  p.setGravityScale(reused, 0.5);
  p.step(1 / 60, 4);
  check('2d force/impulse APIs finite', assertFinite(p.states(), 'states2d'));
  check('2d getMass positive', p.getMass(reused) > 0);

  // 1000-step soak
  let finite = true;
  for (let i = 0; i < 1000; i++) {
    p.step(1 / 60, 4);
    if (i % 100 === 0 && !assertFinite(p.states(), `soak2d@${i}`)) {
      finite = false;
      break;
    }
  }
  check('2d 1000-step soak', finite);

  // 500-body stress timing
  p.init(0, -10);
  const g2 = p.createBody({ type: S2, position: [0, -1] });
  p.addBox(g2, 60, 1);
  for (let i = 0; i < 500; i++) {
    const b = p.createBody({ position: [(i % 25) * 0.9 - 11, 2 + Math.floor(i / 25) * 0.9] });
    p.addBox(b, 0.4, 0.4);
  }
  const t0 = performance.now();
  for (let i = 0; i < 120; i++) p.step(1 / 60, 4);
  const ms2 = (performance.now() - t0) / 120;
  check('2d 500-body stress finite', assertFinite(p.states(), 'stress2d'));
  console.log(`  time  2d 500-body avg step: ${ms2.toFixed(2)} ms`);

  // determinism audit — same construction + inputs twice
  const run = (): string => {
    p.init(0, -10);
    const g = p.createBody({ type: S2, position: [0, -1] });
    p.addBox(g, 50, 1);
    const bodies: number[] = [];
    for (let i = 0; i < 60; i++) {
      const b = p.createBody({ position: [(i % 10) * 0.8 - 4, 2 + Math.floor(i / 10) * 0.8] });
      if (i % 3 === 0) p.addCircle(b, 0.3, { restitution: 0.5 });
      else p.addBox(b, 0.3, 0.3);
      bodies.push(b);
    }
    for (let s = 0; s < 300; s++) {
      if (s % 45 === 0) p.applyImpulse(bodies[s % bodies.length]!, 1.5, 3);
      p.step(1 / 60, 4);
    }
    return hashStates(p.states());
  };
  const h1 = run();
  const h2 = run();
  check('2d determinism (same-binary replay)', h1 === h2, `${h1} vs ${h2}`);
  console.log(`  info  2d state hash: ${h1}`);
}

// ---------------- 3D ----------------

async function test3d(): Promise<void> {
  console.log('\n== Box3D (w3_) ==');
  const p = await Physics3D.create([0, -10, 0]);

  const ground = p.createBody({ type: S3, position: [0, -1, 0] });
  p.addBox(ground, 50, 1, 50, { friction: 0.8 });

  const box = p.createBody({ position: [0, 4, 0] });
  p.addBox(box, 0.5, 0.5, 0.5, { flags: CE3 | HE3 });
  const ball = p.createBody({ position: [2, 6, 0] });
  p.addSphere(ball, 0.5, { restitution: 0.4, flags: HE3 });
  const cap = p.createBody({ position: [-2, 5, 0] });
  p.addCapsule(cap, [-0.4, 0, 0], [0.4, 0, 0], 0.3);
  const compound = p.createBody({ position: [4, 5, 0] });
  p.addBoxOffset(compound, 0.3, 0.3, 0.3, [-0.5, 0, 0]);
  p.addBoxOffset(compound, 0.3, 0.3, 0.3, [0.5, 0, 0]);

  const sensor = p.createBody({ type: S3, position: [0, 1, 0] });
  p.addBox(sensor, 3, 0.2, 3, { flags: SEN3 });
  p.setUserData(sensor, 77);
  p.setUserData(box, 42);

  let sawContact = false;
  let sawHit = false;
  let sawSensor = false;
  let sensorUserOk = false;
  const pair = { slotA: 0, userA: 0, slotB: 0, userB: 0 };
  const hit = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, speed: 0, slotA: 0, userA: 0, slotB: 0, userB: 0 };

  for (let i = 0; i < 240; i++) {
    p.step(1 / 60, 4);
    if (p.contactBeginCount() > 0) sawContact = true;
    for (let h = 0; h < p.hitCount(); h++) {
      p.readHit(h, hit);
      if (hit.speed > 0) sawHit = true;
    }
    for (let s = 0; s < p.sensorBeginCount(); s++) {
      p.readSensorBegin(s, pair);
      sawSensor = true;
      if (pair.userA === 77 || pair.userB === 77) sensorUserOk = true;
    }
  }
  check('3d contact begin events', sawContact);
  check('3d hit events with speed', sawHit);
  check('3d sensor begin events', sawSensor);
  check('3d sensor event carries user data', sensorUserOk);
  check('3d soak finite', assertFinite(p.states(), 'states3d'));

  const st = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, awake: false, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 };
  check('3d readBody valid', p.readBody(box, st));
  check('3d box rests on ground', st.y > -0.6 && st.y < 1.4, `y=${st.y}`);

  const ray = p.castRayClosest([10, 5, 0], [0, -20, 0]);
  check('3d raycast hit', ray.hit && Math.abs(ray.y - 0) < 0.05, `y=${ray.y}`);

  // Box3D's default shape category is ALL bits (unlike Box2D's 1) — the ground
  // filter must be set explicitly for masking to have anything to miss.
  p.setFilter(ground, 0x1, 0xffffffff);
  const ghost = p.createBody({ position: [8, 3, 0] });
  p.addSphere(ghost, 0.3);
  p.setFilter(ghost, 0x2, 0x4);
  for (let i = 0; i < 120; i++) p.step(1 / 60, 4);
  p.readBody(ghost, st);
  check('3d filter falls through ground', st.y < -2, `y=${st.y}`);

  const kin = p.createBody({ type: K3, position: [0, 8, 0] });
  p.addBox(kin, 1, 0.2, 1);
  for (let i = 0; i < 60; i++) {
    p.setTargetTransform(kin, i * 0.05, 8, 0, 0, 0, 0, 1, 1 / 60);
    p.step(1 / 60, 4);
  }
  p.readBody(kin, st);
  check('3d kinematic target transform', Math.abs(st.x - 59 * 0.05) < 0.2, `x=${st.x}`);

  // revolute pendulum about z-axis
  const pivot = p.createBody({ type: S3, position: [12, 8, 0] });
  p.addBox(pivot, 0.1, 0.1, 0.1);
  const bob = p.createBody({ position: [14, 8, 0] });
  p.addBox(bob, 0.4, 0.1, 0.1);
  const rj = p.createRevoluteJoint(pivot, bob, [12, 8, 0], [0, 0, 1]);
  check('3d revolute created', rj >= 0);
  let minY3 = 8;
  for (let i = 0; i < 120; i++) {
    p.step(1 / 60, 4);
    p.readBody(bob, st);
    minY3 = Math.min(minY3, st.y);
  }
  check('3d pendulum swings down', minY3 < 7, `minY=${minY3}`);

  const anchor = p.createBody({ type: S3, position: [18, 10, 0] });
  p.addBox(anchor, 0.1, 0.1, 0.1);
  const weight = p.createBody({ position: [18, 8, 0] });
  p.addSphere(weight, 0.2);
  p.createDistanceJoint(anchor, weight, [18, 10, 0], [18, 8, 0], 2);
  for (let i = 0; i < 120; i++) p.step(1 / 60, 4);
  p.readBody(weight, st);
  const dist = Math.hypot(st.x - 18, st.y - 10, st.z);
  check('3d distance joint holds', Math.abs(dist - 2) < 0.1, `d=${dist}`);

  const rail = p.createBody({ type: S3, position: [24, 5, 0] });
  p.addBox(rail, 0.1, 0.1, 0.1);
  const slider = p.createBody({ position: [24, 5, 0] });
  p.addBox(slider, 0.3, 0.3, 0.3);
  const pj = p.createPrismaticJoint(rail, slider, [24, 5, 0], [1, 0, 0], { enableMotor: true, motorSpeed: 2, maxMotorForce: 500, enableLimit: true, lower: -3, upper: 3 });
  for (let i = 0; i < 90; i++) p.step(1 / 60, 4);
  p.readBody(slider, st);
  check('3d prismatic motor drives +x', st.x > 24.5, `x=${st.x}`);
  p.setMotorSpeed(pj, -2);
  for (let i = 0; i < 30; i++) p.step(1 / 60, 4);
  const xAfter = st.x;
  p.readBody(slider, st);
  check('3d motor speed reversal', st.x < xAfter, `x=${st.x}`);

  // spherical joint holds anchor (pendulum pole)
  const top = p.createBody({ type: S3, position: [30, 12, 0] });
  p.addBox(top, 0.1, 0.1, 0.1);
  const pole = p.createBody({ position: [30, 9, 0] });
  p.addCapsule(pole, [0, -2, 0], [0, 2, 0], 0.2);
  const sj = p.createSphericalJoint(top, pole, [30, 11, 0]);
  check('3d spherical created', sj >= 0);
  p.applyImpulse(pole, 2, 0, 1);
  for (let i = 0; i < 120; i++) p.step(1 / 60, 4);
  check('3d spherical joint finite', assertFinite(p.states(), 'spherical3d'));

  // generation-checked handles
  const tmp = p.createBody({ position: [0, 20, 0] });
  p.addSphere(tmp, 0.1);
  p.destroyBody(tmp);
  const reused = p.createBody({ position: [0, 21, 0] });
  p.addSphere(reused, 0.1);
  check('3d slot reused', (tmp & 0xffff) === (reused & 0xffff));
  check('3d stale handle invalid', !p.isValid(tmp) && p.isValid(reused));
  p.setLinearVelocity(tmp, 99, 99, 99);
  p.step(1 / 60, 4);
  p.readBody(reused, st);
  check('3d stale handle no-op', Math.abs(st.vx) < 1, `vx=${st.vx}`);

  const swap = p.createBody({ type: S3, position: [40, 5, 0] });
  p.addBox(swap, 0.3, 0.3, 0.3);
  for (let i = 0; i < 30; i++) p.step(1 / 60, 4);
  p.readBody(swap, st);
  const yStatic = st.y;
  p.setBodyType(swap, 2);
  for (let i = 0; i < 60; i++) p.step(1 / 60, 4);
  p.readBody(swap, st);
  check('3d body type swap falls', st.y < yStatic - 1, `y=${st.y}`);

  p.applyForce(reused, 50, 0, 0);
  p.applyImpulse(reused, 0, 2, 0);
  p.applyImpulseAt(reused, 0.1, 0, 0, 0, 21, 0);
  p.applyTorque(reused, 1, 0, 0);
  p.setAwake(reused, true);
  p.setGravityScale(reused, 0.5);
  p.step(1 / 60, 4);
  check('3d force/impulse APIs finite', assertFinite(p.states(), 'states3d'));
  check('3d getMass positive', p.getMass(reused) > 0);

  let finite = true;
  for (let i = 0; i < 1000; i++) {
    p.step(1 / 60, 4);
    if (i % 100 === 0 && !assertFinite(p.states(), `soak3d@${i}`)) {
      finite = false;
      break;
    }
  }
  check('3d 1000-step soak', finite);

  // 500-body stress timing
  p.init(0, -10, 0);
  const g3 = p.createBody({ type: S3, position: [0, -1, 0] });
  p.addBox(g3, 60, 1, 60);
  for (let i = 0; i < 500; i++) {
    const b = p.createBody({ position: [(i % 25) * 0.9 - 11, 2 + Math.floor(i / 25) * 0.9, ((i * 7) % 5) * 0.9 - 1.8] });
    p.addBox(b, 0.4, 0.4, 0.4);
  }
  const t0 = performance.now();
  for (let i = 0; i < 120; i++) p.step(1 / 60, 4);
  const ms3 = (performance.now() - t0) / 120;
  check('3d 500-body stress finite', assertFinite(p.states(), 'stress3d'));
  console.log(`  time  3d 500-body avg step: ${ms3.toFixed(2)} ms`);

  // determinism audit
  const run = (): string => {
    p.init(0, -10, 0);
    const g = p.createBody({ type: S3, position: [0, -1, 0] });
    p.addBox(g, 50, 1, 50);
    const bodies: number[] = [];
    for (let i = 0; i < 60; i++) {
      const b = p.createBody({ position: [(i % 10) * 0.8 - 4, 2 + Math.floor(i / 10) * 0.8, ((i * 3) % 4) * 0.8 - 1.2] });
      if (i % 3 === 0) p.addSphere(b, 0.3, { restitution: 0.5 });
      else p.addBox(b, 0.3, 0.3, 0.3);
      bodies.push(b);
    }
    for (let s = 0; s < 300; s++) {
      if (s % 45 === 0) p.applyImpulse(bodies[s % bodies.length]!, 1.5, 3, 0.5);
      p.step(1 / 60, 4);
    }
    return hashStates(p.states());
  };
  const h1 = run();
  const h2 = run();
  check('3d determinism (same-binary replay)', h1 === h2, `${h1} vs ${h2}`);
  console.log(`  info  3d state hash: ${h1}`);
}

await test2d();
await test3d();

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  process.exit(1);
}
