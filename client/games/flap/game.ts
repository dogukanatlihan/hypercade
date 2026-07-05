// ONE-WING — tap/timing (MECHANICS §2). Box2D v3. The 2D exemplar game:
// physics-true pillars, sensor score gates, the graze twist (a knockable cap
// block, once per run), and the full juice pass.

import type { Game, GameContext } from '@sdk/types';
import type { Physics2D, PairEvent, BodyState2D } from '@sdk/physics2d';
import { BODY_STATIC, BODY_DYNAMIC, SHAPE_SENSOR, SHAPE_CONTACT_EVENTS, slotOf } from '@sdk/physics2d';
import { gameMeta } from '@shared/registry';

// world units are meters; portrait camera shows ~9m width
const VIEW_W = 9;
const GRAVITY = -22;
const BIRD_R = 0.35;
const BIRD_X_VIEW = 0.32; // bird sits at 32% of screen width
const FLAP_VY = 7.6;
const SCROLL_VX = 3.2;
const PILLAR_SPACING = 5.2;
const PILLAR_W = 1.1;
const GAP_START = 3.4;
const GAP_FLOOR = 2.6 * (BIRD_R * 2); // MECHANICS: floor at 2.6× body height
const CAP_H = 0.42;
const WORLD_TOP = 16;

// user-data tags
const TAG_BIRD = 1;
const TAG_COLUMN = 2;
const TAG_CAP = 3;
const TAG_GATE = 4;
const TAG_GROUND = 5;

interface Pillar {
  columnBottom: number;
  columnTop: number;
  cap: number;
  gate: number;
  x: number;
  gapY: number;
  gapH: number;
  scored: boolean;
  capKnocked: boolean;
}

interface Feather {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  spin: number;
}

export function createGame(): Game {
  const meta = gameMeta('flap')!;
  let ctx: GameContext;
  let phys: Physics2D;
  let c2d: CanvasRenderingContext2D;

  let bird = -1;
  let ground = -1;
  let pillars: Pillar[] = [];
  let nextPillarX = 0;
  let score = 0;
  let grazes = 0;
  let grazeUsed = false;
  let alive = false;
  let started = false; // first tap starts gravity
  let deathTimer = 0; // slow-mo window after death
  let camX = 0;
  let flashT = 0; // graze heartbeat
  let shake = 0;
  let feathers: Feather[] = [];
  let birdRot = 0;
  const st: BodyState2D = { x: 0, y: 0, angle: 0, awake: false, vx: 0, vy: 0, w: 0 };
  const pair: PairEvent = { slotA: 0, userA: 0, slotB: 0, userB: 0 };
  const slotTag = new Map<number, number>();
  let detachInput: (() => void) | null = null;

  const gapFor = (n: number): number => Math.max(GAP_START * Math.pow(0.9, Math.floor(n / 10)), GAP_FLOOR);

  function spawnPillar(): void {
    const n = pillars.length;
    const gapH = gapFor(n);
    const drift = n >= 20 ? Math.sin(n * 1.7) * 1.2 : 0;
    const gapY = ctxRng(2.6 + gapH / 2, 9.5 - gapH / 2) + drift * 0.4;
    const x = nextPillarX;
    nextPillarX += PILLAR_SPACING;

    const mk = (cy: number, hh: number): number => {
      const h = phys.createBody({ type: BODY_STATIC, position: [x, cy] });
      phys.addBox(h, PILLAR_W / 2, hh, { friction: 0.6, flags: SHAPE_CONTACT_EVENTS });
      phys.setUserData(h, TAG_COLUMN);
      slotTag.set(slotOf(h), TAG_COLUMN);
      return h;
    };
    const bottomTop = gapY - gapH / 2;
    const topBottom = gapY + gapH / 2;
    const columnBottom = mk(bottomTop / 2, bottomTop / 2);
    const columnTop = mk((WORLD_TOP + topBottom) / 2, (WORLD_TOP - topBottom) / 2);

    // the graze cap: a real dynamic block resting on the bottom column's lip
    const cap = phys.createBody({ type: BODY_DYNAMIC, position: [x, bottomTop + CAP_H / 2] });
    phys.addBox(cap, PILLAR_W / 2 + 0.06, CAP_H / 2, { density: 0.6, friction: 0.7, flags: SHAPE_CONTACT_EVENTS });
    phys.setUserData(cap, TAG_CAP);
    slotTag.set(slotOf(cap), TAG_CAP);

    const gate = phys.createBody({ type: BODY_STATIC, position: [x + PILLAR_W / 2 + 0.3, gapY] });
    phys.addBox(gate, 0.05, gapH / 2 - 0.05, { flags: SHAPE_SENSOR });
    phys.setUserData(gate, TAG_GATE);
    slotTag.set(slotOf(gate), TAG_GATE);

    pillars.push({ columnBottom, columnTop, cap, gate, x, gapY, gapH, scored: false, capKnocked: false });
  }

  function ctxRng(min: number, max: number): number {
    return ctx.rng.range(min, max);
  }

  function flap(): void {
    if (!alive) return;
    started = true;
    phys.readBody(bird, st);
    phys.setLinearVelocity(bird, SCROLL_VX, FLAP_VY);
    ctx.audio.note(620, { dur: 0.08, type: 'triangle', vol: 0.1, slideTo: 880 });
    ctx.audio.buzz(8);
    for (let i = 0; i < 5; i++) {
      feathers.push({
        x: st.x - BIRD_R * 0.7,
        y: st.y - BIRD_R * 0.4,
        vx: ctxRng(-2.4, -0.6),
        vy: ctxRng(-1.4, 0.8),
        life: 1,
        spin: ctxRng(-6, 6),
      });
    }
  }

  function die(): void {
    if (!alive) return;
    alive = false;
    deathTimer = 0.25; // slow-mo 250ms (MECHANICS juice)
    shake = ctx.settings().reducedMotion ? 0 : 0.5;
    ctx.audio.womp();
    ctx.audio.buzz(60);
  }

  function handleEvents(): void {
    for (let i = 0; i < phys.sensorBeginCount(); i++) {
      phys.readSensorBegin(i, pair);
      if (pair.userA === TAG_GATE && pair.userB === TAG_BIRD) {
        score += 1;
        ctx.hud.setScore(score);
        ctx.audio.pop(Math.min(score, 12));
      }
    }
    for (let i = 0; i < phys.contactBeginCount(); i++) {
      phys.readContactBegin(i, pair);
      const tags = [pair.userA, pair.userB];
      if (!tags.includes(TAG_BIRD)) continue;
      const other = pair.userA === TAG_BIRD ? pair.userB : pair.userA;
      if (other === TAG_CAP) {
        // physics-true forgiveness: the cap tumbles, you live — once per run
        if (!grazeUsed) {
          grazeUsed = true;
          grazes += 1;
          flashT = 1;
          ctx.hud.showCombo('GRAZE', true);
          ctx.audio.chime(3);
          ctx.audio.buzz(25);
        } else {
          die();
        }
      } else if (other === TAG_COLUMN || other === TAG_GROUND) {
        die();
      }
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
      detachInput = ctx.input.onAction(() => flap());
      if (import.meta.env.DEV) {
        (window as unknown as Record<string, unknown>)['__flapDbg'] = {
          state: () => {
            phys.readBody(bird, st);
            return { started, alive, score, bird, x: st.x, y: st.y, vy: st.vy };
          },
          scanNaN: () => {
            const s = phys.states();
            for (let i = 0; i < s.length; i++) {
              if (s[i] !== undefined && !Number.isFinite(s[i]!)) return { index: i, slot: Math.floor(i / 8), field: i % 8 };
            }
            return null;
          },
        };
      }
    },

    start(): void {
      phys.init(0, GRAVITY);
      slotTag.clear();
      pillars = [];
      feathers = [];
      score = 0;
      grazes = 0;
      grazeUsed = false;
      deathTimer = 0;
      flashT = 0;
      shake = 0;
      birdRot = 0;
      started = false;
      camX = 0;

      ground = phys.createBody({ type: BODY_STATIC, position: [200, -0.5] });
      phys.addBox(ground, 400, 0.5, { friction: 0.8, flags: SHAPE_CONTACT_EVENTS });
      phys.setUserData(ground, TAG_GROUND);

      bird = phys.createBody({ type: BODY_DYNAMIC, position: [0, 6], bullet: true, angularDamping: 2 });
      phys.addCircle(bird, BIRD_R, { density: 1, friction: 0.2, restitution: 0.1, flags: SHAPE_CONTACT_EVENTS });
      phys.setUserData(bird, TAG_BIRD);
      // hold still until the first flap (gravity off) — first 5 seconds teach by doing
      phys.setGravityScale(bird, 0);

      nextPillarX = 7;
      for (let i = 0; i < 4; i++) spawnPillar();

      alive = true;
      ctx.hud.setScore(0);
      ctx.hud.setSub('tap to flap');
    },

    step(dt: number): void {
      if (!alive && deathTimer <= 0) return;

      if (started && alive) {
        phys.setGravityScale(bird, 1);
        phys.readBody(bird, st);
        phys.setLinearVelocity(bird, SCROLL_VX, st.vy); // constant forward roll
        if (st.y > WORLD_TOP - 1) phys.setLinearVelocity(bird, SCROLL_VX, Math.min(st.vy, 0));
      }

      const scale = deathTimer > 0 ? 0.3 : 1; // slow-mo on death
      phys.step(dt * scale, 4);
      if (deathTimer > 0) {
        deathTimer -= dt;
        if (deathTimer <= 0) {
          ctx.endRun({ score, durationMs: 0, seed: 0, stats: { grazes } });
        }
      }

      if (alive) handleEvents();

      // stream pillars: spawn ahead, destroy behind
      phys.readBody(bird, st);
      while (nextPillarX < st.x + VIEW_W * 2) spawnPillar();
      while (pillars.length > 0 && pillars[0]!.x < st.x - VIEW_W) {
        const p = pillars.shift()!;
        for (const h of [p.columnBottom, p.columnTop, p.cap, p.gate]) phys.destroyBody(h);
      }

      // feathers
      for (let i = feathers.length - 1; i >= 0; i--) {
        const f = feathers[i]!;
        f.life -= dt * 1.8;
        f.x += f.vx * dt;
        f.y += f.vy * dt;
        f.vy -= 3 * dt;
        if (f.life <= 0) feathers.splice(i, 1);
      }
      flashT = Math.max(0, flashT - dt * 2.2);
      shake = Math.max(0, shake - dt * 1.6);
      if (started && alive) ctx.hud.setSub('');
    },

    render(): void {
      const w = ctx.width;
      const h = ctx.height;
      const dpr = ctx.dpr;
      const colors = ctx.colors();
      c2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      c2d.clearRect(0, 0, w, h);

      // fit 9m across in portrait, but never lose the 13m vertical field on wide screens
      const scale = Math.min(w / VIEW_W, h / 13);
      phys.readBody(bird, st);
      camX += (st.x - camX) * 0.35;
      const sx = (x: number): number => (x - camX) * scale + w * BIRD_X_VIEW;
      const sy = (y: number): number => h - 24 - y * scale; // ground 24px above the bottom edge
      const reduced = ctx.settings().reducedMotion;
      const jx = reduced ? 0 : (Math.random() - 0.5) * shake * 14;
      const jy = reduced ? 0 : (Math.random() - 0.5) * shake * 14;
      c2d.translate(jx, jy);

      // parallax haze bands
      c2d.fillStyle = colors.surface;
      for (let i = 0; i < 3; i++) {
        const bx = -((camX * (12 + i * 8)) % (w + 200));
        c2d.globalAlpha = 0.25 - i * 0.06;
        c2d.beginPath();
        c2d.ellipse(bx + w * 0.7 + i * 160, h * (0.25 + i * 0.2), 130 + i * 60, 36 + i * 14, 0, 0, Math.PI * 2);
        c2d.fill();
      }
      c2d.globalAlpha = 1;

      // ground strip
      c2d.fillStyle = colors.surface;
      c2d.fillRect(0, sy(0), w, h - sy(0));
      c2d.strokeStyle = colors.primary;
      c2d.globalAlpha = 0.5;
      c2d.beginPath();
      c2d.moveTo(0, sy(0));
      c2d.lineTo(w, sy(0));
      c2d.stroke();
      c2d.globalAlpha = 1;

      // pillars + caps
      for (const p of pillars) {
        const px = sx(p.x - PILLAR_W / 2);
        const pw = PILLAR_W * scale;
        const bottomTop = p.gapY - p.gapH / 2;
        const topBottom = p.gapY + p.gapH / 2;
        c2d.fillStyle = colors.surface;
        c2d.strokeStyle = colors.accent;
        c2d.lineWidth = 2;
        // bottom column
        roundRect(c2d, px, sy(bottomTop), pw, sy(0) - sy(bottomTop), 6);
        c2d.fill();
        c2d.stroke();
        // top column
        roundRect(c2d, px, sy(WORLD_TOP), pw, sy(topBottom) - sy(WORLD_TOP), 6);
        c2d.fill();
        c2d.stroke();
        // cap block (live physics body)
        if (phys.readBody(p.cap, st)) {
          c2d.save();
          c2d.translate(sx(st.x), sy(st.y));
          c2d.rotate(-st.angle);
          c2d.fillStyle = colors.glow;
          const cw = (PILLAR_W + 0.12) * scale;
          const ch = CAP_H * scale;
          roundRect(c2d, -cw / 2, -ch / 2, cw, ch, 4);
          c2d.fill();
          c2d.restore();
        }
      }

      // feathers
      for (const f of feathers) {
        c2d.save();
        c2d.translate(sx(f.x), sy(f.y));
        c2d.rotate(f.spin * (1 - f.life));
        c2d.globalAlpha = f.life * 0.9;
        c2d.fillStyle = colors.text;
        c2d.beginPath();
        c2d.ellipse(0, 0, 5, 2.4, 0.6, 0, Math.PI * 2);
        c2d.fill();
        c2d.restore();
      }
      c2d.globalAlpha = 1;

      // bird — rotation follows velocity (MECHANICS juice)
      phys.readBody(bird, st);
      const targetRot = Math.atan2(st.vy, 8);
      birdRot += (targetRot - birdRot) * 0.25;
      c2d.save();
      c2d.translate(sx(st.x), sy(st.y));
      c2d.rotate(-birdRot);
      const r = BIRD_R * scale;
      c2d.fillStyle = colors.primary;
      c2d.beginPath();
      c2d.arc(0, 0, r, 0, Math.PI * 2);
      c2d.fill();
      // wing
      c2d.fillStyle = colors.glow;
      c2d.beginPath();
      c2d.ellipse(-r * 0.25, 0, r * 0.55, r * 0.32, -0.5 + Math.sin(performance.now() * 0.02) * 0.4, 0, Math.PI * 2);
      c2d.fill();
      // eye
      c2d.fillStyle = colors.bg;
      c2d.beginPath();
      c2d.arc(r * 0.42, -r * 0.25, r * 0.16, 0, Math.PI * 2);
      c2d.fill();
      // beak
      c2d.fillStyle = colors.glow;
      c2d.beginPath();
      c2d.moveTo(r * 0.85, 0);
      c2d.lineTo(r * 1.35, -r * 0.12);
      c2d.lineTo(r * 0.85, -r * 0.3);
      c2d.fill();
      c2d.restore();

      // graze heartbeat flash (skipped under reduced motion)
      if (flashT > 0 && !reduced) {
        const a = Math.sin(flashT * Math.PI) * 0.28;
        const grad = c2d.createRadialGradient(w / 2, h / 2, h * 0.3, w / 2, h / 2, h * 0.75);
        grad.addColorStop(0, 'transparent');
        grad.addColorStop(1, colors.danger);
        c2d.globalAlpha = a;
        c2d.fillStyle = grad;
        c2d.fillRect(0, 0, w, h);
        c2d.globalAlpha = 1;
      }
    },

    dispose(): void {
      detachInput?.();
      phys.init(0, GRAVITY); // free the world's bodies
    },
  };
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  c.roundRect(x, y, w, h, r);
}
