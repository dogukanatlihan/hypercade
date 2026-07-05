// SNIP — physics puzzle / cut (MECHANICS §5). Box2D v3.
// Rope = distance-joint chain of small capsules pinned to its anchor by a
// revolute joint (MECHANICS §5 physics line). A swipe destroys the crossed
// link body — its joints die with it — and severed segments STAY live (the
// twist): they keep physical presence and can be landed on or swung on.
// 24 levels (levels.ts) flow in-place: clearing one auto-advances to the next,
// losing one reloads it. Score = TOTAL sparks across best-per-level, persisted
// in storage ('levelSparks'). endRun fires ONCE per run — when all 24 are
// cleared, or after FAIL_LIMIT losses in a row on the same level — banking
// the cumulative stars/XP the run earned.

import type { Game, GameContext } from '@sdk/types';
import type { Physics2D, PairEvent, BodyState2D, HitEvent2D } from '@sdk/physics2d';
import { BODY_STATIC, BODY_DYNAMIC, BODY_KINEMATIC, SHAPE_SENSOR, SHAPE_HIT_EVENTS, SHAPE_CONTACT_EVENTS } from '@sdk/physics2d';
import { gameMeta } from '@shared/registry';
import { LEVELS, LEVEL_COUNT, type LevelDef, type RopeDef } from './levels';
import { clamp, segSegDistSq, anchorPos, starPath, drawJetField, drawMouth, drawBumper, drawCandy } from './draw';

// world: levels live in a 10×14 m space, y-up (levels.ts)
const WORLD_W = 10;
const WORLD_H = 14;
const GRAVITY = -10;
const LINK_R = 0.09; // capsule radius (spec)
const TARGET_LINK_LEN = 0.45;
const CANDY_R = 0.3;
const GOAL_R = 0.55; // sensor radius; the mouth is drawn larger
const SPARK_R = 0.38;
const CUT_SLOP = 0.2; // finger slop added to the link radius
const REST_SPEED = 0.18; // below this the detached candy counts as resting
const REST_FAIL_S = 3; // detached + resting this long = unreachable (spec)
const WIN_DELAY = 1.4; // 'LEVEL CLEAR' beat before auto-advancing to the next level
const LOSE_DELAY = 1.0; // 'LOST IT' beat before reloading the same level
const HINT_S = 6;
const MAX_SPARKS = LEVEL_COUNT * 3; // 72
const FAIL_LIMIT = 3; // consecutive losses on one level before the run banks out

// user-data tags (sensor/hit event routing)
const TAG_CANDY = 1;
const TAG_GOAL = 2;
const TAG_BUMPER = 3;
const TAG_SPARK0 = 10; // 10 + spark index

const CAT_ROPE = 0x0002;
const ROPE_GROUP = -1; // links never collide with each other (any rope)

// feature-intro hints (teach by doing, no tutorial screens)
const INTRO_HINTS: Readonly<Partial<Record<number, string>>> = {
  0: 'swipe across a rope to cut it',
  8: 'anchors move — time the cut',
  14: 'bumpers bounce the candy',
  19: 'air jets push the candy',
};

interface Rope {
  def: RopeDef;
  anchorH: number;
  links: number[]; // body handles; -1 once severed
  hl: number; // capsule half-length
  linkLen: number;
  linkMass: number;
  rests: number[]; // rest length per chain segment (anchor…candy)
  intact: boolean; // still holds the candy (no link cut yet)
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  glow: boolean;
}

interface CutFlash {
  x: number;
  y: number;
  angle: number;
  life: number;
}

interface TrailDot {
  x: number;
  y: number;
  life: number;
}

export function createGame(): Game {
  const meta = gameMeta('rope')!;
  let ctx: GameContext;
  let phys: Physics2D;
  let c2d: CanvasRenderingContext2D;

  // progress (persisted)
  let levelIdx = 0;
  let levelSparks: number[] = [];
  let level: LevelDef = LEVELS[0]!;

  // run-scope (spans levels; reset only by start(), never by an in-place reload)
  let failCount = 0; // consecutive losses on the current level
  let runSparks = 0; // sparks banked across the levels cleared this run
  let runOneCut = 0; // one-cut clears this run
  let runCuts = 0; // total cuts across the levels cleared this run

  // per-attempt state
  let candy = -1;
  let candyAlive = false;
  let candyMass = 1;
  let ropes: Rope[] = [];
  let sparkBodies: number[] = []; // -1 once collected
  let goalBody = -1;
  let bumpAnim: number[] = [];
  let collectedCount = 0;
  let cuts = 0; // swipe gestures that severed ≥1 link
  let gestureCut = false;
  let phase: 'play' | 'won' | 'lost' = 'play';
  let phaseT = 0;
  let ended = false;
  let restT = 0;
  let t = 0; // level clock
  let shake = 0;
  let candyInJet = false;
  let lastChew = 0;
  let eatX = 0;
  let eatY = 0;
  let lastSub = '';
  let trail: TrailDot[] = [];
  let parts: Particle[] = [];
  let flashes: CutFlash[] = [];

  // reused event/state scratch (no per-frame allocs)
  const st: BodyState2D = { x: 0, y: 0, angle: 0, awake: false, vx: 0, vy: 0, w: 0 };
  const st2: BodyState2D = { x: 0, y: 0, angle: 0, awake: false, vx: 0, vy: 0, w: 0 };
  const pair: PairEvent = { slotA: 0, userA: 0, slotB: 0, userB: 0 };
  const hit: HitEvent2D = { x: 0, y: 0, nx: 0, ny: 0, speed: 0, slotA: 0, userA: 0, slotB: 0, userB: 0 };
  const detach: (() => void)[] = [];

  // ---- camera (min-based fit: whole 10×14 field visible in both orientations) ----
  function view(): { s: number; ox: number; oy: number } {
    const s = Math.min(ctx.width / WORLD_W, ctx.height / WORLD_H);
    return { s, ox: (ctx.width - WORLD_W * s) / 2, oy: (ctx.height - WORLD_H * s) / 2 };
  }

  // ---- scoring helpers ----
  function totalCommitted(): number {
    let sum = 0;
    for (let i = 0; i < LEVEL_COUNT; i++) sum += levelSparks[i]!;
    return sum;
  }

  function liveTotal(): number {
    return totalCommitted() - levelSparks[levelIdx]! + Math.max(levelSparks[levelIdx]!, collectedCount);
  }

  function updateSub(): void {
    let text = `level ${levelIdx + 1} — sparks ${liveTotal()}/${MAX_SPARKS}`;
    const hint = INTRO_HINTS[levelIdx];
    if (phase === 'play' && hint !== undefined && t < HINT_S && cuts === 0) text = hint;
    if (phase === 'play' && restT > 1) text = 'out of reach — restarting…';
    if (text !== lastSub) {
      lastSub = text;
      ctx.hud.setSub(text);
    }
  }

  // ---- world building ----
  function buildRope(def: RopeDef): Rope {
    const a0 = anchorPos(def, 0);
    const cx = level.candy[0];
    const cy = level.candy[1];
    const dx = cx - a0.x;
    const dy = cy - a0.y;
    const d = Math.max(Math.hypot(dx, dy), 0.6);
    const n = def.links ?? clamp(Math.round(d / TARGET_LINK_LEN), 3, 14);
    const linkLen = d / n;
    const hl = Math.max(linkLen / 2 - LINK_R, 0.05);
    const ux = dx / d;
    const uy = dy / d;
    const angle = Math.atan2(uy, ux);
    const anchorH = phys.createBody({ type: def.move ? BODY_KINEMATIC : BODY_STATIC, position: [a0.x, a0.y] });
    const links: number[] = [];
    let prev = -1;
    let px = a0.x;
    let py = a0.y;
    for (let i = 0; i < n; i++) {
      const mx = a0.x + ux * linkLen * (i + 0.5);
      const my = a0.y + uy * linkLen * (i + 0.5);
      const h = phys.createBody({ type: BODY_DYNAMIC, position: [mx, my], angle, linearDamping: 0.15, angularDamping: 0.8 });
      phys.addCapsule(h, [-hl, 0], [hl, 0], LINK_R, { density: 1.2, friction: 0.4, restitution: 0.05 });
      phys.setFilter(h, CAT_ROPE, 0xffffffff, ROPE_GROUP);
      if (i === 0) phys.createRevoluteJoint(anchorH, h, [a0.x, a0.y]);
      else phys.createDistanceJoint(prev, h, [px, py], [mx, my], linkLen);
      links.push(h);
      prev = h;
      px = mx;
      py = my;
    }
    phys.createDistanceJoint(prev, candy, [px, py], [cx, cy], linkLen * 0.5);
    const rests: number[] = [linkLen * 0.5];
    for (let i = 0; i < n - 1; i++) rests.push(linkLen);
    rests.push(linkLen * 0.5);
    return { def, anchorH, links, hl, linkLen, linkMass: phys.getMass(links[0]!), rests, intact: true };
  }

  // ---- cutting ----
  function sever(r: Rope, i: number, px: number, py: number): void {
    const h = r.links[i]!;
    r.links[i] = -1;
    // snap recoil: the freed neighbours (and candy, if it was the last link)
    // twang away from the cut point — impulses scaled by mass, engine-applied
    const recoil = (nh: number, factor: number): void => {
      if (nh < 0 || !phys.readBody(nh, st2)) return;
      let rdx = st2.x - px;
      let rdy = st2.y - py;
      const len = Math.hypot(rdx, rdy) || 1;
      rdx /= len;
      rdy /= len;
      const m = nh === candy ? candyMass : r.linkMass;
      phys.applyImpulse(nh, rdx * m * factor, rdy * m * factor + m * factor * 0.4);
    };
    recoil(i > 0 ? r.links[i - 1]! : -1, 0.9);
    recoil(i < r.links.length - 1 ? r.links[i + 1]! : candyAlive ? candy : -1, i < r.links.length - 1 ? 0.9 : 0.3);
    phys.destroyBody(h);
    r.intact = false;
    if (!gestureCut) {
      gestureCut = true;
      cuts += 1;
    }
    flashes.push({ x: px, y: py, angle: ctx.rng.range(0, Math.PI), life: 1 });
    for (let k = 0; k < 5; k++) {
      parts.push({ x: px, y: py, vx: ctx.rng.range(-2, 2), vy: ctx.rng.range(-0.5, 3), life: 0.6, glow: false });
    }
    ctx.audio.noise({ dur: 0.07, vol: 0.16, freq: 2600, q: 2 });
    ctx.audio.pop(7);
    ctx.audio.buzz(12);
  }

  function cutSweep(ax: number, ay: number, bx: number, by: number): void {
    if (Math.hypot(bx - ax, by - ay) < 1e-4) return;
    const thresh = LINK_R + CUT_SLOP;
    const t2 = thresh * thresh;
    for (const r of ropes) {
      for (let i = 0; i < r.links.length; i++) {
        const h = r.links[i]!;
        if (h < 0 || !phys.readBody(h, st2)) continue;
        const ex = Math.cos(st2.angle) * r.hl;
        const ey = Math.sin(st2.angle) * r.hl;
        if (segSegDistSq(ax, ay, bx, by, st2.x - ex, st2.y - ey, st2.x + ex, st2.y + ey) <= t2) {
          sever(r, i, st2.x, st2.y);
        }
      }
    }
  }

  // ---- outcomes ----
  function win(): void {
    if (phase !== 'play') return;
    phase = 'won';
    phaseT = 0;
    lastChew = 0;
    if (phys.readBody(candy, st)) {
      eatX = st.x;
      eatY = st.y;
    } else {
      eatX = level.goal[0];
      eatY = level.goal[1];
    }
    phys.destroyBody(candy); // eaten — removed from the world
    candyAlive = false;
    levelSparks[levelIdx] = Math.max(levelSparks[levelIdx]!, collectedCount);
    ctx.storage.set('levelSparks', levelSparks);
    // bank this clear into the run totals — endRun reports them cumulatively
    runSparks += collectedCount;
    runCuts += cuts;
    if (cuts === 1) runOneCut += 1;
    failCount = 0; // cleared it — the streak resets
    ctx.audio.fanfare();
    ctx.audio.buzz(30);
    if (cuts === 1) ctx.hud.showCombo('ONE CUT!', true);
    else if (collectedCount === 3) ctx.hud.showCombo('ALL SPARKS!', true);
    ctx.hud.flash(levelIdx >= LEVEL_COUNT - 1 ? 'ALL LEVELS CLEAR' : 'LEVEL CLEAR', 1200);
  }

  function lose(msg: string): void {
    if (phase !== 'play') return;
    phase = 'lost';
    phaseT = 0;
    failCount += 1;
    shake = ctx.settings().reducedMotion ? 0 : 0.35;
    ctx.audio.womp();
    ctx.audio.buzz(50);
    ctx.hud.showCombo(msg); // why it was lost (CANDY LOST / OUT OF REACH)
    ctx.hud.flash(failCount >= FAIL_LIMIT ? 'OUT OF TRIES' : 'LOST IT — RETRY', 1000);
  }

  function collectSpark(i: number): void {
    const b = sparkBodies[i];
    if (b === undefined || b < 0) return;
    phys.destroyBody(b);
    sparkBodies[i] = -1;
    collectedCount += 1;
    const sp = level.sparks[i]!;
    for (let k = 0; k < 10; k++) {
      parts.push({ x: sp[0], y: sp[1], vx: ctx.rng.range(-3, 3), vy: ctx.rng.range(-1, 4), life: 0.8, glow: true });
    }
    ctx.audio.chime(collectedCount * 2);
    ctx.audio.buzz(15);
    ctx.hud.showCombo(`SPARK ${collectedCount}/3`, collectedCount === 3);
  }

  // ---- per-step event handling ----
  function handleSensors(): void {
    let sawGoal = false;
    for (let i = 0; i < phys.sensorBeginCount(); i++) {
      phys.readSensorBegin(i, pair);
      const other = pair.userA === TAG_CANDY ? pair.userB : pair.userB === TAG_CANDY ? pair.userA : 0;
      if (other === 0) continue;
      if (other === TAG_GOAL) sawGoal = true;
      else if (other >= TAG_SPARK0 && other < TAG_SPARK0 + 3) collectSpark(other - TAG_SPARK0);
    }
    if (sawGoal) win();
  }

  function handleHits(): void {
    const reduced = ctx.settings().reducedMotion;
    for (let i = 0; i < phys.hitCount(); i++) {
      phys.readHit(i, hit);
      const isCandy = hit.userA === TAG_CANDY || hit.userB === TAG_CANDY;
      const isBumper = hit.userA === TAG_BUMPER || hit.userB === TAG_BUMPER;
      if (isBumper) {
        // flash the nearest bumper ring
        const defs = level.bumpers ?? [];
        let best = -1;
        let bestD = Infinity;
        for (let k = 0; k < defs.length; k++) {
          const bd = defs[k]!;
          const dd = (bd.x - hit.x) * (bd.x - hit.x) + (bd.y - hit.y) * (bd.y - hit.y);
          if (dd < bestD) {
            bestD = dd;
            best = k;
          }
        }
        if (best >= 0) bumpAnim[best] = 1;
        const vol = isCandy ? Math.min(0.06 + hit.speed * 0.02, 0.2) : 0.04;
        ctx.audio.note(280 + Math.min(hit.speed * 35, 300), { dur: 0.12, type: 'triangle', vol, slideTo: 520 + Math.min(hit.speed * 40, 400) });
        if (isCandy) {
          ctx.audio.buzz(10);
          if (!reduced) shake = Math.min(0.2, hit.speed * 0.02);
        }
      } else if (isCandy && hit.speed > 1.5) {
        ctx.audio.thud(hit.speed * 0.6); // candy landing on rope/anything
      }
    }
  }

  // ---- level flow ----
  // (Re)build the world for the CURRENT levelIdx. Drives both the shell's
  // start() and the in-place advance/retry flow, so it resets ONLY per-attempt
  // state — run-scope counters (failCount, run totals, `ended`) are owned by
  // start() and the outcome handlers.
  function buildLevel(): void {
    phys.init(0, GRAVITY);
    phys.setHitEventThreshold(1.2);
    level = LEVELS[levelIdx]!;

    // reset attempt state
    ropes = [];
    sparkBodies = [];
    bumpAnim = [];
    trail = [];
    parts = [];
    flashes = [];
    collectedCount = 0;
    cuts = 0;
    gestureCut = false;
    phase = 'play';
    phaseT = 0;
    restT = 0;
    t = 0;
    shake = 0;
    candyInJet = false;
    lastChew = 0;
    lastSub = '';

    // candy — the payload every joint ultimately carries
    candy = phys.createBody({ type: BODY_DYNAMIC, position: [level.candy[0], level.candy[1]], bullet: true, linearDamping: 0.05, angularDamping: 0.4 });
    phys.addCircle(candy, CANDY_R, { density: 1, friction: 0.4, restitution: 0.25, flags: SHAPE_HIT_EVENTS | SHAPE_CONTACT_EVENTS });
    phys.setUserData(candy, TAG_CANDY);
    candyAlive = true;
    candyMass = phys.getMass(candy);

    for (const def of level.ropes) ropes.push(buildRope(def));

    goalBody = phys.createBody({ type: BODY_STATIC, position: [level.goal[0], level.goal[1]] });
    phys.addCircle(goalBody, GOAL_R, { flags: SHAPE_SENSOR });
    phys.setUserData(goalBody, TAG_GOAL);

    level.sparks.forEach((sp, i) => {
      const b = phys.createBody({ type: BODY_STATIC, position: [sp[0], sp[1]] });
      phys.addCircle(b, SPARK_R, { flags: SHAPE_SENSOR });
      phys.setUserData(b, TAG_SPARK0 + i);
      sparkBodies.push(b);
    });

    (level.bumpers ?? []).forEach((bd) => {
      const b = phys.createBody({ type: BODY_STATIC, position: [bd.x, bd.y] });
      phys.addCircle(b, bd.r, { friction: 0.1, restitution: 0.9, flags: SHAPE_HIT_EVENTS | SHAPE_CONTACT_EVENTS });
      phys.setUserData(b, TAG_BUMPER);
      bumpAnim.push(0);
    });

    ctx.hud.setScore(totalCommitted());
    updateSub();
  }

  // endRun fires ONCE per run: all levels cleared, or FAIL_LIMIT losses banked.
  // Reports the run's cumulative feats; score stays total best sparks.
  function bankRun(): void {
    if (ended) return;
    ended = true;
    ctx.endRun({
      score: totalCommitted(),
      durationMs: 0,
      seed: 0,
      stats: { oneCutSolves: runOneCut, sparks: runSparks, cuts: runCuts, level: levelIdx + 1 },
    });
  }

  return {
    meta,

    async init(context: GameContext): Promise<void> {
      ctx = context;
      phys = await ctx.physics2d();
      const c = ctx.canvas.getContext('2d');
      if (!c) throw new Error('no 2d context');
      c2d = c;
      detach.push(ctx.input.onDown(() => {
        gestureCut = false;
      }));
      detach.push(ctx.input.onDrag((e) => {
        if (phase !== 'play') return;
        const v = view();
        const ax = (e.prevX - v.ox) / v.s;
        const ay = (ctx.height - e.prevY - v.oy) / v.s;
        const bx = (e.x - v.ox) / v.s;
        const by = (ctx.height - e.y - v.oy) / v.s;
        cutSweep(ax, ay, bx, by);
      }));
      if (import.meta.env.DEV) {
        (window as unknown as Record<string, unknown>)['__ropeDbg'] = {
          state: () => ({ levelIdx, phase, cuts, collected: collectedCount, total: liveTotal(), ropes: ropes.map((r) => r.links.filter((h) => h >= 0).length) }),
        };
      }
    },

    // Restart from the shell: resume the stored level, reset run-scope state,
    // and (re)build that level cleanly in place.
    start(): void {
      // load progress (validated — never trust stored shapes)
      const storedSparks = ctx.storage.get<number[]>('levelSparks', []);
      levelSparks = [];
      for (let i = 0; i < LEVEL_COUNT; i++) {
        const raw = Array.isArray(storedSparks) ? storedSparks[i] : undefined;
        levelSparks.push(typeof raw === 'number' && Number.isFinite(raw) ? clamp(Math.floor(raw), 0, 3) : 0);
      }
      const rawLevel = ctx.storage.get<number>('level', 0);
      levelIdx = typeof rawLevel === 'number' && Number.isFinite(rawLevel) ? clamp(Math.floor(rawLevel), 0, LEVEL_COUNT - 1) : 0;

      // reset run-scope state (survives in-place level changes; only start() clears it)
      failCount = 0;
      runSparks = 0;
      runOneCut = 0;
      runCuts = 0;
      ended = false;

      buildLevel();
    },

    step(dt: number): void {
      if (ended) return;
      t += dt;
      if (phase !== 'play') phaseT += dt;

      // kinematic moving anchors — engine-driven via target transforms
      for (const r of ropes) {
        if (r.def.move) {
          const p = anchorPos(r.def, t);
          phys.setTargetTransform(r.anchorH, p.x, p.y, 0, dt);
        }
      }

      // air jets: uniform acceleration field, applied as per-body engine forces
      const jets = level.jets ?? [];
      if (jets.length > 0) {
        let anyIn = false;
        for (const j of jets) {
          if (candyAlive && phys.readBody(candy, st) && Math.abs(st.x - j.x) < j.hw && Math.abs(st.y - j.y) < j.hh) {
            phys.applyForce(candy, j.fx * candyMass, j.fy * candyMass);
            anyIn = true;
          }
          for (const r of ropes) {
            for (const h of r.links) {
              if (h >= 0 && phys.readBody(h, st2) && Math.abs(st2.x - j.x) < j.hw && Math.abs(st2.y - j.y) < j.hh) {
                phys.applyForce(h, j.fx * r.linkMass, j.fy * r.linkMass);
              }
            }
          }
        }
        if (anyIn && !candyInJet) ctx.audio.whoosh();
        candyInJet = anyIn;
      }

      phys.step(dt, 4);

      if (phase === 'play' && candyAlive) handleSensors();
      handleHits();

      // candy checks: off-screen fail, unreachable-rest fail, spark trail
      if (phase === 'play' && candyAlive && phys.readBody(candy, st)) {
        if (st.x < -1.5 || st.x > WORLD_W + 1.5 || st.y < -1.5 || st.y > WORLD_H + 2) {
          lose('CANDY LOST');
        } else {
          const speed = Math.hypot(st.vx, st.vy);
          const attached = ropes.some((r) => r.intact);
          restT = !attached && speed < REST_SPEED ? restT + dt : 0;
          if (restT >= REST_FAIL_S) lose('OUT OF REACH');
          if (speed > 2.5) {
            trail.push({ x: st.x, y: st.y, life: 0.5 });
            if (trail.length > 26) trail.shift();
          }
        }
      }

      // free severed rope debris that has fallen out of the world
      for (const r of ropes) {
        for (let i = 0; i < r.links.length; i++) {
          const h = r.links[i]!;
          if (h >= 0 && phys.readBody(h, st2) && st2.y < -2.5) {
            phys.destroyBody(h);
            r.links[i] = -1;
          }
        }
      }

      // effect decay
      for (let i = trail.length - 1; i >= 0; i--) {
        const d = trail[i]!;
        d.life -= dt * 1.6;
        if (d.life <= 0) trail.splice(i, 1);
      }
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i]!;
        p.life -= dt * 1.5;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy -= 6 * dt;
        if (p.life <= 0) parts.splice(i, 1);
      }
      for (let i = flashes.length - 1; i >= 0; i--) {
        const f = flashes[i]!;
        f.life -= dt * 3.5;
        if (f.life <= 0) flashes.splice(i, 1);
      }
      for (let i = 0; i < bumpAnim.length; i++) bumpAnim[i] = Math.max(0, bumpAnim[i]! - dt * 3);
      shake = Math.max(0, shake - dt * 1.8);

      // goal chews audibly while the candy goes down
      if (phase === 'won') {
        const chews = Math.floor(phaseT / 0.3);
        if (chews > lastChew && chews <= 3) {
          lastChew = chews;
          ctx.audio.thud(2.5);
        }
        if (phaseT >= WIN_DELAY && !ended) {
          if (levelIdx >= LEVEL_COUNT - 1) {
            ctx.storage.set('level', 0); // wrap — a fresh run starts back at level 1
            bankRun(); // all 24 cleared: end the run, report cumulative sparks
          } else {
            levelIdx += 1; // auto-advance IN PLACE — no endRun
            ctx.storage.set('level', levelIdx); // resume here on the next start()
            buildLevel();
          }
          return;
        }
      } else if (phase === 'lost' && phaseT >= LOSE_DELAY && !ended) {
        if (failCount >= FAIL_LIMIT) bankRun(); // gave up on this level — bank stars/XP
        else buildLevel(); // reload the SAME level IN PLACE — no endRun
        return;
      }

      ctx.hud.setScore(phase === 'lost' ? totalCommitted() : liveTotal());
      updateSub();
    },

    render(): void {
      const w = ctx.width;
      const h = ctx.height;
      const colors = ctx.colors();
      const reduced = ctx.settings().reducedMotion;
      c2d.setTransform(ctx.dpr, 0, 0, ctx.dpr, 0, 0);
      c2d.clearRect(0, 0, w, h);
      const v = view();
      const s = v.s;
      const sx = (x: number): number => v.ox + x * s;
      const sy = (y: number): number => h - v.oy - y * s;
      if (shake > 0 && !reduced) c2d.translate((Math.random() - 0.5) * shake * 12, (Math.random() - 0.5) * shake * 12);

      // playfield frame — losing the candy past it fails the level
      c2d.strokeStyle = colors.surface;
      c2d.lineWidth = 2;
      c2d.globalAlpha = 0.6;
      c2d.beginPath();
      c2d.roundRect(sx(0), sy(WORLD_H), WORLD_W * s, WORLD_H * s, 10);
      c2d.stroke();
      c2d.globalAlpha = 1;

      // air jets (behind everything)
      for (const j of level.jets ?? []) drawJetField(c2d, j, colors.accent, t, reduced, s, sx, sy);

      // bumpers
      const bumperDefs = level.bumpers ?? [];
      for (let i = 0; i < bumperDefs.length; i++) {
        const bd = bumperDefs[i]!;
        drawBumper(c2d, sx(bd.x), sy(bd.y), bd.r * s, bumpAnim[i]!, colors);
      }

      // goal mouth — opens as the candy nears, chews on delivery
      {
        const gx = sx(level.goal[0]);
        const gy = sy(level.goal[1]);
        const R = GOAL_R * 1.25 * s;
        let open: number;
        if (phase === 'won') {
          open = 0.2 + 0.8 * Math.abs(Math.sin(phaseT * 9));
        } else {
          let prox = 0.15;
          if (candyAlive && phys.readBody(candy, st)) {
            prox = clamp(1 - Math.hypot(st.x - level.goal[0], st.y - level.goal[1]) / 4.5, 0.15, 1);
          }
          open = 0.25 + 0.5 * prox + (reduced ? 0 : 0.05 * Math.sin(t * 3));
        }
        drawMouth(c2d, gx, gy, R, open, colors);
        // candy being eaten
        if (phase === 'won') {
          const u = clamp(phaseT / 0.45, 0, 1);
          const px = eatX + (level.goal[0] - eatX) * u;
          const py = eatY + (level.goal[1] - eatY) * u;
          const cr = CANDY_R * s * Math.max(1 - phaseT / 0.55, 0);
          if (cr > 0.5) {
            c2d.fillStyle = colors.primary;
            c2d.beginPath();
            c2d.arc(sx(px), sy(py), cr, 0, Math.PI * 2);
            c2d.fill();
          }
        }
      }

      // sparks
      for (let i = 0; i < level.sparks.length; i++) {
        if (sparkBodies[i] === -1) continue;
        const sp = level.sparks[i]!;
        const px = sx(sp[0]);
        const py = sy(sp[1]);
        const pulse = reduced ? 1 : 1 + 0.12 * Math.sin(t * 4 + i * 2.1);
        const rr = SPARK_R * s * 0.85 * pulse;
        const rot = reduced ? 0 : t * 1.2 + i;
        c2d.fillStyle = colors.glow;
        c2d.globalAlpha = 0.22;
        starPath(c2d, px, py, rr * 1.9, rot);
        c2d.fill();
        c2d.globalAlpha = 0.95;
        starPath(c2d, px, py, rr, rot);
        c2d.fill();
        c2d.globalAlpha = 1;
      }

      // ropes — polyline through anchor → live links → candy, coloured by
      // joint stretch (white → danger red as tension rises)
      const lw = Math.max(2, LINK_R * 2 * s);
      for (const r of ropes) {
        // moving-anchor track
        const m = r.def.move;
        if (m) {
          c2d.strokeStyle = colors.surface;
          c2d.globalAlpha = 0.5;
          c2d.lineWidth = 2;
          c2d.setLineDash([3, 6]);
          c2d.beginPath();
          c2d.moveTo(sx(r.def.x - m.ax), sy(r.def.y - m.ay));
          c2d.lineTo(sx(r.def.x + m.ax), sy(r.def.y + m.ay));
          c2d.stroke();
          c2d.setLineDash([]);
          c2d.globalAlpha = 1;
        }
        const a = anchorPos(r.def, t);
        const n = r.links.length;
        // nodes: [anchor, links…, candy]
        let prevX = a.x;
        let prevY = a.y;
        let prevOk = true;
        c2d.lineCap = 'round';
        for (let i = 0; i <= n; i++) {
          let curX = 0;
          let curY = 0;
          let curOk = false;
          if (i < n) {
            const lh = r.links[i]!;
            if (lh >= 0 && phys.readBody(lh, st2)) {
              curX = st2.x;
              curY = st2.y;
              curOk = true;
            }
          } else if (candyAlive && phys.readBody(candy, st2)) {
            curX = st2.x;
            curY = st2.y;
            curOk = true;
          }
          if (prevOk && curOk) {
            const rest = r.rests[i]!;
            const dist = Math.hypot(curX - prevX, curY - prevY);
            // rigid distance joints stretch <5% under load — map that window
            const tension = clamp((dist / rest - 1 - 0.002) / 0.03, 0, 1);
            c2d.strokeStyle = 'rgba(255,255,255,0.85)';
            c2d.lineWidth = lw;
            c2d.beginPath();
            c2d.moveTo(sx(prevX), sy(prevY));
            c2d.lineTo(sx(curX), sy(curY));
            c2d.stroke();
            if (tension > 0.02) {
              c2d.strokeStyle = colors.danger;
              c2d.globalAlpha = tension;
              c2d.stroke();
              c2d.globalAlpha = 1;
            }
          }
          prevX = curX;
          prevY = curY;
          prevOk = curOk;
        }
        // anchor pin
        c2d.fillStyle = colors.accent;
        c2d.beginPath();
        c2d.arc(sx(a.x), sy(a.y), Math.max(0.12 * s, 3), 0, Math.PI * 2);
        c2d.fill();
        c2d.strokeStyle = colors.text;
        c2d.globalAlpha = 0.4;
        c2d.lineWidth = 1.5;
        c2d.beginPath();
        c2d.arc(sx(a.x), sy(a.y), Math.max(0.2 * s, 5), 0, Math.PI * 2);
        c2d.stroke();
        c2d.globalAlpha = 1;
      }

      // spark trail behind the candy
      for (const d of trail) {
        c2d.fillStyle = colors.glow;
        c2d.globalAlpha = d.life * 0.55;
        c2d.beginPath();
        c2d.arc(sx(d.x), sy(d.y), CANDY_R * s * 0.45 * d.life * 2, 0, Math.PI * 2);
        c2d.fill();
      }
      c2d.globalAlpha = 1;

      // candy
      if (candyAlive && phys.readBody(candy, st)) {
        const px = sx(st.x);
        const py = sy(st.y);
        const r = CANDY_R * s;
        drawCandy(c2d, px, py, r, st.angle, colors);
        // unreachable countdown ring
        if (restT > 0.8) {
          const frac = clamp(restT / REST_FAIL_S, 0, 1);
          c2d.strokeStyle = colors.danger;
          c2d.lineWidth = 3;
          c2d.beginPath();
          c2d.arc(px, py, r * 1.55, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
          c2d.stroke();
        }
      }

      // particles + cut flashes
      for (const p of parts) {
        c2d.fillStyle = p.glow ? colors.glow : colors.text;
        c2d.globalAlpha = clamp(p.life, 0, 1) * 0.9;
        c2d.beginPath();
        c2d.arc(sx(p.x), sy(p.y), p.glow ? 3.5 : 2.2, 0, Math.PI * 2);
        c2d.fill();
      }
      c2d.globalAlpha = 1;
      for (const f of flashes) {
        const px = sx(f.x);
        const py = sy(f.y);
        const len = (0.35 + (1 - f.life) * 0.4) * s;
        c2d.save();
        c2d.translate(px, py);
        c2d.rotate(f.angle);
        c2d.strokeStyle = '#ffffff';
        c2d.globalAlpha = f.life;
        c2d.lineWidth = 3;
        c2d.beginPath();
        c2d.moveTo(-len / 2, 0);
        c2d.lineTo(len / 2, 0);
        c2d.stroke();
        c2d.restore();
      }
      c2d.globalAlpha = 1;

      // ghosted hint gesture (level 1, until the first cut)
      if (levelIdx === 0 && cuts === 0 && t < HINT_S && phase === 'play') {
        const r0 = level.ropes[0]!;
        const mx = (r0.x + level.candy[0]) / 2;
        const my = (r0.y + level.candy[1]) / 2;
        c2d.strokeStyle = colors.text;
        c2d.globalAlpha = 0.35;
        c2d.lineWidth = 2;
        c2d.setLineDash([5, 7]);
        c2d.beginPath();
        c2d.moveTo(sx(mx - 1.4), sy(my));
        c2d.lineTo(sx(mx + 1.4), sy(my));
        c2d.stroke();
        c2d.setLineDash([]);
        if (!reduced) {
          const u = (t % 1.6) / 1.6;
          const fx = mx - 1.4 + 2.8 * u;
          c2d.globalAlpha = 0.55 * (1 - Math.abs(u - 0.5) * 0.8);
          c2d.fillStyle = colors.text;
          c2d.beginPath();
          c2d.arc(sx(fx), sy(my), 9, 0, Math.PI * 2);
          c2d.fill();
        }
        c2d.globalAlpha = 1;
      }
    },

    dispose(): void {
      detach.forEach((d) => d());
      detach.length = 0;
      phys.init(0, GRAVITY); // free the world's bodies
    },
  };
}
