// PEGWORKS — idle plinko (MECHANICS §8). Box2D v3.
// Pooled dynamic balls fall through a jittered pegfield into multiplier bins;
// earnings buy upgrades (×1.15 cost curve); prestige evolves the layout
// (revolute motor spinners from P1, a lateral-force magnet zone from P2) and
// mints a permanent ×2 token each time. Offline accrual is simulated honestly:
// a 10s ×20 fast-forward montage with the counter rolling up — no dialog.
// The canvas IS the UI: shop buttons are drawn + hit-tested on the canvas.

import type { Game, GameContext, Palette } from '@sdk/types';
import type { Physics2D, PairEvent, BodyState2D } from '@sdk/physics2d';
import { BODY_STATIC, SHAPE_SENSOR, SHAPE_CONTACT_EVENTS, slotOf } from '@sdk/physics2d';
import { Rng } from '@sdk/rng';
import { gameMeta } from '@shared/registry';

// world is VIEW_W × VIEW_H meters, origin bottom-left
const VIEW_W = 10;
const VIEW_H = 13;
const GRAVITY = -14;
const BALL_R = 0.13;
const PEG_R = 0.09;
const DROP_Y = 12.35; // spawn height
const DROP_LINE_Y = 11; // dashed hint line
const TAP_ZONE_MIN_Y = 2.2; // world-y above which a tap = manual drop
const KILL_Y = 0.1;
const MAX_POOL = 300; // throughput target (MECHANICS §8)
const BIN_MULTS = [8, 4, 2, 1, 0.5, 1, 2, 4, 8] as const;
const BIN_W = (VIEW_W - 0.4) / BIN_MULTS.length;
const PEG_ROWS = 9;
const PEG_COLS = 9;
const COST_CURVE = 1.15;
const PRESTIGE_BASE = 1_000_000; // ×10 per prestige → 1M, 10M, 100M (★3 = 3rd)
const OFFLINE_CAP_S = 8 * 3600;
const MONTAGE_S = 10;
const MONTAGE_SPEED = 20;
const GOLD = '#ffc93a'; // deliberate material color for golden balls
const PENTA = [392, 440, 494, 587, 659, 740, 880, 988, 1175] as const;

// body user-data: tag * 65536 + index (exact in f32 event buffers)
const TAG_BALL = 1;
const TAG_PEG = 2;
const TAG_BIN = 3;
const TAG_SPIN = 4;
const ud = (tag: number, idx: number): number => tag * 65536 + idx;
const udTag = (u: number): number => Math.floor(u / 65536);
const udIdx = (u: number): number => u % 65536;

interface Levels {
  rate: number;
  value: number;
  balls: number;
  gold: number;
  peg: number;
  bins: number;
}

interface SaveData {
  cash: number;
  lifetime: number;
  prestiges: number;
  levels: Levels;
  layoutSeed: number;
  lastSeen: number;
  avgPayout: number;
  ballsDropped: number;
  manualDrops: number;
  goldenBalls: number;
}

interface Ball {
  handle: number;
  active: boolean;
  golden: boolean;
  manual: boolean;
  hits: number;
  still: number;
}

interface Peg {
  x: number;
  y: number;
  lit: number;
  row: number;
}

interface Bin {
  x: number;
  mult: number;
  flash: number;
}

interface Spinner {
  bar: number;
  x: number;
  y: number;
  len: number;
}

interface MagnetZone {
  cx: number;
  y0: number;
  y1: number;
  halfW: number;
}

interface FloatText {
  x: number;
  y: number;
  vy: number;
  life: number;
  text: string;
  gold: boolean;
}

type BtnId = keyof Levels | 'bank' | 'prestige';

interface Btn {
  x: number;
  y: number;
  w: number;
  h: number;
  id: BtnId;
}

const UPG_ORDER: ReadonlyArray<keyof Levels> = ['rate', 'value', 'balls', 'gold', 'peg', 'bins'];
const UPG_LABEL: Record<keyof Levels, string> = { rate: 'AUTO', value: 'VALUE', balls: 'BALLS', gold: 'GOLD', peg: 'PEGS', bins: 'BINS' };
const UPG_BASE: Record<keyof Levels, number> = { rate: 25, value: 15, balls: 40, gold: 120, peg: 80, bins: 60 };

function fmt(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  if (a >= 100 || n % 1 === 0) return String(Math.floor(n));
  return n.toFixed(1);
}

function multLabel(m: number): string {
  const v = Math.round(m * 10) / 10;
  return `×${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}`;
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  c.roundRect(x, y, w, h, r);
}

export function createGame(): Game {
  const meta = gameMeta('plinko')!;
  let ctx: GameContext;
  let phys: Physics2D;
  let c2d: CanvasRenderingContext2D;

  // ---- persisted economy (everything via ctx.storage) ----
  let cash = 0;
  let lifetime = 0; // the score axis: lifetime earnings
  let prestiges = 0;
  let levels: Levels = { rate: 0, value: 0, balls: 0, gold: 0, peg: 0, bins: 0 };
  let layoutSeed = 1;
  let lastSeen = 0;
  let avgPayout = 0; // EMA of auto-equivalent payout, drives offline estimate
  let ballsDropped = 0;
  let manualDrops = 0;
  let goldenBalls = 0;
  let loaded = false;
  let dirty = false;

  // ---- session/world state ----
  let pool: Ball[] = [];
  let pegs: Peg[] = [];
  let bins: Bin[] = [];
  let spinners: Spinner[] = [];
  let magnet: MagnetZone | null = null;
  let floats: FloatText[] = [];
  let buttons: Btn[] = [];
  let activeCount = 0;
  let dropAcc = 0;
  let t = 0;
  let ended = false;
  let sessionDrops = 0;
  let montageT = 0;
  let offlinePool = 0;
  let offlineCredited = 0;
  let dispCash = 0;
  let dispLife = 0;
  let comboT = 0;
  let saveT = 0;
  let humT = 0;
  let pegSoundCd = 0;
  let binSoundCd = 0;
  let lastSub = '';

  // ---- layout (canvas IS the UI) ----
  let vs = 1; // world→screen scale
  let ox = 0;
  let oy = 0;
  let uiTop = 0;

  const st: BodyState2D = { x: 0, y: 0, angle: 0, awake: false, vx: 0, vy: 0, w: 0 };
  const pair: PairEvent = { slotA: 0, userA: 0, slotB: 0, userB: 0 };
  const detachFns: (() => void)[] = [];

  // ---- derived economy ----
  const autoRate = (): number => levels.rate * 0.4; // balls/s
  const baseValue = (): number => 1 + levels.value;
  const maxBalls = (): number => Math.min(40 + levels.balls * 15, MAX_POOL);
  const goldChance = (): number => Math.min(levels.gold * 0.01, 0.5);
  const pegBonus = (): number => 0.05 * levels.peg; // per peg hit
  const binBoost = (): number => 1 + 0.1 * levels.bins;
  const prestigeMult = (): number => Math.pow(2, prestiges);
  const prestigeAt = (): number => PRESTIGE_BASE * Math.pow(10, prestiges);
  const totalLevels = (): number => levels.rate + levels.value + levels.balls + levels.gold + levels.peg + levels.bins;
  const costOf = (id: keyof Levels): number => Math.ceil(UPG_BASE[id] * Math.pow(COST_CURVE, levels[id]));
  const isMaxed = (id: keyof Levels): boolean =>
    (id === 'balls' && maxBalls() >= MAX_POOL) || (id === 'gold' && goldChance() >= 0.5 - 1e-9);

  function statsPayload(): Record<string, number> {
    return { prestiges, ballsDropped, manualDrops, goldenBalls };
  }

  // ---- persistence ----
  function loadSave(): void {
    const s = ctx.storage.get<Partial<SaveData> | null>('save', null);
    cash = s?.cash ?? 0;
    lifetime = s?.lifetime ?? 0;
    prestiges = s?.prestiges ?? 0;
    const lv = s?.levels;
    levels = { rate: lv?.rate ?? 0, value: lv?.value ?? 0, balls: lv?.balls ?? 0, gold: lv?.gold ?? 0, peg: lv?.peg ?? 0, bins: lv?.bins ?? 0 };
    layoutSeed = s?.layoutSeed ?? (ctx.rng.next() >>> 0);
    lastSeen = s?.lastSeen ?? Date.now();
    avgPayout = s?.avgPayout ?? 0;
    ballsDropped = s?.ballsDropped ?? 0;
    manualDrops = s?.manualDrops ?? 0;
    goldenBalls = s?.goldenBalls ?? 0;
    loaded = true;
  }

  function saveNow(): void {
    const data: SaveData = { cash, lifetime, prestiges, levels, layoutSeed, lastSeen: Date.now(), avgPayout, ballsDropped, manualDrops, goldenBalls };
    ctx.storage.set('save', data);
    dirty = false;
  }

  // ---- world build (layout persists across sessions via layoutSeed) ----
  function buildWorld(): void {
    phys.init(0, GRAVITY);
    pool = [];
    pegs = [];
    bins = [];
    spinners = [];
    magnet = null;
    activeCount = 0;
    dropAcc = 0;
    const lr = new Rng(layoutSeed); // SDK PCG32, dedicated stream so the layout survives reloads

    const wall = (x: number, y: number, hx: number, hy: number): void => {
      const h = phys.createBody({ type: BODY_STATIC, position: [x, y] });
      phys.addBox(h, hx, hy, { friction: 0.2, restitution: 0.2 });
    };
    wall(0, VIEW_H / 2, 0.2, VIEW_H / 2 + 1); // left, inner face x=0.2
    wall(VIEW_W, VIEW_H / 2, 0.2, VIEW_H / 2 + 1); // right, inner face x=9.8
    wall(VIEW_W / 2, 0.2, VIEW_W / 2, 0.2); // floor, top y=0.4

    // bins: sensors between dividers, multiplier in user-data index
    BIN_MULTS.forEach((mult, i) => {
      const cx = 0.2 + BIN_W * (i + 0.5);
      const sensor = phys.createBody({ type: BODY_STATIC, position: [cx, 0.85] });
      phys.addBox(sensor, BIN_W / 2 - 0.02, 0.32, { flags: SHAPE_SENSOR });
      phys.setUserData(sensor, ud(TAG_BIN, i));
      bins.push({ x: cx, mult, flash: 0 });
      if (i > 0) {
        const d = phys.createBody({ type: BODY_STATIC, position: [0.2 + BIN_W * i, 1.05] });
        phys.addBox(d, 0.045, 0.65, { friction: 0.1, restitution: 0.3 });
      }
    });

    // prestige element 1+: revolute motor spinners
    const spinCount = Math.min(prestiges, 3);
    for (let i = 0; i < spinCount; i++) {
      let sx0 = 0;
      let sy0 = 0;
      for (let attempt = 0; attempt < 10; attempt++) {
        sx0 = lr.range(2.2, VIEW_W - 2.2);
        sy0 = lr.range(4.6, 9.2);
        let ok = true;
        for (const sp of spinners) if (Math.hypot(sx0 - sp.x, sy0 - sp.y) < 2.6) ok = false;
        if (ok) break;
      }
      const anchor = phys.createBody({ type: BODY_STATIC, position: [sx0, sy0] });
      const bar = phys.createBody({ position: [sx0, sy0], angularDamping: 0.2 });
      phys.addBox(bar, 0.8, 0.07, { density: 2, friction: 0.2, restitution: 0.5, flags: SHAPE_CONTACT_EVENTS });
      phys.setUserData(bar, ud(TAG_SPIN, i));
      phys.createRevoluteJoint(anchor, bar, [sx0, sy0], {
        enableMotor: true,
        motorSpeed: (i % 2 === 0 ? 1 : -1) * lr.range(1.6, 2.6),
        maxMotorTorque: 80,
      });
      spinners.push({ bar, x: sx0, y: sy0, len: 0.8 });
    }

    // prestige element 2+: magnet zone (per-step lateral force toward its center)
    if (prestiges >= 2) {
      magnet = { cx: lr.range(3, VIEW_W - 3), y0: 3.6, y1: 5.4, halfW: 1.8 };
    }

    // pegfield: staggered grid with rng jitter; evolves each prestige
    const jit = 0.12 + 0.05 * Math.min(prestiges, 4);
    const skipChance = prestiges > 0 ? 0.07 : 0;
    const dy = (10.1 - 2.9) / (PEG_ROWS - 1);
    const dx = (VIEW_W - 1.5) / (PEG_COLS - 1);
    for (let r = 0; r < PEG_ROWS; r++) {
      const rowY = 2.9 + r * dy;
      const offset = r % 2 === 1 ? dx / 2 : 0;
      for (let c = 0; c < PEG_COLS; c++) {
        if (r % 2 === 1 && c === PEG_COLS - 1) continue;
        const x = 0.75 + c * dx + offset + lr.range(-jit, jit);
        const y = rowY + lr.range(-jit * 0.6, jit * 0.6);
        if (x < 0.45 || x > VIEW_W - 0.45) continue;
        if (lr.chance(skipChance)) continue;
        let blocked = false;
        for (const sp of spinners) {
          if ((x - sp.x) * (x - sp.x) + (y - sp.y) * (y - sp.y) < 1.3 * 1.3) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;
        const idx = pegs.length;
        const h = phys.createBody({ type: BODY_STATIC, position: [x, y] });
        phys.addCircle(h, PEG_R, { friction: 0.1, restitution: 0.55, flags: SHAPE_CONTACT_EVENTS });
        phys.setUserData(h, ud(TAG_PEG, idx));
        pegs.push({ x, y, lit: 0, row: r });
      }
    }
  }

  // ---- ball pool (recycle via setEnabled; spawn placement = streaming) ----
  function spawnBall(x: number, manual: boolean): boolean {
    const cx = Math.min(Math.max(x, 0.4), VIEW_W - 0.4);
    let b: Ball | undefined;
    for (const p of pool) {
      if (!p.active) {
        b = p;
        break;
      }
    }
    if (!b) {
      if (pool.length >= maxBalls()) return false;
      const idx = pool.length;
      const h = phys.createBody({ position: [cx, DROP_Y], linearDamping: 0.04, angularDamping: 0.1 });
      phys.addCircle(h, BALL_R, { density: 1, friction: 0.08, restitution: 0.42, flags: SHAPE_CONTACT_EVENTS });
      phys.setUserData(h, ud(TAG_BALL, idx));
      b = { handle: h, active: false, golden: false, manual: false, hits: 0, still: 0 };
      pool.push(b);
    } else {
      phys.setTransform(b.handle, cx, DROP_Y, 0);
      phys.setEnabled(b.handle, true);
    }
    phys.setLinearVelocity(b.handle, ctx.rng.range(-0.4, 0.4), -0.5);
    phys.setAngularVelocity(b.handle, ctx.rng.range(-3, 3));
    phys.setAwake(b.handle, true);
    b.active = true;
    b.golden = ctx.rng.chance(goldChance());
    b.manual = manual;
    b.hits = 0;
    b.still = 0;
    ballsDropped += 1;
    if (b.golden) goldenBalls += 1;
    if (manual) {
      manualDrops += 1;
      sessionDrops += 1;
    }
    dirty = true;
    return true;
  }

  function recycleBall(b: Ball): void {
    if (!b.active) return;
    b.active = false;
    phys.setEnabled(b.handle, false);
  }

  function pushFloat(x: number, y: number, text: string, gold: boolean): void {
    if (montageT > 0 && !gold) return; // avoid float spam at ×20
    if (floats.length >= 28) floats.shift();
    floats.push({ x, y, vy: 1.6, life: 1, text, gold });
  }

  function settleBall(b: Ball, binIdx: number): void {
    const bin = bins[binIdx];
    if (!bin || !b.active) return;
    const autoValue = baseValue() * bin.mult * binBoost() * (1 + pegBonus() * b.hits) * prestigeMult() * (b.golden ? 10 : 1);
    const v = autoValue * (b.manual ? 1.5 : 1);
    cash += v;
    lifetime += v;
    dirty = true;
    avgPayout = avgPayout <= 0 ? autoValue : avgPayout * 0.97 + autoValue * 0.03;
    bin.flash = 1;
    pushFloat(bin.x, 2.1, `+${fmt(v)}`, b.golden);
    if (binSoundCd <= 0) {
      ctx.audio.pop(Math.min(8, Math.floor(Math.log10(Math.max(1, v)))));
      binSoundCd = montageT > 0 ? 0.25 : 0.09;
    }
    if (b.golden && comboT <= 0) {
      ctx.hud.showCombo('GOLDEN ×10', true);
      ctx.audio.chime(6);
      comboT = 1.2;
    } else if (bin.mult >= 8 && comboT <= 0) {
      ctx.hud.showCombo(`JACKPOT ${multLabel(bin.mult * binBoost())}`);
      ctx.audio.chime(4);
      comboT = 1.1;
    }
    recycleBall(b);
  }

  const binIndexAt = (x: number): number => Math.min(BIN_MULTS.length - 1, Math.max(0, Math.floor((x - 0.2) / BIN_W)));

  // ---- per-step simulation ----
  function handleEvents(): void {
    const sb = phys.sensorBeginCount();
    for (let i = 0; i < sb; i++) {
      phys.readSensorBegin(i, pair);
      let binU = pair.userA;
      let ballU = pair.userB;
      if (udTag(binU) !== TAG_BIN) {
        binU = pair.userB;
        ballU = pair.userA;
      }
      if (udTag(binU) !== TAG_BIN || udTag(ballU) !== TAG_BALL) continue;
      const b = pool[udIdx(ballU)];
      if (!b || !b.active) continue;
      settleBall(b, udIdx(binU));
    }
    const cb = phys.contactBeginCount();
    for (let i = 0; i < cb; i++) {
      phys.readContactBegin(i, pair);
      let pegU = pair.userA;
      let otherU = pair.userB;
      if (udTag(pegU) !== TAG_PEG) {
        pegU = pair.userB;
        otherU = pair.userA;
      }
      if (udTag(pegU) !== TAG_PEG || udTag(otherU) !== TAG_BALL) continue;
      const peg = pegs[udIdx(pegU)];
      const b = pool[udIdx(otherU)];
      if (!peg || !b || !b.active) continue;
      peg.lit = 1; // peg light-up
      b.hits += 1; // feeds the peg-multiplier upgrade
      if (pegSoundCd <= 0) {
        // xylophone pitch rises as the ball descends the rows
        ctx.audio.note(PENTA[peg.row % PENTA.length] ?? 660, { dur: 0.09, type: 'triangle', vol: 0.05 });
        pegSoundCd = montageT > 0 ? 0.12 : 0.045;
      }
    }
  }

  function tickBalls(dt: number): void {
    const sv = phys.states();
    const stride = phys.stride;
    let count = 0;
    for (const b of pool) {
      if (!b.active) continue;
      count += 1;
      const o = slotOf(b.handle) * stride;
      const x = sv[o]!;
      const y = sv[o + 1]!;
      if (y < KILL_Y || x < -0.5 || x > VIEW_W + 0.5) {
        recycleBall(b); // escaped — no payout
        count -= 1;
        continue;
      }
      if (y < 0.72) {
        settleBall(b, binIndexAt(x)); // sensor missed (fast entry) — settle by landed bin
        count -= 1;
        continue;
      }
      if (magnet && y > magnet.y0 && y < magnet.y1 && Math.abs(x - magnet.cx) < magnet.halfW) {
        phys.applyForce(b.handle, magnet.cx > x ? 0.35 : -0.35, 0);
      }
      const vx = sv[o + 5]!;
      const vy = sv[o + 6]!;
      if (vx * vx + vy * vy < 0.012 && y > 1.5) {
        b.still += dt;
        if (b.still > 2.2) {
          phys.applyImpulse(b.handle, ctx.rng.range(-0.02, 0.02), 0.03); // physics-true unstick nudge
          b.still = 0;
        }
      } else {
        b.still = 0;
      }
    }
    activeCount = count;
  }

  function simTick(dt: number): void {
    if (autoRate() > 0) {
      dropAcc = Math.min(dropAcc + autoRate() * dt, 4);
      while (dropAcc >= 1) {
        dropAcc -= 1;
        if (!spawnBall(ctx.rng.range(0.5, VIEW_W - 0.5), false)) break;
      }
    }
    phys.step(dt, montageT > 0 ? 2 : 4);
    handleEvents();
    tickBalls(dt);
  }

  // ---- actions ----
  function denySound(): void {
    ctx.audio.note(150, { dur: 0.08, type: 'square', vol: 0.05 });
    ctx.audio.buzz(5);
  }

  function manualDrop(wx: number): void {
    if (spawnBall(wx, true)) {
      ctx.audio.note(520, { dur: 0.05, type: 'triangle', vol: 0.05 });
      ctx.audio.buzz(6);
    } else {
      denySound();
    }
  }

  function buyUpgrade(id: keyof Levels): void {
    if (isMaxed(id)) {
      denySound();
      return;
    }
    const c = costOf(id);
    if (cash < c) {
      denySound();
      return;
    }
    cash -= c;
    levels[id] += 1;
    dirty = true;
    ctx.audio.tick();
    ctx.audio.pop(Math.min(levels[id], 8));
    ctx.audio.buzz(8);
  }

  function bankRun(): void {
    if (ended) return;
    ended = true;
    saveNow();
    ctx.audio.chime(2);
    ctx.endRun({ score: Math.floor(lifetime), durationMs: 0, seed: 0, stats: statsPayload() });
  }

  function doPrestige(): void {
    if (ended) return;
    if (lifetime < prestigeAt()) {
      denySound();
      return;
    }
    ended = true;
    prestiges += 1;
    cash = 0;
    levels = { rate: 0, value: 0, balls: 0, gold: 0, peg: 0, bins: 0 };
    avgPayout = 0;
    layoutSeed = ctx.rng.next() >>> 0; // pegfield evolves
    saveNow();
    ctx.audio.fanfare();
    ctx.audio.buzz(40);
    ctx.endRun({ score: Math.floor(lifetime), durationMs: 0, seed: 0, stats: statsPayload() });
  }

  function endMontage(): void {
    if (montageT <= 0) return;
    montageT = 0;
    const rem = offlinePool - offlineCredited;
    if (rem > 0) {
      cash += rem;
      lifetime += rem;
      offlineCredited = offlinePool;
      dirty = true;
    }
    ctx.hud.flash(`+$${fmt(offlinePool)} while away`, 1400);
    ctx.audio.fanfare();
    saveNow();
  }

  function pressButton(id: BtnId): void {
    if (id === 'bank') {
      bankRun();
      return;
    }
    if (id === 'prestige') {
      doPrestige();
      return;
    }
    buyUpgrade(id);
  }

  function onTapAt(x: number, y: number): void {
    if (ended) return;
    if (montageT > 0) {
      endMontage(); // tap to skip — remainder credited instantly
      return;
    }
    if (y >= uiTop) {
      for (const b of buttons) {
        if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
          pressButton(b.id);
          return;
        }
      }
      return;
    }
    const wy = VIEW_H - (y - oy) / vs;
    if (wy > TAP_ZONE_MIN_Y) manualDrop((x - ox) / vs);
  }

  // ---- layout ----
  function layout(): void {
    const w = ctx.width;
    const h = ctx.height;
    const uiH = Math.min(Math.max(h * 0.26, 150), 220);
    uiTop = h - uiH;
    vs = Math.min(w / VIEW_W, uiTop / VIEW_H);
    ox = (w - VIEW_W * vs) / 2;
    oy = (uiTop - VIEW_H * vs) / 2;
    buttons = [];
    const pad = 8;
    const headerH = 26;
    const bw = w - pad * 2;
    const upW = bw * 0.72;
    const colW = (upW - pad * 2) / 3;
    const rowH = (uiH - headerH - pad * 3) / 2;
    const by0 = uiTop + pad + headerH;
    UPG_ORDER.forEach((id, i) => {
      buttons.push({ x: pad + (i % 3) * (colW + pad), y: by0 + Math.floor(i / 3) * (rowH + pad), w: colW, h: rowH, id });
    });
    const rx = pad + upW + pad;
    const rw = bw - upW - pad;
    buttons.push({ x: rx, y: by0, w: rw, h: rowH, id: 'bank' });
    buttons.push({ x: rx, y: by0 + rowH + pad, w: rw, h: rowH, id: 'prestige' });
  }

  function updateSub(): void {
    let s: string;
    if (montageT > 0) s = 'offline replay ×20 — tap to skip';
    else if (ballsDropped === 0) s = 'tap the top — drop a ball';
    else if (sessionDrops < 3 && lifetime < 300) s = 'manual drops pay +50% · buy upgrades below';
    else if (lifetime >= prestigeAt()) s = 'PRESTIGE ready — permanent ×2';
    else s = 'BANK to submit your score';
    if (s !== lastSub) {
      lastSub = s;
      ctx.hud.setSub(s);
    }
  }

  // ---- shop rendering ----
  function effectOf(id: keyof Levels): string {
    switch (id) {
      case 'rate':
        return `${autoRate().toFixed(1)}/s auto`;
      case 'value':
        return `$${fmt(baseValue())}/ball`;
      case 'balls':
        return `${maxBalls()} max`;
      case 'gold':
        return `${Math.round(goldChance() * 100)}% ×10`;
      case 'peg':
        return `+${Math.round(pegBonus() * 100)}%/hit`;
      case 'bins':
        return `bins ×${binBoost().toFixed(1)}`;
    }
  }

  function drawButton(b: Btn, colors: Palette): void {
    const cxm = b.x + b.w / 2;
    roundRect(c2d, b.x, b.y, b.w, b.h, 8);
    c2d.fillStyle = colors.bg;
    c2d.globalAlpha = 0.55;
    c2d.fill();
    c2d.globalAlpha = 1;
    c2d.textAlign = 'center';
    if (b.id === 'bank') {
      c2d.strokeStyle = colors.primary;
      c2d.lineWidth = 2;
      c2d.stroke();
      c2d.fillStyle = colors.primary;
      c2d.font = '800 13px system-ui';
      c2d.fillText('BANK', cxm, b.y + b.h / 2 - 2);
      c2d.fillStyle = colors.text;
      c2d.globalAlpha = 0.6;
      c2d.font = '600 9px system-ui';
      c2d.fillText('submit score', cxm, b.y + b.h / 2 + 12);
      c2d.globalAlpha = 1;
      return;
    }
    if (b.id === 'prestige') {
      const ready = lifetime >= prestigeAt();
      const prog = Math.min(1, lifetime / prestigeAt());
      c2d.save();
      roundRect(c2d, b.x, b.y, b.w, b.h, 8);
      c2d.clip();
      c2d.fillStyle = ready ? colors.glow : colors.accent;
      c2d.globalAlpha = ready ? 0.3 : 0.15;
      c2d.fillRect(b.x, b.y, b.w * prog, b.h);
      c2d.restore();
      c2d.globalAlpha = 1;
      c2d.strokeStyle = ready ? colors.glow : colors.accent;
      c2d.lineWidth = 2;
      roundRect(c2d, b.x, b.y, b.w, b.h, 8);
      c2d.stroke();
      c2d.fillStyle = ready ? colors.glow : colors.text;
      c2d.font = '800 12px system-ui';
      c2d.fillText('PRESTIGE ×2', cxm, b.y + b.h / 2 - 2);
      c2d.font = '600 9px system-ui';
      c2d.globalAlpha = 0.75;
      c2d.fillText(ready ? 'READY — tap!' : `$${fmt(lifetime)} / $${fmt(prestigeAt())}`, cxm, b.y + b.h / 2 + 12);
      c2d.globalAlpha = 1;
      return;
    }
    const id = b.id;
    const maxed = isMaxed(id);
    const c = costOf(id);
    const can = !maxed && cash >= c;
    c2d.strokeStyle = can ? colors.accent : colors.text;
    c2d.globalAlpha = can ? 0.95 : 0.3;
    c2d.lineWidth = can ? 2 : 1;
    c2d.stroke();
    c2d.globalAlpha = 1;
    c2d.fillStyle = colors.text;
    c2d.font = '800 11px system-ui';
    c2d.fillText(`${UPG_LABEL[id]} ${levels[id]}`, cxm, b.y + 14);
    c2d.globalAlpha = 0.65;
    c2d.font = '600 9px system-ui';
    c2d.fillText(effectOf(id), cxm, b.y + 26);
    c2d.globalAlpha = 1;
    c2d.fillStyle = maxed ? colors.text : can ? colors.glow : colors.danger;
    c2d.font = '700 11px system-ui';
    c2d.fillText(maxed ? 'MAX' : `$${fmt(c)}`, cxm, b.y + b.h - 8);
  }

  function drawShop(w: number, h: number, colors: Palette): void {
    c2d.fillStyle = colors.surface;
    c2d.fillRect(0, uiTop, w, h - uiTop);
    c2d.strokeStyle = colors.accent;
    c2d.globalAlpha = 0.6;
    c2d.lineWidth = 1;
    c2d.beginPath();
    c2d.moveTo(0, uiTop);
    c2d.lineTo(w, uiTop);
    c2d.stroke();
    c2d.globalAlpha = 1;
    c2d.textAlign = 'left';
    c2d.font = '800 17px system-ui';
    c2d.fillStyle = colors.text;
    c2d.fillText(`$${fmt(Math.floor(dispCash))}`, 10, uiTop + 20); // odometer-roll counter
    c2d.textAlign = 'right';
    c2d.font = '600 10px system-ui';
    c2d.globalAlpha = 0.75;
    const tok = prestiges > 0 ? ` · ×${prestigeMult()} PRESTIGE` : '';
    c2d.fillText(`LIFETIME $${fmt(Math.floor(dispLife))}${tok}`, w - 10, uiTop + 18);
    c2d.globalAlpha = 1;
    for (const b of buttons) drawButton(b, colors);
  }

  return {
    meta,
    async init(context: GameContext): Promise<void> {
      ctx = context;
      phys = await ctx.physics2d();
      const c = ctx.canvas.getContext('2d');
      if (!c) throw new Error('no 2d context');
      c2d = c;
      detachFns.push(ctx.input.onTap((x, y) => onTapAt(x, y)));
      detachFns.push(
        ctx.input.onKey((code, down) => {
          if (!down || ended) return;
          if (code === 'Space' || code === 'Enter') {
            if (montageT > 0) endMontage();
            else manualDrop(VIEW_W / 2 + ctx.rng.range(-1.5, 1.5));
          }
        }),
      );
      ctx.onResize(() => layout());
    },

    start(): void {
      ended = false;
      loadSave();
      buildWorld();
      t = 0;
      floats = [];
      comboT = 0;
      sessionDrops = 0;
      saveT = 0;
      humT = 0;
      pegSoundCd = 0;
      binSoundCd = 0;
      lastSub = '';
      dispCash = cash;
      dispLife = lifetime;
      montageT = 0;
      offlinePool = 0;
      offlineCredited = 0;

      // the twist: honest offline accrual — fast-forward montage, not a dialog
      const elapsed = (Date.now() - lastSeen) / 1000;
      if (autoRate() > 0 && avgPayout > 0 && elapsed > 300) {
        const simSecs = MONTAGE_S * MONTAGE_SPEED; // the ×20 replay really simulates these
        const offSecs = Math.max(0, Math.min(elapsed, OFFLINE_CAP_S) - simSecs);
        offlinePool = autoRate() * avgPayout * offSecs;
        if (offlinePool > 0) montageT = MONTAGE_S;
      }
      lastSeen = Date.now();
      layout();
      ctx.hud.setScore(Math.floor(lifetime));
      updateSub();
      saveNow();
    },

    step(dt: number): void {
      if (ended) return;
      t += dt;
      const loops = montageT > 0 ? MONTAGE_SPEED : 1;
      for (let i = 0; i < loops; i++) simTick(dt);

      if (montageT > 0) {
        const chunk = Math.min((offlinePool / MONTAGE_S) * dt, offlinePool - offlineCredited);
        if (chunk > 0) {
          cash += chunk;
          lifetime += chunk;
          offlineCredited += chunk;
          dirty = true;
        }
        montageT -= dt;
        if (montageT <= 0) endMontage();
      }

      pegSoundCd = Math.max(0, pegSoundCd - dt);
      binSoundCd = Math.max(0, binSoundCd - dt);
      for (const p of pegs) if (p.lit > 0) p.lit = Math.max(0, p.lit - dt * 3);
      for (const b of bins) if (b.flash > 0) b.flash = Math.max(0, b.flash - dt * 2.2);
      for (let i = floats.length - 1; i >= 0; i--) {
        const f = floats[i]!;
        f.y += f.vy * dt;
        f.life -= dt * 1.1;
        if (f.life <= 0) floats.splice(i, 1);
      }
      if (comboT > 0) {
        comboT -= dt;
        if (comboT <= 0) ctx.hud.hideCombo();
      }
      dispCash += (cash - dispCash) * Math.min(1, dt * 7);
      if (Math.abs(cash - dispCash) < 0.5) dispCash = cash;
      dispLife += (lifetime - dispLife) * Math.min(1, dt * 7);
      if (Math.abs(lifetime - dispLife) < 0.5) dispLife = lifetime;

      // machine hum layers with upgrade count
      humT -= dt;
      if (humT <= 0) {
        humT = 1.7;
        if (activeCount > 0 || autoRate() > 0) {
          const vol = Math.min(0.012 + totalLevels() * 0.0013, 0.05);
          ctx.audio.note(48 + prestiges * 4, { dur: 1.8, type: 'sine', vol });
          ctx.audio.note(72 + prestiges * 6, { dur: 1.8, type: 'sine', vol: vol * 0.4 });
        }
      }

      saveT += dt;
      if (saveT >= 3) {
        saveT = 0;
        if (dirty) saveNow();
      }
      ctx.hud.setScore(Math.floor(lifetime));
      updateSub();
    },

    render(): void {
      const w = ctx.width;
      const h = ctx.height;
      layout();
      const colors = ctx.colors();
      const reduced = ctx.settings().reducedMotion;
      c2d.setTransform(ctx.dpr, 0, 0, ctx.dpr, 0, 0);
      c2d.clearRect(0, 0, w, h);
      const sxf = (x: number): number => ox + x * vs;
      const syf = (y: number): number => oy + (VIEW_H - y) * vs;

      // machine frame
      c2d.fillStyle = colors.surface;
      c2d.globalAlpha = 0.35;
      roundRect(c2d, sxf(0) - 6, syf(VIEW_H) - 6, VIEW_W * vs + 12, VIEW_H * vs + 12, 10);
      c2d.fill();
      c2d.globalAlpha = 0.5;
      c2d.strokeStyle = colors.accent;
      c2d.lineWidth = 2;
      c2d.stroke();
      c2d.globalAlpha = 1;

      // drop zone: dashed line + pulsing chevrons + hints
      c2d.strokeStyle = colors.text;
      c2d.globalAlpha = 0.3;
      c2d.lineWidth = 1;
      c2d.setLineDash([6, 8]);
      c2d.beginPath();
      c2d.moveTo(sxf(0.3), syf(DROP_LINE_Y));
      c2d.lineTo(sxf(VIEW_W - 0.3), syf(DROP_LINE_Y));
      c2d.stroke();
      c2d.setLineDash([]);
      c2d.globalAlpha = reduced ? 0.5 : 0.35 + 0.25 * Math.sin(t * 3);
      c2d.fillStyle = colors.text;
      for (const cxw of [2.5, 5, 7.5]) {
        const px = sxf(cxw);
        const py = syf(DROP_LINE_Y) + 10;
        c2d.beginPath();
        c2d.moveTo(px - 5, py);
        c2d.lineTo(px + 5, py);
        c2d.lineTo(px, py + 6);
        c2d.closePath();
        c2d.fill();
      }
      c2d.globalAlpha = 0.5;
      c2d.font = '600 10px system-ui';
      c2d.textAlign = 'center';
      c2d.fillText('TAP TO DROP · MANUAL +50%', sxf(VIEW_W / 2), syf(DROP_LINE_Y) - 8);
      c2d.textAlign = 'right';
      c2d.fillText(`${activeCount}/${maxBalls()}`, sxf(VIEW_W - 0.3), syf(VIEW_H) + 12);
      c2d.globalAlpha = 1;

      // ghost ball at hover x
      if (montageT <= 0 && !ctx.input.pointerDown && ctx.input.y < uiTop) {
        const wyy = VIEW_H - (ctx.input.y - oy) / vs;
        if (wyy > TAP_ZONE_MIN_Y) {
          const gx = Math.min(Math.max((ctx.input.x - ox) / vs, 0.4), VIEW_W - 0.4);
          c2d.globalAlpha = 0.4;
          c2d.strokeStyle = colors.glow;
          c2d.setLineDash([3, 3]);
          c2d.beginPath();
          c2d.arc(sxf(gx), syf(DROP_Y), BALL_R * vs, 0, Math.PI * 2);
          c2d.stroke();
          c2d.setLineDash([]);
          c2d.globalAlpha = 1;
        }
      }

      // magnet zone
      if (magnet) {
        const m = magnet;
        const mx = sxf(m.cx - m.halfW);
        const my = syf(m.y1);
        const mw = m.halfW * 2 * vs;
        const mh = syf(m.y0) - my;
        c2d.fillStyle = colors.glow;
        c2d.globalAlpha = reduced ? 0.14 : 0.09 + 0.06 * Math.sin(t * 2.4);
        c2d.fillRect(mx, my, mw, mh);
        c2d.globalAlpha = 0.45;
        c2d.strokeStyle = colors.glow;
        c2d.setLineDash([4, 6]);
        c2d.strokeRect(mx, my, mw, mh);
        c2d.setLineDash([]);
        c2d.font = '700 11px system-ui';
        c2d.textAlign = 'center';
        c2d.fillStyle = colors.glow;
        c2d.fillText('» MAGNET «', sxf(m.cx), my + mh / 2);
        c2d.globalAlpha = 1;
      }

      // pegs (light up on hit)
      for (const p of pegs) {
        const px = sxf(p.x);
        const py = syf(p.y);
        c2d.beginPath();
        c2d.arc(px, py, PEG_R * vs, 0, Math.PI * 2);
        c2d.fillStyle = colors.text;
        c2d.globalAlpha = 0.3;
        c2d.fill();
        if (p.lit > 0) {
          c2d.globalAlpha = Math.min(1, p.lit);
          c2d.fillStyle = colors.glow;
          c2d.beginPath();
          c2d.arc(px, py, PEG_R * vs * (1 + 0.7 * p.lit), 0, Math.PI * 2);
          c2d.fill();
        }
      }
      c2d.globalAlpha = 1;

      // spinners (live revolute motor bodies)
      for (const sp of spinners) {
        if (!phys.readBody(sp.bar, st)) continue;
        c2d.save();
        c2d.translate(sxf(st.x), syf(st.y));
        c2d.rotate(-st.angle);
        c2d.fillStyle = colors.accent;
        roundRect(c2d, -sp.len * vs, -0.07 * vs, sp.len * 2 * vs, 0.14 * vs, 3);
        c2d.fill();
        c2d.restore();
        c2d.fillStyle = colors.text;
        c2d.beginPath();
        c2d.arc(sxf(sp.x), syf(sp.y), 3, 0, Math.PI * 2);
        c2d.fill();
      }

      // bins: flash fill, dividers, multiplier labels
      const binTopY = syf(1.7);
      const floorY = syf(0.4);
      bins.forEach((b, i) => {
        if (b.flash > 0) {
          c2d.globalAlpha = b.flash * (reduced ? 0.25 : 0.45);
          c2d.fillStyle = b.mult >= 4 ? colors.glow : colors.primary;
          c2d.fillRect(sxf(b.x - BIN_W / 2) + 1, binTopY, BIN_W * vs - 2, floorY - binTopY);
          c2d.globalAlpha = 1;
        }
        c2d.font = '700 11px system-ui';
        c2d.textAlign = 'center';
        c2d.fillStyle = b.mult >= 4 ? colors.accent : colors.text;
        c2d.globalAlpha = b.mult >= 4 ? 0.95 : 0.6;
        c2d.fillText(multLabel(b.mult * binBoost()), sxf(b.x), syf(0.75));
        c2d.globalAlpha = 1;
        if (i > 0) {
          const dxp = sxf(0.2 + BIN_W * i);
          c2d.fillStyle = colors.surface;
          c2d.fillRect(dxp - 0.045 * vs, binTopY, 0.09 * vs, floorY - binTopY);
          c2d.strokeStyle = colors.accent;
          c2d.globalAlpha = 0.4;
          c2d.strokeRect(dxp - 0.045 * vs, binTopY, 0.09 * vs, floorY - binTopY);
          c2d.globalAlpha = 1;
        }
      });
      c2d.strokeStyle = colors.accent;
      c2d.globalAlpha = 0.6;
      c2d.beginPath();
      c2d.moveTo(sxf(0.2), floorY);
      c2d.lineTo(sxf(VIEW_W - 0.2), floorY);
      c2d.stroke();
      c2d.globalAlpha = 1;

      // balls — one states() view for the whole pool (no per-ball allocation)
      const sv = phys.states();
      const stride = phys.stride;
      for (const b of pool) {
        if (!b.active) continue;
        const o = slotOf(b.handle) * stride;
        const bx = sxf(sv[o]!);
        const by = syf(sv[o + 1]!);
        const r = BALL_R * vs;
        c2d.beginPath();
        c2d.arc(bx, by, r, 0, Math.PI * 2);
        c2d.fillStyle = b.golden ? GOLD : colors.primary;
        c2d.fill();
        if (b.golden) {
          c2d.strokeStyle = colors.glow;
          c2d.lineWidth = 2;
          c2d.stroke();
        }
        if (b.manual) {
          c2d.strokeStyle = colors.text;
          c2d.lineWidth = 1.5;
          c2d.globalAlpha = 0.8;
          c2d.beginPath();
          c2d.arc(bx, by, r + 2, 0, Math.PI * 2);
          c2d.stroke();
          c2d.globalAlpha = 1;
        }
      }

      // payout floats
      c2d.textAlign = 'center';
      c2d.font = '800 12px system-ui';
      for (const f of floats) {
        c2d.globalAlpha = Math.min(1, f.life) * 0.9;
        c2d.fillStyle = f.gold ? GOLD : colors.glow;
        c2d.fillText(f.text, sxf(f.x), syf(f.y));
      }
      c2d.globalAlpha = 1;

      // offline montage banner
      if (montageT > 0) {
        const bw2 = Math.min(w * 0.8, 340);
        const bh2 = 84;
        const bx2 = (w - bw2) / 2;
        const by2 = syf(VIEW_H * 0.62);
        c2d.fillStyle = colors.surface;
        c2d.globalAlpha = 0.92;
        roundRect(c2d, bx2, by2, bw2, bh2, 12);
        c2d.fill();
        c2d.globalAlpha = 1;
        c2d.strokeStyle = colors.glow;
        c2d.lineWidth = 1.5;
        c2d.stroke();
        c2d.textAlign = 'center';
        c2d.fillStyle = colors.text;
        c2d.font = '800 14px system-ui';
        c2d.fillText('OFFLINE REPLAY ×20', w / 2, by2 + 22);
        c2d.font = '800 16px system-ui';
        c2d.fillStyle = colors.glow;
        c2d.fillText(`+$${fmt(offlineCredited)}`, w / 2, by2 + 44);
        const prog = 1 - montageT / MONTAGE_S;
        c2d.fillStyle = colors.text;
        c2d.globalAlpha = 0.2;
        c2d.fillRect(bx2 + 16, by2 + 56, bw2 - 32, 6);
        c2d.globalAlpha = 1;
        c2d.fillStyle = colors.primary;
        c2d.fillRect(bx2 + 16, by2 + 56, (bw2 - 32) * prog, 6);
        c2d.font = '600 10px system-ui';
        c2d.fillStyle = colors.text;
        c2d.globalAlpha = 0.6;
        c2d.fillText('tap to skip', w / 2, by2 + 76);
        c2d.globalAlpha = 1;
      }

      drawShop(w, h, colors);
    },

    dispose(): void {
      for (const d of detachFns) d();
      detachFns.length = 0;
      if (loaded) saveNow(); // stamps lastSeen for offline accrual
      phys.init(0, GRAVITY); // free the world's bodies
    },
  };
}
