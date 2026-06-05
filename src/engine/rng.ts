/**
 * Seeded PRNG (xoshiro128** variant, simplified for single-stream use).
 * Deterministic — same seed always produces the same sequence.
 *
 * Note: the core backtest is deterministic because it contains no randomness
 * (no Math.random, no wall-clock). The recorded `seed` is reserved for strategies
 * or extensions that need reproducible randomness; pass it to this RNG. It is not
 * required for the engine's own determinism.
 */
export class SeededRng {
  private s: Uint32Array;

  constructor(seed: number) {
    // Expand a single 53-bit seed into four 32-bit words via splitmix64.
    this.s = new Uint32Array(4);
    let z = (seed | 0) >>> 0;
    this.s[0] = splitmix32((z = splitmix32(z)));
    this.s[1] = splitmix32((z = splitmix32(z)));
    this.s[2] = splitmix32((z = splitmix32(z)));
    this.s[3] = splitmix32((z = splitmix32(z)));
  }

  /** Return a float in [0, 1). */
  next(): number {
    return (this.nextU32() >>> 8) / 0x1000000; // top 24 bits
  }

  /** Return a 32-bit unsigned integer. */
  nextU32(): number {
    const s = this.s;
    const t = (s[1]! << 9) >>> 0;
    let r = (s[0]! * 5) >>> 0;
    r = ((r << 7) | (r >>> 25)) * 9;
    s[2]! ^= s[0]!;
    s[3]! ^= s[1]!;
    s[1]! ^= s[2]!;
    s[0]! ^= s[3]!;
    s[2]! ^= t;
    s[3]! = ((s[3]! << 11) | (s[3]! >>> 21)) >>> 0;
    return r >>> 0;
  }
}

function splitmix32(z: number): number {
  z = ((z >>> 0) + 0x9e3779b9) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  return (z ^ (z >>> 16)) >>> 0;
}
