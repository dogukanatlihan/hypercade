// sling — SIEGE SLING · Launch / Destroy (MECHANICS §4). Box2D v3.
// Drag back from the sling, release to hurl a dense ball into procedurally
// built crate-and-plank structures sheltering targets. 3 shots per wave.
// Twist: while aiming the world runs at 0.25× and bodies under load shimmer.
// Score axis (shared/scoring.ts): waves fully cleared (integer). The points
// economy (100/target + 500/unused shot + 10/displaced block) lives in the
// sub line and run stats.

import type { Game, GameContext } from '@sdk/types';
import type { Physics2D, PairEvent, BodyState2D, HitEvent2D } from '@sdk/physics2d';
import { BODY_STATIC, BODY_DYNAMIC, SHAPE_CONTACT_EVENTS, SHAPE_HIT_EVENTS } from '@sdk/physics2d';
import { gameMeta } from '@shared/registry';

// world units are metres; camera anchors the sling at SLING_FRAC of the screen
// width (empty drag room to its left) and keeps the yard visible out to
// VIEW_RIGHT in both orientations (min()-scale: fit height on wide screens)
const VIEW_RIGHT = 17.2; // rightmost world x that must stay on screen
const VIEW_H = 12;
const SLING_FRAC = 0.21; // sling post sits ~21% in from the left edge
const GRAVITY = -10;
const SLING_X = 2.3;
const SLING_Y = 2.5;
const BALL_R = 0.34;
const MAX_PULL = 2.4;
const LAUNCH_K = 8.4; // m/s per metre of pull → ~20 m/s at full draw
const MIN_PULL = 0.3; // shorter drags cancel instead of wasting a shot
const SHOTS_PER_WAVE = 3;
const CRATE = 0.62;
const TARGET_R = 0.27;
const TARGET_KILL_SPEED = 3; // hit-event speed that crushes a target
const DISPLACE_DIST = 0.35;
const AIM_TIMESCALE = 0.25; // the twist: slow-time while aiming
const TRAJ_DOTS = 12;
const TRAJ_DT = 0.09;
const POINTS_TARGET = 100;
const POINTS_UNUSED_SHOT = 500;
const POINTS_DISPLACED = 10;

// user-data ints: tag in the low 4 bits, entity id in the rest
const TAG_BALL = 1;
const TAG_BLOCK = 2;
const TAG_TARGET = 3;
const tagOf = (ud: number): number => ud & 15;
const idOf = (ud: number): number => ud >> 4;

type MaterialId = 'wood' | 'stone' | 'ice';

interface Material {
  density: number;
  friction: number;
  restitution: number;
  breakAt: number; // hit-event speed that shatters this material
  fill: string; // deliberate material colors (allowed outside the palette)
  edge: string;
}

const MATERIALS: Record<MaterialId, Material> = {
  wood: { density: 0.9, friction: 0.55, restitution: 0.05, breakAt: 5, fill: '#b5824c', edge: '#6f4c26' },
  stone: { density: 2.4, friction: 0.7, restitution: 0.02, breakAt: 10.5, fill: '#9aa1ac', edge: '#5c6470' },
  ice: { density: 3.1, friction: 0.06, restitution: 0.05, breakAt: 2.6, fill: 'rgba(168,219,245,0.85)', edge: '#6fb1d4' },
};

const POST_FILL = '#7d6a55';
const POST_EDGE = '#54462f';

interface Block {
  h: number;
  hw: number;
  hh: number;
  mat: MaterialId;
  x0: number;
  y0: number;
  displaced: boolean;
  joint?: number; // revolute pivot (wave 3+ plank)
}

interface TargetBody {
  h: number;
  x0: number;
  y0: number;
}

interface BallBody {
  h: number;
  slow: number;
  age: number;
}

interface Prop {
  h: number;
  x: number;
  y: number;
  hw: number;
  hh: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  grav: number;
  life: number;
  decay: number;
  size: number;
  rot: number;
  spin: number;
  kind: 'debris' | 'dust' | 'spark';
  color: string;
}

type Phase = 'play' | 'cleared' | 'lost' | 'done';

export function createGame(): Game {
  const meta = gameMeta('sling')!;
  let ctx: GameContext;
  let phys: Physics2D;
  let c2d: CanvasRenderingContext2D;

  let phase: Phase = 'play';
  let phaseT = 0;
  let waveIndex = 1;
  let wavesCleared = 0;
  let points = 0;
  let shotsLeft = SHOTS_PER_WAVE;
  let shotsUsed = 0;
  let shotsUsedThisWave = 0;
  let oneShotWaves = 0;
  let targetsDown = 0;
  let blocksBroken = 0;
  let displacedCount = 0;

  let aiming = false;
  let aimSX = 0;
  let aimSY = 0;
  let aimX = 0;
  let aimY = 0;
  let firstShot = false;
  let hintT = 5;
  let calmT = 0;
  let calmTotal = 0;
  let shake = 0;
  let thudCd = 0;
  let tGlobal = 0;
  let lastSub = '';
  let nextId = 1;
  let secondStory = false;

  const blocks = new Map<number, Block>();
  const targets = new Map<number, TargetBody>();
  const balls: BallBody[] = [];
  const props: Prop[] = [];
  const jointHandles: number[] = [];
  const particles: Particle[] = [];

  const st: BodyState2D = { x: 0, y: 0, angle: 0, awake: false, vx: 0, vy: 0, w: 0 };
  const pair: PairEvent = { slotA: 0, userA: 0, slotB: 0, userB: 0 };
  const hit: HitEvent2D = { x: 0, y: 0, nx: 0, ny: 0, speed: 0, slotA: 0, userA: 0, slotB: 0, userB: 0 };
  let detachFns: (() => void)[] = [];

  // ---- camera (sling anchored at SLING_FRAC · yard visible to VIEW_RIGHT) ----

  function cam(): { s: number; ox: number; pad: number } {
    // fit the sling→yard span into the width right of the anchor, but never
    // exceed the height fit — on wide screens the height term wins (zoom cap)
    const s = Math.min((ctx.width * (1 - SLING_FRAC)) / (VIEW_RIGHT - SLING_X), ctx.height / VIEW_H);
    return { s, ox: ctx.width * SLING_FRAC - SLING_X * s, pad: Math.min(ctx.height * 0.05, 34) };
  }

  function toWorld(px: number, py: number): [number, number] {
    const { s, ox, pad } = cam();
    return [(px - ox) / s, (ctx.height - pad - py) / s];
  }

  // ---- world construction ----

  function addBlock(x: number, y: number, hw: number, hh: number, mat: MaterialId): number {
    const m = MATERIALS[mat];
    const h = phys.createBody({ type: BODY_DYNAMIC, position: [x, y] });
    phys.addBox(h, hw, hh, { density: m.density, friction: m.friction, restitution: m.restitution, flags: SHAPE_HIT_EVENTS });
    const id = nextId++;
    phys.setUserData(h, TAG_BLOCK | (id << 4));
    blocks.set(id, { h, hw, hh, mat, x0: x, y0: y, displaced: false });
    return id;
  }

  function addTarget(x: number, y: number): void {
    const h = phys.createBody({ type: BODY_DYNAMIC, position: [x, y] });
    phys.addCircle(h, TARGET_R, { density: 0.6, friction: 0.5, restitution: 0.25, flags: SHAPE_CONTACT_EVENTS | SHAPE_HIT_EVENTS });
    const id = nextId++;
    phys.setUserData(h, TAG_TARGET | (id << 4));
    targets.set(id, { h, x0: x, y0: y });
  }

  function addProp(x: number, y: number, hw: number, hh: number): number {
    const h = phys.createBody({ type: BODY_STATIC, position: [x, y] });
    phys.addBox(h, hw, hh, { friction: 0.7 });
    props.push({ h, x, y, hw, hh });
    return h;
  }

  function pickMat(wave: number): MaterialId {
    if (wave < 3) return 'wood';
    if (wave < 5) return ctx.rng.chance(0.45) ? 'stone' : 'wood';
    const r = ctx.rng.float();
    return r < 0.3 ? 'ice' : r < 0.62 ? 'stone' : 'wood';
  }

  function plankMat(wave: number): MaterialId {
    if (wave >= 5 && ctx.rng.chance(0.35)) return 'ice';
    if (wave >= 4 && ctx.rng.chance(0.3)) return 'stone';
    return 'wood';
  }

  function buildBay(cx: number, wave: number, pivot: boolean): void {
    if (pivot) {
      // revolute plank pivot (from wave 3): counterweighted seesaw sheltering
      // a ground target under its raised end
      const postH = 1.4;
      const post = addProp(cx, postH / 2, 0.13, postH / 2);
      const plankId = addBlock(cx, postH + 0.12, 1.45, 0.12, plankMat(wave));
      const plank = blocks.get(plankId)!;
      const j = phys.createRevoluteJoint(post, plank.h, [cx, postH + 0.12], { lower: -0.55, upper: 0.55, enableLimit: true });
      plank.joint = j;
      jointHandles.push(j);
      addBlock(cx - 1.05, postH + 0.24 + CRATE / 2, CRATE / 2, CRATE / 2, pickMat(wave)); // counterweight
      addTarget(cx + 1.05, TARGET_R + 0.01);
      return;
    }
    const half = CRATE / 2;
    const maxH = Math.min(2 + Math.floor(wave / 2), 5);
    const colH = ctx.rng.int(2, maxH);
    const gap = 1.35;
    const colXs: readonly number[] = [cx - gap / 2 - half, cx + gap / 2 + half];
    for (const colX of colXs) {
      const mat = pickMat(wave);
      for (let j = 0; j < colH; j++) addBlock(colX, half + j * CRATE, half, half, mat);
    }
    const roofHW = gap / 2 + CRATE + 0.18;
    const roofY = colH * CRATE + 0.12;
    addBlock(cx, roofY, roofHW, 0.12, plankMat(wave));
    // sheltered target between the columns, sometimes on a pedestal
    const tx = cx + ctx.rng.range(-0.2, 0.2);
    if (wave >= 2 && ctx.rng.chance(0.5)) {
      addBlock(cx, 0.2, 0.2, 0.2, 'wood');
      addTarget(tx, 0.4 + TARGET_R + 0.02);
    } else {
      addTarget(tx, TARGET_R + 0.01);
    }
    // one second story per wave from wave 4: an exposed rooftop target
    if (wave >= 4 && !secondStory && ctx.rng.chance(0.55)) {
      secondStory = true;
      const y2 = roofY + 0.12 + half;
      addBlock(cx - gap / 2, y2, half, half, pickMat(wave));
      addBlock(cx + gap / 2, y2, half, half, pickMat(wave));
      const roof2Y = y2 + half + 0.1;
      addBlock(cx, roof2Y, roofHW * 0.72, 0.1, plankMat(wave));
      addTarget(cx, roof2Y + 0.1 + TARGET_R + 0.02);
    }
  }

  function buildWave(wave: number): void {
    secondStory = false;
    const bays = wave >= 3 ? 3 : 2;
    const pivotIdx = wave >= 3 ? ctx.rng.int(0, bays - 1) : -1;
    let x = 8.2;
    for (let i = 0; i < bays; i++) {
      buildBay(x, wave, i === pivotIdx);
      x += ctx.rng.range(3.25, 3.6);
    }
  }

  function clearWaveBodies(): void {
    for (const j of jointHandles) phys.destroyJoint(j);
    jointHandles.length = 0;
    for (const b of blocks.values()) phys.destroyBody(b.h);
    blocks.clear();
    for (const t of targets.values()) phys.destroyBody(t.h);
    targets.clear();
    for (const b of balls) phys.destroyBody(b.h);
    balls.length = 0;
    for (const p of props) phys.destroyBody(p.h);
    props.length = 0;
  }

  // ---- particles (render-only, pooled by cap) ----

  function pushParticle(p: Particle): void {
    if (particles.length < 350) particles.push(p);
  }

  function spawnDebris(x: number, y: number, b: Block, vx: number, vy: number): void {
    const m = MATERIALS[b.mat];
    for (let i = 0; i < 8; i++) {
      pushParticle({
        x: x + ctx.rng.range(-b.hw, b.hw) * 0.7,
        y: y + ctx.rng.range(-b.hh, b.hh) * 0.7,
        vx: vx * 0.4 + ctx.rng.range(-3.5, 3.5),
        vy: vy * 0.4 + ctx.rng.range(0.5, 4.5),
        grav: -14,
        life: 1,
        decay: ctx.rng.range(0.9, 1.4),
        size: ctx.rng.range(0.08, 0.2),
        rot: ctx.rng.range(0, 6.3),
        spin: ctx.rng.range(-9, 9),
        kind: 'debris',
        color: m.fill,
      });
    }
    spawnDust(x, y, 0.4);
  }

  function spawnDust(x: number, y: number, strength: number): void {
    const color = ctx.colors().text;
    for (let i = 0; i < 5; i++) {
      pushParticle({
        x: x + ctx.rng.range(-0.2, 0.2),
        y: y + ctx.rng.range(-0.1, 0.15),
        vx: ctx.rng.range(-1, 1),
        vy: ctx.rng.range(0.2, 1),
        grav: 1.2,
        life: 1,
        decay: 1.3,
        size: strength * ctx.rng.range(0.5, 1),
        rot: 0,
        spin: 0,
        kind: 'dust',
        color,
      });
    }
  }

  function spawnRing(x: number, y: number): void {
    const color = ctx.colors().accent;
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      pushParticle({
        x, y,
        vx: Math.cos(a) * 3.5,
        vy: Math.sin(a) * 3.5,
        grav: -3,
        life: 1,
        decay: 1.6,
        size: 0.09,
        rot: 0,
        spin: 0,
        kind: 'spark',
        color,
      });
    }
  }

  function spawnFireworks(count: number): void {
    if (ctx.settings().reducedMotion) return; // no celebratory flash under reduced motion
    const color = ctx.colors().glow;
    for (let k = 0; k < count; k++) {
      const fx = 6 + k * 3;
      const fy = 6.5 + k * 0.6;
      for (let i = 0; i < 18; i++) {
        const a = ctx.rng.range(0, Math.PI * 2);
        const sp = ctx.rng.range(2, 5);
        pushParticle({
          x: fx, y: fy,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          grav: -3.5,
          life: 1,
          decay: 0.9,
          size: 0.08,
          rot: 0,
          spin: 0,
          kind: 'spark',
          color,
        });
      }
    }
  }

  function stepParticles(dt: number): void {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i]!;
      p.life -= p.decay * dt;
      if (p.life <= 0) {
        particles[i] = particles[particles.length - 1]!;
        particles.pop();
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += p.grav * dt;
      p.rot += p.spin * dt;
    }
  }

  // ---- gameplay ----

  function bumpShake(v: number): void {
    if (ctx.settings().reducedMotion) return;
    shake = Math.max(shake, Math.min(v, 0.7));
  }

  interface Pull {
    ok: boolean;
    bx: number;
    by: number;
    vx: number;
    vy: number;
    len: number;
  }

  function computePull(): Pull {
    const dx = aimX - aimSX;
    const dy = aimY - aimSY;
    const len = Math.hypot(dx, dy);
    if (len < 1e-4) return { ok: false, bx: SLING_X, by: SLING_Y, vx: 0, vy: 0, len: 0 };
    const cl = Math.min(len, MAX_PULL);
    const ux = dx / len;
    const uy = dy / len;
    const bx = SLING_X + ux * cl;
    const by = Math.max(SLING_Y + uy * cl, BALL_R + 0.02);
    return { ok: len >= MIN_PULL, bx, by, vx: -ux * cl * LAUNCH_K, vy: -uy * cl * LAUNCH_K, len: cl };
  }

  function launch(p: Pull): void {
    const h = phys.createBody({ type: BODY_DYNAMIC, position: [p.bx, p.by], bullet: true, angularDamping: 0.4 });
    phys.addCircle(h, BALL_R, { density: 5, friction: 0.5, restitution: 0.18, flags: SHAPE_CONTACT_EVENTS | SHAPE_HIT_EVENTS });
    phys.setUserData(h, TAG_BALL);
    phys.setLinearVelocity(h, p.vx, p.vy);
    balls.push({ h, slow: 0, age: 0 });
    shotsLeft -= 1;
    shotsUsed += 1;
    shotsUsedThisWave += 1;
    firstShot = true;
    ctx.audio.whoosh();
    ctx.audio.buzz(10);
  }

  function breakBlock(id: number, b: Block): void {
    blocks.delete(id);
    if (b.joint !== undefined) {
      const ji = jointHandles.indexOf(b.joint);
      if (ji >= 0) jointHandles.splice(ji, 1);
      phys.destroyJoint(b.joint);
    }
    let bx = b.x0;
    let by = b.y0;
    let bvx = 0;
    let bvy = 0;
    if (phys.readBody(b.h, st)) {
      bx = st.x; by = st.y; bvx = st.vx; bvy = st.vy;
    }
    phys.destroyBody(b.h);
    blocksBroken += 1;
    if (!b.displaced) {
      points += POINTS_DISPLACED;
      displacedCount += 1;
    }
    spawnDebris(bx, by, b, bvx, bvy);
    const f = b.mat === 'ice' ? 1900 : b.mat === 'stone' ? 260 : 640;
    ctx.audio.noise({ dur: 0.16, vol: 0.16, freq: f, q: 1.2 });
    bumpShake(0.2);
  }

  function killTarget(id: number): void {
    const t = targets.get(id);
    if (!t) return;
    targets.delete(id);
    let tx = t.x0;
    let ty = t.y0;
    if (phys.readBody(t.h, st)) {
      tx = st.x; ty = st.y;
    }
    phys.destroyBody(t.h);
    targetsDown += 1;
    points += POINTS_TARGET;
    spawnRing(tx, ty);
    ctx.audio.pop(Math.min(targetsDown, 10));
    ctx.audio.chime(Math.min(targetsDown, 6));
    ctx.audio.buzz(15);
    bumpShake(0.18);
  }

  function hitSide(ud: number, otherUd: number): void {
    const tag = tagOf(ud);
    if (tag === TAG_BLOCK) {
      const b = blocks.get(idOf(ud));
      if (b && hit.speed >= MATERIALS[b.mat].breakAt) breakBlock(idOf(ud), b);
    } else if (tag === TAG_TARGET) {
      if (hit.speed >= TARGET_KILL_SPEED || tagOf(otherUd) === TAG_BALL) killTarget(idOf(ud));
    }
  }

  function processEvents(): void {
    const hc = phys.hitCount();
    for (let i = 0; i < hc; i++) {
      phys.readHit(i, hit);
      if (hit.speed > 2) calmT = 0; // something is still happening — hold the end check
      hitSide(hit.userA, hit.userB);
      hitSide(hit.userB, hit.userA);
      if (hit.speed > 1.8 && thudCd <= 0) {
        thudCd = 0.055;
        ctx.audio.thud(hit.speed);
        if (hit.speed > 4) spawnDust(hit.x, hit.y, Math.min(hit.speed * 0.06, 0.5));
        if (hit.speed > 6) bumpShake(0.12 + hit.speed * 0.015);
      }
    }
    const cbc = phys.contactBeginCount();
    for (let i = 0; i < cbc; i++) {
      phys.readContactBegin(i, pair);
      const ta = tagOf(pair.userA);
      const tb = tagOf(pair.userB);
      if (ta === TAG_BALL && tb === TAG_TARGET) killTarget(idOf(pair.userB));
      else if (tb === TAG_BALL && ta === TAG_TARGET) killTarget(idOf(pair.userA));
    }
  }

  /** Demolition bonus: +10 the first time a block strays from its build spot. */
  function scanDisplacement(): void {
    for (const b of blocks.values()) {
      if (b.displaced) continue;
      if (!phys.readBody(b.h, st)) continue;
      const dx = st.x - b.x0;
      const dy = st.y - b.y0;
      if (dx * dx + dy * dy > DISPLACE_DIST * DISPLACE_DIST) {
        b.displaced = true;
        points += POINTS_DISPLACED;
        displacedCount += 1;
      }
    }
  }

  function updateBalls(dt: number): void {
    for (let i = balls.length - 1; i >= 0; i--) {
      const b = balls[i]!;
      b.age += dt;
      if (!phys.readBody(b.h, st)) {
        balls.splice(i, 1);
        continue;
      }
      const speed = Math.hypot(st.vx, st.vy);
      b.slow = speed < 0.1 && Math.abs(st.w) < 0.25 ? b.slow + dt : 0;
      if (b.slow > 1.15 || b.age > 14 || st.x < -4 || st.x > 34) {
        if (b.slow > 1.15) spawnDust(st.x, st.y, 0.25);
        phys.destroyBody(b.h);
        balls.splice(i, 1);
      }
    }
  }

  function waveClear(): void {
    aiming = false;
    points += shotsLeft * POINTS_UNUSED_SHOT;
    wavesCleared += 1;
    if (shotsUsedThisWave <= 1) {
      oneShotWaves += 1;
      ctx.hud.showCombo('ONE SHOT!', true);
    }
    ctx.hud.flash(`WAVE ${waveIndex} CLEAR`);
    ctx.hud.setScore(wavesCleared);
    ctx.audio.fanfare();
    ctx.audio.buzz(25);
    spawnFireworks(shotsLeft); // firework of remaining shots (MECHANICS juice)
    phase = 'cleared';
    phaseT = 1.5;
  }

  function nextWave(): void {
    clearWaveBodies();
    waveIndex += 1;
    shotsLeft = SHOTS_PER_WAVE;
    shotsUsedThisWave = 0;
    calmT = 0;
    calmTotal = 0;
    buildWave(waveIndex);
  }

  function maybeLose(dt: number): void {
    if (shotsLeft === 0 && balls.length === 0 && !aiming) {
      calmT += dt;
      calmTotal += dt;
      if (calmT > 1.4 || calmTotal > 6) {
        phase = 'lost';
        phaseT = 1.1;
        ctx.hud.flash('WAVE FAILED');
        ctx.audio.womp();
        ctx.audio.buzz(60);
      }
    } else {
      calmT = 0;
      calmTotal = 0;
    }
  }

  function refreshSub(): void {
    let sub: string;
    if (!firstShot && hintT > 0) sub = 'pull back from the sling · release to launch';
    else if (phase === 'cleared') sub = `wave ${waveIndex} clear · +${shotsLeft * POINTS_UNUSED_SHOT} shot bonus`;
    else sub = `wave ${waveIndex} · shots ${'●'.repeat(shotsLeft)}${'○'.repeat(SHOTS_PER_WAVE - shotsLeft)} · ${points} pts`;
    if (sub !== lastSub) {
      lastSub = sub;
      ctx.hud.setSub(sub);
    }
  }

  return {
    meta,

    async init(context: GameContext): Promise<void> {
      ctx = context;
      phys = await ctx.physics2d();
      const c = ctx.canvas.getContext('2d');
      if (!c) throw new Error('no 2d context');
      c2d = c;
      detachFns.push(
        ctx.input.onDown((x, y) => {
          if (phase !== 'play' || shotsLeft <= 0) return;
          aiming = true;
          const [wx, wy] = toWorld(x, y);
          aimSX = aimX = wx;
          aimSY = aimY = wy;
          ctx.audio.tick();
        }),
        ctx.input.onDrag((e) => {
          if (!aiming) return;
          const [wx, wy] = toWorld(e.x, e.y);
          aimX = wx;
          aimY = wy;
        }),
        ctx.input.onRelease(() => {
          if (!aiming) return;
          aiming = false;
          const p = computePull();
          if (p.ok) launch(p);
        }),
      );
    },

    start(): void {
      phys.init(0, GRAVITY);
      phys.setHitEventThreshold(1);
      blocks.clear();
      targets.clear();
      balls.length = 0;
      props.length = 0;
      jointHandles.length = 0;
      particles.length = 0;
      phase = 'play';
      phaseT = 0;
      waveIndex = 1;
      wavesCleared = 0;
      points = 0;
      shotsLeft = SHOTS_PER_WAVE;
      shotsUsed = 0;
      shotsUsedThisWave = 0;
      oneShotWaves = 0;
      targetsDown = 0;
      blocksBroken = 0;
      displacedCount = 0;
      aiming = false;
      firstShot = false;
      hintT = 5;
      calmT = 0;
      calmTotal = 0;
      shake = 0;
      thudCd = 0;
      tGlobal = 0;
      lastSub = '';
      nextId = 1;

      const ground = phys.createBody({ type: BODY_STATIC, position: [15, -0.6] });
      phys.addBox(ground, 19, 0.6, { friction: 0.9 });

      buildWave(1);
      ctx.hud.setScore(0);
      refreshSub();
    },

    step(dt: number): void {
      if (phase === 'done') return;
      tGlobal += dt;
      thudCd = Math.max(0, thudCd - dt);
      const ts = aiming && phase === 'play' ? AIM_TIMESCALE : 1; // slow-time twist
      phys.step(dt * ts, 4);
      processEvents();
      scanDisplacement();
      updateBalls(dt * ts);

      if (phase === 'play' && targets.size === 0) waveClear();
      if (phase === 'play') maybeLose(dt);
      if (phase === 'cleared') {
        phaseT -= dt;
        if (phaseT <= 0) {
          phase = 'play';
          nextWave();
        }
      }
      if (phase === 'lost') {
        phaseT -= dt;
        if (phaseT <= 0) {
          phase = 'done';
          ctx.endRun({
            score: wavesCleared,
            durationMs: 0,
            seed: 0,
            stats: {
              oneShotWaves,
              shotsUsed,
              points,
              targetsDestroyed: targetsDown,
              blocksBroken,
              blocksDisplaced: displacedCount,
            },
          });
          return;
        }
      }

      stepParticles(dt * ts);
      shake = Math.max(0, shake - dt * 2);
      if (hintT > 0) hintT -= dt;
      refreshSub();
    },

    render(): void {
      const w = ctx.width;
      const h = ctx.height;
      const dpr = ctx.dpr;
      const colors = ctx.colors();
      const { s, ox, pad } = cam();
      const sx = (x: number): number => ox + x * s;
      const sy = (y: number): number => h - pad - y * s;
      const reduced = ctx.settings().reducedMotion;

      c2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      c2d.clearRect(0, 0, w, h);
      if (shake > 0 && !reduced) c2d.translate(Math.sin(tGlobal * 91) * shake * 12, Math.cos(tGlobal * 83) * shake * 12);

      // distant hills
      c2d.fillStyle = colors.surface;
      c2d.globalAlpha = 0.4;
      c2d.beginPath();
      c2d.ellipse(sx(13), sy(0), 6.5 * s, 1.4 * s, 0, Math.PI, Math.PI * 2);
      c2d.fill();
      c2d.globalAlpha = 0.28;
      c2d.beginPath();
      c2d.ellipse(sx(5), sy(0), 4.5 * s, 0.9 * s, 0, Math.PI, Math.PI * 2);
      c2d.fill();
      c2d.globalAlpha = 1;

      // ground
      c2d.fillStyle = colors.surface;
      c2d.fillRect(0, sy(0), w, h - sy(0));
      c2d.strokeStyle = colors.primary;
      c2d.globalAlpha = 0.5;
      c2d.beginPath();
      c2d.moveTo(0, sy(0));
      c2d.lineTo(w, sy(0));
      c2d.stroke();
      c2d.globalAlpha = 1;

      const pull = aiming ? computePull() : null;
      const prongL: readonly [number, number] = [SLING_X - 0.17, SLING_Y + 0.1];
      const prongR: readonly [number, number] = [SLING_X + 0.17, SLING_Y + 0.02];
      const bandTo: readonly [number, number] = pull ? [pull.bx, pull.by] : [SLING_X, SLING_Y];
      const showPouchBall = !aiming && shotsLeft > 0 && phase === 'play';

      // back band (behind the ball)
      c2d.strokeStyle = pull && pull.len >= MAX_PULL * 0.98 ? colors.danger : colors.accent;
      c2d.lineWidth = Math.max(2, s * 0.055);
      c2d.lineCap = 'round';
      if (pull || showPouchBall) {
        c2d.beginPath();
        c2d.moveTo(sx(prongR[0]), sy(prongR[1]));
        c2d.lineTo(sx(bandTo[0]), sy(bandTo[1]));
        c2d.stroke();
      }

      // sling post
      c2d.strokeStyle = POST_FILL;
      c2d.lineWidth = Math.max(3, s * 0.11);
      c2d.beginPath();
      c2d.moveTo(sx(SLING_X), sy(0));
      c2d.lineTo(sx(SLING_X), sy(SLING_Y - 0.35));
      c2d.moveTo(sx(SLING_X), sy(SLING_Y - 0.35));
      c2d.lineTo(sx(prongL[0]), sy(prongL[1]));
      c2d.moveTo(sx(SLING_X), sy(SLING_Y - 0.35));
      c2d.lineTo(sx(prongR[0]), sy(prongR[1]));
      c2d.stroke();

      // pivot posts (static props)
      for (const p of props) {
        c2d.fillStyle = POST_FILL;
        c2d.strokeStyle = POST_EDGE;
        c2d.lineWidth = Math.max(1.5, s * 0.03);
        const pw = p.hw * 2 * s;
        const ph = p.hh * 2 * s;
        c2d.beginPath();
        c2d.roundRect(sx(p.x) - pw / 2, sy(p.y) - ph / 2, pw, ph, 3);
        c2d.fill();
        c2d.stroke();
      }

      // blocks (+ stress shimmer while aiming: awake but nearly static = under load)
      for (const b of blocks.values()) {
        if (!phys.readBody(b.h, st)) continue;
        const m = MATERIALS[b.mat];
        c2d.save();
        c2d.translate(sx(st.x), sy(st.y));
        c2d.rotate(-st.angle);
        const pw = b.hw * 2 * s;
        const ph = b.hh * 2 * s;
        c2d.fillStyle = m.fill;
        c2d.strokeStyle = m.edge;
        c2d.lineWidth = Math.max(1.5, s * 0.035);
        c2d.beginPath();
        c2d.roundRect(-pw / 2, -ph / 2, pw, ph, Math.min(4, pw * 0.12));
        c2d.fill();
        c2d.stroke();
        if (Math.abs(b.hw - b.hh) < 0.01) {
          // crate cross-brace detail
          c2d.globalAlpha = 0.35;
          c2d.beginPath();
          c2d.moveTo(-pw / 2 + 3, -ph / 2 + 3);
          c2d.lineTo(pw / 2 - 3, ph / 2 - 3);
          c2d.moveTo(pw / 2 - 3, -ph / 2 + 3);
          c2d.lineTo(-pw / 2 + 3, ph / 2 - 3);
          c2d.stroke();
          c2d.globalAlpha = 1;
        }
        if (aiming && st.awake && Math.hypot(st.vx, st.vy) < 0.1) {
          c2d.globalAlpha = 0.3 + 0.25 * Math.sin(tGlobal * 12);
          c2d.strokeStyle = colors.glow;
          c2d.lineWidth = Math.max(2.5, s * 0.06);
          c2d.beginPath();
          c2d.roundRect(-pw / 2 - 2, -ph / 2 - 2, pw + 4, ph + 4, Math.min(5, pw * 0.14));
          c2d.stroke();
          c2d.globalAlpha = 1;
        }
        c2d.restore();
      }

      // targets
      for (const t of targets.values()) {
        if (!phys.readBody(t.h, st)) continue;
        c2d.save();
        c2d.translate(sx(st.x), sy(st.y));
        c2d.rotate(-st.angle);
        const r = TARGET_R * s;
        c2d.fillStyle = colors.danger;
        c2d.beginPath();
        c2d.arc(0, 0, r, 0, Math.PI * 2);
        c2d.fill();
        c2d.strokeStyle = colors.bg;
        c2d.globalAlpha = 0.5;
        c2d.lineWidth = Math.max(1.5, s * 0.03);
        c2d.beginPath();
        c2d.arc(0, 0, r * 0.62, 0, Math.PI * 2);
        c2d.stroke();
        c2d.globalAlpha = 1;
        c2d.fillStyle = colors.bg;
        c2d.beginPath();
        c2d.arc(-r * 0.3, -r * 0.15, r * 0.14, 0, Math.PI * 2);
        c2d.arc(r * 0.3, -r * 0.15, r * 0.14, 0, Math.PI * 2);
        c2d.fill();
        c2d.restore();
      }

      // balls in flight
      for (const b of balls) {
        if (!phys.readBody(b.h, st)) continue;
        c2d.save();
        c2d.translate(sx(st.x), sy(st.y));
        c2d.rotate(-st.angle);
        const r = BALL_R * s;
        c2d.fillStyle = colors.primary;
        c2d.beginPath();
        c2d.arc(0, 0, r, 0, Math.PI * 2);
        c2d.fill();
        c2d.strokeStyle = colors.bg;
        c2d.globalAlpha = 0.4;
        c2d.lineWidth = Math.max(1.5, s * 0.03);
        c2d.beginPath();
        c2d.moveTo(-r * 0.7, 0);
        c2d.lineTo(r * 0.7, 0);
        c2d.stroke();
        c2d.globalAlpha = 1;
        c2d.restore();
      }

      // particles
      for (const p of particles) {
        const px = sx(p.x);
        const py = sy(p.y);
        if (p.kind === 'debris') {
          c2d.save();
          c2d.translate(px, py);
          c2d.rotate(-p.rot);
          c2d.globalAlpha = Math.min(p.life, 1) * 0.95;
          c2d.fillStyle = p.color;
          const d = p.size * s;
          c2d.fillRect(-d / 2, -d / 2, d, d);
          c2d.restore();
        } else if (p.kind === 'dust') {
          c2d.globalAlpha = p.life * 0.3;
          c2d.fillStyle = p.color;
          c2d.beginPath();
          c2d.arc(px, py, p.size * (1.8 - p.life) * s, 0, Math.PI * 2);
          c2d.fill();
        } else {
          c2d.globalAlpha = p.life;
          c2d.fillStyle = p.color;
          c2d.beginPath();
          c2d.arc(px, py, p.size * s * 0.6, 0, Math.PI * 2);
          c2d.fill();
        }
      }
      c2d.globalAlpha = 1;

      // pulled ball + front band + trajectory preview
      if (pull) {
        const r = BALL_R * s;
        c2d.fillStyle = colors.primary;
        c2d.beginPath();
        c2d.arc(sx(pull.bx), sy(pull.by), r, 0, Math.PI * 2);
        c2d.fill();
        c2d.strokeStyle = pull.len >= MAX_PULL * 0.98 ? colors.danger : colors.accent;
        c2d.lineWidth = Math.max(2, s * 0.055);
        c2d.beginPath();
        c2d.moveTo(sx(prongL[0]), sy(prongL[1]));
        c2d.lineTo(sx(pull.bx), sy(pull.by));
        c2d.stroke();
        if (pull.ok) {
          c2d.fillStyle = colors.glow;
          for (let i = 0; i < TRAJ_DOTS; i++) {
            const t = (i + 1) * TRAJ_DT;
            const dx = pull.bx + pull.vx * t;
            const dy = pull.by + pull.vy * t + 0.5 * GRAVITY * t * t;
            if (dy < 0.1) break;
            c2d.globalAlpha = 0.75 * (1 - i / TRAJ_DOTS);
            c2d.beginPath();
            c2d.arc(sx(dx), sy(dy), Math.max(2, s * 0.05), 0, Math.PI * 2);
            c2d.fill();
          }
          c2d.globalAlpha = 1;
        }
      } else if (showPouchBall) {
        c2d.fillStyle = colors.primary;
        c2d.beginPath();
        c2d.arc(sx(SLING_X), sy(SLING_Y), BALL_R * s, 0, Math.PI * 2);
        c2d.fill();
        c2d.strokeStyle = colors.accent;
        c2d.lineWidth = Math.max(2, s * 0.055);
        c2d.beginPath();
        c2d.moveTo(sx(prongL[0]), sy(prongL[1]));
        c2d.lineTo(sx(SLING_X), sy(SLING_Y));
        c2d.stroke();
      }

      // ghosted hint gesture until the first shot (teach by doing)
      if (!firstShot && !aiming && phase === 'play') {
        const osc = (Math.sin(tGlobal * 2.2) + 1) / 2;
        const gx = SLING_X - osc * 1.1;
        const gy = SLING_Y - osc * 0.75;
        c2d.globalAlpha = 0.35;
        c2d.strokeStyle = colors.text;
        c2d.lineWidth = Math.max(1.5, s * 0.03);
        c2d.setLineDash([5, 6]);
        c2d.beginPath();
        c2d.moveTo(sx(SLING_X), sy(SLING_Y));
        c2d.lineTo(sx(gx), sy(gy));
        c2d.stroke();
        c2d.setLineDash([]);
        c2d.fillStyle = colors.text;
        c2d.beginPath();
        c2d.arc(sx(gx), sy(gy), BALL_R * s * 0.8, 0, Math.PI * 2);
        c2d.fill();
        c2d.globalAlpha = 1;
      }
    },

    dispose(): void {
      for (const d of detachFns) d();
      detachFns = [];
      phys.init(0, GRAVITY); // free the world's bodies
    },
  };
}
