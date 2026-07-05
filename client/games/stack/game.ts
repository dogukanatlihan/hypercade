// BOXSTACK — stacking (MECHANICS §9). Box3D + three.js. Adapted from the
// frozen reference (Box3DTestApp/src/main.js): the proven swing/drop/settle/
// collapse core is kept; SDK wrap, palette restyle, star beacons and stats
// hooks are new. The 3D exemplar game.

import * as THREE from 'three';
import type { Game, GameContext } from '@sdk/types';
import type { Physics3D, BodyState3D, HitEvent } from '@sdk/physics3d';
import { BODY_STATIC, BODY_DYNAMIC, SHAPE_HIT_EVENTS } from '@sdk/physics3d';
import { gameMeta } from '@shared/registry';
import { STAR_THRESHOLDS } from '@shared/scoring';

const CRATE_HALF = { x: 1.25, y: 0.5, z: 1.25 };
const BASE_HALF = { x: 1.9, y: 1.0, z: 1.9 };
const SPAWN_RISE = 4.2;
const SWING_AMPLITUDE = 4.0;
const SWING_SPEED_BASE = 1.35;
const SWING_SPEED_GAIN = 0.045;
const KILL_Y = -9;
const SETTLE_SPEED = 0.22;
const PERFECT_OFFSET = 0.32;
const SUBSTEPS = 4;

interface Placed {
  handle: number;
  mesh: THREE.Mesh;
  restY: number;
  isBase?: boolean;
}

export function createGame(): Game {
  const meta = gameMeta('stack')!;
  let ctx: GameContext;
  let phys: Physics3D;

  let renderer: THREE.WebGLRenderer;
  let scene: THREE.Scene;
  let camera: THREE.PerspectiveCamera;
  let sun: THREE.DirectionalLight;
  let crateGeo: THREE.BoxGeometry;
  let crateEdges: THREE.EdgesGeometry;
  let dropMarker: THREE.LineLoop;
  let beacons: THREE.Mesh[] = [];

  const bodies: Placed[] = [];
  const tmp: BodyState3D = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, awake: false, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 };
  const hit: HitEvent = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, speed: 0, slotA: 0, userA: 0, slotB: 0, userB: 0 };

  let mode: 'idle' | 'swing' | 'falling' | 'collapsing' | 'over' = 'idle';
  let score = 0;
  let combo = 0;
  let maxPerfectStreak = 0;
  let swingPhase = 0;
  let swingAxis: 'x' | 'z' = 'x';
  let craneMesh: THREE.Mesh | null = null;
  let fallingBody: Placed | null = null;
  let fallTimer = 0;
  let towerTopY = BASE_HALF.y;
  let collapseTimer = 0;
  let camY = 6;
  let shake = 0;
  let time = 0;
  let detachInput: (() => void) | null = null;
  const rings: THREE.Mesh[] = [];
  let ringGeo: THREE.RingGeometry;

  function crateColor(index: number): THREE.Color {
    const hue = (0.03 + index * 0.023) % 1;
    return new THREE.Color().setHSL(hue, 0.72, 0.58);
  }

  function makeCrateMesh(index: number): THREE.Mesh {
    const mat = new THREE.MeshStandardMaterial({ color: crateColor(index), roughness: 0.42, metalness: 0.12 });
    const mesh = new THREE.Mesh(crateGeo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const line = new THREE.LineSegments(crateEdges, new THREE.LineBasicMaterial({ color: '#0b0e1a', transparent: true, opacity: 0.35 }));
    mesh.add(line);
    return mesh;
  }

  function spawnRing(x: number, y: number, z: number, hot: boolean): void {
    if (ctx.settings().reducedMotion) return;
    const mat = new THREE.MeshBasicMaterial({
      color: hot ? '#ff5d73' : '#ffb454',
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(ringGeo, mat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, y + 0.02, z);
    ring.userData['life'] = 0;
    scene.add(ring);
    rings.push(ring);
  }

  function updateRings(dt: number): void {
    for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i]!;
      r.userData['life'] += dt;
      const t = (r.userData['life'] as number) / 0.55;
      r.scale.setScalar(1.4 + t * 4.2);
      (r.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - t);
      if (t >= 1) {
        scene.remove(r);
        (r.material as THREE.Material).dispose();
        rings.splice(i, 1);
      }
    }
  }

  /** Star-threshold beacon lights on the tower at ★ heights (adaptation twist). */
  function buildBeacons(): void {
    beacons.forEach((b) => scene.remove(b));
    beacons = [];
    const thresholds = STAR_THRESHOLDS[meta.id];
    const colors = ['#ffd75e', '#ffb454', '#ff5d73'];
    thresholds.forEach((t, i) => {
      const y = BASE_HALF.y + t * CRATE_HALF.y * 2;
      const geo = new THREE.TorusGeometry(BASE_HALF.x + 1.2, 0.05, 8, 40);
      const mat = new THREE.MeshBasicMaterial({ color: colors[i], transparent: true, opacity: 0.35 });
      const ring = new THREE.Mesh(geo, mat);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = y;
      scene.add(ring);
      beacons.push(ring);
    });
  }

  function towerTopBlock(): Placed | null {
    return bodies.length > 0 ? bodies[bodies.length - 1]! : null;
  }

  function spawnCrane(): void {
    craneMesh = makeCrateMesh(score);
    craneMesh.castShadow = false; // angled shadow misleads aim; dropMarker shows truth
    craneMesh.position.set(0, towerTopY + SPAWN_RISE, 0);
    scene.add(craneMesh);
    swingAxis = score % 2 === 0 ? 'x' : 'z';
    swingPhase = ctx.rng.float() * Math.PI * 2;
  }

  function dropCrate(): void {
    if (mode !== 'swing' || !craneMesh) return;
    craneMesh.castShadow = true;
    dropMarker.visible = false;
    const p = craneMesh.position;
    const handle = phys.createBody({ type: BODY_DYNAMIC, position: [p.x, p.y, p.z] });
    phys.addBox(handle, CRATE_HALF.x, CRATE_HALF.y, CRATE_HALF.z, { density: 1, friction: 0.75, restitution: 0.02, flags: SHAPE_HIT_EVENTS });
    fallingBody = { handle, mesh: craneMesh, restY: 0 };
    craneMesh = null;
    fallTimer = 0;
    mode = 'falling';
    ctx.audio.whoosh();
  }

  function startCollapse(): void {
    if (mode === 'collapsing' || mode === 'over') return;
    mode = 'collapsing';
    collapseTimer = 0;
    if (craneMesh) {
      scene.remove(craneMesh);
      craneMesh = null;
    }
    if (fallingBody) {
      bodies.push({ ...fallingBody, restY: fallingBody.mesh.position.y });
      fallingBody = null;
    }
    ctx.audio.womp();
    ctx.audio.buzz(60);
  }

  function finalizeGameOver(): void {
    mode = 'over';
    ctx.endRun({ score, durationMs: 0, seed: 0, stats: { maxPerfectStreak } });
  }

  function resolveLanding(): void {
    const top = towerTopBlock();
    if (!top || !fallingBody) return;
    const dx = Math.abs(tmp.x - top.mesh.position.x);
    const dz = Math.abs(tmp.z - top.mesh.position.z);
    const offset = Math.hypot(dx, dz);
    const supported = dx < CRATE_HALF.x * 2 * 0.92 && dz < CRATE_HALF.z * 2 * 0.92 && tmp.y > towerTopY - 0.3;

    if (!supported) {
      startCollapse();
      return;
    }

    bodies.push({ ...fallingBody, restY: tmp.y });
    fallingBody = null;
    score += 1;
    ctx.hud.setScore(score);
    towerTopY = tmp.y + CRATE_HALF.y;

    const perfect = offset < PERFECT_OFFSET;
    if (perfect) {
      combo += 1;
      maxPerfectStreak = Math.max(maxPerfectStreak, combo);
      ctx.hud.showCombo(combo > 1 ? `PERFECT ×${combo}` : 'PERFECT', combo >= 3);
      ctx.audio.chime(combo);
      ctx.audio.buzz(15);
      spawnRing(tmp.x, towerTopY, tmp.z, combo >= 3);
    } else {
      combo = 0;
    }

    spawnCrane();
    mode = 'swing';
  }

  return {
    meta,
    async init(context: GameContext): Promise<void> {
      ctx = context;
      phys = await ctx.physics3d();

      renderer = new THREE.WebGLRenderer({ canvas: ctx.canvas, antialias: true });
      renderer.setPixelRatio(ctx.dpr);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;

      scene = new THREE.Scene();
      const bg = ctx.colors().bg;
      scene.background = new THREE.Color(bg);
      scene.fog = new THREE.Fog(bg, 26, 60);

      camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
      scene.add(new THREE.HemisphereLight('#8fa3ff', '#1a1030', 0.85));
      sun = new THREE.DirectionalLight('#ffe3b8', 2.2);
      sun.position.set(9, 16, 7);
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      sun.shadow.camera.near = 1;
      sun.shadow.camera.far = 60;
      sun.shadow.camera.left = -14;
      sun.shadow.camera.right = 14;
      sun.shadow.camera.top = 22;
      sun.shadow.camera.bottom = -14;
      scene.add(sun);
      scene.add(sun.target);

      const floor = new THREE.Mesh(new THREE.CircleGeometry(60, 48), new THREE.MeshStandardMaterial({ color: '#101736', roughness: 1 }));
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -BASE_HALF.y;
      floor.receiveShadow = true;
      scene.add(floor);

      crateGeo = new THREE.BoxGeometry(CRATE_HALF.x * 2, CRATE_HALF.y * 2, CRATE_HALF.z * 2);
      crateEdges = new THREE.EdgesGeometry(crateGeo);
      ringGeo = new THREE.RingGeometry(1, 1.18, 40);

      const markerGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-CRATE_HALF.x, 0, -CRATE_HALF.z),
        new THREE.Vector3(CRATE_HALF.x, 0, -CRATE_HALF.z),
        new THREE.Vector3(CRATE_HALF.x, 0, CRATE_HALF.z),
        new THREE.Vector3(-CRATE_HALF.x, 0, CRATE_HALF.z),
      ]);
      dropMarker = new THREE.LineLoop(markerGeo, new THREE.LineBasicMaterial({ color: '#ffb454', transparent: true, opacity: 0.6, depthWrite: false }));
      dropMarker.visible = false;
      scene.add(dropMarker);

      const resize = (w: number, h: number): void => {
        renderer.setSize(w, h, true);
        camera.aspect = w / h;
        const BASE_FOV = 42;
        if (camera.aspect < 1) {
          // portrait: hold the horizontal field so the full swing stays in frame
          const hHalf = Math.tan(THREE.MathUtils.degToRad(BASE_FOV / 2));
          camera.fov = Math.min(THREE.MathUtils.radToDeg(2 * Math.atan(hHalf / camera.aspect)), 82);
        } else {
          camera.fov = BASE_FOV;
        }
        camera.updateProjectionMatrix();
      };
      ctx.onResize(resize);
      resize(ctx.width, ctx.height);

      detachInput = ctx.input.onAction(() => dropCrate());
    },

    start(): void {
      for (const b of bodies) scene.remove(b.mesh);
      bodies.length = 0;
      if (craneMesh) {
        scene.remove(craneMesh);
        craneMesh = null;
      }
      if (fallingBody) {
        scene.remove(fallingBody.mesh);
        fallingBody = null;
      }
      phys.init(0, -10, 0);

      const ground = phys.createBody({ type: BODY_STATIC, position: [0, -BASE_HALF.y - 0.5, 0] });
      phys.addBox(ground, 60, 0.5, 60, { friction: 0.8 });

      const basePedestal = phys.createBody({ type: BODY_STATIC, position: [0, 0, 0] });
      phys.addBox(basePedestal, BASE_HALF.x, BASE_HALF.y, BASE_HALF.z, { friction: 0.9 });
      const baseMesh = new THREE.Mesh(
        new THREE.BoxGeometry(BASE_HALF.x * 2, BASE_HALF.y * 2, BASE_HALF.z * 2),
        new THREE.MeshStandardMaterial({ color: '#2a3566', roughness: 0.7, metalness: 0.15 }),
      );
      baseMesh.receiveShadow = true;
      baseMesh.castShadow = true;
      scene.add(baseMesh);
      bodies.push({ handle: -1, mesh: baseMesh, restY: 0, isBase: true });

      score = 0;
      combo = 0;
      maxPerfectStreak = 0;
      towerTopY = BASE_HALF.y;
      camY = 6;
      buildBeacons();
      ctx.hud.setScore(0);
      ctx.hud.setSub('tap to drop');
      spawnCrane();
      mode = 'swing';
    },

    step(dt: number): void {
      if (mode === 'idle' || mode === 'over') return;
      time += dt;
      phys.step(dt, SUBSTEPS);

      for (const b of bodies) {
        if (b.isBase) continue;
        if (phys.readBody(b.handle, tmp)) {
          b.mesh.position.set(tmp.x, tmp.y, tmp.z);
          b.mesh.quaternion.set(tmp.qx, tmp.qy, tmp.qz, tmp.qw);
        }
      }

      for (let i = 0; i < phys.hitCount(); i++) {
        phys.readHit(i, hit);
        ctx.audio.thud(hit.speed);
        if (!ctx.settings().reducedMotion) shake = Math.min(shake + hit.speed * 0.012, 0.35);
      }

      if (mode === 'falling' && fallingBody) {
        fallTimer += dt;
        if (phys.readBody(fallingBody.handle, tmp)) {
          fallingBody.mesh.position.set(tmp.x, tmp.y, tmp.z);
          fallingBody.mesh.quaternion.set(tmp.qx, tmp.qy, tmp.qz, tmp.qw);
          if (tmp.y < KILL_Y) {
            startCollapse();
            return;
          }
          const speed = Math.hypot(tmp.vx, tmp.vy, tmp.vz);
          if ((speed < SETTLE_SPEED && fallTimer > 0.35) || fallTimer > 4) {
            resolveLanding();
          }
        }
      }

      if (mode === 'collapsing') {
        collapseTimer += dt;
        let allQuiet = true;
        for (const b of bodies) {
          if (b.isBase) continue;
          if (phys.readBody(b.handle, tmp) && Math.hypot(tmp.vx, tmp.vy, tmp.vz) > 0.4) {
            allQuiet = false;
            break;
          }
        }
        if ((allQuiet && collapseTimer > 1.2) || collapseTimer > 4.5) {
          finalizeGameOver();
        }
      }

      if (mode === 'swing' || mode === 'falling') {
        for (const b of bodies) {
          if (b.isBase) continue;
          if (b.mesh.position.y < KILL_Y || b.mesh.position.y < b.restY - 2.2) {
            startCollapse();
            break;
          }
        }
      }

      // crane swing (kinematic-by-hand, matches reference feel)
      if (mode === 'swing' && craneMesh) {
        const speed = SWING_SPEED_BASE + score * SWING_SPEED_GAIN;
        swingPhase += dt * speed;
        const offset = Math.sin(swingPhase) * SWING_AMPLITUDE;
        const y = towerTopY + SPAWN_RISE + Math.cos(swingPhase * 2.3) * 0.15;
        if (swingAxis === 'x') craneMesh.position.set(offset, y, 0);
        else craneMesh.position.set(0, y, offset);
        craneMesh.rotation.z = swingAxis === 'x' ? Math.sin(swingPhase) * -0.06 : 0;
        craneMesh.rotation.x = swingAxis === 'z' ? Math.sin(swingPhase) * 0.06 : 0;

        dropMarker.position.set(craneMesh.position.x, towerTopY + 0.04, craneMesh.position.z);
        const hold = Math.max(1.15 - score * 0.03, 0.35);
        const cycle = (time * 1) % (hold + 1.6);
        let a = 0;
        if (cycle < 0.3) a = cycle / 0.3;
        else if (cycle < 0.3 + hold) a = 1;
        else if (cycle < 0.75 + hold) a = 1 - (cycle - 0.3 - hold) / 0.45;
        (dropMarker.material as THREE.LineBasicMaterial).opacity = a * 0.7;
        dropMarker.visible = a > 0.02;
      } else {
        dropMarker.visible = false;
      }

      updateRings(dt);
      shake = Math.max(shake - dt * 1.4, 0);
      if (score > 0) ctx.hud.setSub('');
    },

    render(): void {
      const dt = 1 / 60;
      const targetY = Math.max(towerTopY, BASE_HALF.y) + 3.2;
      camY += (targetY - camY) * Math.min(dt * 2.4, 1);
      const sx = (Math.random() - 0.5) * shake;
      const sy2 = (Math.random() - 0.5) * shake;
      camera.position.set(10.5 + sx, camY + 4.4 + sy2, 12.5);
      camera.lookAt(0, camY - 1.4, 0);
      sun.position.set(9, camY + 12, 7);
      sun.target.position.set(0, camY - 4, 0);

      // beacons pulse gently near the current height
      for (const b of beacons) {
        const d = Math.abs(b.position.y - towerTopY);
        (b.material as THREE.MeshBasicMaterial).opacity = d < 3 ? 0.7 : 0.3;
      }

      renderer.render(scene, camera);
    },

    dispose(): void {
      detachInput?.();
      phys.init(0, -10, 0);
      renderer.dispose();
      crateGeo.dispose();
      crateEdges.dispose();
      ringGeo.dispose();
    },
  };
}
