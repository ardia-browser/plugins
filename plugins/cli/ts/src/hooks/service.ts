import { closeSync, constants, openSync, readFileSync, renameSync, statSync, lstatSync, writeSync } from "node:fs";
import { dumps, type JsonObject, type Value } from "../json.ts";
import { EVENTS, NAMED_ONLY_EVENTS, TAB_IDLE_EVENTS, USER_IDLE_EVENTS } from "../events.ts";
import { strOf } from "../py.ts";
import { loads } from "../pylib/jsonloads.ts";
import { MethodError, type StreamConnection, Unreachable } from "../stream.ts";
import { strerrorOr } from "../pyerr.ts";
import { Decider, type Accepted } from "./decide.ts";
import { type Hook, HooksError, readHooks } from "./model.ts";
import type { LogSink } from "./log.ts";
import { CommandRunner, dataOf, HookRunner, sleep } from "./runner.ts";
import { Scheduler } from "./schedule.ts";

export const LAUNCH_STATE = "ArdiaHooks.state.json";
const LAUNCH_SEEN_CAP = 200;
const BACKOFF_START = 1;
const BACKOFF_MAX = 30;
export const WATCH_INTERVAL = 1;

export function minimizedEvent(event: JsonObject): JsonObject {
  const data = event.get("data");
  if (!(data instanceof Map) || typeof data.get("url") !== "string") return event;
  const url = data.get("url") as string;
  const cuts = [url.indexOf("?"), url.indexOf("#")].filter((at) => at >= 0);
  if (cuts.length === 0) return event;
  const copy = new Map(event);
  const trimmed = new Map(data);
  trimmed.set("url", url.slice(0, Math.min(...cuts)));
  copy.set("data", trimmed);
  return copy;
}

export class LaunchSeen {
  seen: string[] = [];

  constructor(readonly path: string | null) {
    if (path === null) return;
    try {
      const loaded = loads(readFileSync(path, "utf8"));
      const list = loaded instanceof Map ? loaded.get("seen") : undefined;
      if (Array.isArray(list)) this.seen = list.filter((key): key is string => typeof key === "string").slice(-LAUNCH_SEEN_CAP);
    } catch {}
  }

  first(key: string): boolean {
    if (this.seen.includes(key)) return false;
    this.seen = [...this.seen, key].slice(-LAUNCH_SEEN_CAP);
    if (this.path !== null) {
      try {
        const temp = `${this.path}.${process.pid}`;
        const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
        try {
          const data = Buffer.from(dumps(new Map<string, Value>([["version", 1n], ["seen", [...this.seen]]]), "spaced", true), "utf8");
          let at = 0;
          while (at < data.length) at += writeSync(fd, data, at);
        } finally {
          closeSync(fd);
        }
        renameSync(temp, this.path);
      } catch {}
    }
    return true;
  }
}

type Runner = HookRunner | CommandRunner;
export type Connect = (path: string) => Promise<StreamConnection>;

export class Service {
  runners = new Map<string, Runner>();
  retired: Runner[] = [];
  hooks = new Map<string, Hook>();
  connections = 0;
  connection: StreamConnection | undefined;
  scopes = new Map<string, Value>();
  accepted: Accepted = new Map();
  readonly decider: Decider;
  readonly scheduler: Scheduler;
  readonly launches: LaunchSeen;
  private changedFlag = false;
  private changedWake: (() => void) | undefined;
  subscribedWaiters: (() => void)[] = [];
  subscribed = false;
  private stopping = false;
  private wakeStop: (() => void) | undefined;

  constructor(
    readonly socketPath: string,
    readonly log: LogSink,
    readonly capture: boolean,
    readonly connect: Connect,
    readonly backoffStart: number = BACKOFF_START,
    readonly backoffMax: number = BACKOFF_MAX,
    statePath: string | null = null,
  ) {
    this.decider = new Decider(log);
    this.scheduler = new Scheduler((hook, event) => this.fireScheduled(hook, event), log);
    this.launches = new LaunchSeen(statePath);
  }

  private markChanged(): void {
    this.changedFlag = true;
    this.changedWake?.();
  }

  setHooks(hooks: readonly Hook[]): void {
    const wanted = new Map(hooks.map((hook) => [hook.name, hook]));
    for (const [name, runner] of [...this.runners]) {
      if (!runner.hook.equals(wanted.get(name))) {
        runner.close();
        this.retired.push(runner);
        this.runners.delete(name);
      }
    }
    this.retired = this.retired.filter((runner) => !runner.done);
    for (const [name, hook] of wanted) {
      if (this.runners.has(name) || hook.decide || hook.omnibox !== null) continue;
      this.runners.set(name, hook.command ? new CommandRunner(hook, this.log, this) : new HookRunner(hook, this.log, this.capture));
    }
    this.hooks = wanted;
    this.scheduler.setHooks(hooks);
    this.markChanged();
  }

  eventNames(): string[] {
    const names = new Set<string>();
    for (const runner of this.runners.values()) if (runner.hook.listens) for (const event of runner.hook.events) names.add(event);
    if (names.has("*")) return ["*", ...NAMED_ONLY_EVENTS.filter((name) => names.has(name))];
    return EVENTS.filter((name) => names.has(name));
  }

  subscription(): JsonObject {
    const extra: JsonObject = new Map();
    const listening = [...this.runners.values()].map((runner) => runner.hook).filter((hook) => hook.listens);
    if (listening.some((hook) => hook.fullUrls)) extra.set("fullUrls", true);
    const sortedIdle = (events: readonly string[]) =>
      [...new Set(listening.filter((hook) => hook.idle && hook.events.some((event) => events.includes(event))).map((hook) => hook.idle as number))].sort((a, b) => a - b);
    const tab = sortedIdle(TAB_IDLE_EVENTS);
    const user = sortedIdle(USER_IDLE_EVENTS);
    if (tab.length > 0 || user.length > 0) {
      const idle: JsonObject = new Map();
      if (tab.length > 0) idle.set("tab", tab.map(BigInt));
      if (user.length > 0) idle.set("user", user.map(BigInt));
      extra.set("idle", idle);
    }
    const served = [...this.hooks.values()].filter((hook) => hook.served).map((hook) => hook.definition());
    if (served.length > 0) extra.set("hooks", served);
    return extra;
  }

  dispatch(event: JsonObject): void {
    const dropped = event.get("dropped");
    if (typeof dropped === "bigint" && dropped > 0n) this.log.write(`warning: Ardia dropped ${dropped} event${dropped !== 1n ? "s" : ""} before this one because the runner fell behind`);
    const data = event.get("data");
    const launch = event.get("event") === "app.launched" && data instanceof Map ? data.get("launchId") : undefined;
    for (const runner of [...this.runners.values()]) {
      const hook = runner.hook;
      if (!hook.wants(event)) continue;
      if (launch !== undefined && launch !== null && !this.launches.first(`${strOf(launch)}:${hook.name}:${hook.revision}`)) continue;
      runner.offer(hook.fullUrls ? event : minimizedEvent(event));
    }
  }

  fireScheduled(hook: Hook, event: JsonObject): void {
    const runner = this.runners.get(hook.name);
    if (runner === undefined) return;
    if (runner instanceof HookRunner && (runner.process !== undefined || runner.queue.length > 0)) {
      this.log.write(`hook ${hook.name}: still running from the last time; skipped ${strOf(dataOf(event).get("occurrence"))}`);
      return;
    }
    runner.offer(event);
  }

  async runForever(): Promise<void> {
    const schedules = this.scheduler.run();
    try {
      await this.connectForever();
    } finally {
      this.scheduler.stop();
      await schedules;
    }
  }

  private pause(seconds: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, seconds * 1000);
      this.wakeStop = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  private async connectForever(): Promise<void> {
    let delay = this.backoffStart;
    let reported: string | undefined;
    while (!this.stopping) {
      let connection: StreamConnection;
      try {
        connection = await this.connect(this.socketPath);
      } catch (error) {
        if (!(error instanceof Unreachable)) throw error;
        if (reported !== error.message) {
          this.log.write(`${error.message}; retrying`);
          reported = error.message;
        }
        await this.pause(delay);
        delay = Math.min(delay * 2, this.backoffMax);
        continue;
      }
      delay = this.backoffStart;
      reported = undefined;
      this.connections += 1;
      const gap = this.connections > 1 ? " (events in between may have been missed)" : "";
      const version = connection.info.get("version");
      this.log.write(`connected to Ardia ${version === undefined ? "" : strOf(version)}`.trimEnd() + gap);
      this.connection = connection;
      try {
        await this.serve(connection);
      } catch (error) {
        if (error instanceof Unreachable) this.log.write(`lost Ardia: ${error.message}`);
        else if (error instanceof MethodError) {
          this.log.write(`Ardia refused the subscription (${error.code}: ${error.message}); retrying`);
          await this.pause(delay);
          delay = Math.min(delay * 2, this.backoffMax);
        } else throw error;
      } finally {
        this.connection = undefined;
        this.accepted = new Map();
        this.subscribed = false;
        await this.decider.stop();
        connection.close();
      }
    }
  }

  private async loadScopes(connection: StreamConnection): Promise<void> {
    if (![...this.runners.values()].some((runner) => runner instanceof CommandRunner)) return;
    let catalog: Value;
    try {
      catalog = await connection.call("commands", undefined, 10);
    } catch (error) {
      if (error instanceof MethodError || error instanceof Unreachable) return;
      throw error;
    }
    if (Array.isArray(catalog)) {
      this.scopes = new Map();
      for (const entry of catalog) {
        const id = entry instanceof Map ? entry.get("id") : undefined;
        if (entry instanceof Map && typeof id === "string") this.scopes.set(id, entry.get("scope") ?? null);
      }
    }
  }

  private async subscribe(connection: StreamConnection): Promise<void> {
    const extra = this.subscription();
    const sent = new Map([...this.hooks.values()].filter((hook) => hook.served).map((hook) => [hook.name, hook]));
    this.accepted = new Map();
    const reply = await connection.subscribe(this.eventNames(), extra);
    const revisions = reply instanceof Map && reply.get("revisions") instanceof Map ? (reply.get("revisions") as JsonObject) : new Map<string, Value>();
    this.accepted = new Map();
    for (const [name, revision] of revisions) {
      const hook = sent.get(name);
      if (hook !== undefined && typeof revision === "string") this.accepted.set(name, [revision, hook]);
    }
    if (extra.has("hooks")) {
      const servedList = reply instanceof Map ? reply.get("served") : undefined;
      const served = Array.isArray(servedList) ? servedList : [];
      const missing = [...this.hooks.values()].filter((hook) => hook.served && !served.includes(hook.name)).map((hook) => hook.name);
      if (missing.length > 0) this.log.write(`Ardia doesn't take these hooks from this runner yet (not in its hooks.json, or changed): ${missing.join(", ")}`);
    }
    await this.loadScopes(connection);
  }

  private async serve(connection: StreamConnection): Promise<void> {
    this.markChanged();
    type Next = { kind: "event"; event: JsonObject } | { kind: "decide"; message: JsonObject } | { kind: "changed" } | { kind: "stop" } | { kind: "failed"; error: unknown };
    const failed = (error: unknown): Next => ({ kind: "failed", error });
    let reading: Promise<Next> | undefined;
    let deciding: Promise<Next> | undefined;
    for (;;) {
      if (this.stopping) return;
      if (this.changedFlag) {
        this.changedFlag = false;
        await this.subscribe(connection);
        this.subscribed = true;
        for (const wake of this.subscribedWaiters.splice(0)) wake();
      }
      reading ??= connection.nextEvent().then((event): Next => ({ kind: "event", event }), failed);
      deciding ??= connection.nextDecide().then((message): Next => ({ kind: "decide", message }), failed);
      const waiting = new Promise<Next>((resolve) => {
        if (this.changedFlag) resolve({ kind: "changed" });
        this.changedWake = () => resolve({ kind: "changed" });
        this.wakeStop = () => resolve({ kind: "stop" });
      });
      const next = await Promise.race([reading, deciding, waiting]);
      this.changedWake = undefined;
      if (next.kind === "failed") throw next.error;
      if (next.kind === "decide") {
        deciding = undefined;
        this.decider.handle(next.message, this.accepted, connection);
      } else if (next.kind === "event") {
        reading = undefined;
        const behind = connection.takeDropped();
        if (behind) this.log.write(`warning: ${behind} event${behind !== 1 ? "s" : ""} dropped before this one because the runner fell behind reading them`);
        this.dispatch(next.event);
      } else if (next.kind === "stop") return;
    }
  }

  whenSubscribed(): Promise<void> {
    if (this.subscribed) return Promise.resolve();
    return new Promise((resolve) => this.subscribedWaiters.push(resolve));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.wakeStop?.();
    this.connection?.close();
    await this.decider.stop();
    await Promise.all([...this.runners.values(), ...this.retired].map((runner) => runner.stop().catch(() => {})));
  }
}

export function fileSignature(path: string): string | null {
  try {
    const info = statSync(path, { bigint: true });
    const link = lstatSync(path, { bigint: true });
    return [info.ino, info.dev, info.size, info.mtimeNs, link.ino, link.mtimeNs].join(":");
  } catch {
    return null;
  }
}

export function load(path: string, service: Service, log: LogSink): void {
  let hooks: Hook[];
  try {
    hooks = readHooks(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      log.write(`no ${path} yet; waiting for it`);
      service.setHooks([]);
      return;
    }
    if (error instanceof HooksError) {
      log.write(`${path}: ${error.message}; keeping the hooks loaded before`);
      return;
    }
    if (typeof (error as NodeJS.ErrnoException).errno === "number") {
      log.write(`${path}: ${strerrorOr(error)}; keeping the hooks loaded before`);
      return;
    }
    throw error;
  }
  service.setHooks(hooks);
  log.write(`loaded ${hooks.length} hook${hooks.length !== 1 ? "s" : ""}: ${hooks.map((hook) => hook.name).join(", ") || "none"}`);
}

export async function watchHooks(path: string, service: Service, log: LogSink, stopped: () => boolean, interval = WATCH_INTERVAL): Promise<void> {
  let seen: string | null | undefined;
  let first = true;
  while (!stopped()) {
    const signature = fileSignature(path);
    if (first || signature !== seen) {
      first = false;
      seen = signature;
      load(path, service, log);
    }
    await sleep(interval);
  }
}
