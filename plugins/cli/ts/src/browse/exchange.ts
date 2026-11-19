import { close, type Dir } from "../privatefs.ts";
import { interrupted, wakeOnInterrupt } from "../control.ts";
import { connectAt, peerUid } from "../libc.ts";
import { codeOf, errnoOf, uid } from "../paths.ts";
import { BrowseError, formatG, gone, stalled, unreachable } from "./errors.ts";

export const MAX_RESPONSE = 256 * 1024 * 1024;
const POLL_MS = 100;
const ABSENT = new Set(["ECONNREFUSED", "ENOENT"]);
export const CONNECT_WAIT_MS = 15_000;

export class Interrupted extends Error {}

export class Absent extends Error {}

type Received = { chunks: Uint8Array[]; size: number; ended: boolean; failure: string | undefined; lineEnded: boolean; tooLarge: boolean };

export class Link {
  readonly got: Received = { chunks: [], size: 0, ended: false, failure: undefined, lineEnded: false, tooLarge: false };
  limit = MAX_RESPONSE;
  waking: (() => void) | undefined;
  socket: Bun.Socket | undefined;
  private queued: Uint8Array | undefined;
  private flushedThen: (() => void) | undefined;

  wake(): void {
    this.waking?.();
  }

  received(chunk: Uint8Array): void {
    const got = this.got;
    if (got.lineEnded || got.tooLarge) return;
    got.chunks.push(chunk);
    got.size += chunk.length;
    if (got.size > this.limit) got.tooLarge = true;
    else if (chunk.at(-1) === 0x0a) got.lineEnded = true;
    this.wake();
  }

  ended(failure?: string): void {
    this.got.ended = true;
    if (failure !== undefined) this.got.failure ??= failure;
    this.wake();
  }

  send(bytes: Uint8Array, flushed: () => void): void {
    this.queued = bytes;
    this.flushedThen = flushed;
    this.drain();
  }

  drain(): void {
    const socket = this.socket;
    const queued = this.queued;
    if (socket === undefined || queued === undefined) return;
    const wrote = socket.write(queued);
    if (wrote < 0) {
      this.ended("EPIPE");
      return;
    }
    if (wrote < queued.length) {
      this.queued = queued.subarray(wrote);
      return;
    }
    this.queued = undefined;
    const then = this.flushedThen;
    this.flushedThen = undefined;
    then?.();
    this.wake();
  }

  destroy(): void {
    this.socket?.terminate();
    this.socket = undefined;
  }
}

function wait(link: Link | undefined, until: number): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      if (link !== undefined && link.waking === finish) link.waking = undefined;
      wakeOnInterrupt(undefined);
      resolve();
    };
    const timer = setTimeout(finish, Math.max(1, Math.min(POLL_MS, until - performance.now())));
    if (link !== undefined) link.waking = finish;
    wakeOnInterrupt(finish);
  });
}

function connectedFd(dir: Dir, name: string): number {
  try {
    return connectAt(dir.fd, name, CONNECT_WAIT_MS);
  } catch (error) {
    if (ABSENT.has(codeOf(error) ?? "")) throw new Absent();
    throw error;
  }
}

export async function connect(dir: Dir, name: string): Promise<Link> {
  if (interrupted()) throw new Interrupted();
  const fd = connectedFd(dir, name);
  let peer: number | undefined;
  try {
    peer = peerUid(fd);
  } catch {
    peer = undefined;
  }
  if (peer !== uid()) {
    close(fd);
    throw new BrowseError("The session socket isn't served by your user; refusing it", 1, undefined, "socket_refused");
  }
  const link = new Link();
  try {
    link.socket = await Bun.connect({
      fd,
      allowHalfOpen: true,
      socket: {
        data: (_socket, chunk) => link.received(chunk),
        drain: () => link.drain(),
        end: () => link.ended(),
        close: (_socket, error) => link.ended(error === undefined ? undefined : (codeOf(error) ?? String(errnoOf(error)))),
        error: (_socket, error) => link.ended(codeOf(error) ?? String(errnoOf(error))),
      },
    });
  } catch (error) {
    close(fd);
    throw error;
  }
  return link;
}

export async function exchange(link: Link, line: Uint8Array, command: string, seconds: number, limit = MAX_RESPONSE): Promise<Buffer> {
  const deadline = performance.now() + seconds * 1000;
  const got = link.got;
  link.limit = limit;
  let flushed = false;
  link.send(line, () => {
    flushed = true;
  });
  try {
    while (!flushed) {
      if (got.failure !== undefined || got.ended) {
        if (got.chunks.length === 0) throw unreachable("the ardia browse daemon closed the connection before taking the command (see the session log)");
        break;
      }
      if (interrupted()) throw new Interrupted();
      if (performance.now() >= deadline) throw unreachable(`the ardia browse daemon didn't take the command in ${formatG(seconds)} s (see the session log)`);
      await wait(link, deadline);
    }
    for (;;) {
      if (got.tooLarge) throw new BrowseError("The daemon's answer was too large", 1, undefined, "answer_too_large");
      if (got.lineEnded || got.ended) break;
      if (got.failure !== undefined) throw gone(command);
      if (interrupted()) throw new Interrupted();
      if (performance.now() >= deadline) throw stalledAnswer(command, seconds);
      await wait(link, deadline);
    }
  } finally {
    link.destroy();
  }
  const raw = Buffer.concat(got.chunks);
  if (raw.at(-1) !== 0x0a) throw gone(command);
  return raw;
}

export class Stalled extends BrowseError {}

function stalledAnswer(command: string, seconds: number): BrowseError {
  const error = stalled(command, seconds);
  return new Stalled(error.text, error.exit, error.code, error.fallback);
}
