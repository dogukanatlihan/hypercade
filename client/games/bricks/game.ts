// VOLLEY — aim/bounce (MECHANICS §6). Box2D v3. BBTAN-style volley breaker:
// drag to aim a swarm of perfect-restitution balls, chip numbered bricks that
// descend one row per turn, shield bricks armor everything but their top face,
// and the rare prism brick splits any ball that hits it (physics-true chaos).

import type { Game, GameContext } from '@sdk/types';
import type { Physics2D, PairEvent, BodyState2D, HitEvent2D, RayHit2D } from '@sdk/physics2d';
import { BODY_STATIC, BODY_DYNAMIC, SHAPE_SENSOR, SHAPE_CONTACT_EVENTS, SHAPE_HIT_EVENTS, slotOf } from '@sdk/physics2d';
import { gameMeta } from '@shared/registry';

// world units are meters; playfield x ∈ [0, 5.6], launch line at y ≈ 0.3
const COLS = 7;
const CELL = 0.8; // grid pitch; bricks descend one CELL per turn
const FIELD_W = COLS * CELL; // 5.6
const BRICK_H = 0.37; // brick half-extent (leaves a small visual gutter)
const BALL_R = 0.22;
const BALL_SPEED = 14;
const LAUNCH_Y = 0.3;
const FAIL_Y = 1.15; // a brick bottom crossing this ends the run
const ROW_Y = 8.55; // new rows spawn here
const CEIL_Y = ROW_Y + BRICK_H + 0.02; // ceiling underside, flush over the top row
const VIEW_W = 6.6; // camera fits this in portrait AND landscape (min-based)
const VIEW_H = 10.2;
const MID_Y = 4.55;
const FIRE_TICKS = 4; // one ball per 4 ticks
const SHIFT_TICKS = 18; // 0.3s descend animation
const MIN_AIM = (8 * Math.PI) / 180; // aim clamped ≥ 8° above horizontal
const MAX_POOL = 200;
const WATCHDOG_TICKS = 45 * 60; // after 45s, stragglers get biased home

// explicit collision categories on BOTH sides (ENGINE-NOTES rule)
const CAT_WALL = 1;
const CAT_BRICK = 2;
const CAT_BALL = 4;
const CAT_PICKUP = 8;

// user-data: plain tags; bricks encode (type+1)·1000 + hitsLeft so the shim
// mirrors the JS hit counter (events carry it, harness can audit it)
const TAG_WALL = 1;
const TAG_BALL = 2;
const TAG_PICKUP = 3;
const BRICK_BASE = 1000;

const T_NORMAL = 0;
const T_SHIELD = 1;
const T_PRISM = 2;

type Phase = 'aim' | 'volley' | 'shift' | 'dead';

interface Brick {
  handle: number;
  slot: number;
  x: number;
  y: number;
  hits: number;
  maxHits: number;
  type: number;
  flash: number; // number-pop / chip highlight timer
  dead: boolean;
  cracks: readonly [number, number, number, number];
}

interface Pickup {
  handle: number;
  slot: number;
  x: number;
  y: number;
  dead: boolean;
}

interface Ball {
  handle: number;
  slot: number;
  active: boolean;
}

interface Particle {
  kind: number; // 0 shard, 1 ring, 2 spark
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  decay: number;
  size: number;
  rot: number;
  spin: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
const colX = (c: number): number => (c + 0.5) * CELL;
const ease = (t: number): number => t * t * (3 - 2 * t);
const brickCode = (type: number, hits: number): number => (type + 1) * BRICK_BASE + Math.max(Math.min(hits, 999), 0);

export function createGame(): Game {
  const meta = gameMeta('bricks')!;
  let ctx: GameContext;
  let phys: Physics2D;
  let c2d: CanvasRenderingContext2D;

  // run state
  let phase: Phase = 'aim';
  let turn = 1;
  let score = 0;
  let ended = false;
  let deathTimer = 0;
  let tGlobal = 0;

  // aiming
  let aimAngle = Math.PI / 2;
  let aiming = false; // pointer currently dragging an aim
  let pointerAiming = false; // any pointer down (suppresses tap-fired action)
  let kbAim = false; // arrows used this turn → show preview for keyboard players

  // launcher
  let launchX = FIELD_W / 2;
  let launcherDrawX = FIELD_W / 2;
  let nextLaunchX: number | null = null;
  let firstReturn = false;

  // volley
  let ballCount = 1;
  let toFire = 0;
  let fireTimer = 0;
  let firedThisVolley = 0;
  let volleyTicks = 0;
  let combo = 0; // chips this volley → pop pitch ladder
  let breaksThisVolley = 0;
  let splitShown = false;

  // stats
  let ballsFired = 0;
  let maxVolleyBreaks = 0;
  let bricksBroken = 0;
  let pickupsCollected = 0;

  // entities
  let bricks: Brick[] = [];
  let pickups: Pickup[] = [];
  let balls: Ball[] = [];
  let activeCount = 0;
  let brickDirty = false;
  let pickupDirty = false;
  const brickBySlot = new Map<number, Brick>();
  const pickupBySlot = new Map<number, Pickup>();
  const ballBySlot = new Map<number, Ball>();

  // shift animation
  let shiftTick = 0;
  let shiftOff = 0;

  // fx + per-step audio budgets
  let shake = 0;
  let particles: Particle[] = [];
  let stepBreaks = 0;
  let popsThisStep = 0;
  let clinksThisStep = 0;
  let landsThisStep = 0;
  let wallClick = 0;
  const topHitSlots = new Set<number>();

  // scratch (no per-tick allocation)
  const st: BodyState2D = { x: 0, y: 0, angle: 0, awake: false, vx: 0, vy: 0, w: 0 };
  const pair: PairEvent = { slotA: 0, userA: 0, slotB: 0, userB: 0 };
  const hit: HitEvent2D = { x: 0, y: 0, nx: 0, ny: 0, speed: 0, slotA: 0, userA: 0, slotB: 0, userB: 0 };
  const ray: RayHit2D = { hit: false, x: 0, y: 0, nx: 0, ny: 0, fraction: 0, slot: -1 };
  let detachFns: (() => void)[] = [];

  // ---- camera (min-based scale fits portrait and landscape) ----

  const viewScale = (): number => Math.min(ctx.width / VIEW_W, ctx.height / VIEW_H);
  const sx = (x: number, s: number): number => ctx.width / 2 + (x - FIELD_W / 2) * s;
  const sy = (y: number, s: number): number => ctx.height / 2 - (y - MID_Y) * s;

  function clampAim(a: number): number {
    if (a < -Math.PI / 2) return Math.PI - MIN_AIM; // pointer below-left wraps to the far clamp
    return clamp(a, MIN_AIM, Math.PI - MIN_AIM);
  }

  function aimFromPointer(px: number, py: number): void {
    const s = viewScale();
    const wx = (px - ctx.width / 2) / s + FIELD_W / 2;
    const wy = (ctx.height / 2 - py) / s + MID_Y;
    const dx = wx - launchX;
    const dy = wy - LAUNCH_Y;
    if (dx === 0 && dy === 0) return;
    aimAngle = clampAim(Math.atan2(dy, dx));
  }

  // ---- world construction ----

  function buildWalls(): void {
    const h = phys.createBody({ type: BODY_STATIC, position: [0, 0] });
    // left / right / ceiling as offset boxes on one body; bottom stays open
    phys.addBoxOffset(h, 0.3, 5.4, -0.3, 4.6, 0, { friction: 0, restitution: 1, flags: SHAPE_CONTACT_EVENTS });
    phys.addBoxOffset(h, 0.3, 5.4, FIELD_W + 0.3, 4.6, 0, { friction: 0, restitution: 1, flags: SHAPE_CONTACT_EVENTS });
    phys.addBoxOffset(h, FIELD_W / 2 + 0.6, 0.3, FIELD_W / 2, CEIL_Y + 0.3, 0, { friction: 0, restitution: 1, flags: SHAPE_CONTACT_EVENTS });
    phys.setUserData(h, TAG_WALL);
    phys.setFilter(h, CAT_WALL, CAT_BALL);
  }

  function buildBallPool(): void {
    const poolSize = Math.min(MAX_POOL, phys.maxBodies - 96); // leave room for bricks/pickups/walls
    for (let i = 0; i < poolSize; i++) {
      const h = phys.createBody({
        type: BODY_DYNAMIC,
        position: [-3, -3 - i * 0.06],
        gravityScale: 0, // pure reflections — the BBTAN feel
        bullet: true,
        fixedRotation: true,
        enableSleep: false,
      });
      phys.addCircle(h, BALL_R, { density: 1, friction: 0, restitution: 1, flags: SHAPE_CONTACT_EVENTS | SHAPE_HIT_EVENTS });
      phys.setUserData(h, TAG_BALL);
      phys.setFilter(h, CAT_BALL, CAT_WALL | CAT_BRICK | CAT_PICKUP); // no ball-ball collisions
      phys.setEnabled(h, false);
      const b: Ball = { handle: h, slot: slotOf(h), active: false };
      balls.push(b);
      ballBySlot.set(b.slot, b);
    }
  }

  function createBrick(col: number, type: number, hits: number): void {
    const x = colX(col);
    const h = phys.createBody({ type: BODY_STATIC, position: [x, ROW_Y] });
    phys.addBox(h, BRICK_H, BRICK_H, { friction: 0, restitution: 1, flags: SHAPE_CONTACT_EVENTS | SHAPE_HIT_EVENTS });
    phys.setUserData(h, brickCode(type, hits));
    phys.setFilter(h, CAT_BRICK, CAT_BALL);
    const br: Brick = {
      handle: h,
      slot: slotOf(h),
      x,
      y: ROW_Y,
      hits,
      maxHits: hits,
      type,
      flash: 0,
      dead: false,
      cracks: [ctx.rng.float(), ctx.rng.float(), ctx.rng.float(), ctx.rng.float()],
    };
    bricks.push(br);
    brickBySlot.set(br.slot, br);
  }

  function createPickup(col: number): void {
    const x = colX(col);
    const h = phys.createBody({ type: BODY_STATIC, position: [x, ROW_Y] });
    phys.addCircle(h, 0.3, { flags: SHAPE_SENSOR });
    phys.setUserData(h, TAG_PICKUP);
    phys.setFilter(h, CAT_PICKUP, CAT_BALL);
    const p: Pickup = { handle: h, slot: slotOf(h), x, y: ROW_Y, dead: false };
    pickups.push(p);
    pickupBySlot.set(p.slot, p);
  }

  function spawnRow(): void {
    const cols = [0, 1, 2, 3, 4, 5, 6];
    for (let i = cols.length - 1; i > 0; i--) {
      const j = ctx.rng.int(0, i);
      const t = cols[i]!;
      cols[i] = cols[j]!;
      cols[j] = t;
    }
    let count = turn >= 15 ? ctx.rng.int(4, 6) : ctx.rng.int(3, 5);
    count = Math.min(count, COLS - 1); // always leave a slot for the pickup
    let prismPlaced = false;
    for (let k = 0; k < count; k++) {
      let type = T_NORMAL;
      if (!prismPlaced && turn >= 3 && ctx.rng.chance(0.07)) {
        type = T_PRISM;
        prismPlaced = true;
      } else if (turn >= 5 && ctx.rng.chance(0.12)) {
        type = T_SHIELD;
      }
      // ramp: values scale with turn, occasional double-value brick
      const hits = type === T_PRISM ? Math.min(3, turn) : Math.min(ctx.rng.chance(0.22) ? turn * 2 : turn, 999);
      createBrick(cols[k]!, type, hits);
    }
    createPickup(cols[count]!); // +1 ball pickup every turn
  }

  // ---- balls ----

  function takePooled(): Ball | null {
    for (const b of balls) if (!b.active) return b;
    return null;
  }

  function launchBall(b: Ball, x: number, y: number, vx: number, vy: number): void {
    b.active = true;
    activeCount += 1;
    phys.setEnabled(b.handle, true);
    phys.setTransform(b.handle, clamp(x, BALL_R + 0.02, FIELD_W - BALL_R - 0.02), Math.max(y, LAUNCH_Y), 0);
    phys.setLinearVelocity(b.handle, vx, vy);
  }

  function collectBall(b: Ball, x: number): void {
    b.active = false;
    activeCount -= 1;
    phys.setEnabled(b.handle, false);
    if (!firstReturn) {
      firstReturn = true;
      nextLaunchX = clamp(x, BALL_R + 0.15, FIELD_W - BALL_R - 0.15); // first return point = next launch x
      ctx.audio.tick();
    } else if (landsThisStep < 3) {
      landsThisStep += 1;
      ctx.audio.note(860, { dur: 0.03, type: 'sine', vol: 0.03 });
    }
    pushParticle({ kind: 2, x, y: LAUNCH_Y, vx: ctx.rng.range(-0.6, 0.6), vy: ctx.rng.range(0.5, 1.4), life: 1, decay: 4, size: 2.4, rot: 0, spin: 0 });
  }

  function splitFrom(ballSlot: number): void {
    const src = ballBySlot.get(ballSlot);
    if (!src || !src.active) return;
    if (!phys.readBody(src.handle, st)) return;
    const spare = takePooled();
    if (!spare) return; // pool cap — the twist saturates honestly at 200 balls
    let vx = -st.vx; // mirrored-angle twin, correct reflection symmetry
    const vy = st.vy;
    if (Math.abs(vx) < 0.4) vx = ctx.rng.chance(0.5) ? 1.2 : -1.2; // near-vertical: fan the twin out
    const k = BALL_SPEED / Math.hypot(vx, vy);
    launchBall(spare, st.x + Math.sign(vx) * 0.06, st.y, vx * k, vy * k);
    ballsFired += 1;
    firedThisVolley += 1;
    ctx.audio.note(880, { dur: 0.12, type: 'triangle', vol: 0.1, slideTo: 1400 });
    if (!splitShown) {
      splitShown = true;
      ctx.hud.showCombo('PRISM SPLIT', true);
      ctx.audio.buzz(15);
    }
    for (let i = 0; i < 5; i++) {
      pushParticle({ kind: 2, x: st.x, y: st.y, vx: ctx.rng.range(-3, 3), vy: ctx.rng.range(-3, 3), life: 1, decay: 3, size: 2.6, rot: 0, spin: 0 });
    }
  }

  function updateBalls(): void {
    const strongBias = volleyTicks > WATCHDOG_TICKS;
    for (const b of balls) {
      if (!b.active) continue;
      if (!phys.readBody(b.handle, st)) {
        b.active = false;
        activeCount -= 1;
        continue;
      }
      if ((st.y <= LAUNCH_Y - 0.05 && st.vy < 0) || st.y < -0.6 || st.x < -0.8 || st.x > FIELD_W + 0.8 || st.y > CEIL_Y + 1.6) {
        collectBall(b, st.x); // reached the bottom line (or escape safety net)
        continue;
      }
      // keep |v| = BALL_SPEED (restitution drift) and bias near-horizontal
      // balls slightly downward so a volley always comes home — visible
      // workaround for the classic infinite-sideways-bounce, not a teleport
      let vx = st.vx;
      let vy = st.vy;
      if (Math.abs(vy) < 0.45) vy -= 0.12;
      if (strongBias && vy > -1.5) vy -= 0.35;
      const sp = Math.hypot(vx, vy);
      if (sp < 0.001) {
        phys.setLinearVelocity(b.handle, 0, -BALL_SPEED);
        continue;
      }
      if (Math.abs(sp - BALL_SPEED) > 0.05 || vy !== st.vy) {
        const k = BALL_SPEED / sp;
        phys.setLinearVelocity(b.handle, vx * k, vy * k);
      }
    }
  }

  // ---- bricks & pickups ----

  function damageBrick(br: Brick): void {
    br.hits -= 1;
    br.flash = 1;
    combo += 1;
    if (popsThisStep < 5) {
      popsThisStep += 1;
      ctx.audio.pop(Math.min(combo, 12)); // combo pitch ladder
    }
    if (br.hits <= 0) breakBrick(br);
    else phys.setUserData(br.handle, brickCode(br.type, br.hits)); // shim mirrors the counter
  }

  function breakBrick(br: Brick): void {
    br.dead = true;
    brickDirty = true;
    phys.destroyBody(br.handle);
    brickBySlot.delete(br.slot);
    stepBreaks += 1;
    breaksThisVolley += 1;
    bricksBroken += 1;
    for (let i = 0; i < 7; i++) {
      pushParticle({
        kind: 0,
        x: br.x + ctx.rng.range(-0.3, 0.3),
        y: br.y + ctx.rng.range(-0.3, 0.3),
        vx: ctx.rng.range(-3.5, 3.5),
        vy: ctx.rng.range(0.5, 4.5),
        life: 1,
        decay: 2.2,
        size: ctx.rng.range(2.5, 5.5),
        rot: ctx.rng.range(0, Math.PI),
        spin: ctx.rng.range(-8, 8),
      });
    }
  }

  function collectPickup(p: Pickup, chimeIt: boolean): void {
    if (p.dead) return;
    p.dead = true;
    pickupDirty = true;
    phys.destroyBody(p.handle);
    pickupBySlot.delete(p.slot);
    ballCount += 1;
    pickupsCollected += 1;
    if (chimeIt) {
      ctx.audio.chime(2);
      ctx.audio.buzz(12);
      ctx.hud.showCombo('+1 BALL');
    } else {
      ctx.audio.pop(4); // auto-collected at the line
    }
    pushParticle({ kind: 1, x: p.x, y: p.y - (phase === 'shift' ? shiftOff : 0), vx: 0, vy: 0, life: 1, decay: 2.8, size: 0.15, rot: 0, spin: 0 });
  }

  // ---- volley flow ----

  function fireVolley(): void {
    if (phase !== 'aim' || ended) return;
    phase = 'volley';
    toFire = ballCount;
    fireTimer = 0;
    firedThisVolley = 0;
    volleyTicks = 0;
    combo = 0;
    breaksThisVolley = 0;
    splitShown = false;
    firstReturn = false;
    nextLaunchX = null;
    kbAim = false;
    ctx.hud.setSub(`balls ×${ballCount}`);
  }

  function endVolley(): void {
    score += 1; // score = turns survived
    ctx.hud.setScore(score);
    maxVolleyBreaks = Math.max(maxVolleyBreaks, breaksThisVolley);
    ctx.audio.whoosh(); // ball vacuum swoosh
    ctx.hud.hideCombo();
    if (nextLaunchX !== null) launchX = nextLaunchX;
    nextLaunchX = null;
    phase = 'shift';
    shiftTick = 0;
    shiftOff = 0;
  }

  function finishShift(): void {
    shiftOff = 0;
    for (const b of bricks) {
      b.y -= CELL;
      phys.setTransform(b.handle, b.x, b.y, 0); // static bricks reposition between volleys
    }
    for (const p of pickups) {
      p.y -= CELL;
      phys.setTransform(p.handle, p.x, p.y, 0);
    }
    ctx.audio.note(150, { dur: 0.14, type: 'sine', vol: 0.1, slideTo: 105 }); // row lands
    if (!ctx.settings().reducedMotion) shake = Math.min(shake + 0.18, 0.5);

    // pickups that reached the collection zone are granted automatically
    for (const p of pickups) if (p.y - 0.3 <= FAIL_Y) collectPickup(p, false);
    if (pickupDirty) {
      pickups = pickups.filter((p) => !p.dead);
      pickupDirty = false;
    }

    // end: any brick's bottom crosses the fail line
    for (const b of bricks) {
      if (b.y - BRICK_H <= FAIL_Y) {
        die();
        return;
      }
    }
    turn += 1;
    spawnRow();
    phase = 'aim';
    ctx.hud.setSub(`turn ${turn} · balls ×${ballCount}`);
  }

  function die(): void {
    phase = 'dead';
    deathTimer = 0.9;
    shake = ctx.settings().reducedMotion ? 0 : 0.8;
    ctx.audio.womp();
    ctx.audio.buzz(60);
    ctx.hud.hideCombo();
    ctx.hud.setSub('the wall reached the line');
  }

  // ---- physics events ----

  function handleEvents(): void {
    // pass 1 — hit events: mark bricks struck on their TOP face this step.
    // PairEvents carry no normal, and the hit event's A/B normal orientation
    // is engine-convention dependent, so the geometric test (contact point on
    // the top surface) is used — convention-proof and equivalent to ny<-0.5.
    topHitSlots.clear();
    for (let i = 0; i < phys.hitCount(); i++) {
      phys.readHit(i, hit);
      let brickSlot = -1;
      if (hit.userA >= BRICK_BASE && hit.userB === TAG_BALL) brickSlot = hit.slotA;
      else if (hit.userB >= BRICK_BASE && hit.userA === TAG_BALL) brickSlot = hit.slotB;
      if (brickSlot < 0) continue;
      const br = brickBySlot.get(brickSlot);
      if (!br) continue;
      if (hit.y >= br.y + BRICK_H - 0.06) topHitSlots.add(brickSlot);
    }

    // pass 2 — contact begins: damage, shield gating, prism splits, wall clicks
    for (let i = 0; i < phys.contactBeginCount(); i++) {
      phys.readContactBegin(i, pair);
      const aBall = pair.userA === TAG_BALL;
      const bBall = pair.userB === TAG_BALL;
      if (!aBall && !bBall) continue;
      const otherUser = aBall ? pair.userB : pair.userA;
      const otherSlot = aBall ? pair.slotB : pair.slotA;
      const ballSlot = aBall ? pair.slotA : pair.slotB;
      if (otherUser >= BRICK_BASE) {
        const br = brickBySlot.get(otherSlot);
        if (!br || br.dead) continue;
        if (br.type === T_SHIELD && !topHitSlots.has(otherSlot)) {
          // armored face — clink, no damage
          br.flash = Math.max(br.flash, 0.4);
          if (clinksThisStep < 3) {
            clinksThisStep += 1;
            ctx.audio.note(1250, { dur: 0.05, type: 'square', vol: 0.05 });
          }
          continue;
        }
        if (br.type === T_PRISM) splitFrom(ballSlot);
        damageBrick(br);
      } else if (otherUser === TAG_WALL && wallClick <= 0) {
        wallClick = 3; // rate-limited bounce click
        ctx.audio.note(760, { dur: 0.03, type: 'sine', vol: 0.035 });
      }
    }

    // sensor begins: +1 ball pickups
    for (let i = 0; i < phys.sensorBeginCount(); i++) {
      phys.readSensorBegin(i, pair);
      let pkSlot = -1;
      if (pair.userA === TAG_PICKUP && pair.userB === TAG_BALL) pkSlot = pair.slotA;
      else if (pair.userB === TAG_PICKUP && pair.userA === TAG_BALL) pkSlot = pair.slotB;
      if (pkSlot < 0) continue;
      const pk = pickupBySlot.get(pkSlot);
      if (pk) collectPickup(pk, true);
    }

    if (stepBreaks > 0) {
      if (!ctx.settings().reducedMotion) shake = Math.min(shake + 0.1 + stepBreaks * 0.12, 0.9); // shake scales with simultaneous breaks
      ctx.audio.noise({ dur: 0.1 + stepBreaks * 0.03, vol: Math.min(0.08 + stepBreaks * 0.05, 0.3), freq: 500 });
      if (stepBreaks >= 3) {
        ctx.hud.showCombo(`CRUSH ×${stepBreaks}`, true);
        ctx.audio.chime(stepBreaks);
        ctx.audio.buzz(20);
      }
    }
    if (brickDirty) {
      bricks = bricks.filter((b) => !b.dead);
      brickDirty = false;
    }
    if (pickupDirty) {
      pickups = pickups.filter((p) => !p.dead);
      pickupDirty = false;
    }
  }

  // ---- particles ----

  function pushParticle(p: Particle): void {
    if (particles.length > 220) particles.shift();
    particles.push(p);
  }

  function updateParticles(dt: number): void {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i]!;
      p.life -= p.decay * dt;
      if (p.life <= 0) {
        particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.kind === 0) {
        p.vy -= 14 * dt;
        p.rot += p.spin * dt;
      } else if (p.kind === 1) {
        p.size += 2.6 * dt;
      }
    }
  }

  // ---- game object ----

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
          pointerAiming = true;
          if (phase === 'aim') {
            aiming = true;
            aimFromPointer(x, y);
          }
        }),
        ctx.input.onDrag((e) => {
          if (aiming && phase === 'aim') aimFromPointer(e.x, e.y);
        }),
        ctx.input.onRelease((e) => {
          if (aiming && phase === 'aim' && Math.hypot(e.totalX, e.totalY) > 10) fireVolley();
          aiming = false;
          pointerAiming = false;
        }),
        // keyboard parity: arrows rotate (polled in step), Space/Enter fires.
        // pointerAiming suppresses the action a plain tap would emit.
        ctx.input.onAction(() => {
          if (phase === 'aim' && !pointerAiming) fireVolley();
        }),
      );

      if (import.meta.env.DEV) {
        (window as unknown as Record<string, unknown>)['__bricksDbg'] = {
          state: () => ({ phase, turn, score, ballCount, activeCount, toFire, bricks: bricks.length, ballsFired, maxVolleyBreaks }),
          fire: (deg: number) => {
            aimAngle = clampAim((deg * Math.PI) / 180);
            fireVolley();
          },
        };
      }
    },

    start(): void {
      phys.init(0, 0); // no gravity — balls fly straight (gravityScale 0 too)
      phys.setHitEventThreshold(1);

      bricks = [];
      pickups = [];
      balls = [];
      particles = [];
      brickBySlot.clear();
      pickupBySlot.clear();
      ballBySlot.clear();
      activeCount = 0;
      brickDirty = false;
      pickupDirty = false;
      topHitSlots.clear();

      phase = 'aim';
      turn = 1;
      score = 0;
      ended = false;
      deathTimer = 0;
      tGlobal = 0;
      aimAngle = Math.PI / 2;
      aiming = false;
      pointerAiming = false;
      kbAim = false;
      launchX = FIELD_W / 2;
      launcherDrawX = FIELD_W / 2;
      nextLaunchX = null;
      firstReturn = false;
      ballCount = 1;
      toFire = 0;
      fireTimer = 0;
      firedThisVolley = 0;
      volleyTicks = 0;
      combo = 0;
      breaksThisVolley = 0;
      splitShown = false;
      ballsFired = 0;
      maxVolleyBreaks = 0;
      bricksBroken = 0;
      pickupsCollected = 0;
      shiftTick = 0;
      shiftOff = 0;
      shake = 0;
      wallClick = 0;

      buildWalls();
      buildBallPool();
      spawnRow();

      ctx.hud.setScore(0);
      ctx.hud.setSub('drag to aim · release to fire'); // teach by doing
    },

    step(dt: number): void {
      if (ended) return;
      tGlobal += dt;
      stepBreaks = 0;
      popsThisStep = 0;
      clinksThisStep = 0;
      landsThisStep = 0;
      if (wallClick > 0) wallClick -= 1;

      if (phase === 'aim') {
        const ax = ctx.input.axis();
        if (ax !== 0) {
          kbAim = true;
          aimAngle = clampAim(aimAngle - ax * 1.6 * dt);
        }
      } else if (phase === 'volley') {
        volleyTicks += 1;
        if (toFire > 0) {
          fireTimer -= 1;
          if (fireTimer <= 0) {
            const b = takePooled();
            if (b) {
              launchBall(b, launchX, LAUNCH_Y, Math.cos(aimAngle) * BALL_SPEED, Math.sin(aimAngle) * BALL_SPEED);
              ballsFired += 1;
              firedThisVolley += 1;
              toFire -= 1;
              ctx.audio.note(480 + (firedThisVolley % 10) * 26, { dur: 0.05, type: 'triangle', vol: 0.05, slideTo: 720 });
            } else {
              toFire = 0; // pool exhausted (defensive)
            }
            fireTimer = FIRE_TICKS;
          }
        }
      }

      phys.step(dt, 4);

      if (phase === 'volley') {
        handleEvents();
        updateBalls();
        if (toFire === 0 && activeCount === 0) endVolley();
      } else if (phase === 'shift') {
        shiftTick += 1;
        shiftOff = CELL * ease(Math.min(shiftTick / SHIFT_TICKS, 1));
        for (const b of bricks) phys.setTransform(b.handle, b.x, b.y - shiftOff, 0);
        for (const p of pickups) phys.setTransform(p.handle, p.x, p.y - shiftOff, 0);
        if (shiftTick >= SHIFT_TICKS) finishShift();
      } else if (phase === 'dead') {
        deathTimer -= dt;
        if (deathTimer <= 0 && !ended) {
          ended = true;
          ctx.endRun({
            score,
            durationMs: 0,
            seed: 0,
            stats: { maxVolleyBreaks, ballsFired, bricksBroken, pickups: pickupsCollected },
          });
        }
      }

      for (const b of bricks) b.flash = Math.max(0, b.flash - dt * 3.2);
      updateParticles(dt);
      shake = Math.max(0, shake - dt * 1.8);
      launcherDrawX += (launchX - launcherDrawX) * 0.2;
    },

    render(): void {
      const w = ctx.width;
      const h = ctx.height;
      const dpr = ctx.dpr;
      const colors = ctx.colors();
      const s = viewScale();
      const reduced = ctx.settings().reducedMotion;
      c2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      c2d.clearRect(0, 0, w, h);

      const jx = reduced ? 0 : (Math.random() - 0.5) * shake * 12;
      const jy = reduced ? 0 : (Math.random() - 0.5) * shake * 12;
      c2d.translate(jx, jy);

      // playfield backdrop + walls
      const left = sx(0, s);
      const right = sx(FIELD_W, s);
      const top = sy(CEIL_Y, s);
      const bottom = sy(0, s);
      c2d.fillStyle = colors.surface;
      c2d.globalAlpha = 0.35;
      c2d.fillRect(left, top, right - left, bottom - top);
      c2d.globalAlpha = 1;
      c2d.fillStyle = colors.surface;
      c2d.fillRect(left - 0.24 * s, top - 0.24 * s, right - left + 0.48 * s, 0.24 * s); // ceiling
      c2d.fillRect(left - 0.24 * s, top - 0.24 * s, 0.24 * s, bottom - top + 0.24 * s); // left
      c2d.fillRect(right, top - 0.24 * s, 0.24 * s, bottom - top + 0.24 * s); // right
      c2d.strokeStyle = colors.accent;
      c2d.globalAlpha = 0.55;
      c2d.lineWidth = 1.5;
      c2d.beginPath();
      c2d.moveTo(left, top);
      c2d.lineTo(left, bottom);
      c2d.moveTo(right, top);
      c2d.lineTo(right, bottom);
      c2d.moveTo(left, top);
      c2d.lineTo(right, top);
      c2d.stroke();
      c2d.globalAlpha = 1;

      // fail line — pulses when the wall closes in
      let lowest = Infinity;
      for (const b of bricks) lowest = Math.min(lowest, b.y - (phase === 'shift' ? shiftOff : 0) - BRICK_H);
      const danger = lowest < FAIL_Y + CELL * 2;
      const pulse = danger && !reduced ? 0.45 + 0.35 * Math.abs(Math.sin(tGlobal * 4)) : danger ? 0.7 : 0.35;
      c2d.strokeStyle = colors.danger;
      c2d.globalAlpha = pulse;
      c2d.lineWidth = 2;
      c2d.setLineDash([6, 7]);
      c2d.beginPath();
      c2d.moveTo(left, sy(FAIL_Y, s));
      c2d.lineTo(right, sy(FAIL_Y, s));
      c2d.stroke();
      c2d.setLineDash([]);
      c2d.globalAlpha = 1;

      // pickups
      for (const p of pickups) {
        const px = sx(p.x, s);
        const py = sy(p.y - (phase === 'shift' ? shiftOff : 0), s);
        const pr = 0.22 * s * (1 + (reduced ? 0 : 0.1 * Math.sin(tGlobal * 5)));
        c2d.strokeStyle = colors.glow;
        c2d.lineWidth = 2;
        c2d.beginPath();
        c2d.arc(px, py, pr, 0, Math.PI * 2);
        c2d.stroke();
        c2d.fillStyle = colors.primary;
        c2d.beginPath();
        c2d.arc(px, py, BALL_R * 0.55 * s, 0, Math.PI * 2);
        c2d.fill();
        c2d.fillStyle = colors.text;
        c2d.font = `700 ${Math.max(8, 0.2 * s)}px system-ui`;
        c2d.textAlign = 'center';
        c2d.textBaseline = 'middle';
        c2d.fillText('+1', px, py - pr - 0.12 * s);
      }

      // bricks
      for (const b of bricks) {
        const y = b.y - (phase === 'shift' ? shiftOff : 0);
        const px = sx(b.x - BRICK_H, s);
        const py = sy(y + BRICK_H, s);
        const size = BRICK_H * 2 * s;
        const cx = sx(b.x, s);
        const cy = sy(y, s);
        const failing = y - BRICK_H <= FAIL_Y + 0.01;

        c2d.fillStyle = colors.surface;
        roundRect(c2d, px, py, size, size, 4);
        c2d.fill();
        c2d.lineWidth = 2;
        c2d.strokeStyle = failing ? colors.danger : b.type === T_PRISM ? colors.glow : colors.accent;
        if (b.flash > 0.5) c2d.strokeStyle = colors.glow;
        c2d.stroke();

        // crack states scale with damage
        const dmg = 1 - b.hits / b.maxHits;
        if (dmg > 0.01) {
          c2d.strokeStyle = colors.text;
          c2d.globalAlpha = 0.15 + dmg * 0.45;
          c2d.lineWidth = 1;
          c2d.beginPath();
          const [ca, cb, cc, cd] = b.cracks;
          c2d.moveTo(cx + (ca - 0.5) * size * 0.4, cy + (cb - 0.5) * size * 0.4);
          c2d.lineTo(px + ca * size, py);
          c2d.moveTo(cx + (ca - 0.5) * size * 0.4, cy + (cb - 0.5) * size * 0.4);
          c2d.lineTo(px, py + cb * size);
          if (dmg > 0.45) {
            c2d.moveTo(cx + (cc - 0.5) * size * 0.3, cy + (cd - 0.5) * size * 0.3);
            c2d.lineTo(px + size, py + cd * size);
          }
          if (dmg > 0.75) {
            c2d.moveTo(cx, cy);
            c2d.lineTo(px + cc * size, py + size);
          }
          c2d.stroke();
          c2d.globalAlpha = 1;
        }

        if (b.type === T_SHIELD) {
          // armored: only the glowing top face is vulnerable
          c2d.fillStyle = colors.glow;
          c2d.fillRect(px + 1, py + 1, size - 2, Math.max(3, 0.09 * s));
          c2d.strokeStyle = colors.text;
          c2d.globalAlpha = 0.5;
          c2d.lineWidth = 2.5;
          c2d.beginPath();
          c2d.moveTo(px + 2, py + size - 3);
          c2d.lineTo(px + size - 2, py + size - 3);
          c2d.stroke();
          c2d.globalAlpha = 1;
        } else if (b.type === T_PRISM) {
          const d = size * 0.34;
          c2d.strokeStyle = colors.glow;
          c2d.globalAlpha = 0.7;
          c2d.lineWidth = 1.5;
          c2d.beginPath();
          c2d.moveTo(cx, cy - d);
          c2d.lineTo(cx + d, cy);
          c2d.lineTo(cx, cy + d);
          c2d.lineTo(cx - d, cy);
          c2d.closePath();
          c2d.stroke();
          c2d.globalAlpha = 1;
        }

        // number pops on chip
        const fontPx = Math.max(10, 0.4 * s) * (1 + b.flash * 0.45);
        c2d.fillStyle = b.flash > 0.5 ? colors.glow : colors.text;
        c2d.font = `900 ${fontPx}px system-ui`;
        c2d.textAlign = 'center';
        c2d.textBaseline = 'middle';
        c2d.fillText(String(b.hits), cx, cy);
      }

      // balls with velocity streaks
      for (const b of balls) {
        if (!b.active) continue;
        if (!phys.readBody(b.handle, st)) continue;
        const bx = sx(st.x, s);
        const by = sy(st.y, s);
        c2d.strokeStyle = colors.primary;
        c2d.globalAlpha = 0.3;
        c2d.lineWidth = BALL_R * s;
        c2d.lineCap = 'round';
        c2d.beginPath();
        c2d.moveTo(sx(st.x - st.vx * 0.028, s), sy(st.y - st.vy * 0.028, s));
        c2d.lineTo(bx, by);
        c2d.stroke();
        c2d.globalAlpha = 1;
        c2d.fillStyle = colors.primary;
        c2d.beginPath();
        c2d.arc(bx, by, BALL_R * s, 0, Math.PI * 2);
        c2d.fill();
      }

      // particles
      for (const p of particles) {
        const px = sx(p.x, s);
        const py = sy(p.y, s);
        c2d.globalAlpha = Math.max(0, Math.min(1, p.life)) * 0.9;
        if (p.kind === 0) {
          c2d.save();
          c2d.translate(px, py);
          c2d.rotate(p.rot);
          c2d.fillStyle = colors.accent;
          c2d.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
          c2d.restore();
        } else if (p.kind === 1) {
          c2d.strokeStyle = colors.glow;
          c2d.lineWidth = 2;
          c2d.beginPath();
          c2d.arc(px, py, p.size * s, 0, Math.PI * 2);
          c2d.stroke();
        } else {
          c2d.fillStyle = colors.glow;
          c2d.beginPath();
          c2d.arc(px, py, p.size, 0, Math.PI * 2);
          c2d.fill();
        }
      }
      c2d.globalAlpha = 1;

      // aim preview — dotted, raycast + one reflection (2 bounces of dots)
      if (phase === 'aim' && (aiming || kbAim)) {
        const dx = Math.cos(aimAngle);
        const dy = Math.sin(aimAngle);
        const r1 = phys.castRayClosest([launchX, LAUNCH_Y], [dx * 24, dy * 24], CAT_BALL, CAT_WALL | CAT_BRICK, ray);
        const d1 = r1.hit ? r1.fraction * 24 : 24;
        drawDots(c2d, s, launchX, LAUNCH_Y, dx, dy, d1, colors.glow, sx, sy, 0.5);
        if (r1.hit) {
          const dot = dx * r1.nx + dy * r1.ny;
          const rx = dx - 2 * dot * r1.nx;
          const ry = dy - 2 * dot * r1.ny;
          const ox = r1.x + rx * 0.02;
          const oy = r1.y + ry * 0.02;
          const r2 = phys.castRayClosest([ox, oy], [rx * 4.2, ry * 4.2], CAT_BALL, CAT_WALL | CAT_BRICK, ray);
          const d2 = r2.hit ? r2.fraction * 4.2 : 4.2;
          drawDots(c2d, s, ox, oy, rx, ry, d2, colors.text, sx, sy, 0.3);
        }
      }

      // next-launch ghost marker (first returned ball)
      if (nextLaunchX !== null && phase === 'volley') {
        c2d.strokeStyle = colors.text;
        c2d.globalAlpha = 0.4;
        c2d.lineWidth = 2;
        c2d.beginPath();
        c2d.moveTo(sx(nextLaunchX, s), sy(0.02, s));
        c2d.lineTo(sx(nextLaunchX - 0.14, s), sy(0.02, s) + 0.2 * s);
        c2d.moveTo(sx(nextLaunchX, s), sy(0.02, s));
        c2d.lineTo(sx(nextLaunchX + 0.14, s), sy(0.02, s) + 0.2 * s);
        c2d.stroke();
        c2d.globalAlpha = 1;
      }

      // launcher chevron + ball counter
      const lx = sx(launcherDrawX, s);
      const ly = sy(LAUNCH_Y, s);
      c2d.fillStyle = colors.primary;
      c2d.beginPath();
      c2d.moveTo(lx, ly - 0.24 * s);
      c2d.lineTo(lx + 0.2 * s, ly + 0.14 * s);
      c2d.lineTo(lx - 0.2 * s, ly + 0.14 * s);
      c2d.closePath();
      c2d.fill();
      c2d.fillStyle = colors.text;
      c2d.font = `700 ${Math.max(10, 0.26 * s)}px system-ui`;
      c2d.textAlign = 'center';
      c2d.textBaseline = 'middle';
      const shown = phase === 'volley' ? toFire : ballCount;
      if (shown > 0) c2d.fillText(`×${shown}`, lx + 0.62 * s, ly);

      // death tint over the breached line (static under reduced motion)
      if (phase === 'dead') {
        const a = reduced ? 0.14 : 0.1 + 0.12 * Math.abs(Math.sin(tGlobal * 5));
        c2d.fillStyle = colors.danger;
        c2d.globalAlpha = a;
        c2d.fillRect(left, sy(FAIL_Y, s), right - left, bottom - sy(FAIL_Y, s));
        c2d.globalAlpha = 1;
      }
    },

    dispose(): void {
      detachFns.forEach((d) => d());
      detachFns = [];
      phys.init(0, 0); // frees the world's bodies
    },
  };
}

function drawDots(
  c: CanvasRenderingContext2D,
  s: number,
  x0: number,
  y0: number,
  dx: number,
  dy: number,
  dist: number,
  color: string,
  sx: (x: number, s: number) => number,
  sy: (y: number, s: number) => number,
  skip: number,
): void {
  const spacing = 0.42;
  c.fillStyle = color;
  for (let d = skip; d < dist; d += spacing) {
    const t = d / Math.max(dist, 0.001);
    c.globalAlpha = 0.85 - t * 0.45;
    c.beginPath();
    c.arc(sx(x0 + dx * d, s), sy(y0 + dy * d, s), Math.max(1.5, 0.045 * s * (1 - t * 0.4)), 0, Math.PI * 2);
    c.fill();
  }
  c.globalAlpha = 1;
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  c.roundRect(x, y, w, h, r);
}
