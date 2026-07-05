// Thin TS wrapper over the Box2D v3 WASM shim (wasm/shim2d.c).
// Mirrors physics3d.ts — same handle scheme, same event surface.
// State buffer layout per slot (8 floats):
// [0-1] pos, [2] angle (radians), [3] awake, [4] valid, [5-6] linear vel, [7] angular vel

import createBox2d from './gen/box2d.mjs';

export const BODY_STATIC = 0;
export const BODY_KINEMATIC = 1;
export const BODY_DYNAMIC = 2;

export const SHAPE_SENSOR = 1;
export const SHAPE_CONTACT_EVENTS = 2;
export const SHAPE_HIT_EVENTS = 4;

export function slotOf(handle: number): number {
  return handle & 0xffff;
}

export interface Body2DOptions {
  type?: number;
  position?: readonly [number, number];
  angle?: number;
  linearDamping?: number;
  angularDamping?: number;
  gravityScale?: number;
  enableSleep?: boolean;
  bullet?: boolean;
  fixedRotation?: boolean;
}

export interface Shape2DOptions {
  density?: number;
  friction?: number;
  restitution?: number;
  flags?: number;
}

export interface BodyState2D {
  x: number;
  y: number;
  angle: number;
  awake: boolean;
  vx: number;
  vy: number;
  w: number;
}

export interface HitEvent2D {
  x: number;
  y: number;
  nx: number;
  ny: number;
  speed: number;
  slotA: number;
  userA: number;
  slotB: number;
  userB: number;
}

export interface PairEvent {
  slotA: number;
  userA: number;
  slotB: number;
  userB: number;
}

export interface RayHit2D {
  hit: boolean;
  x: number;
  y: number;
  nx: number;
  ny: number;
  fraction: number;
  slot: number;
}

interface EmscriptenModule {
  HEAPF32: Float32Array;
  [fn: string]: unknown;
}

type Fn = (...args: number[]) => number;

let modulePromise: Promise<EmscriptenModule> | null = null;

/** The engine WASM loads once per session; the world resets between games. */
export async function loadBox2d(): Promise<EmscriptenModule> {
  if (!modulePromise) {
    modulePromise = createBox2d() as Promise<EmscriptenModule>;
  }
  return modulePromise;
}

export class Physics2D {
  private readonly mod: EmscriptenModule;
  readonly stride: number;
  readonly maxBodies: number;
  private statesPtr = 0;
  private hitsPtr = 0;
  private contactBeginPtr = 0;
  private contactEndPtr = 0;
  private sensorBeginPtr = 0;
  private sensorEndPtr = 0;
  private rayPtr = 0;

  static async create(gravity: readonly [number, number] = [0, -10]): Promise<Physics2D> {
    const mod = await loadBox2d();
    return new Physics2D(mod, gravity);
  }

  constructor(mod: EmscriptenModule, gravity: readonly [number, number]) {
    this.mod = mod;
    this.stride = this.call('_w2_GetStateStride');
    this.maxBodies = this.call('_w2_GetMaxBodies');
    this.init(gravity[0], gravity[1]);
  }

  private call(name: string, ...args: number[]): number {
    return (this.mod[name] as Fn)(...args);
  }

  init(gx: number, gy: number): void {
    this.call('_w2_Init', gx, gy);
    this.statesPtr = this.call('_w2_GetStatesPtr');
    this.hitsPtr = this.call('_w2_GetHitsPtr');
    this.contactBeginPtr = this.call('_w2_GetContactBeginPtr');
    this.contactEndPtr = this.call('_w2_GetContactEndPtr');
    this.sensorBeginPtr = this.call('_w2_GetSensorBeginPtr');
    this.sensorEndPtr = this.call('_w2_GetSensorEndPtr');
    this.rayPtr = this.call('_w2_GetRayResultPtr');
  }

  setGravity(gx: number, gy: number): void {
    this.call('_w2_SetGravity', gx, gy);
  }

  setHitEventThreshold(speed: number): void {
    this.call('_w2_SetHitEventThreshold', speed);
  }

  createBody(opts: Body2DOptions = {}): number {
    const p = opts.position ?? [0, 0];
    return this.call(
      '_w2_CreateBody',
      opts.type ?? BODY_DYNAMIC,
      p[0], p[1],
      opts.angle ?? 0,
      opts.linearDamping ?? 0,
      opts.angularDamping ?? 0,
      opts.gravityScale ?? 1,
      opts.enableSleep === false ? 0 : 1,
      opts.bullet ? 1 : 0,
      opts.fixedRotation ? 1 : 0,
    );
  }

  addBox(handle: number, hx: number, hy: number, opts: Shape2DOptions = {}): void {
    this.call('_w2_AddBoxShape', handle, hx, hy, opts.density ?? 1, opts.friction ?? 0.6, opts.restitution ?? 0, opts.flags ?? 0);
  }

  addBoxOffset(handle: number, hx: number, hy: number, ox: number, oy: number, angle = 0, opts: Shape2DOptions = {}): void {
    this.call('_w2_AddBoxShapeOffset', handle, hx, hy, ox, oy, angle, opts.density ?? 1, opts.friction ?? 0.6, opts.restitution ?? 0, opts.flags ?? 0);
  }

  addCircle(handle: number, radius: number, opts: Shape2DOptions & { center?: readonly [number, number] } = {}): void {
    const c = opts.center ?? [0, 0];
    this.call('_w2_AddCircleShape', handle, c[0], c[1], radius, opts.density ?? 1, opts.friction ?? 0.6, opts.restitution ?? 0, opts.flags ?? 0);
  }

  addCapsule(handle: number, p1: readonly [number, number], p2: readonly [number, number], radius: number, opts: Shape2DOptions = {}): void {
    this.call('_w2_AddCapsuleShape', handle, p1[0], p1[1], p2[0], p2[1], radius, opts.density ?? 1, opts.friction ?? 0.6, opts.restitution ?? 0, opts.flags ?? 0);
  }

  addSegment(handle: number, p1: readonly [number, number], p2: readonly [number, number], opts: Shape2DOptions = {}): void {
    this.call('_w2_AddSegmentShape', handle, p1[0], p1[1], p2[0], p2[1], opts.friction ?? 0.6, opts.restitution ?? 0, opts.flags ?? 0);
  }

  destroyBody(handle: number): void {
    this.call('_w2_DestroyBody', handle);
  }

  isValid(handle: number): boolean {
    return this.call('_w2_IsValid', handle) !== 0;
  }

  setUserData(handle: number, value: number): void {
    this.call('_w2_SetUserData', handle, value);
  }

  getUserData(handle: number): number {
    return this.call('_w2_GetUserData', handle);
  }

  setTransform(handle: number, px: number, py: number, angle = 0): void {
    this.call('_w2_SetTransform', handle, px, py, angle);
  }

  setTargetTransform(handle: number, px: number, py: number, angle: number, dt: number): void {
    this.call('_w2_SetTargetTransform', handle, px, py, angle, dt);
  }

  setLinearVelocity(handle: number, vx: number, vy: number): void {
    this.call('_w2_SetLinearVelocity', handle, vx, vy);
  }

  setAngularVelocity(handle: number, w: number): void {
    this.call('_w2_SetAngularVelocity', handle, w);
  }

  applyImpulse(handle: number, ix: number, iy: number): void {
    this.call('_w2_ApplyImpulse', handle, ix, iy);
  }

  applyImpulseAt(handle: number, ix: number, iy: number, px: number, py: number): void {
    this.call('_w2_ApplyImpulseAt', handle, ix, iy, px, py);
  }

  applyForce(handle: number, fx: number, fy: number): void {
    this.call('_w2_ApplyForce', handle, fx, fy);
  }

  applyTorque(handle: number, torque: number): void {
    this.call('_w2_ApplyTorque', handle, torque);
  }

  setGravityScale(handle: number, scale: number): void {
    this.call('_w2_SetGravityScale', handle, scale);
  }

  setAwake(handle: number, awake: boolean): void {
    this.call('_w2_SetAwake', handle, awake ? 1 : 0);
  }

  setEnabled(handle: number, enabled: boolean): void {
    this.call('_w2_SetEnabled', handle, enabled ? 1 : 0);
  }

  setBodyType(handle: number, type: number): void {
    this.call('_w2_SetBodyType', handle, type);
  }

  setFilter(handle: number, categoryBits: number, maskBits: number, groupIndex = 0): void {
    this.call('_w2_SetFilter', handle, categoryBits, maskBits, groupIndex);
  }

  getMass(handle: number): number {
    return this.call('_w2_GetMass', handle);
  }

  // ---- joints ----

  createRevoluteJoint(
    handleA: number, handleB: number,
    anchor: readonly [number, number],
    opts: { lower?: number; upper?: number; enableLimit?: boolean; motorSpeed?: number; maxMotorTorque?: number; enableMotor?: boolean; collideConnected?: boolean } = {},
  ): number {
    return this.call(
      '_w2_CreateRevoluteJoint', handleA, handleB, anchor[0], anchor[1],
      opts.lower ?? 0, opts.upper ?? 0, opts.enableLimit ? 1 : 0,
      opts.motorSpeed ?? 0, opts.maxMotorTorque ?? 0, opts.enableMotor ? 1 : 0,
      opts.collideConnected ? 1 : 0,
    );
  }

  createPrismaticJoint(
    handleA: number, handleB: number,
    anchor: readonly [number, number],
    axis: readonly [number, number],
    opts: { lower?: number; upper?: number; enableLimit?: boolean; motorSpeed?: number; maxMotorForce?: number; enableMotor?: boolean } = {},
  ): number {
    return this.call(
      '_w2_CreatePrismaticJoint', handleA, handleB, anchor[0], anchor[1], axis[0], axis[1],
      opts.lower ?? 0, opts.upper ?? 0, opts.enableLimit ? 1 : 0,
      opts.motorSpeed ?? 0, opts.maxMotorForce ?? 0, opts.enableMotor ? 1 : 0,
    );
  }

  createDistanceJoint(
    handleA: number, handleB: number,
    anchorA: readonly [number, number],
    anchorB: readonly [number, number],
    length: number,
    opts: { minLength?: number; maxLength?: number; enableLimit?: boolean; hertz?: number; dampingRatio?: number; enableSpring?: boolean; collideConnected?: boolean } = {},
  ): number {
    return this.call(
      '_w2_CreateDistanceJoint', handleA, handleB,
      anchorA[0], anchorA[1], anchorB[0], anchorB[1],
      length, opts.minLength ?? length, opts.maxLength ?? length, opts.enableLimit ? 1 : 0,
      opts.hertz ?? 0, opts.dampingRatio ?? 0, opts.enableSpring ? 1 : 0,
      opts.collideConnected ? 1 : 0,
    );
  }

  createMouseJoint(groundHandle: number, handle: number, target: readonly [number, number], opts: { hertz?: number; dampingRatio?: number; maxForce?: number } = {}): number {
    return this.call('_w2_CreateMouseJoint', groundHandle, handle, target[0], target[1], opts.hertz ?? 5, opts.dampingRatio ?? 0.7, opts.maxForce ?? 1000);
  }

  setMouseTarget(jointHandle: number, tx: number, ty: number): void {
    this.call('_w2_MouseJoint_SetTarget', jointHandle, tx, ty);
  }

  destroyJoint(jointHandle: number): void {
    this.call('_w2_DestroyJoint', jointHandle);
  }

  setMotorSpeed(jointHandle: number, speed: number): void {
    this.call('_w2_SetMotorSpeed', jointHandle, speed);
  }

  // ---- queries ----

  castRayClosest(
    origin: readonly [number, number],
    translation: readonly [number, number],
    categoryBits = 0xffffffff,
    maskBits = 0xffffffff,
    out: RayHit2D = { hit: false, x: 0, y: 0, nx: 0, ny: 0, fraction: 0, slot: -1 },
  ): RayHit2D {
    const hit = this.call('_w2_CastRayClosest', origin[0], origin[1], translation[0], translation[1], categoryBits, maskBits);
    const v = this.view(this.rayPtr, 8);
    out.hit = hit !== 0;
    out.x = v[0]!; out.y = v[1]!;
    out.nx = v[3]!; out.ny = v[4]!;
    out.fraction = v[6]!;
    out.slot = v[7]!;
    return out;
  }

  // ---- step & state ----

  step(dt: number, substeps = 4): void {
    this.call('_w2_Step', dt, substeps);
  }

  /** Float32Array view over WASM memory. Re-created per call — memory growth detaches buffers. */
  private view(ptr: number, len: number): Float32Array {
    return new Float32Array(this.mod.HEAPF32.buffer, ptr, len);
  }

  states(): Float32Array {
    return this.view(this.statesPtr, this.maxBodies * this.stride);
  }

  /** Read one body's state into `out`. Returns false if the slot is invalid. */
  readBody(handle: number, out: BodyState2D): boolean {
    if (handle < 0) return false;
    const slot = slotOf(handle);
    if (slot >= this.maxBodies) return false;
    const s = this.states();
    const o = slot * this.stride;
    if (s[o + 4] === 0) return false;
    out.x = s[o]!;
    out.y = s[o + 1]!;
    out.angle = s[o + 2]!;
    out.awake = s[o + 3]! > 0.5;
    out.vx = s[o + 5]!;
    out.vy = s[o + 6]!;
    out.w = s[o + 7]!;
    return true;
  }

  hitCount(): number {
    return this.call('_w2_GetHitCount');
  }

  readHit(i: number, out: HitEvent2D): HitEvent2D {
    const v = this.view(this.hitsPtr + i * 12 * 4, 12);
    out.x = v[0]!; out.y = v[1]!;
    out.nx = v[3]!; out.ny = v[4]!;
    out.speed = v[6]!;
    out.slotA = v[7]!; out.userA = v[8]!;
    out.slotB = v[9]!; out.userB = v[10]!;
    return out;
  }

  contactBeginCount(): number {
    return this.call('_w2_GetContactBeginCount');
  }

  readContactBegin(i: number, out: PairEvent): PairEvent {
    return this.readPair(this.contactBeginPtr, i, out);
  }

  contactEndCount(): number {
    return this.call('_w2_GetContactEndCount');
  }

  readContactEnd(i: number, out: PairEvent): PairEvent {
    return this.readPair(this.contactEndPtr, i, out);
  }

  sensorBeginCount(): number {
    return this.call('_w2_GetSensorBeginCount');
  }

  readSensorBegin(i: number, out: PairEvent): PairEvent {
    return this.readPair(this.sensorBeginPtr, i, out);
  }

  sensorEndCount(): number {
    return this.call('_w2_GetSensorEndCount');
  }

  readSensorEnd(i: number, out: PairEvent): PairEvent {
    return this.readPair(this.sensorEndPtr, i, out);
  }

  private readPair(ptr: number, i: number, out: PairEvent): PairEvent {
    const v = this.view(ptr + i * 4 * 4, 4);
    out.slotA = v[0]!;
    out.userA = v[1]!;
    out.slotB = v[2]!;
    out.userB = v[3]!;
    return out;
  }
}
