import { accessSync, closeSync, constants, openSync, readSync, statSync } from "node:fs";

export const E2BIG = 7;
export const ENOEXEC = 8;
const EACCES = 13;
const ARG_MAX = 1_048_576;
const POINTER = 8;
const KERNEL_SLACK = 16;
const HEAD_BYTES = 512;
const NATIVE_MAGICS = ["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca", "7f454c46"];

export function errnoOf(error: unknown, fallback = 0): number {
  const errno = Math.abs((error as NodeJS.ErrnoException | undefined)?.errno ?? 0);
  return errno === 0 ? fallback : errno;
}

function runnable(path: string | Buffer): number | undefined {
  try {
    if (!statSync(path).isFile()) return EACCES;
    accessSync(path, constants.X_OK);
    return undefined;
  } catch (error) {
    return errnoOf(error, EACCES);
  }
}

function head(path: string): Buffer | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    return buffer.subarray(0, readSync(fd, buffer, 0, HEAD_BYTES, 0));
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

function interpreterOf(start: Buffer): Buffer | undefined {
  const end = start.indexOf(0x0a);
  const line = start.subarray(2, end === -1 ? start.length : end);
  let from = 0;
  while (from < line.length && (line[from] === 0x20 || line[from] === 0x09)) from += 1;
  let to = from;
  while (to < line.length && line[to] !== 0x20 && line[to] !== 0x09) to += 1;
  return to > from ? line.subarray(from, to) : undefined;
}

export function execBlocker(path: string): number | undefined {
  const blocked = runnable(path);
  if (blocked !== undefined) return blocked;
  const start = head(path);
  if (start === undefined) return undefined;
  if (start[0] === 0x23 && start[1] === 0x21) {
    const interpreter = interpreterOf(start);
    return interpreter === undefined ? ENOEXEC : runnable(interpreter);
  }
  return NATIVE_MAGICS.includes(start.subarray(0, 4).toString("hex")) ? undefined : ENOEXEC;
}

export function exceedsArgMax(argv: string[], env: Record<string, string | undefined>): boolean {
  const entries = Object.entries(env).flatMap(([key, value]) => (value === undefined ? [] : [`${key}=${value}`]));
  const strings = [...argv, ...entries].reduce((sum, word) => sum + Buffer.byteLength(word) + 1, 0);
  return strings + POINTER * (argv.length + entries.length) + KERNEL_SLACK > ARG_MAX;
}
