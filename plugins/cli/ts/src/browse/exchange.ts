import { createConnection, type Socket } from "node:net";
import { interrupted, wakeOnInterrupt } from "../control.ts";
import { peerUid } from "../libc.ts";
import { errnoOf, uid } from "../paths.ts";
import { BrowseError, formatG, gone, stalled, unreachable } from "./errors.ts";

export const MAX_RESPONSE = 256 * 1024 * 1024;
const POLL_MS = 100;
const ECONNREFUSED = new Set(["ECONNREFUSED", "ENOENT"]);

export class Interrupted extends Error {}

export class Absent extends Error {}

const EVENTS = ["connect", "data", "end", "close", "error", "drain"] as const;
let waking: (() => void) | undefined;

function wake(): void {
  waking?.();
}

function wait(socket: Socket | undefined, until: number): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      for (const event of EVENTS) socket?.off(event, finish);
      if (waking === finish) waking = undefined;
      wakeOnInterrupt(undefined);
      resolve();
    };
    const timer = setTimeout(finish, Math.max(1, Math.min(POLL_MS, until - performance.now())));
    for (const event of EVENTS) socket?.on(event, finish);
    waking = finish;
    wakeOnInterrupt(finish);
  });
}

function fdOf(socket: Socket): number | undefined {
  const fd = (socket as unknown as { _handle?: { fd?: number } })._handle?.fd;
  return typeof fd === "number" ? fd : undefined;
}

export async function connect(path: string): Promise<Socket> {
  const socket = createConnection({ path, allowHalfOpen: true });
  socket.pause();
  let outcome: "connected" | NodeJS.ErrnoException | undefined;
  socket.once("connect", () => {
    outcome = "connected";
  });
  socket.once("error", (error) => {
    outcome ??= error;
  });
  while (outcome === undefined) {
    if (interrupted()) {
      socket.destroy();
      throw new Interrupted();
    }
    await wait(socket, performance.now() + POLL_MS);
  }
  if (outcome !== "connected") {
    socket.destroy();
    if (ECONNREFUSED.has(outcome.code ?? "")) throw new Absent();
    throw outcome;
  }
  const fd = fdOf(socket);
  let peer: number | undefined;
  try {
    peer = fd === undefined ? undefined : peerUid(fd);
  } catch {
    peer = undefined;
  }
  if (peer !== uid()) {
    socket.destroy();
    throw new BrowseError("The session socket isn't served by your user; refusing it", 1, undefined, "socket_refused");
  }
  return socket;
}

type Received = { chunks: Buffer[]; size: number; ended: boolean; failure: string | undefined; lineEnded: boolean };

export async function exchange(socket: Socket, line: Uint8Array, command: string, seconds: number, limit = MAX_RESPONSE): Promise<Buffer> {
  const deadline = performance.now() + seconds * 1000;
  const got: Received = { chunks: [], size: 0, ended: false, failure: undefined, lineEnded: false };
  let tooLarge = false;
  socket.on("data", (chunk: Buffer) => {
    if (got.lineEnded || tooLarge) return;
    got.chunks.push(chunk);
    got.size += chunk.length;
    if (got.size > limit) tooLarge = true;
    else if (chunk.at(-1) === 0x0a) got.lineEnded = true;
  });
  socket.on("end", () => {
    got.ended = true;
  });
  socket.on("close", () => {
    got.ended = true;
  });
  socket.on("error", (error: NodeJS.ErrnoException) => {
    got.failure ??= error.code ?? String(errnoOf(error));
  });
  let flushed = false;
  socket.write(line, () => {
    flushed = true;
    wake();
  });
  socket.resume();
  try {
    while (!flushed) {
      if (got.failure !== undefined || got.ended) {
        if (got.chunks.length === 0) throw unreachable("the ardia browse daemon closed the connection before taking the command (see the session log)");
        break;
      }
      if (interrupted()) throw new Interrupted();
      if (performance.now() >= deadline) throw unreachable(`the ardia browse daemon didn't take the command in ${formatG(seconds)} s (see the session log)`);
      await wait(socket, deadline);
    }
    for (;;) {
      if (tooLarge) throw new BrowseError("The daemon's answer was too large", 1, undefined, "answer_too_large");
      if (got.lineEnded || got.ended) break;
      if (got.failure !== undefined) throw gone(command);
      if (interrupted()) throw new Interrupted();
      if (performance.now() >= deadline) throw stalledAnswer(command, seconds);
      await wait(socket, deadline);
    }
  } finally {
    socket.destroy();
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
