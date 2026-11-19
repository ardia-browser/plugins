import { lstatSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { fromChain, wire } from "./caller.ts";
import { askPython } from "./facts.ts";
import { dumps, field, object, parse, same, type Value } from "./json.ts";
import { baseName, errnoOf, join, LINUX, purePath, envSet, expandUser, home, strerror, uid } from "./paths.ts";
import { MAX_LINE_BYTES, MIN_APP_PROTOCOL, PROTOCOL, SOCKET_FILE } from "./protocol.ts";
import { strOf, truthy, Unsupported } from "./py.ts";

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
    const socket = createConnection({ path });
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

const POLL_MS = 100;

class Connection {
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 0n;
  private lost: string | undefined;
  private ended = false;
  private broken: number | undefined;
  private wake: (() => void) | undefined;

  constructor(readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
      this.notify();
    });
    socket.on("end", () => {
      this.ended = true;
      this.notify();
    });
    socket.on("error", (error) => {
      this.broken = errnoOf(error);
      this.notify();
    });
    socket.on("close", () => {
      this.ended = true;
      this.notify();
    });
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  private lose(reason: string): ControlFailure {
    this.lost = reason;
    return unreachable(reason);
  }

  private takeLine(): Buffer | undefined {
    const end = this.buffer.indexOf(0x0a);
    if (end < 0) return undefined;
    const line = this.buffer.subarray(0, end + 1);
    this.buffer = this.buffer.subarray(end + 1);
    return line;
  }

  private async readReply(ident: bigint, method: string, timeout: number): Promise<Value> {
    const deadline = performance.now() + timeout * 1000;
    for (;;) {
      for (let line = this.takeLine(); line !== undefined; line = this.takeLine()) {
        if (line.length > MAX_LINE_BYTES + 1) throw this.lose("Ardia sent a line longer than 1 MB");
        const message = parse(line);
        if (message === undefined) throw this.lose("Ardia sent a line that isn't JSON");
        const id = field(message, "id");
        if (typeof id === "bigint" && id === ident) return message;
      }
      if (this.buffer.length > MAX_LINE_BYTES + 2) throw this.lose("Ardia sent a line longer than 1 MB");
      if (interrupted()) throw new ControlFailure({ kind: "interrupted" });
      const left = deadline - performance.now();
      if (left <= 0) throw unreachable(`Ardia didn't answer ${method} in ${seconds(timeout)} s`);
      if (this.broken !== undefined) throw this.lose(`the connection broke (${strerror(this.broken)})`);
      if (this.ended) throw this.lose("Ardia closed the connection");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(1, Math.min(left, POLL_MS)));
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        this.wake = done;
        wakeAll = done;
      });
      this.wake = undefined;
      wakeAll = undefined;
    }
  }

  async call(method: string, params: Value | undefined, timeout: number): Promise<Value> {
    if (this.lost !== undefined) throw unreachable(this.lost);
    this.nextId += 1n;
    const ident = this.nextId;
    const request = object([
      ["id", ident],
      ["method", method],
    ]);
    if (params !== undefined) request.set("params", params);
    const line = Buffer.from(`${dumps(request, "compact")}\n`, "utf8");
    if (line.length > MAX_LINE_BYTES) {
      throw new ControlFailure({ kind: "method", code: "bad_request", message: "the request is longer than 1 MB" });
    }
    this.socket.write(line);
    let reply: Value;
    try {
      reply = await this.readReply(ident, method, timeout);
    } catch (error) {
      throw marked(error, true);
    }
    const error = field(reply, "error");
    if (error !== undefined) throw new ControlFailure(methodFailure(error));
    return field(reply, "result") ?? null;
  }
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
    info = await connection.call("hello", object([["caller", callerWire], ["protocol", BigInt(PROTOCOL)]]), CONNECT_TIMEOUT);
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

export async function call(dataDir: string | undefined, method: string, params: Value | undefined, python: string | null): Promise<Value> {
  const path = join(dataRoot(dataDir), SOCKET_FILE);
  checkSocket(path);
  const socket = await connectSocket(path, CONNECT_TIMEOUT);
  const name = baseName(path);
  let release: (() => void) | undefined;
  try {
    const fd = (socket as unknown as { _handle?: { fd?: number } })._handle?.fd;
    const facts = typeof fd === "number" ? askPython(python, fd) : undefined;
    if (facts?.interruptsIgnored !== true) release = catchInterrupts();
    if (facts?.peerUid === undefined) throw unreachable(`${name} couldn't check who serves it`);
    if (facts.peerUid !== uid()) throw unreachable(`${name} is served by another user`);
    const connection = new Connection(socket);
    await hello(connection, name, wire(fromChain(facts.chain)));
    return await connection.call(method, params, CALL_TIMEOUT);
  } finally {
    release?.();
    socket.destroy();
  }
}
