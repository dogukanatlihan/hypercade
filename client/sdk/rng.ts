// PCG32 seeded RNG — all game randomness flows through this (TECH-BRIEF §4).
// Deterministic per seed, which is what makes daily-challenge seeds free later.

export class Rng {
  private state: bigint;
  private inc: bigint;

  constructor(seed: number, seq = 54n) {
    this.state = 0n;
    this.inc = (seq << 1n) | 1n;
    this.next();
    this.state += BigInt(Math.floor(seed) >>> 0) + (BigInt(Math.floor(seed / 0x100000000) >>> 0) << 32n);
    this.next();
  }

  reseed(seed: number): void {
    this.state = 0n;
    this.next();
    this.state += BigInt(Math.floor(seed) >>> 0);
    this.next();
  }

  /** Uniform uint32. */
  next(): number {
    const old = this.state;
    this.state = (old * 6364136223846793005n + this.inc) & 0xffffffffffffffffn;
    const xorshifted = Number(((old >> 18n) ^ old) >> 27n & 0xffffffffn) >>> 0;
    const rot = Number(old >> 59n);
    return ((xorshifted >>> rot) | (xorshifted << (-rot & 31))) >>> 0;
  }

  /** Uniform float in [0, 1). */
  float(): number {
    return this.next() / 0x100000000;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + this.float() * (max - min);
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.float() * (max - min + 1));
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.float() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.float() * items.length)]!;
  }
}

/** Non-deterministic seed source for normal runs. */
export function randomSeed(): number {
  return (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
}
