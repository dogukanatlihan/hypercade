// Thin TS wrapper over the Box3D WASM shim (wasm/shim3d.c).
// State buffer layout per slot (16 floats):
// [0-2] pos, [3-6] quat (x,y,z,w), [7] awake, [8] valid, [9-11] linear vel, [12-14] angular vel, [15] reserved
//
// Handles are generation-checked ints from the shim: (gen << 16) | slot.
// Use slotOf(handle) to index the state buffer.

import createBox3d from './gen/box3d.mjs';

export const BODY_STATIC = 0;
export const BODY_KINEMATIC = 1;
export const BODY_DYNAMIC = 2;

export const SHAPE_SENSOR = 1;
export const SHAPE_CONTACT_EVENTS = 2;
export const SHAPE_HIT_EVENTS = 4;

export function slotOf(handle: number): number {
  return handle & 0xffff;
}

export interface Body3DOptions {
  type?: number;
  position?: readonly [number, number, number];
  rotation?: readonly [number, number, number, number];
  linearDamping?: number;
  angularDamping?: number;
  gravityScale?: number;
  enableSleep?: boolean;
  bullet?: boolean;
}

export interface Shape3DOptions {
  density?: number;
  friction?: number;
  restitution?: number;
  flags?: number;
}

export interface BodyState3D {
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  awake: boolean;
  vx: number;
  vy: number;
  vz: number;
  wx: number;
  wy: number;
  wz: number;
}

export interface HitEvent {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
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

export interface RayHit {
  hit: boolean;
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
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
export async function loadBox3d(): Promise<EmscriptenModule> {
  if (!modulePromise) {
    modulePromise = createBox3d() as Promise<EmscriptenModule>;
  }
  return modulePromise;
}

export class Physics3D {
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

  static async create(gravity: readonly [number, number, number] = [0, -10, 0]): Promise<Physics3D> {
    const mod = await loadBox3d();
    return new Physics3D(mod, gravity);
  }

  constructor(mod: EmscriptenModule, gravity: readonly [number, number, number]) {
    this.mod = mod;
    this.stride = this.call('_w3_GetStateStride');
    this.maxBodies = this.call('_w3_GetMaxBodies');
    this.init(gravity[0], gravity[1], gravity[2]);
  }

  private call(name: string, ...args: number[]): number {
    return (this.mod[name] as Fn)(...args);
  }

  init(gx: number, gy: number, gz: number): void {
    this.call('_w3_Init', gx, gy, gz);
    this.statesPtr = this.call('_w3_GetStatesPtr');
    this.hitsPtr = this.call('_w3_GetHitsPtr');
    this.contactBeginPtr = this.call('_w3_GetContactBeginPtr');
    this.contactEndPtr = this.call('_w3_GetContactEndPtr');
    this.sensorBeginPtr = this.call('_w3_GetSensorBeginPtr');
    this.sensorEndPtr = this.call('_w3_GetSensorEndPtr');
    this.rayPtr = this.call('_w3_GetRayResultPtr');
  }

  setGravity(gx: number, gy: number, gz: number): void {
    this.call('_w3_SetGravity', gx, gy, gz);
  }

  setHitEventThreshold(speed: number): void {
    this.call('_w3_SetHitEventThreshold', speed);
  }

  createBody(opts: Body3DOptions = {}): number {
    const p = opts.position ?? [0, 0, 0];
    const q = opts.rotation ?? [0, 0, 0, 1];
    return this.call(
      '_w3_CreateBody',
      opts.type ?? BODY_DYNAMIC,
      p[0], p[1], p[2],
      q[0], q[1], q[2], q[3],
      opts.linearDamping ?? 0,
      opts.angularDamping ?? 0,
      opts.gravityScale ?? 1,
      opts.enableSleep === false ? 0 : 1,
      opts.bullet ? 1 : 0,
    );
  }

  addBox(handle: number, hx: number, hy: number, hz: number, opts: Shape3DOptions = {}): void {
    this.call('_w3_AddBoxShape', handle, hx, hy, hz, opts.density ?? 1, opts.friction ?? 0.6, opts.restitution ?? 0, opts.flags ?? 0);
  }

  addBoxOffset(
    handle: number,
    hx: number, hy: number, hz: number,
    offset: readonly [number, number, number],
    rotation: readonly [number, number, number, number] = [0, 0, 0, 1],
    opts: Shape3DOptions = {},
  ): void {
    this.call(
      '_w3_AddBoxShapeOffset', handle, hx, hy, hz,
      offset[0], offset[1], offset[2],
      rotation[0], rotation[1], rotation[2], rotation[3],
      opts.density ?? 1, opts.friction ?? 0.6, opts.restitution ?? 0, opts.flags ?? 0,
    );
  }

  addSphere(handle: number, radius: number, opts: Shape3DOptions & { center?: readonly [number, number, number] } = {}): void {
    const c = opts.center ?? [0, 0, 0];
    this.call('_w3_AddSphereShape', handle, c[0], c[1], c[2], radius, opts.density ?? 1, opts.friction ?? 0.6, opts.restitution ?? 0, opts.flags ?? 0);
  }

  addCapsule(
    handle: number,
    p1: readonly [number, number, number],
    p2: readonly [number, number, number],
    radius: number,
    opts: Shape3DOptions = {},
  ): void {
    this.call(
      '_w3_AddCapsuleShape', handle,
      p1[0], p1[1], p1[2], p2[0], p2[1], p2[2], radius,
      opts.density ?? 1, opts.friction ?? 0.6, opts.restitution ?? 0, opts.flags ?? 0,
    );
  }

  destroyBody(handle: number): void {
    this.call('_w3_DestroyBody', handle);
  }

  isValid(handle: number): boolean {
    return this.call('_w3_IsValid', handle) !== 0;
  }

  setUserData(handle: number, value: number): void {
    this.call('_w3_SetUserData', handle, value);
  }

  getUserData(handle: number): number {
    return this.call('_w3_GetUserData', handle);
  }

  setTransform(handle: number, px: number, py: number, pz: number, qx = 0, qy = 0, qz = 0, qw = 1): void {
    this.call('_w3_SetTransform', handle, px, py, pz, qx, qy, qz, qw);
  }

  setTargetTransform(handle: number, px: number, py: number, pz: number, qx: number, qy: number, qz: number, qw: number, dt: number): void {
    this.call('_w3_SetTargetTransform', handle, px, py, pz, qx, qy, qz, qw, dt);
  }

  setLinearVelocity(handle: number, vx: number, vy: number, vz: number): void {
    this.call('_w3_SetLinearVelocity', handle, vx, vy, vz);
  }

  setAngularVelocity(handle: number, wx: number, wy: number, wz: number): void {
    this.call('_w3_SetAngularVelocity', handle, wx, wy, wz);
  }

  applyImpulse(handle: number, ix: number, iy: number, iz: number): void {
    this.call('_w3_ApplyImpulse', handle, ix, iy, iz);
  }

  applyImpulseAt(handle: number, ix: number, iy: number, iz: number, px: number, py: number, pz: number): void {
    this.call('_w3_ApplyImpulseAt', handle, ix, iy, iz, px, py, pz);
  }

  applyForce(handle: number, fx: number, fy: number, fz: number): void {
    this.call('_w3_ApplyForce', handle, fx, fy, fz);
  }

  applyTorque(handle: number, tx: number, ty: number, tz: number): void {
    this.call('_w3_ApplyTorque', handle, tx, ty, tz);
  }

  setGravityScale(handle: number, scale: number): void {
    this.call('_w3_SetGravityScale', handle, scale);
  }

  setAwake(handle: number, awake: boolean): void {
    this.call('_w3_SetAwake', handle, awake ? 1 : 0);
  }

  setEnabled(handle: number, enabled: boolean): void {
    this.call('_w3_SetEnabled', handle, enabled ? 1 : 0);
  }

  setBodyType(handle: number, type: number): void {
    this.call('_w3_SetBodyType', handle, type);
  }

  setFilter(handle: number, categoryBits: number, maskBits: number, groupIndex = 0): void {
    this.call('_w3_SetFilter', handle, categoryBits, maskBits, groupIndex);
  }

  getMass(handle: number): number {
    return this.call('_w3_GetMass', handle);
  }

  // ---- joints ----

  createRevoluteJoint(
    handleA: number, handleB: number,
    anchor: readonly [number, number, number],
    axis: readonly [number, number, number],
    opts: { lower?: number; upper?: number; enableLimit?: boolean; motorSpeed?: number; maxMotorTorque?: number; enableMotor?: boolean; collideConnected?: boolean } = {},
  ): number {
    return this.call(
      '_w3_CreateRevoluteJoint', handleA, handleB,
      anchor[0], anchor[1], anchor[2], axis[0], axis[1], axis[2],
      opts.lower ?? 0, opts.upper ?? 0, opts.enableLimit ? 1 : 0,
      opts.motorSpeed ?? 0, opts.maxMotorTorque ?? 0, opts.enableMotor ? 1 : 0,
      opts.collideConnected ? 1 : 0,
    );
  }

  createPrismaticJoint(
    handleA: number, handleB: number,
    anchor: readonly [number, number, number],
    axis: readonly [number, number, number],
    opts: { lower?: number; upper?: number; enableLimit?: boolean; motorSpeed?: number; maxMotorForce?: number; enableMotor?: boolean } = {},
  ): number {
    return this.call(
      '_w3_CreatePrismaticJoint', handleA, handleB,
      anchor[0], anchor[1], anchor[2], axis[0], axis[1], axis[2],
      opts.lower ?? 0, opts.upper ?? 0, opts.enableLimit ? 1 : 0,
      opts.motorSpeed ?? 0, opts.maxMotorForce ?? 0, opts.enableMotor ? 1 : 0,
    );
  }

  createDistanceJoint(
    handleA: number, handleB: number,
    anchorA: readonly [number, number, number],
    anchorB: readonly [number, number, number],
    length: number,
    opts: { minLength?: number; maxLength?: number; enableLimit?: boolean; hertz?: number; dampingRatio?: number; enableSpring?: boolean; collideConnected?: boolean } = {},
  ): number {
    return this.call(
      '_w3_CreateDistanceJoint', handleA, handleB,
      anchorA[0], anchorA[1], anchorA[2], anchorB[0], anchorB[1], anchorB[2],
      length, opts.minLength ?? length, opts.maxLength ?? length, opts.enableLimit ? 1 : 0,
      opts.hertz ?? 0, opts.dampingRatio ?? 0, opts.enableSpring ? 1 : 0,
      opts.collideConnected ? 1 : 0,
    );
  }

  createSphericalJoint(handleA: number, handleB: number, anchor: readonly [number, number, number], coneAngle = 0, enableConeLimit = false): number {
    return this.call('_w3_CreateSphericalJoint', handleA, handleB, anchor[0], anchor[1], anchor[2], coneAngle, enableConeLimit ? 1 : 0);
  }

  destroyJoint(jointHandle: number): void {
    this.call('_w3_DestroyJoint', jointHandle);
  }

  setMotorSpeed(jointHandle: number, speed: number): void {
    this.call('_w3_SetMotorSpeed', jointHandle, speed);
  }

  // ---- queries ----

  castRayClosest(
    origin: readonly [number, number, number],
    translation: readonly [number, number, number],
    categoryBits = 0xffffffff,
    maskBits = 0xffffffff,
    out: RayHit = { hit: false, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, fraction: 0, slot: -1 },
  ): RayHit {
    const hit = this.call('_w3_CastRayClosest', origin[0], origin[1], origin[2], translation[0], translation[1], translation[2], categoryBits, maskBits);
    const v = this.view(this.rayPtr, 8);
    out.hit = hit !== 0;
    out.x = v[0]!; out.y = v[1]!; out.z = v[2]!;
    out.nx = v[3]!; out.ny = v[4]!; out.nz = v[5]!;
    out.fraction = v[6]!;
    out.slot = v[7]!;
    return out;
  }

  // ---- step & state ----

  step(dt: number, substeps = 4): void {
    this.call('_w3_Step', dt, substeps);
  }

  /** Float32Array view over WASM memory. Re-created per call — memory growth detaches buffers. */
  private view(ptr: number, len: number): Float32Array {
    return new Float32Array(this.mod.HEAPF32.buffer, ptr, len);
  }

  states(): Float32Array {
    return this.view(this.statesPtr, this.maxBodies * this.stride);
  }

  /** Read one body's state into `out`. Returns false if the slot is invalid. */
  readBody(handle: number, out: BodyState3D): boolean {
    if (handle < 0) return false;
    const slot = slotOf(handle);
    if (slot >= this.maxBodies) return false;
    const s = this.states();
    const o = slot * this.stride;
    if (s[o + 8] === 0) return false;
    out.x = s[o]!; out.y = s[o + 1]!; out.z = s[o + 2]!;
    out.qx = s[o + 3]!; out.qy = s[o + 4]!; out.qz = s[o + 5]!; out.qw = s[o + 6]!;
    out.awake = s[o + 7]! > 0.5;
    out.vx = s[o + 9]!; out.vy = s[o + 10]!; out.vz = s[o + 11]!;
    out.wx = s[o + 12]!; out.wy = s[o + 13]!; out.wz = s[o + 14]!;
    return true;
  }

  hitCount(): number {
    return this.call('_w3_GetHitCount');
  }

  readHit(i: number, out: HitEvent): HitEvent {
    const v = this.view(this.hitsPtr + i * 12 * 4, 12);
    out.x = v[0]!; out.y = v[1]!; out.z = v[2]!;
    out.nx = v[3]!; out.ny = v[4]!; out.nz = v[5]!;
    out.speed = v[6]!;
    out.slotA = v[7]!; out.userA = v[8]!;
    out.slotB = v[9]!; out.userB = v[10]!;
    return out;
  }

  contactBeginCount(): number {
    return this.call('_w3_GetContactBeginCount');
  }

  readContactBegin(i: number, out: PairEvent): PairEvent {
    return this.readPair(this.contactBeginPtr, i, out);
  }

  contactEndCount(): number {
    return this.call('_w3_GetContactEndCount');
  }

  readContactEnd(i: number, out: PairEvent): PairEvent {
    return this.readPair(this.contactEndPtr, i, out);
  }

  sensorBeginCount(): number {
    return this.call('_w3_GetSensorBeginCount');
  }

  readSensorBegin(i: number, out: PairEvent): PairEvent {
    return this.readPair(this.sensorBeginPtr, i, out);
  }

  sensorEndCount(): number {
    return this.call('_w3_GetSensorEndCount');
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
