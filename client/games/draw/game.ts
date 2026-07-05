// INKLINE — draw/dexterity (MECHANICS §7). Box2D v3. Brain Dots-like:
// two balls must touch; drawn strokes become rigid dynamic capsule-chain
// bodies that fall and settle. TWIST: draw speed sets stroke thickness —
// slow drag = thick heavy hammer, fast flick = thin light scaffold
// (capsule radius = thickness, fixed density ⇒ mass scales with area).
// 24 data-defined levels: grounds → gaps → see-saws → movers → wind fields.

import type { Game, GameContext } from '@sdk/types';
import type { Physics2D, PairEvent, BodyState2D, HitEvent2D } from '@sdk/physics2d';
import { BODY_STATIC, BODY_KINEMATIC, BODY_DYNAMIC, SHAPE_CONTACT_EVENTS, SHAPE_HIT_EVENTS } from '@sdk/physics2d';
import { gameMeta } from '@shared/registry';
import type { LevelDef, Saw, Mover, WindZone, InkBody } from './levels';
import { LEVELS, LEVEL_W, LEVEL_H, LEVEL_COUNT, moverPos } from './levels';
import type { Confetti } from './fx';
import { drawWindZone, drawBallFace, drawHeart } from './fx';

const GRAVITY = -10;
const BALL_R = 0.35;

// stroke sampling + the ink-weight twist
const PT_SPACING = 0.22; // min polyline point spacing (spec floor 0.15m)
const MAX_STROKE_PTS = 80;
const THICK_MAX = 0.16; // slow drag → heavy hammer
const THICK_MIN = 0.05; // fast flick → light scaffold
const SPEED_SLOW = 1.0; // m/s at/below → THICK_MAX
const SPEED_FAST = 7.0; // m/s at/above → THICK_MIN
const INK_DENSITY = 1.4; // fixed — mass scales with drawn area
const NO_DRAW_R = 0.55; // can't ink directly onto a ball

const REST_FAIL_S = 3; // ink spent + everything settled this long, no reunion = retry
const REST_SPEED = 0.09;
const INK_EMPTY = 0.3; // ink budget effectively spent (can't draw a useful stroke)
const MAX_FAILS = 3; // consecutive misses on one level before the run is banked

// user-data tags (balls MUST be 1 and 2 — solve = contactBegin between them)
const TAG_BALL_A = 1;
const TAG_BALL_B = 2;
const TAG_INK = 3;

function sum(arr: readonly number[]): number {
  let t = 0;
  for (const v of arr) t += v;
  return t;
}

export function createGame(): Game {
  const meta = gameMeta('draw')!;
  let ctx: GameContext;
  let phys: Physics2D;
  let c2d: CanvasRenderingContext2D;

  // world objects
  let ballA = -1;
  let ballB = -1;
  let staticBoxes: { x: number; y: number; hx: number; hy: number; angle: number }[] = [];
  let saws: Saw[] = [];
  let movers: Mover[] = [];
  let winds: WindZone[] = [];
  let inks: InkBody[] = [];

  // level/run state
  let levelIdx = 0;
  let level: LevelDef = LEVELS[0]!;
  let solvedArr: number[] = [];
  let underArr: number[] = [];
  let oneArr: number[] = [];
  let score = 0;
  let inkLeft = 0;
  let inkUsed = 0;
  let strokes = 0;
  let alive = false;
  let outcome: 'solved' | 'failed' | null = null;
  let pendingT = 0;
  let failStreak = 0; // consecutive misses on the CURRENT level (reset on solve/advance)
  let simT = 0;
  let restT = 0;
  let lastTickSec = -1;
  let lastThudT = -10;

  // active stroke
  let drawing = false;
  let strokePts: [number, number][] = [];
  let strokeLen = 0;
  let strokeT0 = 0;
  let penX = 0;
  let penY = 0;

  // juice
  let confetti: Confetti[] = [];
  let heart: { x: number; y: number; t: number } | null = null;
  let lastSub = '';

  const st: BodyState2D = { x: 0, y: 0, angle: 0, awake: false, vx: 0, vy: 0, w: 0 };
  const st2: BodyState2D = { x: 0, y: 0, angle: 0, awake: false, vx: 0, vy: 0, w: 0 };
  const pair: PairEvent = { slotA: 0, userA: 0, slotB: 0, userB: 0 };
  const hitEv: HitEvent2D = { x: 0, y: 0, nx: 0, ny: 0, speed: 0, slotA: 0, userA: 0, slotB: 0, userB: 0 };
  const detach: (() => void)[] = [];

  // ---- camera ----

  function scale(): number {
    return Math.min(ctx.width / (LEVEL_W + 0.7), ctx.height / (LEVEL_H + 0.7));
  }

  function sx(wx: number, s: number): number {
    return (wx - LEVEL_W / 2) * s + ctx.width / 2;
  }

  function sy(wy: number, s: number): number {
    return ctx.height / 2 - (wy - LEVEL_H / 2) * s;
  }

  function toWorld(px: number, py: number): [number, number] {
    const s = scale();
    return [(px - ctx.width / 2) / s + LEVEL_W / 2, (ctx.height / 2 - py) / s + LEVEL_H / 2];
  }

  // ---- persistence / scoring (score axis = STAR_THRESHOLDS.draw) ----

  function loadArr(key: string): number[] {
    const raw = ctx.storage.get<number[]>(key, []);
    const out: number[] = [];
    for (let i = 0; i < LEVEL_COUNT; i++) out.push(raw[i] === 1 ? 1 : 0);
    return out;
  }

  function computeScore(): number {
    // levels solved total + 0.5 per under-par-ink solve, rounded (12/24/36 axis)
    return Math.round(sum(solvedArr) + sum(underArr) * 0.5);
  }

  // ---- world build ----

  function currentThickness(): number {
    const dur = Math.max((performance.now() - strokeT0) / 1000, 0.06);
    const spd = strokeLen / dur;
    const t = Math.min(Math.max((spd - SPEED_SLOW) / (SPEED_FAST - SPEED_SLOW), 0), 1);
    return THICK_MAX + (THICK_MIN - THICK_MAX) * t;
  }

  function buildLevel(): void {
    staticBoxes = [];
    saws = [];
    movers = [];
    winds = [];
    inks = [];

    // side walls keep balls in play (visible frame rails — no invisible deaths)
    for (const wx of [-0.2, LEVEL_W + 0.2]) {
      const wall = phys.createBody({ type: BODY_STATIC, position: [wx, LEVEL_H / 2] });
      phys.addBox(wall, 0.2, LEVEL_H, { friction: 0.4, flags: SHAPE_HIT_EVENTS });
    }

    for (const b of level.boxes ?? []) {
      const angle = b[4] ?? 0;
      const h = phys.createBody({ type: BODY_STATIC, position: [b[0], b[1]], angle });
      phys.addBox(h, b[2], b[3], { friction: 0.75, flags: SHAPE_HIT_EVENTS });
      staticBoxes.push({ x: b[0], y: b[1], hx: b[2], hy: b[3], angle });
    }

    for (const sdef of level.saws ?? []) {
      const [cx, cy, halfLen] = sdef;
      const pivot = phys.createBody({ type: BODY_STATIC, position: [cx, cy] });
      const board = phys.createBody({ type: BODY_DYNAMIC, position: [cx, cy], angularDamping: 0.3 });
      phys.addBox(board, halfLen, 0.12, { density: 0.9, friction: 0.9, flags: SHAPE_HIT_EVENTS });
      phys.createRevoluteJoint(pivot, board, [cx, cy], { lower: -0.5, upper: 0.5, enableLimit: true });
      saws.push({ board, cx, cy, halfLen });
    }

    (level.movers ?? []).forEach((mdef, i) => {
      const m: Mover = { h: -1, cx: mdef[0], cy: mdef[1], hx: mdef[2], hy: mdef[3], dx: mdef[4], dy: mdef[5], period: mdef[6], phase: i * 2.1 };
      const p0 = moverPos(m, 0);
      m.h = phys.createBody({ type: BODY_KINEMATIC, position: p0 });
      phys.addBox(m.h, m.hx, m.hy, { friction: 0.9, flags: SHAPE_HIT_EVENTS });
      movers.push(m);
    });

    for (const wdef of level.wind ?? []) {
      winds.push({ cx: wdef[0], cy: wdef[1], hx: wdef[2], hy: wdef[3], fx: wdef[4], fy: wdef[5] });
    }

    const mkBall = (pos: readonly [number, number], tag: number): number => {
      const h = phys.createBody({ type: BODY_DYNAMIC, position: pos, angularDamping: 0.05 });
      phys.addCircle(h, BALL_R, { density: 1, friction: 0.6, restitution: 0.15, flags: SHAPE_CONTACT_EVENTS | SHAPE_HIT_EVENTS });
      phys.setUserData(h, tag);
      return h;
    };
    ballA = mkBall(level.a, TAG_BALL_A);
    ballB = mkBall(level.b, TAG_BALL_B);
  }

  // ---- drawing input → capsule-chain bodies ----

  function nearBall(wx: number, wy: number): boolean {
    for (const h of [ballA, ballB]) {
      if (phys.readBody(h, st) && Math.hypot(wx - st.x, wy - st.y) < NO_DRAW_R) return true;
    }
    return false;
  }

  function beginStroke(wx: number, wy: number): void {
    strokePts = [];
    strokeLen = 0;
    strokeT0 = performance.now();
    if (!nearBall(wx, wy)) strokePts.push([wx, wy]);
  }

  function addPoint(wx: number, wy: number): void {
    wx = Math.min(Math.max(wx, 0.05), LEVEL_W - 0.05);
    wy = Math.min(Math.max(wy, 0.05), LEVEL_H - 0.05);
    penX = wx;
    penY = wy;
    if (nearBall(wx, wy)) {
      finalizeStroke(null); // break the stroke at the no-draw ring
      return;
    }
    const last = strokePts.length > 0 ? strokePts[strokePts.length - 1]! : null;
    if (last === null) {
      // fresh (sub-)stroke — reset the speed clock so thickness stays honest
      strokeT0 = performance.now();
      strokePts.push([wx, wy]);
      return;
    }
    let d = Math.hypot(wx - last[0], wy - last[1]);
    if (d < PT_SPACING) return;
    if (inkLeft <= 0) {
      finalizeStroke(null);
      return;
    }
    if (d > inkLeft) {
      // clamp final segment to the remaining budget
      const f = inkLeft / d;
      wx = last[0] + (wx - last[0]) * f;
      wy = last[1] + (wy - last[1]) * f;
      d = inkLeft;
    }
    strokePts.push([wx, wy]);
    strokeLen += d;
    inkUsed += d;
    inkLeft = Math.max(0, inkLeft - d);
    restT = 0;
    if (strokePts.length % 3 === 0) {
      ctx.audio.note(460 + (strokePts.length % 18) * 14, { dur: 0.03, type: 'triangle', vol: 0.025 });
    }
    if (inkLeft <= 0) {
      finalizeStroke(null);
      ctx.hud.showCombo('INK EMPTY');
      ctx.audio.buzz(20);
    } else if (strokePts.length >= MAX_STROKE_PTS) {
      finalizeStroke([wx, wy]); // chain into a fresh stroke, pen still down
    }
  }

  /** Turn the sampled polyline into ONE dynamic body of capsules at its centroid. */
  function finalizeStroke(chain: readonly [number, number] | null): void {
    if (strokePts.length >= 2) {
      const dur = Math.max((performance.now() - strokeT0) / 1000, 0.06);
      const spd = strokeLen / dur;
      const t = Math.min(Math.max((spd - SPEED_SLOW) / (SPEED_FAST - SPEED_SLOW), 0), 1);
      const r = THICK_MAX + (THICK_MIN - THICK_MAX) * t;

      let cx = 0;
      let cy = 0;
      for (const p of strokePts) {
        cx += p[0];
        cy += p[1];
      }
      cx /= strokePts.length;
      cy /= strokePts.length;

      const h = phys.createBody({ type: BODY_DYNAMIC, position: [cx, cy], angularDamping: 0.05 });
      const local: [number, number][] = strokePts.map((p) => [p[0] - cx, p[1] - cy]);
      for (let i = 1; i < local.length; i++) {
        const p1 = local[i - 1]!;
        const p2 = local[i]!;
        phys.addCapsule(h, p1, p2, r, { density: INK_DENSITY, friction: 0.85, restitution: 0.02, flags: SHAPE_HIT_EVENTS });
      }
      phys.setUserData(h, TAG_INK);
      inks.push({ h, pts: local, r, age: 0 });
      strokes += 1;
      restT = 0;
      ctx.audio.pop(Math.min(strokes, 8));
      ctx.audio.buzz(8);
    }
    strokePts = [];
    strokeLen = 0;
    if (chain) {
      strokeT0 = performance.now();
      strokePts.push([chain[0], chain[1]]);
    }
  }

  // ---- run outcomes ----

  function solve(): void {
    if (!alive) return;
    alive = false;
    outcome = 'solved';
    pendingT = 1.4; // hold on the reunion, then auto-advance in-place
    failStreak = 0; // a solve clears the miss streak for this level

    const ha = phys.readBody(ballA, st);
    const hb = phys.readBody(ballB, st2);
    const mx = ha && hb ? (st.x + st2.x) / 2 : LEVEL_W / 2;
    const my = ha && hb ? (st.y + st2.y) / 2 : LEVEL_H / 2;
    heart = { x: mx, y: my + 0.6, t: 0 };
    const n = ctx.settings().reducedMotion ? 18 : 40;
    for (let i = 0; i < n; i++) {
      const a = ctx.rng.range(0, Math.PI * 2);
      const v = ctx.rng.range(2, 6.5);
      confetti.push({ x: mx, y: my, vx: Math.cos(a) * v, vy: Math.abs(Math.sin(a)) * v + 1.5, spin: ctx.rng.range(-9, 9), life: 1, ci: ctx.rng.int(0, 3) });
    }

    const under = inkUsed <= level.par;
    const one = strokes === 1;
    solvedArr[levelIdx] = 1;
    if (under) underArr[levelIdx] = 1;
    if (one) oneArr[levelIdx] = 1;
    ctx.storage.set('solved', solvedArr);
    ctx.storage.set('under', underArr);
    ctx.storage.set('one', oneArr);
    ctx.storage.set('level', (levelIdx + 1) % LEVEL_COUNT);

    score = computeScore();
    ctx.hud.setScore(score);
    ctx.hud.flash('LEVEL CLEAR', 1200);
    ctx.hud.showCombo(one ? 'ONE STROKE!' : under ? 'UNDER PAR!' : 'SOLVED', one || under);
    ctx.audio.fanfare();
    ctx.audio.chime(6);
    ctx.audio.pop(10);
    ctx.audio.buzz(30);
  }

  function fail(reason: string): void {
    if (!alive) return;
    alive = false;
    outcome = 'failed';
    pendingT = 1.0;
    ctx.hud.flash(reason, 900);
    ctx.audio.womp();
    ctx.audio.buzz(40);
  }

  function finishRun(): void {
    ctx.endRun({
      score,
      durationMs: 0,
      seed: 0,
      stats: {
        oneStrokeSolves: sum(oneArr), // 'Minimalist' badge
        levelsSolved: sum(solvedArr),
        underParSolves: sum(underArr),
        allClear: sum(solvedArr) >= LEVEL_COUNT ? 1 : 0,
        level: levelIdx + 1,
        solved: outcome === 'solved' ? 1 : 0,
        strokes,
        inkUsed: Math.round(inkUsed * 10) / 10,
      },
    });
  }

  /** (Re)build the current level in-place — fresh world, ink refilled, run alive. */
  function loadLevel(): void {
    phys.init(0, GRAVITY); // frees every body from the previous level
    phys.setHitEventThreshold(1.2);
    level = LEVELS[levelIdx]!;

    inkLeft = level.ink;
    inkUsed = 0;
    strokes = 0;
    simT = 0;
    restT = 0;
    pendingT = 0;
    lastTickSec = -1;
    lastThudT = -10;
    outcome = null;
    drawing = false;
    strokePts = [];
    strokeLen = 0;
    lastSub = '';

    buildLevel(); // resets saws/movers/winds/inks and spawns the two balls
    alive = true;
    ctx.storage.set('level', levelIdx);
    updateSub();
  }

  /** After a solve: bank the run once every level is cleared, else move on. */
  function advanceLevel(): void {
    if (sum(solvedArr) >= LEVEL_COUNT) {
      finishRun(); // all 24 solved — report cumulative score
      return;
    }
    let next = levelIdx;
    for (let step = 1; step <= LEVEL_COUNT; step++) {
      const cand = (levelIdx + step) % LEVEL_COUNT;
      if (solvedArr[cand] !== 1) {
        next = cand;
        break;
      }
    }
    levelIdx = next;
    loadLevel();
  }

  /** After a miss: retry the same level, or bank the run after 3 in a row. */
  function retryLevel(): void {
    failStreak += 1;
    if (failStreak >= MAX_FAILS) {
      finishRun(); // banks stars/XP earned so far
      return;
    }
    loadLevel();
  }

  // ---- per-step systems ----

  function handleEvents(): void {
    for (let i = 0; i < phys.contactBeginCount(); i++) {
      phys.readContactBegin(i, pair);
      const ab = pair.userA === TAG_BALL_A && pair.userB === TAG_BALL_B;
      const ba = pair.userA === TAG_BALL_B && pair.userB === TAG_BALL_A;
      if (ab || ba) solve();
    }
    for (let i = 0; i < phys.hitCount(); i++) {
      phys.readHit(i, hitEv);
      if (simT - lastThudT > 0.09 && hitEv.speed > 1.4) {
        ctx.audio.thud(Math.min(hitEv.speed * 0.45, 6));
        lastThudT = simT;
      }
    }
  }

  const windBodies: number[] = []; // reused per step — no per-tick allocation

  function applyWind(): void {
    if (winds.length === 0) return;
    windBodies.length = 0;
    windBodies.push(ballA, ballB);
    for (const ink of inks) windBodies.push(ink.h);
    for (const z of winds) {
      for (const h of windBodies) {
        if (!phys.readBody(h, st)) continue;
        if (Math.abs(st.x - z.cx) < z.hx && Math.abs(st.y - z.cy) < z.hy) {
          phys.applyForce(h, z.fx, z.fy);
        }
      }
    }
  }

  /** True if the body is meaningfully moving (rest detection). */
  function isMoving(h: number, wLimit: number): boolean {
    return phys.readBody(h, st) && (Math.hypot(st.vx, st.vy) > REST_SPEED || Math.abs(st.w) > wLimit);
  }

  function checkFail(dt: number): void {
    // a ball that leaves the world (pits below, generous margins elsewhere) retries at once
    for (const h of [ballA, ballB]) {
      if (phys.readBody(h, st) && (st.y < -1.2 || st.x < -1.5 || st.x > LEVEL_W + 1.5 || st.y > LEVEL_H + 6)) {
        fail('BALL LOST — RETRY');
        return;
      }
    }
    // The puzzle waits indefinitely while the player can still act: with ink left
    // in the pen (or a stroke in progress) the rest-timer stays parked — no fail.
    // This is what makes "stare 30s, then draw" safe.
    if (inkLeft > INK_EMPTY || drawing) {
      restT = 0;
      lastTickSec = -1;
      return;
    }
    // Ink is spent. ONLY now does the settle clock run — fail if nothing reunites.
    let moving = isMoving(ballA, 0.2) || isMoving(ballB, 0.2);
    if (!moving) for (const ink of inks) if (isMoving(ink.h, 0.25)) { moving = true; break; }
    if (!moving) for (const s of saws) if (isMoving(s.board, 0.2)) { moving = true; break; }
    if (moving) {
      restT = 0;
      lastTickSec = -1;
      return;
    }
    restT += dt;
    const sec = Math.floor(restT);
    if (restT > 1 && sec !== lastTickSec) {
      lastTickSec = sec;
      ctx.audio.tick();
    }
    if (restT >= REST_FAIL_S) fail('INK OUT — RETRY');
  }

  function updateSub(): void {
    let text: string;
    if (simT < 5 && strokes === 0) {
      text = levelIdx === 0 ? 'draw ink to unite the dots' : 'slow ink = heavy · fast flick = light';
    } else {
      const cells = Math.max(0, Math.min(12, Math.round((inkLeft / level.ink) * 12)));
      text = `L${levelIdx + 1}/${LEVEL_COUNT} · ${'▰'.repeat(cells)}${'▱'.repeat(12 - cells)} ${inkLeft.toFixed(1)}m`;
    }
    if (text !== lastSub) {
      lastSub = text;
      ctx.hud.setSub(text);
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

      detach.push(
        ctx.input.onDown((x, y) => {
          if (!alive) return;
          drawing = true;
          const [wx, wy] = toWorld(x, y);
          penX = wx;
          penY = wy;
          beginStroke(wx, wy);
        }),
        ctx.input.onDrag((e) => {
          if (!drawing || !alive) return;
          const [wx, wy] = toWorld(e.x, e.y);
          addPoint(wx, wy);
        }),
        ctx.input.onRelease(() => {
          if (!drawing) return;
          drawing = false;
          if (alive) finalizeStroke(null);
          else strokePts = []; // run ended mid-stroke — drop the wet ink
        }),
      );

      if (import.meta.env.DEV) {
        (window as unknown as Record<string, unknown>)['__drawDbg'] = {
          state: () => ({ levelIdx, alive, score, strokes, inkLeft, inkUsed, restT, inks: inks.length, outcome, failStreak }),
        };
      }
    },

    start(): void {
      solvedArr = loadArr('solved');
      underArr = loadArr('under');
      oneArr = loadArr('one');
      const savedLevel = ctx.storage.get<number>('level', 0);
      levelIdx = Number.isInteger(savedLevel) ? Math.min(Math.max(savedLevel, 0), LEVEL_COUNT - 1) : 0;
      // resume on the first unsolved level if the saved one is already cleared
      if (solvedArr[levelIdx] === 1 && sum(solvedArr) < LEVEL_COUNT) {
        for (let i = 0; i < LEVEL_COUNT; i++) if (solvedArr[i] !== 1) { levelIdx = i; break; }
      }

      failStreak = 0;
      confetti = [];
      heart = null;
      score = computeScore();
      ctx.hud.setScore(score);

      loadLevel(); // builds the world in-place and sets alive
    },

    step(dt: number): void {
      if (!alive && pendingT <= 0) return;
      simT += dt;

      for (const m of movers) {
        const [mx, my] = moverPos(m, simT);
        phys.setTargetTransform(m.h, mx, my, 0, dt);
      }
      applyWind();
      phys.step(dt, 4);

      if (alive) {
        handleEvents();
        checkFail(dt);
        updateSub();
      }

      if (pendingT > 0) {
        pendingT -= dt;
        if (pendingT <= 0) {
          // in-place transition — a run only ends inside advance/retry (all-clear or 3 misses)
          if (outcome === 'solved') advanceLevel();
          else retryLevel();
          return;
        }
      }

      // cull ink that fell into pits (bodies stay < 300)
      for (let i = inks.length - 1; i >= 0; i--) {
        const ink = inks[i]!;
        ink.age += dt;
        if (phys.readBody(ink.h, st) && st.y < -2) {
          phys.destroyBody(ink.h);
          inks.splice(i, 1);
        }
      }

      for (let i = confetti.length - 1; i >= 0; i--) {
        const p = confetti[i]!;
        p.life -= dt * 0.8;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy -= 7 * dt;
        if (p.life <= 0) confetti.splice(i, 1);
      }
      if (heart) {
        heart.t += dt;
        heart.y += dt * 0.8;
        if (heart.t > 1.3) heart = null;
      }
    },

    render(): void {
      const w = ctx.width;
      const h = ctx.height;
      const colors = ctx.colors();
      const s = scale();
      c2d.setTransform(ctx.dpr, 0, 0, ctx.dpr, 0, 0);
      c2d.clearRect(0, 0, w, h);
      c2d.fillStyle = colors.bg;
      c2d.fillRect(0, 0, w, h);

      const X = (wx: number): number => sx(wx, s);
      const Y = (wy: number): number => sy(wy, s);

      // level frame (the physical side rails are the vertical edges)
      c2d.strokeStyle = colors.surface;
      c2d.lineWidth = Math.max(3, s * 0.1);
      c2d.globalAlpha = 0.9;
      c2d.beginPath();
      c2d.roundRect(X(0), Y(LEVEL_H), LEVEL_W * s, LEVEL_H * s, 8);
      c2d.stroke();
      c2d.globalAlpha = 1;

      // wind zones (behind geometry): tinted field + streaks along the force
      for (let zi = 0; zi < winds.length; zi++) {
        drawWindZone(c2d, winds[zi]!, zi, simT, s, X, Y, colors.glow);
      }

      // static geometry
      c2d.lineWidth = 2;
      for (const b of staticBoxes) {
        c2d.save();
        c2d.translate(X(b.x), Y(b.y));
        c2d.rotate(-b.angle);
        c2d.fillStyle = colors.surface;
        c2d.strokeStyle = colors.accent;
        c2d.beginPath();
        c2d.roundRect(-b.hx * s, -b.hy * s, b.hx * 2 * s, b.hy * 2 * s, 5);
        c2d.fill();
        c2d.stroke();
        c2d.restore();
      }

      // movers — kinematic platforms with a glow edge
      for (const m of movers) {
        if (!phys.readBody(m.h, st)) continue;
        c2d.save();
        c2d.translate(X(st.x), Y(st.y));
        c2d.fillStyle = colors.surface;
        c2d.strokeStyle = colors.glow;
        c2d.beginPath();
        c2d.roundRect(-m.hx * s, -m.hy * s, m.hx * 2 * s, m.hy * 2 * s, 5);
        c2d.fill();
        c2d.stroke();
        c2d.strokeStyle = colors.glow;
        c2d.globalAlpha = 0.5;
        c2d.beginPath();
        c2d.moveTo(-m.hx * s * 0.6, 0);
        c2d.lineTo(m.hx * s * 0.6, 0);
        c2d.stroke();
        c2d.globalAlpha = 1;
        c2d.restore();
      }

      // see-saws — pivot wedge + live board
      for (const sw of saws) {
        c2d.fillStyle = colors.accent;
        c2d.beginPath();
        c2d.moveTo(X(sw.cx), Y(sw.cy));
        c2d.lineTo(X(sw.cx - 0.28), Y(sw.cy - 0.62));
        c2d.lineTo(X(sw.cx + 0.28), Y(sw.cy - 0.62));
        c2d.closePath();
        c2d.fill();
        if (phys.readBody(sw.board, st)) {
          c2d.save();
          c2d.translate(X(st.x), Y(st.y));
          c2d.rotate(-st.angle);
          c2d.fillStyle = colors.surface;
          c2d.strokeStyle = colors.primary;
          c2d.beginPath();
          c2d.roundRect(-sw.halfLen * s, -0.12 * s, sw.halfLen * 2 * s, 0.24 * s, 4);
          c2d.fill();
          c2d.stroke();
          c2d.restore();
        }
      }

      // ink bodies — wet sheen (glow) dries into plain ink over ~0.5s
      c2d.lineCap = 'round';
      c2d.lineJoin = 'round';
      for (const ink of inks) {
        if (!phys.readBody(ink.h, st)) continue;
        c2d.save();
        c2d.translate(X(st.x), Y(st.y));
        c2d.rotate(-st.angle);
        c2d.beginPath();
        const first = ink.pts[0]!;
        c2d.moveTo(first[0] * s, -first[1] * s);
        for (let i = 1; i < ink.pts.length; i++) {
          const p = ink.pts[i]!;
          c2d.lineTo(p[0] * s, -p[1] * s);
        }
        c2d.lineWidth = ink.r * 2 * s;
        c2d.strokeStyle = colors.text;
        c2d.stroke();
        if (ink.age < 0.5) {
          c2d.strokeStyle = colors.glow;
          c2d.globalAlpha = (1 - ink.age / 0.5) * 0.85;
          c2d.stroke();
          c2d.globalAlpha = 1;
        }
        c2d.restore();
      }

      // balls — they blink toward each other
      const hasA = phys.readBody(ballA, st);
      const hasB = phys.readBody(ballB, st2);
      const face = (bs: BodyState2D, other: BodyState2D, fill: string, blinkOff: number): void => {
        const gx = other.x - bs.x;
        const gy = other.y - bs.y;
        const gm = Math.hypot(gx, gy) || 1;
        const closed = (simT + blinkOff) % 3.4 < 0.14;
        drawBallFace(c2d, X(bs.x), Y(bs.y), BALL_R * s, gx / gm, gy / gm, closed, fill, colors.bg, colors.text);
      };
      if (hasA && hasB) {
        face(st, st2, colors.primary, 0);
        face(st2, st, colors.danger, 1.6);
      }

      // no-draw rings while the pen is down
      if (drawing && hasA && hasB) {
        c2d.strokeStyle = colors.danger;
        c2d.globalAlpha = 0.25;
        c2d.setLineDash([5, 5]);
        c2d.lineWidth = 1.5;
        for (const bs of [st, st2]) {
          c2d.beginPath();
          c2d.arc(X(bs.x), Y(bs.y), NO_DRAW_R * s, 0, Math.PI * 2);
          c2d.stroke();
        }
        c2d.setLineDash([]);
        c2d.globalAlpha = 1;
      }

      // live stroke — wet ink with a bright core, width = live thickness
      if (drawing && strokePts.length > 0) {
        const th = currentThickness();
        c2d.beginPath();
        const p0 = strokePts[0]!;
        c2d.moveTo(X(p0[0]), Y(p0[1]));
        for (let i = 1; i < strokePts.length; i++) {
          const p = strokePts[i]!;
          c2d.lineTo(X(p[0]), Y(p[1]));
        }
        c2d.lineTo(X(penX), Y(penY));
        c2d.strokeStyle = colors.glow;
        c2d.lineWidth = th * 2 * s;
        c2d.globalAlpha = 0.95;
        c2d.stroke();
        c2d.strokeStyle = colors.text;
        c2d.lineWidth = Math.max(1, th * 0.7 * s);
        c2d.globalAlpha = 0.4;
        c2d.stroke();
        c2d.globalAlpha = 1;
        // pen nib shows the current weight
        c2d.fillStyle = colors.glow;
        c2d.beginPath();
        c2d.arc(X(penX), Y(penY), Math.max(2, th * s), 0, Math.PI * 2);
        c2d.fill();
      }

      // confetti + reunion heart
      for (const p of confetti) {
        const cc = [colors.primary, colors.accent, colors.glow, colors.danger][p.ci]!;
        c2d.save();
        c2d.translate(X(p.x), Y(p.y));
        c2d.rotate(p.spin * (1 - p.life));
        c2d.globalAlpha = Math.max(0, p.life);
        c2d.fillStyle = cc;
        c2d.fillRect(-3, -2, 6, 4);
        c2d.restore();
      }
      c2d.globalAlpha = 1;
      if (heart) {
        const a = heart.t < 0.9 ? 1 : 1 - (heart.t - 0.9) / 0.4;
        drawHeart(c2d, X(heart.x), Y(heart.y), (0.5 + Math.min(heart.t * 1.6, 0.4)) * s, colors.danger, Math.max(0, a));
      }

      // out-of-ink retry countdown — only after the pen runs dry, so it's never a surprise
      if (alive && restT > 1) {
        const remain = Math.max(0, REST_FAIL_S - restT);
        c2d.fillStyle = colors.text;
        c2d.globalAlpha = 0.8;
        c2d.font = `600 ${Math.max(13, Math.round(s * 0.42))}px system-ui`;
        c2d.textAlign = 'center';
        c2d.fillText(`out of ink — retry in ${remain.toFixed(1)}`, w / 2, Y(LEVEL_H) + s * 0.9);
        c2d.globalAlpha = 1;
      }
    },

    dispose(): void {
      for (const d of detach) d();
      detach.length = 0;
      phys.init(0, GRAVITY); // free the world's bodies
    },
  };
}
