import { userInfo } from "node:os";
import { dumps, type JsonObject, type Value } from "../json.ts";
import { home } from "../paths.ts";
import { strOf } from "../py.ts";
import { formatG, MethodError, Unreachable } from "../stream.ts";
import { exitStatus, type GroupChild, SpawnFailed, spawnGroup } from "../proc/group.ts";
import { strerror } from "../paths.ts";
import type { Hook } from "./model.ts";
import type { LogSink } from "./log.ts";

export const QUEUE_CAP = 100;
export const KILL_GRACE = 5;
export const DRAIN_GRACE = 1;
export const LINE_LIMIT = 64 * 1024;
const ENV_LIMIT = 4096;
const COMMAND_BURST = 10;
const COMMAND_WINDOW = 10;
const EVENT_ENV: [string, string | null][] = [
  ["ARDIA_EVENT", null],
  ["ARDIA_WINDOW_ID", "windowId"],
  ["ARDIA_TAB_ID", "tabId"],
  ["ARDIA_PROFILE", "profile"],
  ["ARDIA_URL", "url"],
  ["ARDIA_TITLE", "title"],
];
export const EVENT_VARIABLES = EVENT_ENV.map(([name]) => name);

export function envValue(value: Value): string {
  const text = strOf(value).replace(/\0/g, "");
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length <= ENV_LIMIT) return text;
  return new TextDecoder("utf-8", { fatal: false }).decode(encoded.subarray(0, ENV_LIMIT)).replace(/�$/, "");
}

export function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
  return env;
}

export function dataOf(event: JsonObject): JsonObject {
  const data = event.get("data");
  return data instanceof Map ? data : new Map();
}

export function hookEnv(event: JsonObject, base: Record<string, string> = baseEnv()): Record<string, string> {
  const env = { ...base };
  const data = dataOf(event);
  const privateEvent = event.get("event") === "notification.shown";
  for (const [variable, key] of EVENT_ENV) {
    delete env[variable];
    if (privateEvent && (key === "title" || key === "url")) continue;
    const value = key === null ? event.get("event") : data.get(key);
    if (value !== undefined && value !== null && !(value instanceof Map) && !Array.isArray(value) && typeof value !== "boolean") env[variable] = envValue(value);
  }
  return env;
}

export function programArgv(program: readonly string[]): string[] {
  const [first, ...rest] = program as [string, ...string[]];
  if (!first.startsWith("~")) return [first, ...rest];
  const slash = first.indexOf("/");
  const user = slash < 0 ? first.slice(1) : first.slice(1, slash);
  const tail = slash < 0 ? "" : first.slice(slash);
  let base: string | undefined;
  if (user === "") base = home();
  else {
    try {
      if (userInfo().username === user) base = userInfo().homedir;
    } catch {
      base = undefined;
    }
  }
  if (base === undefined) return [first, ...rest];
  const trimmed = base.length > 1 ? base.replace(/\/+$/, "") : base;
  return [trimmed + tail || "/", ...rest];
}

export function wellFormedPayload(event: JsonObject): Buffer {
  return Buffer.from(`${dumps(event, "compact")}\n`, "utf8");
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, seconds * 1000)));
}

type Lines = { done: Promise<void> };

function pump(stream: NodeJS.ReadableStream | null | undefined, emit: (line: Buffer, cut: boolean) => void): Lines | undefined {
  if (stream === null || stream === undefined) return undefined;
  let pending: Buffer = Buffer.alloc(0);
  let cutting = false;
  const done = new Promise<void>((resolve) => {
    stream.on("data", (chunk: Buffer) => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      for (;;) {
        const end = pending.indexOf(0x0a);
        if (end < 0) break;
        const line = pending.subarray(0, end);
        pending = pending.subarray(end + 1);
        if (cutting) {
          cutting = false;
          continue;
        }
        emit(line, false);
      }
      if (pending.length > LINE_LIMIT && !cutting) {
        emit(pending.subarray(0, LINE_LIMIT), true);
        cutting = true;
      }
      if (cutting) pending = Buffer.alloc(0);
    });
    const finish = () => {
      if (pending.length > 0 && !cutting) emit(pending, false);
      pending = Buffer.alloc(0);
      resolve();
    };
    stream.on("end", finish);
    stream.on("close", finish);
    stream.on("error", finish);
  });
  return { done };
}

function within<T>(promise: Promise<T>, seconds: number): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, seconds * 1000));
    void promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

const TIMED_OUT = Symbol("timed out");

export class HookRunner {
  queue: JsonObject[] = [];
  dropped = 0;
  runs = 0;
  process: GroupChild | undefined;
  readonly task: Promise<void>;
  private closing = false;
  private lastWarning = Number.NEGATIVE_INFINITY;
  private wake: (() => void) | undefined;
  private finished = false;

  constructor(
    readonly hook: Hook,
    private readonly log: LogSink,
    private readonly capture: boolean,
    private readonly cap: number = QUEUE_CAP,
    private readonly killGrace: number = KILL_GRACE,
  ) {
    this.task = this.loop().finally(() => {
      this.finished = true;
    });
  }

  get done(): boolean {
    return this.finished;
  }

  offer(event: JsonObject): void {
    if (this.closing) return;
    if (this.queue.length >= this.cap) {
      this.queue.shift();
      this.dropped += 1;
      const now = performance.now() / 1000;
      if (now - this.lastWarning >= 5) {
        this.log.write(`warning: hook ${this.hook.name}: ${this.cap} events waiting, dropped the oldest (${this.dropped} so far)`);
        this.lastWarning = now;
      }
    }
    this.queue.push(event);
    this.wake?.();
  }

  private async loop(): Promise<void> {
    for (;;) {
      while (this.queue.length === 0) {
        if (this.closing) return;
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
        this.wake = undefined;
      }
      const event = this.queue.shift() as JsonObject;
      try {
        await this.runOnce(event);
      } catch (error) {
        const name = error instanceof Error ? error.constructor.name : "Error";
        this.log.write(`hook ${this.hook.name}: ${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async runOnce(event: JsonObject): Promise<number | null> {
    this.runs += 1;
    const argv = programArgv(this.hook.program);
    let child: GroupChild;
    try {
      child = await spawnGroup(argv, { stdin: "pipe", stdout: this.capture ? "pipe" : "inherit", stderr: this.capture ? "pipe" : "inherit", env: hookEnv(event) });
    } catch (error) {
      const reason = error instanceof SpawnFailed ? strerror(error.errno) : String(error);
      this.log.write(`hook ${this.hook.name}: can't run ${argv[0]}: ${reason}`);
      return null;
    }
    this.process = child;
    const emit = (line: Buffer, cut: boolean) => this.emit(line, cut);
    const pumps = [pump(child.child.stdout, emit), pump(child.child.stderr, emit)].filter((entry): entry is Lines => entry !== undefined);
    const exited = new Promise<number>((resolve) => {
      if (child.child.exitCode !== null || child.child.signalCode !== null) resolve(statusOf(child));
      else child.child.once("exit", () => resolve(statusOf(child)));
    });
    const deadline = performance.now() / 1000 + this.hook.timeout;
    const left = () => Math.max(deadline - performance.now() / 1000, 0);
    let timedOut = false;
    let status: number | null = null;
    try {
      const fed = await within(this.feed(child, wellFormedPayload(event)), this.hook.timeout);
      if (fed === TIMED_OUT) timedOut = true;
      else {
        const waited = await within(exited, left());
        if (waited === TIMED_OUT) timedOut = true;
        else {
          status = waited;
          if (pumps.length > 0 && (await within(Promise.all(pumps.map((entry) => entry.done)), left())) === TIMED_OUT) timedOut = true;
        }
      }
      if (timedOut) status = await this.stopGroup(child, exited, pumps);
    } finally {
      this.process = undefined;
      if (!timedOut) child.forget();
    }
    if (timedOut) this.log.write(`hook ${this.hook.name}: stopped after its ${formatG(this.hook.timeout)} s timeout (with anything it left running)`);
    else if (status !== 0) this.log.write(`hook ${this.hook.name}: ${argv[0]} exited with status ${status === null ? "None" : status}`);
    return status;
  }

  private feed(child: GroupChild, payload: Buffer): Promise<void> {
    const stdin = child.child.stdin;
    if (stdin === null) return Promise.resolve();
    return new Promise((resolve) => {
      stdin.on("error", () => resolve());
      stdin.end(payload, () => resolve());
    });
  }

  private async stopGroup(child: GroupChild, exited: Promise<number>, pumps: Lines[]): Promise<number | null> {
    const stopping = child.terminate(this.killGrace, DRAIN_GRACE);
    const finished = Promise.all([exited, ...pumps.map((entry) => entry.done)]);
    const drained = await within(finished, this.killGrace);
    if (drained !== TIMED_OUT) return drained[0];
    await stopping;
    const last = await within(exited, DRAIN_GRACE);
    return last === TIMED_OUT ? null : last;
  }

  private emit(line: Buffer, cut: boolean): void {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(line.subarray(0, LINE_LIMIT));
    this.log.write(`[${this.hook.name}] ${text}${cut || line.length > LINE_LIMIT ? " …(line cut at 64 KB)" : ""}`);
  }

  close(): void {
    this.closing = true;
    this.queue = [];
    this.wake?.();
  }

  async stop(grace = 2): Promise<void> {
    this.close();
    const child = this.process;
    if (child === undefined) {
      await within(this.task, grace);
      return;
    }
    await Promise.all([child.terminate(grace), within(this.task, grace)]);
  }

}

function statusOf(child: GroupChild): number {
  return exitStatus(child.child);
}

export type CommandService = { connection: { closed: boolean; call(method: string, params?: Value, timeout?: number | null): Promise<Value> } | undefined; scopes: Map<string, Value> };

export class CommandRunner {
  recent: number[] = [];
  tasks = new Set<Promise<void>>();

  constructor(
    readonly hook: Hook,
    private readonly log: LogSink,
    private readonly service: CommandService,
  ) {}

  get done(): boolean {
    return true;
  }

  offer(event: JsonObject): void {
    const now = performance.now() / 1000;
    while (this.recent.length > 0 && now - (this.recent[0] as number) > COMMAND_WINDOW) this.recent.shift();
    if (this.recent.length >= COMMAND_BURST) {
      this.log.write(`warning: hook ${this.hook.name}: more than ${COMMAND_BURST} commands in ${COMMAND_WINDOW} s; skipped one (a hook may be triggering itself)`);
      return;
    }
    this.recent.push(now);
    const task: Promise<void> = this.run(event).finally(() => this.tasks.delete(task));
    this.tasks.add(task);
  }

  private async run(event: JsonObject): Promise<void> {
    const connection = this.service.connection;
    if (connection === undefined || connection.closed) {
      this.log.write(`hook ${this.hook.name}: Ardia isn't connected; ${this.hook.command} didn't run`);
      return;
    }
    const data = dataOf(event);
    const params: JsonObject = new Map<string, Value>([["command", this.hook.command as string]]);
    if (this.hook.arg !== null) params.set("arg", this.hook.arg);
    const window = data.has("windowId") ? data.get("windowId") : event.get("event") === "app.launched" ? data.get("focusedWindowId") : undefined;
    if (typeof window === "string") params.set("window", window);
    const tab = data.get("tabId");
    if (typeof tab === "string" && this.service.scopes.get(this.hook.command as string) === "page") params.set("tab", tab);
    try {
      await connection.call("run", params, 10);
    } catch (error) {
      if (error instanceof MethodError) this.log.write(`hook ${this.hook.name}: ${this.hook.command}: ${error.message}`);
      else if (error instanceof Unreachable) this.log.write(`hook ${this.hook.name}: ${this.hook.command} may not have run: ${error.message}`);
      else throw error;
    }
  }

  close(): void {}

  async stop(grace = 2): Promise<void> {
    if (this.tasks.size > 0) await within(Promise.all([...this.tasks]), grace);
  }
}

export { sleep };
