import { randomBytes } from "node:crypto";
import { Random, seedShared } from "../pylib/random.ts";

let seeded: Random | null = null;

export function seedTokens(seed: bigint | number | null): void {
  if (seed === null) {
    seeded = null;
    return;
  }
  seedShared(seed);
  seeded = new Random(BigInt(seed) + 1n);
}

export function tokenBytes(size: number): Buffer {
  if (seeded === null) return randomBytes(size);
  const bits = size === 0 ? 0n : seeded.getrandbits(size * 8);
  const out = Buffer.alloc(size);
  let rest = bits;
  for (let index = 0; index < size; index += 1) {
    out[index] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

export function tokenHex(size = 32): string {
  return tokenBytes(size).toString("hex");
}

export function wallSeconds(): number {
  return (performance.timeOrigin + performance.now()) / 1000;
}
