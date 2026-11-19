import { PyException } from "./str.ts";

const N = 624;
const M = 397;
const TWO_PI = 2 * Math.PI;

export class Random {
  private readonly mt = new Uint32Array(N);
  private index = N + 1;
  private gaussNext: number | null = null;

  constructor(seed?: bigint | number) {
    if (seed === undefined) this.seedWords(Array.from(crypto.getRandomValues(new Uint32Array(N))));
    else this.seed(seed);
  }

  seed(seed: bigint | number): void {
    let value = typeof seed === "bigint" ? seed : BigInt(Math.trunc(seed));
    if (value < 0n) value = -value;
    const words: number[] = [];
    while (value > 0n) {
      words.push(Number(value & 0xffffffffn));
      value >>= 32n;
    }
    this.seedWords(words.length ? words : [0]);
  }

  private initGenrand(seed: number): void {
    const mt = this.mt;
    mt[0] = seed >>> 0;
    for (let i = 1; i < N; i += 1) {
      const previous = (mt[i - 1] as number) ^ ((mt[i - 1] as number) >>> 30);
      mt[i] = (Math.imul(1812433253, previous) + i) >>> 0;
    }
    this.index = N;
  }

  private seedWords(key: number[]): void {
    this.initGenrand(19650218);
    const mt = this.mt;
    let i = 1;
    let j = 0;
    for (let k = Math.max(N, key.length); k > 0; k -= 1) {
      const previous = (mt[i - 1] as number) ^ ((mt[i - 1] as number) >>> 30);
      mt[i] = (((mt[i] as number) ^ Math.imul(previous, 1664525)) + (key[j] as number) + j) >>> 0;
      i += 1;
      j += 1;
      if (i >= N) {
        mt[0] = mt[N - 1] as number;
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (let k = N - 1; k > 0; k -= 1) {
      const previous = (mt[i - 1] as number) ^ ((mt[i - 1] as number) >>> 30);
      mt[i] = (((mt[i] as number) ^ Math.imul(previous, 1566083941)) - i) >>> 0;
      i += 1;
      if (i >= N) {
        mt[0] = mt[N - 1] as number;
        i = 1;
      }
    }
    mt[0] = 0x80000000;
    this.index = N;
    this.gaussNext = null;
  }

  private twist(): void {
    const mt = this.mt;
    for (let kk = 0; kk < N; kk += 1) {
      const y = ((mt[kk] as number) & 0x80000000) | ((mt[(kk + 1) % N] as number) & 0x7fffffff);
      mt[kk] = ((mt[(kk + M) % N] as number) ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0)) >>> 0;
    }
    this.index = 0;
  }

  genrand(): number {
    if (this.index >= N) this.twist();
    let y = this.mt[this.index] as number;
    this.index += 1;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  random(): number {
    const a = this.genrand() >>> 5;
    const b = this.genrand() >>> 6;
    return (a * 67108864 + b) / 9007199254740992;
  }

  getrandbits(k: number): bigint {
    if (k < 0) throw new PyException("ValueError", "number of bits must be non-negative");
    if (k <= 32) return BigInt(k === 0 ? 0 : this.genrand() >>> (32 - k));
    let out = 0n;
    let shift = 0n;
    for (let left = k; left > 0; left -= 32) {
      let word = this.genrand();
      if (left < 32) word >>>= 32 - left;
      out |= BigInt(word) << shift;
      shift += 32n;
    }
    return out;
  }

  randbelow(n: number): number {
    if (n <= 0) return 0;
    const width = n.toString(2).length;
    let r = Number(this.getrandbits(width));
    while (r >= n) r = Number(this.getrandbits(width));
    return r;
  }

  uniform(a: number, b: number): number {
    return a + (b - a) * this.random();
  }

  randint(a: number, b: number): number {
    const width = b + 1 - a;
    if (width <= 0) throw new PyException("ValueError", `empty range in randrange(${a}, ${b + 1})`);
    return a + this.randbelow(width);
  }

  choice<T>(items: readonly T[]): T {
    if (items.length === 0) throw new PyException("IndexError", "Cannot choose from an empty sequence");
    return items[this.randbelow(items.length)] as T;
  }

  gauss(mu = 0, sigma = 1): number {
    let z = this.gaussNext;
    this.gaussNext = null;
    if (z === null) {
      const x2pi = this.random() * TWO_PI;
      const g2rad = Math.sqrt(-2 * Math.log(1 - this.random()));
      z = Math.cos(x2pi) * g2rad;
      this.gaussNext = Math.sin(x2pi) * g2rad;
    }
    return mu + z * sigma;
  }
}

let shared = new Random();

export function rng(): Random {
  return shared;
}

export function seedShared(seed: bigint | number): void {
  shared = new Random(seed);
}
