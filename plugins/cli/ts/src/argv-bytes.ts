import { readFileSync } from "node:fs";
import { processInfo } from "./libc.ts";

function sequence(bytes: Uint8Array, at: number): number {
  const lead = bytes[at] as number;
  const next = (offset: number, low = 0x80, high = 0xbf) => {
    const byte = bytes[at + offset];
    return byte !== undefined && byte >= low && byte <= high;
  };
  if (lead < 0x80) return 1;
  if (lead >= 0xc2 && lead <= 0xdf) return next(1) ? 2 : 0;
  if (lead === 0xe0) return next(1, 0xa0) && next(2) ? 3 : 0;
  if (lead === 0xed) return next(1, 0x80, 0x9f) && next(2) ? 3 : 0;
  if (lead >= 0xe1 && lead <= 0xef) return next(1) && next(2) ? 3 : 0;
  if (lead === 0xf0) return next(1, 0x90) && next(2) && next(3) ? 4 : 0;
  if (lead === 0xf4) return next(1, 0x80, 0x8f) && next(2) && next(3) ? 4 : 0;
  if (lead >= 0xf1 && lead <= 0xf3) return next(1) && next(2) && next(3) ? 4 : 0;
  return 0;
}

export function decodeSurrogateEscape(bytes: Uint8Array): string {
  let out = "";
  for (let at = 0; at < bytes.length; ) {
    const length = sequence(bytes, at);
    if (length === 0) {
      out += String.fromCharCode(0xdc00 + (bytes[at] as number));
      at += 1;
    } else {
      out += Buffer.from(bytes.subarray(at, at + length)).toString("utf8");
      at += length;
    }
  }
  return out;
}

function words(raw: Buffer, start: number, count: number): Buffer[] | undefined {
  const found: Buffer[] = [];
  let at = start;
  while (found.length < count) {
    const end = raw.indexOf(0, at);
    if (end < 0) return undefined;
    found.push(raw.subarray(at, end));
    at = end + 1;
  }
  return found;
}

function darwinArgv(): Buffer[] | undefined {
  const facts = processInfo(process.pid);
  if (facts === null || facts.args.length < 4) return undefined;
  const raw = facts.args;
  const argc = raw.readInt32LE(0);
  let at = raw.indexOf(0, 4);
  if (at < 0) return undefined;
  while (at < raw.length && raw[at] === 0) at += 1;
  return words(raw, at, argc);
}

function linuxArgv(): Buffer[] | undefined {
  const raw = readFileSync("/proc/self/cmdline");
  const parts: Buffer[] = [];
  let at = 0;
  while (at < raw.length) {
    const end = raw.indexOf(0, at);
    parts.push(raw.subarray(at, end < 0 ? raw.length : end));
    if (end < 0) break;
    at = end + 1;
  }
  return parts;
}

export function rawArguments(expected: number): string[] | undefined {
  let found: Buffer[] | undefined;
  try {
    found = process.platform === "darwin" ? darwinArgv() : linuxArgv();
  } catch {
    return undefined;
  }
  if (found === undefined || found.length < expected) return undefined;
  return found.slice(found.length - expected).map(decodeSurrogateEscape);
}
