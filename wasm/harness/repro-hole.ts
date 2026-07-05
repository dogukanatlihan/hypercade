// Repro of MAWTOWN's swallow chain: filter-drop through ground + under-plane sensor.
import { Physics3D, BODY_STATIC, BODY_DYNAMIC, BODY_KINEMATIC, SHAPE_SENSOR, SHAPE_HIT_EVENTS } from '../../client/sdk/physics3d.ts';

const CAT_GROUND = 2, CAT_SMALL = 4, CAT_BIG = 8, CAT_RING = 16, CAT_UNDER = 32;
const MASK_ALL = 0xffffffff;
const MASK_SMALL = MASK_ALL & ~CAT_RING;
const MASK_FALLING = MASK_SMALL & ~CAT_GROUND;

const p = await Physics3D.create([0, -20, 0]);
const st = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, awake: false, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 };
const pair = { slotA: 0, userA: 0, slotB: 0, userB: 0 };

const ground = p.createBody({ type: BODY_STATIC, position: [0, -0.15, 0] });
p.addBox(ground, 24, 0.15, 24);
p.setFilter(ground, CAT_GROUND, MASK_ALL);

const sensor = p.createBody({ type: BODY_STATIC, position: [0, -1.6, 0] });
p.addBox(sensor, 24, 0.5, 24, { flags: SHAPE_SENSOR });
p.setFilter(sensor, CAT_UNDER, CAT_SMALL | CAT_BIG);
p.setUserData(sensor, 0);

// crate as the game builds it: static first, filter BIG, user data = index+1
const crate = p.createBody({ type: BODY_STATIC, position: [0.3, 0.35, 0.3] });
p.addBox(crate, 0.35, 0.35, 0.35, { density: 1, friction: 0.45, restitution: 0.05, flags: SHAPE_HIT_EVENTS });
p.setFilter(crate, CAT_BIG, MASK_ALL);
p.setUserData(crate, 7);

// ring kinematic (usually irrelevant, but present)
const ring = p.createBody({ type: BODY_KINEMATIC, position: [0, 0, 0] });
p.addBoxOffset(ring, 0.1, 0.2, 0.1, [0.7, 0, 0]);
p.setFilter(ring, CAT_RING, CAT_BIG);

for (let i = 0; i < 30; i++) p.step(1 / 60, 4);

// reclassify: crate is edible → SMALL
p.setFilter(crate, CAT_SMALL, MASK_SMALL);
// wake to dynamic (hole near)
p.setBodyType(crate, BODY_DYNAMIC);
p.setAwake(crate, true);
for (let i = 0; i < 30; i++) p.step(1 / 60, 4);
p.readBody(crate, st);
console.log('after wake: y=', st.y.toFixed(3));

// THE swallow: clear ground bit
p.setFilter(crate, CAT_SMALL, MASK_FALLING);
let sensorHit = false;
for (let i = 0; i < 240; i++) {
  p.step(1 / 60, 4);
  for (let s = 0; s < p.sensorBeginCount(); s++) {
    p.readSensorBegin(s, pair);
    console.log(`sensor event at step ${i}: userA=${pair.userA} userB=${pair.userB} slotA=${pair.slotA} slotB=${pair.slotB}`);
    sensorHit = true;
  }
  if (sensorHit) break;
}
p.readBody(crate, st);
console.log(`end: crate y=${st.y.toFixed(3)} sensorHit=${sensorHit}`);
