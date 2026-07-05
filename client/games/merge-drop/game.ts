// MERGE CRATER — merge/drop (MECHANICS §3). Box2D v3. Suika-like: aim above
// the crater, release to drop; two same-tier circles that touch merge into the
// next tier at their midpoint. Chains (merges within 0.5 s) multiply points.
// Twist: the crater subtly tilts ±3° following pointer x — implemented by
// rotating the GRAVITY vector (physics-true ambience). The camera rotates by
// the same angle, so gravity always reads as "down" and the crater as tilted.
//
// Engine note (visible workaround, PRD principle 3): changing world gravity
// does not wake sleeping bodies, which would freeze the tilt twist once the
// pile settles — fruits are created with enableSleep:false. Well under budget
// (< 120 live bodies vs 500-body stress @ 0.28 ms/step, ENGINE-NOTES).

import type { Game, GameContext } from '@sdk/types';
import type { Physics2D, PairEvent, BodyState2D, HitEvent2D, RayHit2D } from '@sdk/physics2d';
import { BODY_STATIC, BODY_DYNAMIC, SHAPE_CONTACT_EVENTS, SHAPE_HIT_EVENTS, slotOf } from '@sdk/physics2d';
import { gameMeta } from '@shared/registry';

// world units are meters
const G = 10;
const INNER_HW = 2.25; // container interior half-width (~4.5 m wide, MECHANICS §3)
const WALL_T = 0.3;
const RIM_Y = 6.0; // overflow line
const WALL_TOP = RIM_Y + 3.2; // walls run past the rim: the pile can tower, never spill sideways
const DROP_Y = RIM_Y + 1.15;
const MAX_TILT = (3 * Math.PI) / 180; // twist: ±3°
const CHAIN_WINDOW = 0.5; // merges within 0.5 s of each other chain
const OVERFLOW_S = 2; // rest above the rim this long → run ends
const REST_SPEED = 0.4; // "nearly motionless"
const DROP_COOLDOWN = 0.45;
const KEY_AIM_SPEED = 3.4; // m/s keyboard aim (mouse/keyboard parity)
const MERGE_POP_VY = 1.4; // small upward Δv for the merged fruit
const VIEW_W = 6.4;
const VIEW_H = 9.4;
const WORLD_CY = 3.7; // camera centers this world y

// 11 tiers: radii 0.28 m → 2.2 m
const MAX_TIER = 11;
const TIER_RADII = [0.28, 0.345, 0.425, 0.52, 0.64, 0.785, 0.96, 1.18, 1.45, 1.78, 2.2] as const;
// deliberate material colors (fruit skins) — UI chrome stays on ctx.colors()
const TIER_COLORS = ['#ff5d73', '#ff8a5c', '#b787ff', '#ffb02e', '#ff7042', '#ee4266', '#b3d94c', '#ffa8d2', '#ffd23f', '#7ddf64', '#3ca370'] as const;
// drop bag: early tiers common, tier 5 rare (all draws through ctx.rng)
const DROP_BAG = [1, 1, 1, 2, 2, 2, 3, 3, 4, 5] as const;

const radiusOf = (tier: number): number => TIER_RADII[tier - 1]!;
const colorOf = (tier: number): string => TIER_COLORS[tier - 1]!;
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const clamp01 = (v: number): number => clamp(v, 0, 1);

interface Fruit {
  handle: number;
  tier: number;
  overS: number; // continuous seconds resting above the rim
  pop: number; // squash-stretch anim, 1 → 0
}

interface Ring {
  x: number;
  y: number;
  r: number;
  vr: number;
  life: number;
  max: number;
  color: string;
}

export function createGame(): Game {
  const meta = gameMeta('merge-drop')!;
  let ctx: GameContext;
  let phys: Physics2D;
  let c2d: CanvasRenderingContext2D;

  let fruits: Fruit[] = [];
  const bySlot = new Map<number, Fruit>();
  const consumed = new Set<number>();
  let rings: Ring[] = [];

  let score = 0;
  let maxTier = 0;
  let merges = 0;
  let bestChain = 0;
  let drops = 0;
  let chain = 0;
  let sinceMerge = 999;

  let alive = false;
  let endTimer = 0;
  let runT = 0;
  let cooldown = 0;
  let current = 1; // tier held above the crater
  let next = 1;
  let aimX = 0;
  let pointerLive = false;
  let lastPX = 0;
  let lastPY = 0;
  let tilt = 0;
  let wobble = 0; // container wobble on big merges (render-side)
  let shake = 0;
  let warnProx = 0; // pile within 1 m of the rim
  let warnOver = 0; // worst overflow timer / 2 s
  let tickAcc = 0;
  let comboT = 0;
  let hintDone = false;
  let lastSub = '\0';

  const stA: BodyState2D = { x: 0, y: 0, angle: 0, awake: false, vx: 0, vy: 0, w: 0 };
  const stB: BodyState2D = { x: 0, y: 0, angle: 0, awake: false, vx: 0, vy: 0, w: 0 };
  const pair: PairEvent = { slotA: 0, userA: 0, slotB: 0, userB: 0 };
  const hit: HitEvent2D = { x: 0, y: 0, nx: 0, ny: 0, speed: 0, slotA: 0, userA: 0, slotB: 0, userB: 0 };
  const ray: RayHit2D = { hit: false, x: 0, y: 0, nx: 0, ny: 0, fraction: 0, slot: -1 };
  let detach: (() => void)[] = [];

  function viewScale(): number {
    return Math.min(ctx.width / VIEW_W, ctx.height / VIEW_H);
  }

  function pxToWorldX(px: number): number {
    return (px - ctx.width / 2) / viewScale();
  }

  function setAim(x: number): void {
    const lim = INNER_HW - radiusOf(current) - 0.05;
    aimX = clamp(x, -lim, lim);
  }

  function setSub(s: string): void {
    if (s === lastSub) return;
    lastSub = s;
    ctx.hud.setSub(s);
  }

  function createFruit(tier: number, x: number, y: number): Fruit {
    // enableSleep:false — see engine note in the header (tilt must stay live)
    const h = phys.createBody({ type: BODY_DYNAMIC, position: [x, y], enableSleep: false, angularDamping: 0.05 });
    phys.addCircle(h, radiusOf(tier), {
      density: 1,
      friction: 0.4,
      restitution: Math.max(0.04, 0.2 - tier * 0.012), // small fruit bounces a touch more
      flags: SHAPE_CONTACT_EVENTS | SHAPE_HIT_EVENTS,
    });
    phys.setUserData(h, tier); // body user-data = tier (merge detection)
    const f: Fruit = { handle: h, tier, overS: 0, pop: 0 };
    fruits.push(f);
    bySlot.set(slotOf(h), f);
    if (tier > maxTier) maxTier = tier;
    return f;
  }

  function removeFruit(f: Fruit): void {
    bySlot.delete(slotOf(f.handle));
    const i = fruits.indexOf(f);
    if (i >= 0) fruits.splice(i, 1);
    phys.destroyBody(f.handle);
  }

  function mergeAt(a: Fruit, b: Fruit, mx: number, my: number, tier: number): void {
    removeFruit(a);
    removeFruit(b);
    const newTier = tier + 1;
    const f = createFruit(newTier, mx, my);
    f.pop = 1; // squash-stretch pop (render-side)
    phys.applyImpulse(f.handle, 0, phys.getMass(f.handle) * MERGE_POP_VY);

    chain = sinceMerge <= CHAIN_WINDOW ? chain + 1 : 1;
    sinceMerge = 0;
    bestChain = Math.max(bestChain, chain);
    merges += 1;
    score += tier * tier * 10 * chain; // tier²·10 × chain multiplier

    rings.push({ x: mx, y: my, r: radiusOf(newTier) * 0.7, vr: 5.5, life: 0.45, max: 0.45, color: colorOf(newTier) });
    ctx.audio.pop(Math.min(chain - 1, 12)); // pitch rises per chain step
    ctx.audio.buzz(10);
    if (newTier >= 8) ctx.audio.chime(newTier - 7);
    if (newTier >= 6) wobble = Math.min(1, wobble + 0.2 + (newTier - 5) * 0.09); // big merge → crater wobble
    if (chain >= 2) {
      ctx.hud.showCombo(`CHAIN ×${chain}`, chain >= 3);
      comboT = 1.1;
    }
  }

  function handleMerges(): void {
    consumed.clear();
    const n = phys.contactBeginCount();
    for (let i = 0; i < n; i++) {
      phys.readContactBegin(i, pair);
      if (pair.userA !== pair.userB) continue;
      const tier = pair.userA;
      if (tier < 1 || tier >= MAX_TIER) continue; // two max-tier fruits cap out — they do not merge
      if (consumed.has(pair.slotA) || consumed.has(pair.slotB)) continue;
      const a = bySlot.get(pair.slotA);
      const b = bySlot.get(pair.slotB);
      if (!a || !b || a === b || a.tier !== tier || b.tier !== tier) continue;
      if (!phys.readBody(a.handle, stA) || !phys.readBody(b.handle, stB)) continue;
      consumed.add(pair.slotA);
      consumed.add(pair.slotB);
      mergeAt(a, b, (stA.x + stB.x) / 2, (stA.y + stB.y) / 2, tier);
    }
  }

  function handleHits(): void {
    const n = phys.hitCount();
    if (n === 0) return;
    let smax = 0;
    for (let i = 0; i < n; i++) {
      phys.readHit(i, hit);
      smax = Math.max(smax, hit.speed);
    }
    if (smax > 1.2) ctx.audio.thud(Math.min(smax * 0.6, 7)); // one thud per frame, scaled by hardest impact
  }

  function updatePile(dt: number): void {
    let top = -Infinity;
    let worst = 0;
    for (const f of fruits) {
      if (!phys.readBody(f.handle, stA)) continue;
      top = Math.max(top, stA.y + radiusOf(f.tier));
      const speed = Math.hypot(stA.vx, stA.vy);
      if (stA.y > RIM_Y && speed < REST_SPEED) f.overS += dt;
      else f.overS = 0;
      worst = Math.max(worst, f.overS);
    }
    warnProx = clamp01((top - (RIM_Y - 1)) / 1); // rim warning glow within 1 m
    warnOver = clamp01(worst / OVERFLOW_S);
    if (worst >= OVERFLOW_S) gameOver();
  }

  function updateFx(dt: number): void {
    for (const f of fruits) f.pop = Math.max(0, f.pop - dt * 3.2);
    for (let i = rings.length - 1; i >= 0; i--) {
      const g = rings[i]!;
      g.life -= dt;
      g.r += g.vr * dt;
      if (g.life <= 0) rings.splice(i, 1);
    }
    wobble = Math.max(0, wobble - dt * 2.2);
    shake = Math.max(0, shake - dt * 1.8);
  }

  function drop(): void {
    if (!alive || cooldown > 0) return;
    createFruit(current, aimX, DROP_Y);
    drops += 1;
    cooldown = DROP_COOLDOWN;
    current = next;
    next = ctx.rng.pick(DROP_BAG);
    setAim(aimX); // re-clamp for the new fruit's radius
    ctx.audio.whoosh();
    ctx.audio.buzz(6);
  }

  function gameOver(): void {
    if (!alive) return;
    alive = false;
    endTimer = 0.8;
    shake = ctx.settings().reducedMotion ? 0 : 0.5;
    ctx.hud.hideCombo();
    ctx.audio.womp();
    ctx.audio.buzz(60);
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
        ctx.input.onDown((x) => {
          pointerLive = true;
          setAim(pxToWorldX(x));
        }),
        ctx.input.onDrag((e) => {
          pointerLive = true;
          setAim(pxToWorldX(e.x));
        }),
        ctx.input.onRelease(() => drop()),
        ctx.input.onKey((code, down) => {
          if (down && (code === 'Space' || code === 'Enter')) drop();
        }),
      );
    },

    start(): void {
      phys.init(0, -G);
      phys.setHitEventThreshold(1);
      fruits = [];
      bySlot.clear();
      consumed.clear();
      rings = [];
      score = 0;
      maxTier = 0;
      merges = 0;
      bestChain = 0;
      drops = 0;
      chain = 0;
      sinceMerge = 999;
      endTimer = 0;
      runT = 0;
      cooldown = 0;
      aimX = 0;
      pointerLive = false;
      lastPX = ctx.input.x;
      lastPY = ctx.input.y;
      tilt = 0;
      wobble = 0;
      shake = 0;
      warnProx = 0;
      warnOver = 0;
      tickAcc = 0;
      comboT = 0;
      hintDone = false;
      lastSub = '\0';

      // the crater — static floor + walls, interior 4.5 m wide, rim at 6 m
      const floor = phys.createBody({ type: BODY_STATIC, position: [0, -WALL_T / 2] });
      phys.addBox(floor, INNER_HW + WALL_T, WALL_T / 2, { friction: 0.6, flags: SHAPE_HIT_EVENTS });
      for (const side of [-1, 1]) {
        const wall = phys.createBody({ type: BODY_STATIC, position: [side * (INNER_HW + WALL_T / 2), WALL_TOP / 2] });
        phys.addBox(wall, WALL_T / 2, WALL_TOP / 2, { friction: 0.4, flags: SHAPE_HIT_EVENTS });
      }

      current = ctx.rng.pick(DROP_BAG);
      next = ctx.rng.pick(DROP_BAG);

      alive = true;
      ctx.hud.setScore(0);
      setSub('drag to aim · release to drop');
    },

    step(dt: number): void {
      if (!alive) {
        if (endTimer > 0) {
          // brief slow-mo settle before the run ends (real time under reduced motion)
          phys.step(dt * (ctx.settings().reducedMotion ? 1 : 0.35), 4);
          updateFx(dt);
          endTimer -= dt;
          if (endTimer <= 0) {
            ctx.endRun({ score, durationMs: 0, seed: 0, stats: { maxTier, merges, bestChain, drops } });
          }
        }
        return;
      }

      runT += dt;
      cooldown = Math.max(0, cooldown - dt);
      sinceMerge += dt;

      // aim — pointer hover/drag (polled: Input has no hover event) or keyboard
      if (ctx.input.x !== lastPX || ctx.input.y !== lastPY) {
        lastPX = ctx.input.x;
        lastPY = ctx.input.y;
        pointerLive = true;
      }
      if (pointerLive) setAim(pxToWorldX(ctx.input.x));
      const axis = ctx.input.axis();
      if (axis !== 0) {
        pointerLive = false;
        setAim(aimX + axis * KEY_AIM_SPEED * dt);
      }

      // twist — gravity vector tilts ±3° toward the pointer, the pile responds live
      const src = pointerLive ? pxToWorldX(ctx.input.x) : aimX;
      const target = clamp(src / INNER_HW, -1, 1) * MAX_TILT;
      tilt += (target - tilt) * Math.min(1, dt * 5);
      phys.setGravity(Math.sin(tilt) * G, -Math.cos(tilt) * G);

      phys.step(dt, 4);
      handleMerges();
      handleHits();
      updatePile(dt);
      updateFx(dt);

      ctx.hud.setScore(score);
      if (!hintDone && (drops > 0 || runT > 5)) hintDone = true;
      setSub(!hintDone ? 'drag to aim · release to drop' : warnOver > 0 ? 'over the rim!' : '');
      if (comboT > 0) {
        comboT -= dt;
        if (comboT <= 0) ctx.hud.hideCombo();
      }
      if (warnOver > 0) {
        tickAcc += dt; // overflow metronome
        if (tickAcc >= 0.33) {
          tickAcc = 0;
          ctx.audio.tick();
        }
      } else {
        tickAcc = 0;
      }
    },

    render(): void {
      const w = ctx.width;
      const h = ctx.height;
      const dpr = ctx.dpr;
      const colors = ctx.colors();
      const reduced = ctx.settings().reducedMotion;
      c2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      c2d.clearRect(0, 0, w, h);

      const scale = viewScale();
      const sx = (x: number): number => w / 2 + x * scale;
      const sy = (y: number): number => h / 2 + (WORLD_CY - y) * scale;

      if (shake > 0 && !reduced) {
        c2d.translate((Math.random() - 0.5) * shake * 12, (Math.random() - 0.5) * shake * 12);
      }

      // tilted crater view — gravity was rotated by `tilt`, so rotating the view
      // by the same angle keeps gravity reading as straight down on screen.
      c2d.save();
      const wobRot = reduced ? 0 : Math.sin(runT * 26) * wobble * 0.012;
      c2d.translate(sx(0), sy(0));
      c2d.rotate(tilt + wobRot);
      c2d.translate(-sx(0), -sy(0));

      // container
      const wallW = WALL_T * scale;
      const leftX = sx(-INNER_HW - WALL_T);
      const topY = sy(WALL_TOP);
      const floorY = sy(0);
      c2d.fillStyle = colors.surface;
      c2d.strokeStyle = colors.accent;
      c2d.lineWidth = 2;
      roundRect(c2d, leftX, topY, wallW, floorY - topY + wallW, 5);
      c2d.fill();
      c2d.stroke();
      roundRect(c2d, sx(INNER_HW), topY, wallW, floorY - topY + wallW, 5);
      c2d.fill();
      c2d.stroke();
      roundRect(c2d, leftX, floorY, sx(INNER_HW + WALL_T) - leftX, wallW, 5);
      c2d.fill();
      c2d.stroke();

      // rim line — warning glow when the pile is within 1 m, danger while overflowing
      const warn = Math.max(warnProx * 0.6, warnOver);
      const pulse = reduced ? 1 : 0.7 + 0.3 * Math.sin(runT * 9);
      const rimPx = sy(RIM_Y);
      c2d.strokeStyle = warnOver > 0 ? colors.danger : colors.glow;
      c2d.lineWidth = 6;
      c2d.globalAlpha = 0.08 + warn * 0.5 * pulse;
      c2d.beginPath();
      c2d.moveTo(sx(-INNER_HW), rimPx);
      c2d.lineTo(sx(INNER_HW), rimPx);
      c2d.stroke();
      c2d.lineWidth = 1.5;
      c2d.globalAlpha = 0.3 + warn * 0.7;
      c2d.setLineDash([10, 8]);
      c2d.beginPath();
      c2d.moveTo(sx(-INNER_HW), rimPx);
      c2d.lineTo(sx(INNER_HW), rimPx);
      c2d.stroke();
      c2d.setLineDash([]);
      c2d.globalAlpha = 1;

      // merge ring particles
      for (const g of rings) {
        const t = g.life / g.max;
        c2d.globalAlpha = t * 0.7;
        c2d.strokeStyle = g.color;
        c2d.lineWidth = 2 + t * 3;
        c2d.beginPath();
        c2d.arc(sx(g.x), sy(g.y), g.r * scale, 0, Math.PI * 2);
        c2d.stroke();
      }
      c2d.globalAlpha = 1;

      // fruits — squash-stretch pop on freshly merged ones
      for (const f of fruits) {
        if (!phys.readBody(f.handle, stA)) continue;
        const r = radiusOf(f.tier) * scale;
        const s = Math.sin(f.pop * Math.PI) * 0.3;
        c2d.save();
        c2d.translate(sx(stA.x), sy(stA.y));
        c2d.rotate(-stA.angle);
        c2d.fillStyle = colorOf(f.tier);
        c2d.beginPath();
        c2d.ellipse(0, 0, r * (1 + s), r * (1 - s * 0.7), 0, 0, Math.PI * 2);
        c2d.fill();
        // rind ring + gloss (material shading)
        c2d.globalAlpha = 0.22;
        c2d.strokeStyle = '#000';
        c2d.lineWidth = Math.max(1.5, r * 0.09);
        c2d.beginPath();
        c2d.arc(0, 0, r * 0.82, 0, Math.PI * 2);
        c2d.stroke();
        c2d.globalAlpha = 0.35;
        c2d.fillStyle = '#fff';
        c2d.beginPath();
        c2d.ellipse(-r * 0.34, -r * 0.36, r * 0.22, r * 0.13, -0.6, 0, Math.PI * 2);
        c2d.fill();
        c2d.globalAlpha = 1;
        c2d.restore();
      }

      // held fruit + physics-raycast drop guide (along the tilted gravity vector)
      if (alive) {
        const r = radiusOf(current);
        const dx = Math.sin(tilt);
        const dy = -Math.cos(tilt);
        phys.castRayClosest([aimX, DROP_Y], [dx * 12, dy * 12], 0xffffffff, 0xffffffff, ray);
        const ex = ray.hit ? ray.x : aimX + dx * 12;
        const ey = ray.hit ? ray.y : DROP_Y + dy * 12;
        c2d.strokeStyle = colors.text;
        c2d.globalAlpha = 0.22;
        c2d.lineWidth = 1.5;
        c2d.setLineDash([5, 9]);
        c2d.beginPath();
        c2d.moveTo(sx(aimX), sy(DROP_Y));
        c2d.lineTo(sx(ex), sy(ey));
        c2d.stroke();
        c2d.setLineDash([]);
        c2d.beginPath(); // ghost landing outline
        c2d.arc(sx(ex - dx * r), sy(ey - dy * r), r * scale, 0, Math.PI * 2);
        c2d.stroke();
        c2d.globalAlpha = cooldown > 0 ? 0.35 : 1;
        c2d.fillStyle = colorOf(current);
        c2d.beginPath();
        c2d.arc(sx(aimX), sy(DROP_Y), r * scale, 0, Math.PI * 2);
        c2d.fill();
        c2d.globalAlpha = Math.min(0.35, c2d.globalAlpha);
        c2d.fillStyle = '#fff';
        c2d.beginPath();
        c2d.ellipse(sx(aimX) - r * scale * 0.34, sy(DROP_Y) - r * scale * 0.36, r * scale * 0.22, r * scale * 0.13, -0.6, 0, Math.PI * 2);
        c2d.fill();
        c2d.globalAlpha = 1;
      }

      c2d.restore(); // end tilted view

      // next-fruit preview (screen-fixed, top right)
      c2d.globalAlpha = 0.8;
      c2d.fillStyle = colors.text;
      c2d.font = '700 11px system-ui, sans-serif';
      c2d.textAlign = 'center';
      c2d.fillText('NEXT', w - 40, 60);
      c2d.fillStyle = colorOf(next);
      c2d.beginPath();
      c2d.arc(w - 40, 82, 10 + radiusOf(next) * 14, 0, Math.PI * 2);
      c2d.fill();
      c2d.globalAlpha = 1;

      // overflow danger vignette (skipped under reduced motion)
      if (warnOver > 0 && !reduced) {
        const a = Math.max(0, warnOver * (0.5 + 0.5 * Math.sin(runT * 10)) * 0.22);
        const grad = c2d.createRadialGradient(w / 2, h / 2, h * 0.35, w / 2, h / 2, h * 0.8);
        grad.addColorStop(0, 'transparent');
        grad.addColorStop(1, colors.danger);
        c2d.globalAlpha = a;
        c2d.fillStyle = grad;
        c2d.fillRect(0, 0, w, h);
        c2d.globalAlpha = 1;
      }
    },

    dispose(): void {
      for (const d of detach) d();
      detach = [];
      phys.init(0, -G); // free the world's bodies
    },
  };
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  c.roundRect(x, y, w, h, r);
}
