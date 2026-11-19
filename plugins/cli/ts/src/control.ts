import { lstatSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { peerUid } from "./libc.ts";
import { Connection, Stop } from "./connection.ts";
import { field, object, same, type Value } from "./json.ts";
import { baseName, errnoOf, join, LINUX, purePath, envSet, expandUser, home, strerror, uid } from "./paths.ts";
import { MIN_APP_PROTOCOL, PROTOCOL, SOCKET_FILE } from "./protocol.ts";
import { strOf, truthy, Unsupported } from "./py.ts";
import { routedCaller } from "./routed.ts";

export const NOT_REACHABLE = LINUX
  ? 'Ardia isn\'t running, or "Let the ardia command control Ardia" is off in Settings.'
  : "Ardia isn't running, or Command Line isn't installed (Settings › Plugins).";
const SUN_PATH_MAX = 103;
const LINUX_SUN_PATH_MAX = 107;
const CONNECT_TIMEOUT = 5;
const CALL_TIMEOUT = 30;
const ENOENT = 2;
const ENOTDIR = 20;
const ECONNREFUSED = LINUX ? 111 : 61;

export type Failure =
  | { kind: "unreachable"; message: string; sent: boolean }
  | { kind: "incompatible"; message: string }
  | { kind: "method"; code: string; message: string }
  | { kind: "interrupted" }
  | { kind: "unported" };

export class ControlFailure extends Error {
  constructor(readonly failure: Failure) {
    super(failure.kind);
  }
}

export function errorCode(failure: Failure): string | undefined {
  if (failure.kind === "unreachable") return failure.sent ? "connection_dropped" : "unreachable";
  return failure.kind === "incompatible" ? "unsupported_protocol" : undefined;
}

function unreachable(detail?: string): ControlFailure {
  return new ControlFailure({ kind: "unreachable", message: detail === undefined ? NOT_REACHABLE : `${NOT_REACHABLE} (${detail})`, sent: false });
}

function marked(error: unknown, sent: boolean): unknown {
  if (error instanceof ControlFailure && error.failure.kind === "unreachable") return new ControlFailure({ ...error.failure, sent });
  return error;
}

export function installedDataDir(linux: boolean = LINUX): string {
  if (!linux) return join(home(), "Library", "Application Support", "com.ardia.browser");
  const configHome = envSet("ARDIA_CONFIG_HOME");
  if (configHome !== undefined) return join(purePath(configHome), "ardia");
  const xdg = envSet("XDG_CONFIG_HOME");
  return join(xdg !== undefined ? purePath(xdg) : join(home(), ".config"), "ardia");
}

export function dataRoot(dataDir: string | undefined): string {
  const root = dataDir !== undefined && dataDir !== "" ? dataDir : envSet("ARDIA_DATA_DIR");
  return root === undefined ? installedDataDir() : purePath(expandUser(root));
}

function seconds(value: number): string {
  return String(value);
}

export function checkSocket(path: string): void {
  const size = Buffer.byteLength(path);
  const limit = LINUX ? LINUX_SUN_PATH_MAX : SUN_PATH_MAX;
  if (size > limit) {
    throw new ControlFailure({
      kind: "unreachable",
      message: `the control socket path is ${size} bytes, over the ${limit} a Unix socket allows: ${path}; use a shorter data dir`,
      sent: false,
    });
  }
  const name = baseName(path);
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    const errno = errnoOf(error);
    if (errno === ENOENT || errno === ENOTDIR) throw unreachable();
    throw unreachable(`${name}: ${strerror(errno)}`);
  }
  if (!info.isSocket()) throw unreachable(`${name} isn't a socket`);
  if (info.uid !== uid()) throw unreachable(`${name} belongs to another user`);
}

function connectSocket(path: string, timeout: number): Promise<Socket> {
  const name = baseName(path);
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path, allowHalfOpen: true });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(unreachable(`${name} didn't accept in ${seconds(timeout)} s`));
    }, timeout * 1000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeAllListeners("error");
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      const errno = errnoOf(error);
      socket.destroy();
      reject(errno === ENOENT || errno === ECONNREFUSED ? unreachable() : unreachable(`${name}: ${strerror(errno)}`));
    });
  });
}

let interruptedFlag = false;
let wakeAll: (() => void) | undefined;

export function interrupted(): boolean {
  return interruptedFlag;
}

function onInterrupt(): void {
  interruptedFlag = true;
  wakeAll?.();
}

export function catchInterrupts(): () => void {
  process.on("SIGINT", onInterrupt);
  return () => {
    process.off("SIGINT", onInterrupt);
  };
}

async function callOn(connection: Connection, method: string, params: Value | undefined, timeout: number): Promise<Value> {
  let reply: Value;
  try {
    reply = await connection.request(method, params, timeout);
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    if (error.kind === "interrupted") throw new ControlFailure({ kind: "interrupted" });
    if (error.kind === "too_long") throw new ControlFailure({ kind: "method", code: "bad_request", message: error.reason });
    throw new ControlFailure({ kind: "unreachable", message: `${NOT_REACHABLE} (${error.reason})`, sent: error.kind !== "closed" });
  }
  const error = field(reply, "error");
  if (error !== undefined) throw new ControlFailure(methodFailure(error));
  return field(reply, "result") ?? null;
}

function methodFailure(error: Value): Failure {
  const code = field(error, "code");
  const message = field(error, "message");
  try {
    return { kind: "method", code: truthy(code) ? strOf(code) : "failed", message: truthy(message) ? strOf(message) : "failed" };
  } catch (failure) {
    if (failure instanceof Unsupported) return { kind: "unported" };
    throw failure;
  }
}

function spokenProtocol(info: Value): string {
  const spoken = field(info, "protocol");
  return typeof spoken === "bigint" ? spoken.toString() : "1";
}

async function hello(connection: Connection, name: string, callerWire: Value): Promise<void> {
  let info: Value;
  try {
    info = await callOn(connection, "hello", object([["caller", callerWire], ["protocol", BigInt(PROTOCOL)]]), CONNECT_TIMEOUT);
  } catch (error) {
    if (!(error instanceof ControlFailure)) throw error;
    const failure = error.failure;
    if (failure.kind === "method" && failure.code === "unsupported_protocol") throw new ControlFailure({ kind: "incompatible", message: failure.message });
    if (failure.kind === "method") throw unreachable(`hello failed: ${failure.message}`);
    throw marked(error, false);
  }
  if (!same(field(info, "app"), "Ardia")) throw unreachable(`something other than Ardia answers on ${name}`);
  const spoken = spokenProtocol(info);
  if (BigInt(spoken) < BigInt(MIN_APP_PROTOCOL)) {
    const version = field(info, "version");
    let shown = "";
    try {
      shown = version === undefined ? "" : strOf(version);
    } catch {
      throw new ControlFailure({ kind: "unported" });
    }
    throw new ControlFailure({
      kind: "incompatible",
      message: `Ardia ${shown} speaks control protocol ${spoken}, and this ardia needs ${MIN_APP_PROTOCOL} or later: update Ardia`,
    });
  }
}

function peerOf(fd: number): number | undefined {
  try {
    return peerUid(fd);
  } catch {
    return undefined;
  }
}

export async function call(dataDir: string | undefined, method: string, params: Value | undefined): Promise<Value> {
  const path = join(dataRoot(dataDir), SOCKET_FILE);
  checkSocket(path);
  const socket = await connectSocket(path, CONNECT_TIMEOUT);
  const name = baseName(path);
  let connection: Connection | undefined;
  try {
    const fd = (socket as unknown as { _handle?: { fd?: number } })._handle?.fd;
    const peer = typeof fd === "number" ? peerOf(fd) : undefined;
    if (interrupted()) throw new ControlFailure({ kind: "interrupted" });
    if (peer === undefined || typeof fd !== "number") throw unreachable(`${name} couldn't check who serves it`);
    if (peer !== uid()) throw unreachable(`${name} is served by another user`);
    connection = new Connection(socket, fd, interrupted, (wake) => {
      wakeAll = wake;
    });
    await hello(connection, name, routedCaller());
    return await callOn(connection, method, params, CALL_TIMEOUT);
  } finally {
    connection?.close();
    socket.destroy();
  }
}
