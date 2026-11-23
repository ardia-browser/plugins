import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { decodeBlob } from "./blobs.ts";
import { acceptReady, closeFd, listenUnix, lockExclusive, receive, sendSome, shutdownWrites } from "./ffi.ts";
import { dumps, isObject, loadsBytes, PyFloat, type Py, type PyObject } from "./pyjson.ts";

export const DRAIN_TIMEOUT_MS = 5000;
export const DEFAULT_HELLO: Py = new Map([["result", new Map<string, Py>([["app", "Ardia"], ["version", "1.0"]])]]);
const POLL_MS = 2;
const READ_CHUNK = 8192;
const BACKLOG = 16;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class Signal {
  done = false;
  private waiters: (() => void)[] = [];
  set(): void {
    this.done = true;
    for (const waiter of this.waiters.splice(0)) waiter();
  }
  wait(seconds: number): Promise<void> {
    if (this.done) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, Math.max(0, seconds * 1000));
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

class Connection {
  private buffer = Buffer.alloc(0);
  private ended = false;
  closed = false;

  constructor(readonly fd: number) {}

  async readLine(): Promise<Buffer | null> {
    for (;;) {
      const end = this.buffer.indexOf(0x0a);
      if (end >= 0) {
        const line = this.buffer.subarray(0, end + 1);
        this.buffer = this.buffer.subarray(end + 1);
        return line;
      }
      if (this.ended) {
        if (!this.buffer.length) return null;
        const line = this.buffer;
        this.buffer = Buffer.alloc(0);
        return line;
      }
      if (this.closed) throw new Error("the connection is closed");
      const chunk = receive(this.fd, READ_CHUNK);
      if (chunk === undefined) await sleep(POLL_MS);
      else if (chunk === null) this.ended = true;
      else this.buffer = Buffer.concat([this.buffer, chunk]);
    }
  }

  async sendAll(payload: Buffer | string): Promise<void> {
    let data = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
    while (data.length && !this.closed) {
      const count = sendSome(this.fd, data);
      if (count === undefined) await sleep(POLL_MS);
      else data = data.subarray(count);
    }
    if (this.closed && data.length) throw new Error("the connection is closed");
  }

  async send(payload: Buffer | string): Promise<void> {
    try {
      await this.sendAll(payload);
    } catch {}
  }

  halfClose(): void {
    if (!this.closed) shutdownWrites(this.fd);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeFd(this.fd);
  }
}

class Listener {
  private closing = false;
  private loop: Promise<void>;
  readonly connections: Connection[] = [];

  constructor(readonly fd: number, private serve: (connection: Connection) => void) {
    this.loop = this.accept();
  }

  private take(): boolean {
    const fd = acceptReady(this.fd);
    if (fd === undefined) return false;
    const connection = new Connection(fd);
    this.connections.push(connection);
    this.serve(connection);
    return true;
  }

  private async accept(): Promise<void> {
    while (!this.closing) if (!this.take()) await sleep(POLL_MS);
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.loop;
    while (this.take());
    closeFd(this.fd);
  }

  dropAll(): void {
    for (const connection of this.connections) connection.close();
  }
}

async function joinAll(talkers: Promise<void>[], deadline: number): Promise<boolean> {
  let finished = 0;
  await Promise.race([
    Promise.all(talkers.map((talker) => talker.then(() => void (finished += 1)))),
    sleep(Math.max(0, deadline - Date.now())),
  ]);
  return finished === talkers.length;
}

function seconds(value: Py | undefined): number {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof PyFloat) return value.value;
  if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) return Number(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  throw new Error(`not a number of seconds: ${dumps(value ?? null)}`);
}

export class FakeArdia {
  connections: Py[][] = [];
  endings: string[] = [];
  complete = true;
  private talkers: Promise<void>[] = [];
  private replies = new Map<string, Py[]>();
  private stopped = new Signal();
  private listener: Listener;

  constructor(readonly path: string, readonly hello: Py, replies: PyObject, readonly events: Py[]) {
    for (const [method, reply] of replies) this.replies.set(method, Array.isArray(reply) ? [...reply] : [reply]);
    this.listener = new Listener(listenUnix(path, BACKLOG), (connection) => this.serve(connection));
  }

  get requests(): [Py, Py][] {
    return this.connections.flat().map((request) => [isObject(request) ? request.get("method") ?? null : null, isObject(request) ? request.get("params") ?? null : null]);
  }

  transcript(): Py[][] {
    return this.connections.map((transcript) => [...transcript]);
  }

  private serve(connection: Connection): void {
    const transcript: Py[] = [];
    this.connections.push(transcript);
    this.talkers.push(this.talk(connection, transcript));
  }

  private nextReply(method: Py | undefined): Py {
    if (method === "hello") return this.hello;
    const queue = typeof method === "string" ? this.replies.get(method) : undefined;
    if (!queue || !queue.length) return new Map([["result", null]]);
    return queue.length > 1 ? queue.shift()! : queue[0]!;
  }

  private async talk(connection: Connection, transcript: Py[]): Promise<void> {
    let ending = "error";
    try {
      for (;;) {
        const line = await connection.readLine();
        if (line === null) break;
        let request: Py | undefined;
        try {
          request = loadsBytes(line);
        } catch {
          request = undefined;
        }
        if (!isObject(request)) {
          transcript.push(new Map([["<raw line>", line.toString("base64")]]));
          continue;
        }
        const method = request.get("method");
        transcript.push(request);
        let reply = this.nextReply(method);
        if (reply === "close") {
          ending = "scripted";
          return;
        }
        if (isObject(reply) && reply.has("hang")) {
          await this.stopped.wait(seconds(reply.get("hang")));
          ending = "scripted";
          return;
        }
        const pause = isObject(reply) ? seconds(reply.get("pause") ?? 0n) : 0;
        const then = isObject(reply) ? reply.get("then") : undefined;
        if (isObject(reply)) reply = new Map([...reply].filter(([key]) => key !== "pause" && key !== "then"));
        if (isObject(reply) && reply.has("raw")) await connection.send(decodeBlob(reply.get("raw")));
        else {
          if (!isObject(reply)) throw new Error("a reply is an object");
          const answer: Map<string, Py> = new Map([["id", request.get("id") ?? null]]);
          for (const [key, value] of reply) answer.set(key, value);
          await connection.send(`${dumps(answer)}\n`);
        }
        if (then === "half-close") connection.halfClose();
        if (method === "subscribe") {
          for (const event of this.events) await connection.send(isObject(event) && event.has("raw") ? decodeBlob(event.get("raw")) : `${dumps(event)}\n`);
        }
        if (then === "close") {
          ending = "scripted";
          return;
        }
        if (pause) await this.stopped.wait(pause);
      }
      ending = "eof";
    } catch {
    } finally {
      this.endings.push(ending);
      connection.close();
    }
  }

  async close(): Promise<void> {
    await this.listener.close();
    const finished = await joinAll(this.talkers, Date.now() + DRAIN_TIMEOUT_MS);
    this.complete = finished && !this.endings.includes("error");
    this.stopped.set();
    this.listener.dropAll();
  }
}

export const PARITY_BUILD = "parity";

export function stampedSessionKey(namespace: string, keySource: string, session: string, forPlugin: boolean, build: string): string {
  const raw = `${namespace}\0${keySource}\0${session}${forPlugin ? "\0plugin" : ""}\0build:${build}`;
  return createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 24);
}

function urlSplit(url: string): { scheme: string; netloc: string; path: string } {
  let rest = url.replace(/^[\x00-\x20]+/, "");
  for (const unsafe of ["\t", "\r", "\n"]) rest = rest.split(unsafe).join("");
  let scheme = "";
  const colon = rest.indexOf(":");
  if (colon > 0 && /^[A-Za-z][A-Za-z0-9+.-]*$/.test(rest.slice(0, colon))) {
    scheme = rest.slice(0, colon).toLowerCase();
    rest = rest.slice(colon + 1);
  }
  let netloc = "";
  if (rest.startsWith("//")) {
    const after = rest.slice(2);
    const stop = after.search(/[/?#]/);
    netloc = stop < 0 ? after : after.slice(0, stop);
    rest = stop < 0 ? "" : after.slice(stop);
  }
  const hash = rest.indexOf("#");
  if (hash >= 0) rest = rest.slice(0, hash);
  const query = rest.indexOf("?");
  if (query >= 0) rest = rest.slice(0, query);
  return { scheme, netloc, path: rest };
}

export function endpointKeySource(endpoint: Py | undefined, data: string): string {
  if (isObject(endpoint) && endpoint.has("port")) return `port:${Number(endpoint.get("port"))}`;
  if (isObject(endpoint) && endpoint.has("ws")) {
    const parts = urlSplit(String(endpoint.get("ws")));
    return `ws:${parts.scheme}://${parts.netloc}${parts.path}`;
  }
  if (isObject(endpoint) && endpoint.has("plugin")) {
    return `plugin:${createHash("sha256").update(String(endpoint.get("plugin")), "utf8").digest("hex").slice(0, 32)}`;
  }
  return `token:${data}`;
}

const UTF8_SEQUENCE = /^(?:[\x00-\x7f]|[\xc2-\xdf][\x80-\xbf]|\xe0[\xa0-\xbf][\x80-\xbf]|[\xe1-\xec\xee\xef][\x80-\xbf]{2}|\xed[\x80-\x9f][\x80-\xbf]|\xf0[\x90-\xbf][\x80-\xbf]{2}|[\xf1-\xf3][\x80-\xbf]{3}|\xf4[\x80-\x8f][\x80-\xbf]{2})/;

export function backslashReplace(bytes: Buffer): string {
  const latin = bytes.toString("latin1");
  let out = "";
  let index = 0;
  while (index < latin.length) {
    const match = UTF8_SEQUENCE.exec(latin.slice(index, index + 4));
    if (match) {
      out += Buffer.from(match[0], "latin1").toString("utf8");
      index += match[0].length;
    } else {
      out += `\\x${latin.charCodeAt(index).toString(16).padStart(2, "0")}`;
      index += 1;
    }
  }
  return out;
}

export class FakeDaemon {
  requests: Py[] = [];
  private replies: Py[];
  private talkers: Promise<void>[] = [];
  private stopped = new Signal();
  private listener: Listener;
  private lockFd: number;

  constructor(data: string, spec: PyObject, build: string) {
    const endpoint = spec.get("endpoint") ?? "token";
    const keySource = endpointKeySource(endpoint, data);
    const forPlugin = isObject(endpoint) && endpoint.has("plugin");
    const namespace = spec.get("namespace");
    const session = spec.get("session");
    const key = stampedSessionKey(typeof namespace === "string" ? namespace : "", keySource, typeof session === "string" ? session : "default", forPlugin, build);
    const browse = join(data, "Browse");
    mkdirSync(browse, { recursive: true, mode: 0o700 });
    chmodSync(browse, 0o700);
    const replies = spec.get("replies");
    this.replies = Array.isArray(replies) && replies.length ? [...replies] : [new Map<string, Py>([["out", ""], ["err", ""], ["exit", 0n]])];
    this.lockFd = openSync(join(browse, `${key}.lock`), constants.O_RDWR | constants.O_CREAT, 0o600);
    lockExclusive(this.lockFd);
    const path = join(browse, `${key}.sock`);
    this.listener = new Listener(listenUnix(path, BACKLOG), (connection) => this.talkers.push(this.talk(connection)));
    chmodSync(path, 0o600);
  }

  private async talk(connection: Connection): Promise<void> {
    try {
      const line = (await connection.readLine()) ?? Buffer.alloc(0);
      let payload: Py;
      try {
        payload = loadsBytes(line);
      } catch {
        payload = new Map([["<not json>", backslashReplace(line)]]);
      }
      this.requests.push(payload);
      const reply = this.replies.length > 1 ? this.replies.shift()! : this.replies[0]!;
      if (!line.length || reply === "close") return;
      if (isObject(reply) && reply.has("raw")) {
        await connection.sendAll(decodeBlob(reply.get("raw")));
        return;
      }
      if (isObject(reply) && reply.has("hang")) {
        await this.stopped.wait(seconds(reply.get("hang")));
        return;
      }
      await connection.sendAll(`${dumps(reply, { ensureAscii: false })}\n`);
    } catch {
    } finally {
      connection.close();
    }
  }

  async close(): Promise<void> {
    await this.listener.close();
    closeSync(this.lockFd);
    await joinAll(this.talkers, Date.now() + DRAIN_TIMEOUT_MS);
    this.stopped.set();
    this.listener.dropAll();
  }
}
