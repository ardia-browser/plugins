import { createHmac } from "node:crypto";
import { BrowseError } from "../daemon-errors.ts";

export const DEFAULT_PERIOD = 30;
export const DEFAULT_DIGITS = 6;
export const FRESH_MARGIN = 5;
export const ALGORITHMS: Readonly<Record<string, string>> = { SHA1: "sha1", SHA256: "sha256", SHA512: "sha512" };
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export type TotpSeed = { secret: Buffer; digits: number; period: number; algorithm: string };
export type TotpSettings = { digits: number; period: number; algorithm: string };

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s-]/gu, "").replace(/=+$/u, "").toUpperCase();
  if (clean === "") throw new BrowseError("The TOTP secret is empty", null, "bad_totp");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new BrowseError("The TOTP secret isn't base32 (letters A-Z and digits 2-7)", null, "bad_totp");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  if (out.length < 10) throw new BrowseError("The TOTP secret is too short (under 80 bits)", null, "bad_totp");
  return Buffer.from(out);
}

function settingNumber(given: string | null, fallback: number, allowed: (value: number) => boolean, what: string): number {
  if (given === null || given === "") return fallback;
  if (!/^[0-9]{1,3}$/u.test(given) || !allowed(Number(given))) throw new BrowseError(`The TOTP ${what} ${given} isn't supported`, null, "bad_totp");
  return Number(given);
}

export function parseSeed(input: string): TotpSeed {
  const text = input.trim();
  if (!/^otpauth:\/\//iu.test(text)) return { secret: base32Decode(text), digits: DEFAULT_DIGITS, period: DEFAULT_PERIOD, algorithm: "SHA1" };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new BrowseError("The otpauth:// link doesn't parse", null, "bad_totp");
  }
  if (url.hostname.toLowerCase() !== "totp") throw new BrowseError("Only time-based (otpauth://totp/) codes are supported", null, "bad_totp");
  const secret = url.searchParams.get("secret");
  if (secret === null) throw new BrowseError("The otpauth:// link has no secret", null, "bad_totp");
  const algorithm = (url.searchParams.get("algorithm") ?? "SHA1").toUpperCase();
  if (!Object.hasOwn(ALGORITHMS, algorithm)) throw new BrowseError(`The TOTP algorithm ${algorithm} isn't supported`, null, "bad_totp");
  return {
    secret: base32Decode(secret),
    digits: settingNumber(url.searchParams.get("digits"), DEFAULT_DIGITS, (value) => value >= 6 && value <= 8, "digit count"),
    period: settingNumber(url.searchParams.get("period"), DEFAULT_PERIOD, (value) => value >= 15 && value <= 120, "period"),
    algorithm,
  };
}

export function hotp(secret: Buffer, counter: number, digits = DEFAULT_DIGITS, algorithm = "SHA1"): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(ALGORITHMS[algorithm] ?? "sha1", secret).update(message).digest();
  const offset = (digest[digest.length - 1] as number) & 0x0f;
  const binary = (digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(binary).padStart(digits, "0");
}

export function totpAt(seed: TotpSeed, unixSeconds: number): string {
  return hotp(seed.secret, Math.floor(unixSeconds / seed.period), seed.digits, seed.algorithm);
}

export function remainingAt(seed: TotpSettings, unixSeconds: number): number {
  return seed.period - (unixSeconds % seed.period);
}

export type Clock = { now: () => number; sleep: (seconds: number) => Promise<void> };

export const systemClock: Clock = {
  now: () => Date.now() / 1000,
  sleep: (seconds) => new Promise((resolve) => setTimeout(resolve, Math.max(0, seconds * 1000))),
};

export async function freshCode(seed: TotpSeed, clock: Clock = systemClock, margin = FRESH_MARGIN): Promise<{ code: string; remaining: number; waited: number }> {
  let now = clock.now();
  let waited = 0;
  const left = remainingAt(seed, now);
  if (left < margin) {
    waited = left + 0.05;
    await clock.sleep(waited);
    now = clock.now();
  }
  return { code: totpAt(seed, now), remaining: Math.floor(remainingAt(seed, now)), waited };
}

export function settingsOf(seed: TotpSeed): TotpSettings {
  return { digits: seed.digits, period: seed.period, algorithm: seed.algorithm };
}
