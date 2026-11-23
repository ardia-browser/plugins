import { existsSync, fstatSync, read } from "node:fs";
import { isatty } from "node:tty";
import { interrupted, wakeOnInterrupt } from "../control.ts";
import { LINUX } from "../paths.ts";
import { builtinCrash, type PythonCrash } from "./errors.ts";
import { Interrupted } from "./exchange.ts";
import { pluginMode } from "./route.ts";

const CHUNK = 64 * 1024;
const POLL_MS = 100;

export type Errors = "strict" | "surrogateescape";

function localeName(): string {
  for (const name of ["LC_ALL", "LC_CTYPE", "LANG"]) {
    const value = process.env[name];
    if (value) return value;
  }
  return "";
}

function utf8Codeset(name: string): boolean {
  return /^utf-?8$/i.test(name) || /\.utf-?8(@.*)?$/i.test(name);
}

export function stdioErrorsFor(platform: string, name: string, plugin: boolean, installed: (name: string) => boolean): Errors | undefined {
  const linux = platform === "linux";
  void plugin;
  if (["", "C", "POSIX", "C.UTF-8", "C.utf8", "UTF-8"].includes(name)) return "surrogateescape";
  if (name.includes("/") || name.includes("..")) return undefined;
  if (!linux && !installed(name)) return "surrogateescape";
  return utf8Codeset(name) ? "strict" : undefined;
}

export function pythonStdioErrors(): Errors | undefined {
  return stdioErrorsFor(LINUX ? "linux" : "darwin", localeName(), pluginMode(), (name) => existsSync(`/usr/share/locale/${name}/LC_CTYPE`));
}

export function stdinState(): "tty" | "other" | "closed" {
  try {
    fstatSync(0);
  } catch {
    return "closed";
  }
  return isatty(0) ? "tty" : "other";
}

function readSome(buffer: Buffer): Promise<number | NodeJS.ErrnoException> {
  return new Promise((resolve) => read(0, buffer, 0, buffer.length, null, (error, count) => resolve(error ?? count)));
}

export async function raceInterrupt<T>(work: Promise<T>): Promise<T> {
  let settled: { value: T } | undefined;
  work.then((value) => {
    settled = { value };
    wakeOnInterrupt(undefined);
  });
  while (settled === undefined) {
    if (interrupted()) throw new Interrupted();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, POLL_MS);
      wakeOnInterrupt(() => {
        clearTimeout(timer);
        resolve();
      });
      work.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  return settled.value;
}

export async function readStdin(limit: number): Promise<Buffer | NodeJS.ErrnoException> {
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    if (size > limit) return Buffer.concat(chunks);
    const buffer = Buffer.allocUnsafe(CHUNK);
    const got = await raceInterrupt(readSome(buffer));
    if (typeof got !== "number") {
      if (got.code === "EAGAIN" || got.code === "EINTR") continue;
      return got;
    }
    if (got === 0) return Buffer.concat(chunks);
    chunks.push(buffer.subarray(0, got));
    size += got;
  }
}

function needed(lead: number): [number, number, number] {
  if (lead >= 0xc2 && lead <= 0xdf) return [1, 0x80, 0xbf];
  if (lead === 0xe0) return [2, 0xa0, 0xbf];
  if (lead === 0xed) return [2, 0x80, 0x9f];
  if (lead >= 0xe1 && lead <= 0xef) return [2, 0x80, 0xbf];
  if (lead === 0xf0) return [3, 0x90, 0xbf];
  if (lead === 0xf4) return [3, 0x80, 0x8f];
  if (lead >= 0xf1 && lead <= 0xf3) return [3, 0x80, 0xbf];
  return [0, 0, 0];
}

function badRun(bytes: Uint8Array, at: number): { end: number; reason: string } | undefined {
  const lead = bytes[at] as number;
  if (lead < 0x80) return undefined;
  const [more, low, high] = needed(lead);
  if (more === 0) return { end: at + 1, reason: "invalid start byte" };
  for (let index = 1; index <= more; index += 1) {
    const byte = bytes[at + index];
    const [min, max] = index === 1 ? [low, high] : [0x80, 0xbf];
    if (byte === undefined) return { end: bytes.length, reason: "unexpected end of data" };
    if (byte < min || byte > max) return { end: at + index, reason: "invalid continuation byte" };
  }
  return undefined;
}

function sequenceLength(lead: number): number {
  if (lead < 0x80) return 1;
  if (lead < 0xe0) return 2;
  return lead < 0xf0 ? 3 : 4;
}

export function decodeStdin(bytes: Uint8Array, errors: Errors): string | PythonCrash {
  let out = "";
  let start = 0;
  for (let at = 0; at < bytes.length; ) {
    const bad = badRun(bytes, at);
    if (bad === undefined) {
      at += sequenceLength(bytes[at] as number);
      continue;
    }
    if (errors === "strict") {
      const lead = bytes[at] as number;
      const where = bad.end - at === 1 ? `byte 0x${lead.toString(16).padStart(2, "0")} in position ${at}` : `bytes in position ${at}-${bad.end - 1}`;
      return builtinCrash("UnicodeDecodeError", `'utf-8' codec can't decode ${where}: ${bad.reason}`);
    }
    out += Buffer.from(bytes.subarray(start, at)).toString("utf8");
    for (let index = at; index < bad.end; index += 1) out += String.fromCharCode(0xdc00 + (bytes[index] as number));
    at = bad.end;
    start = at;
  }
  return out + Buffer.from(bytes.subarray(start)).toString("utf8");
}

export function decodeLocale(bytes: Uint8Array): string | PythonCrash {
  const name = localeName();
  const codeset = (name.split(".")[1] ?? "").split("@")[0] ?? "";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder((codeset || "utf-8") as ConstructorParameters<typeof TextDecoder>[0], { fatal: true });
  } catch {
    return builtinCrash("LookupError", `unknown encoding: ${codeset}`);
  }
  try {
    return decoder.decode(bytes);
  } catch {
    return builtinCrash("UnicodeDecodeError", `'${codeset.toLowerCase()}' codec can't decode the input: invalid data`);
  }
}
