import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { type Value } from "../../json.ts";
import { armWatchdog, disarmWatchdog, peerUid, removeDirAt, renameExclusiveAt } from "../../libc.ts";
import { codeOf, uid } from "../../paths.ts";
import { formatG, roundHalfEven } from "../../pylib/format.ts";
import { PyException } from "../../pylib/str.ts";
import { Cancelled, currentSignal, withSignal } from "../cdp/cancel.ts";
import { BrowseError, ConnectionLost, Unreachable } from "../daemon-errors.ts";
import { type Endpoint, EndpointError, resolve, resolveInstance } from "../endpoint.ts";
import { BEHIND_SCRIPT_WAIT, commandLimit, QUEUE_WAIT, queueWait } from "../limits.ts";
import { active, answerFields, begin, failedStep, flag, type Metrics } from "../metrics.ts";
import { browseDir, closeFd, listNames, openPrivateDirAt, PathError, sameSocket, type SocketId, socketIsOurs, takeLock, unlinkQuietly, writePrivateJson } from "../paths.ts";
import * as temptabs from "../state/temptabs.ts";
import { wallSeconds } from "../tokens.ts";
import { release as releaseClaims } from "./claims.ts";
import { type DaemonConfig } from "./config.ts";
import { FifoLock } from "./lock.ts";
import { bindCommandLock } from "../capture/store.ts";
import { closeCaptures } from "../capture/close.ts";
import { type Caller, parseCaller } from "./announce.ts";
import { log } from "./log.ts";
import { canonical } from "./names.ts";
import { type Answer, encodeAnswer, joinedBatch, MAX_REQUEST, MAX_RESPONSE, type Options, render, Result, timedOut } from "./render.ts";
import { redact } from "../../redact.ts";
import { parseText } from "../../json.ts";
import { dispatch, hooks } from "../commands/all.ts";
import { Ctx } from "../commands/ctx.ts";
import { State } from "../state/state.ts";
import { appCall, appTabMap } from "../state/apptabs.ts";
import { heldAppTabs, recentlyUsed, shouldScan, TabHolds } from "./holds.ts";
import { reportException } from "../../telemetry.ts";
import { buildStamp, cliVersion } from "../../version.ts";

export const CONNECTED_IDLE = 30.0;
export const DEFAULT_DAEMON_IDLE = 3600.0;
export const SETTLE_TIMEOUT = 5.0;
export const CLEANUP_TIMEOUT = 10.0;
export const WATCH_INTERVAL = 2.0;
export const EXIT_GRACE = 3.0;
export const READ_TIMEOUT = 30.0;
export const SHUTDOWN_EXIT = 1;

export function settledError(error: BrowseError, browser: { readonly alive: boolean; readonly closedByUs: boolean } | null): { error: BrowseError; lost: boolean } {
  if (error instanceof ConnectionLost) return { error, lost: true };
  if (browser === null || browser.alive || browser.closedByUs) return { error, lost: false };
  if (error.cause instanceof ConnectionLost) return { error, lost: true };
  return { error: new ConnectionLost(), lost: true };
}

type Request = Record<string, unknown>;
type Running = { name: string; since: number };

function monotonic(): number {
  return performance.now() / 1000;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function socketFd(socket: net.Socket): number | null {
  const handle = (socket as unknown as { _handle?: { fd?: unknown } })._handle;
  return typeof handle?.fd === "number" ? handle.fd : null;
}

export class Gone extends Error {}

export class Daemon {
  readonly dirFd: number;
  readonly key: string;
  readonly sock: string;
  readonly lockFd: number | null;
  readonly state: State;
  readonly lock = new FifoLock();
  pending = 0;
  last = monotonic();
  stopping = false;
  private holdsOf: TabHolds | null = null;
  private scannedAt = Number.NEGATIVE_INFINITY;
  closing = 0;
  running: Running | null = null;
  closeAfterBatch = false;
  readonly active = new Set<{ done: Promise<unknown>; stop: AbortController; startedAt: number }>();
  sockId: SocketId | null = null;
  readonly idleLimit: number;
  connectedIdle = CONNECTED_IDLE;
  settleTimeout = SETTLE_TIMEOUT;
  cleanupTimeout = CLEANUP_TIMEOUT;
  closeTimeout = CLEANUP_TIMEOUT;
  closeWait = BEHIND_SCRIPT_WAIT;
  watchdog: { arm(dir: number, name: string, dev: bigint, ino: bigint, ms: number, code: number): number; disarm(): number } = {
    arm: armWatchdog,
    disarm: disarmWatchdog,
  };
  exit: (code: number) => void = (code) => process.exit(code);
  private watchdogState: "idle" | "armed" | "failed" = "idle";
  private stopNow: () => void = () => {};
  private readonly stopped: Promise<void>;
  private server: net.Server | null = null;

  constructor(readonly config: DaemonConfig) {
    this.dirFd = browseDir(config.dataRoot);
    this.key = config.key;
    this.sock = `${this.key}.sock`;
    try {
      this.lockFd = takeLock(`${this.key}.lock`, this.dirFd);
    } catch (error) {
      closeFd(this.dirFd);
      throw error;
    }
    this.state = new State(
      { session: config.session, key: config.key, browseFd: this.dirFd, noAutoDialog: config.noAutoDialog, pinTab: config.pinTab, dataDir: config.dataDir, dataRoot: config.dataRoot },
      () => this.resolveEndpoint(),
    );
    bindCommandLock(this.state, this.lock);
    this.idleLimit = (config.idleTimeoutMs || DEFAULT_DAEMON_IDLE * 1000) / 1000;
    this.stopped = new Promise((resolve) => {
      this.stopNow = resolve;
    });
  }

  async resolveEndpoint(): Promise<Endpoint> {
    try {
      return await resolve({ ws: this.config.ws, port: this.config.port, data_dir: this.config.dataDir });
    } catch (error) {
      if (error instanceof EndpointError) throw new Unreachable(error.message);
      throw error;
    }
  }

  async resolveInstance(): Promise<string | null> {
    try {
      return await resolveInstance({ ws: this.config.ws, port: this.config.port, data_dir: this.config.dataDir });
    } catch (error) {
      if (error instanceof EndpointError) throw new Unreachable(error.message);
      throw error;
    }
  }

  leases(): Set<string> {
    return this.state.activeLeases();
  }

  private enterFolder(): void {
    process.chdir(path.join(this.config.dataRoot, "Browse"));
    const here = fs.statSync(".", { bigint: true });
    const held = fs.fstatSync(this.dirFd, { bigint: true });
    if (here.dev !== held.dev || here.ino !== held.ino) throw new PathError("the Browse folder changed while the daemon started");
  }

  private bindFolder(): number {
    const name = `.${this.key}.bind`;
    let stale: number | null = null;
    try {
      stale = openPrivateDirAt(this.dirFd, name, false);
    } catch (error) {
      if (codeOf(error) !== "ENOENT") throw error;
    }
    if (stale !== null) {
      try {
        for (const entry of listNames(stale)) unlinkQuietly(entry, stale);
      } finally {
        closeFd(stale);
      }
      removeDirAt(this.dirFd, name);
    }
    return openPrivateDirAt(this.dirFd, name, true);
  }

  private listen(): Promise<net.Server> {
    const folder = `.${this.key}.bind`;
    const bindFd = this.bindFolder();
    const previous = process.umask(0o177);
    return new Promise<net.Server>((resolve, reject) => {
      const server = net.createServer({ allowHalfOpen: true }, (socket) => {
        this.handle(socket).catch((error: unknown) => log.exception("request failed", error));
      });
      server.once("error", reject);
      server.listen(`${folder}/s`, () => {
        server.off("error", reject);
        try {
          const bound = socketIsOurs("s", bindFd);
          if (bound === null) throw new PathError("the daemon's socket vanished before it was published");
          try {
            renameExclusiveAt(bindFd, "s", this.dirFd, this.sock);
          } catch (error) {
            if (codeOf(error) === "EEXIST") throw new PathError(`${this.sock} appeared while the daemon started`);
            throw error;
          }
          if (!sameSocket(socketIsOurs(this.sock, this.dirFd), bound)) throw new PathError(`${this.sock} changed while the daemon published it`);
          this.sockId = bound;
        } catch (error) {
          server.close();
          reject(error);
          return;
        }
        resolve(server);
      });
    }).finally(() => {
      process.umask(previous);
      try {
        unlinkQuietly("s", bindFd);
      } catch {}
      closeFd(bindFd);
      try {
        removeDirAt(this.dirFd, folder);
      } catch {}
    });
  }

  private dropSocket(): void {
    try {
      if (this.sockId !== null && sameSocket(socketIsOurs(this.sock, this.dirFd), this.sockId)) unlinkQuietly(this.sock, this.dirFd);
    } catch {}
  }

  private enterStopping(): void {
    this.stopping = true;
    if (this.watchdogState !== "idle") return;
    const id = this.sockId ?? { dev: 0n, ino: 0n };
    let result: number;
    try {
      result = this.watchdog.arm(this.dirFd, this.sock, id.dev, id.ino, (this.settleTimeout + this.cleanupTimeout) * 1000, SHUTDOWN_EXIT);
    } catch {
      result = -1;
    }
    if (result === 0) {
      this.watchdogState = "armed";
      return;
    }
    this.watchdogState = "failed";
    log.warning("the shutdown watchdog couldn't be armed; exiting now");
    this.dropSocket();
    this.exit(SHUTDOWN_EXIT);
  }

  async run(): Promise<number> {
    if (this.lockFd === null) return 0;
    this.enterFolder();
    if (socketIsOurs(this.sock, this.dirFd)) unlinkQuietly(this.sock, this.dirFd);
    this.server = await this.listen();
    writePrivateJson(
      `${this.key}.json`,
      this.dirFd,
      new Map<string, Value>([
        ["session", this.state.session],
        ["namespace", this.config.namespace],
        ["endpoint", this.config.endpointLabel],
        ["pid", BigInt(process.pid)],
        ["started", BigInt(Math.trunc(wallSeconds()))],
        ["build", buildStamp()],
      ]),
    );
    const onSignal = () => this.beginStop();
    for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) process.on(signal, onSignal);
    const idle = setInterval(() => this.idleTick().catch((error: unknown) => log.exception("idle check failed", error)), 1000);
    let watching = false;
    const watch = setInterval(() => {
      if (watching) return;
      watching = true;
      this.watchTick()
        .catch((error: unknown) => log.exception("watch failed", error))
        .finally(() => {
          watching = false;
        });
    }, WATCH_INTERVAL * 1000);
    try {
      await this.stopped;
    } finally {
      this.enterStopping();
      this.server.close();
      clearInterval(idle);
      clearInterval(watch);
      for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) process.off(signal, onSignal);
    }
    if (this.watchdogState === "failed") return SHUTDOWN_EXIT;
    await this.settle();
    await this.cleanup();
    if (this.watchdogState === "armed" && this.watchdog.disarm() !== 0) {
      log.warning("the shutdown watchdog fired while cleanup finished; waiting for it to exit");
      await new Promise(() => {});
    }
    closeFd(this.lockFd);
    return 0;
  }

  beginStop(): void {
    if (this.server !== null) this.enterStopping();
    else this.stopping = true;
    this.stopNow();
  }

  async settle(): Promise<void> {
    const active = [...this.active];
    if (active.length === 0) return;
    await within(Promise.allSettled(active.map((task) => task.done)), this.settleTimeout);
    for (const task of active) task.stop.abort(new Cancelled());
    await within(Promise.allSettled(active.map((task) => task.done)), this.cleanupTimeout);
  }

  refuseClosing(options: Options, name: string): Answer {
    return render(options, null, new BrowseError(`Session ${this.state.session} is closing; start a new command after it ends`, null, "session_closing"), name);
  }

  async cleanup(): Promise<void> {
    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(new Cancelled()), this.cleanupTimeout * 1000);
    try {
      await within(
        withSignal(budget.signal, () => this.cleanupInner()),
        this.cleanupTimeout,
      );
    } catch (error) {
      log.exception("cleanup failed", error);
    } finally {
      clearTimeout(timer);
    }
    this.dropSocket();
    try {
      unlinkQuietly(`${this.key}.json`, this.dirFd);
    } catch {}
    try {
      releaseClaims(this.dirFd, this.key);
    } catch {}
    try {
      this.state.registry.forget();
    } catch {}
  }

  private async cleanupInner(): Promise<void> {
    await this.holds.close();
    await temptabs.drain(this.state);
    if (this.state.connected) {
      for (const page of [...this.state.pages.values()]) if (page.sessionId && page.input.releaseAll) await page.input.releaseAll();
      await closeCaptures(this.state);
    }
    if (hooks.shutdown) await hooks.shutdown();
    await this.state.disconnect();
  }

  async idleTick(): Promise<void> {
    const now = monotonic();
    if (this.state.lost || this.state.restarted) {
      if (this.pending === 0 || now - this.last > EXIT_GRACE) this.stopNow();
      return;
    }
    if (this.state.connected) {
      if (this.pending === 0 && !this.lock.locked && this.leases().size === 0 && !this.state.holding() && now - this.last > this.connectedIdle) {
        await this.lock.acquire();
        try {
          if (this.pending === 0 && this.leases().size === 0 && !this.state.holding()) await this.state.disconnect();
        } finally {
          this.lock.release();
        }
      }
    } else if (this.pending === 0 && now - this.last > this.idleLimit) this.stopNow();
  }

  async watchTick(): Promise<void> {
    const browser = this.state.browser;
    if (browser !== null && browser.link !== null && browser.link.lost && !browser.closedByUs) {
      this.state.lost = true;
      log.info("Ardia closed the connection; this daemon ends");
      return;
    }
    if (browser === null && this.state.instance !== null && this.pending === 0) {
      let instance: string | null;
      try {
        instance = await this.resolveInstance();
      } catch (error) {
        if (error instanceof BrowseError) {
          this.stopNow();
          return;
        }
        throw error;
      }
      if (instance !== this.state.instance) this.stopNow();
    }
    await this.renewHolds();
  }

  private get holds(): TabHolds {
    this.holdsOf ??= new TabHolds(
      this.key,
      (method, params) => appCall(this.state, method, params),
      (why) => log.warning(`Ardia refused to keep this session's tabs loaded (${why}); trying again in a minute`),
    );
    return this.holdsOf;
  }

  private async renewHolds(): Promise<void> {
    if (this.stopping) return;
    const now = monotonic();
    const recent = recentlyUsed(this.state.usedAt, now, [...this.active].map((task) => task.startedAt));
    for (const target of this.state.usedAt.keys()) if (!recent.includes(target)) this.state.usedAt.delete(target);
    const live = (target: string) => this.state.targetInfos.has(target);
    const unmapped = recent.filter((target) => live(target) && !this.state.appTabs.has(target));
    if (this.state.connected && shouldScan(unmapped, this.state.usedAt, this.scannedAt, now)) {
      this.scannedAt = now;
      await appTabMap(this.state).catch(() => undefined);
    }
    await this.holds.tick(heldAppTabs(recent, live, (target) => this.state.appTabs.get(target)), now);
    const gone = new Set(this.holds.gone);
    for (const [target, app] of this.state.appTabs) if (gone.has(app)) this.state.usedAt.delete(target);
  }





  async handle(socket: net.Socket): Promise<void> {
    const fd = socketFd(socket);
    let peer: number | null = null;
    try {
      peer = fd === null ? null : peerUid(fd);
    } catch {}
    if (peer !== uid()) {
      socket.destroy();
      return;
    }
    this.pending += 1;
    this.last = monotonic();
    try {
      const reading = readRequest(socket);
      const line = await reading.line;
      const request = parseRequest(line);
      if (request === null) return;
      const stop = new AbortController();
      let metrics: Metrics | undefined;
      const execute = withSignal(stop.signal, () =>
        begin(request as never, (current) => {
          metrics = current;
          return this.execute(request);
        }),
      );
      const task = { done: execute.catch(() => undefined), stop, startedAt: monotonic() };
      this.active.add(task);
      task.done.finally(() => this.active.delete(task));
      const outcome = await Promise.race([execute.then((answer) => ({ answer }), (error: unknown) => ({ error })), reading.gone.then(() => ({ gone: true }))]);
      if ("gone" in outcome) {
        stop.abort(new Cancelled());
        await task.done;
        return;
      }
      if ("error" in outcome) throw outcome.error;
      const [code, out, err, body] = outcome.answer;
      const fields: [string, Value][] = [];
      if (body) fields.push(["body", Buffer.from(body).toString("base64")], ["body_bytes", BigInt(body.length)]);
      const extra = answerFields(metrics);
      if (extra.metrics) fields.push(["metrics", new Map([...extra.metrics].map(([key, value]): [string, Value] => [key, typeof value === "number" ? BigInt(value) : value]))]);
      if (extra.code) fields.push(["code", extra.code]);
      if (extra.failed_step_command) fields.push(["failed_step_command", extra.failed_step_command]);
      if (request["busy_elsewhere"]) fields.push(["busy_elsewhere", true]);
      fields.push(["daemon", `ts/${cliVersion()}`]);
      const argv0 = Array.isArray(request["argv"]) && request["argv"].length > 0 ? canonical(String(request["argv"][0])) : "";
      await writeAnswer(socket, encodeAnswer(code, out, err, fields, MAX_RESPONSE, argv0, Boolean(record(request["options"])["json"])));
    } catch (error) {
      if (!(error instanceof Gone) && !(error instanceof Cancelled)) log.exception("request failed", error);
    } finally {
      this.pending -= 1;
      this.last = monotonic();
      socket.destroy();
    }
  }

  async execute(request: Request): Promise<Answer> {
    const argv = Array.isArray(request["argv"]) ? (request["argv"] as unknown[]) : [];
    const options = record(request["options"]);
    const name = argv.length > 0 ? canonical(String(argv[0])) : "";
    const cwd = typeof request["cwd"] === "string" && request["cwd"] ? request["cwd"] : (process.env["HOME"] ?? "/");
    const ctx = new Ctx(this.state, options, cwd, record(request["env"]), typeof request["stdin"] === "string" ? request["stdin"] : null, name);
    const caller = parseCaller(request["caller"]);
    if (options["no_auto_dialog"]) this.state.autoDialog = false;
    if (options["pin_tab"] !== undefined && options["pin_tab"] !== null) this.state.pinTab = Boolean(options["pin_tab"]);
    if (this.stopping) return this.refuseClosing(options, name);
    if (name === "close") return this.close(ctx, caller);
    if (request["beside_if_busy"] && this.lock.locked) {
      request["busy_elsewhere"] = true;
      return render(options, null, this.busyError(false), name);
    }
    const words = argv.slice(1).map(String);
    let patience = queueWait(name, words, QUEUE_WAIT, name === "read" && Boolean(request["patient_queue"]));
    if (this.lock.locked && this.running?.name === "script" && patience < BEHIND_SCRIPT_WAIT) {
      patience = BEHIND_SCRIPT_WAIT;
      flag("queued_behind_script", true);
    } else if (patience > QUEUE_WAIT && this.lock.locked) {
      flag(request["patient_queue"] ? "read_queued_beside" : "script_queued_behind_busy", true);
    }
    const signal = currentSignal();
    if (!(await this.lock.acquire(patience, signal))) return render(options, null, this.busyError(patience), name);
    this.state.caller = caller ?? this.state.caller;
    let answer: Answer;
    let closeAfter = false;
    try {
      if (this.stopping || this.closing) return this.refuseClosing(options, name);
      if (this.state.lost) return render(options, null, new ConnectionLost(), name);
      this.state.notice = null;
      if (this.state.connected) await this.state.announceCaller(this.state.endpoint);
      this.closeAfterBatch = false;
      this.state.topCommand = name;
      this.running = { name, since: monotonic() };
      const limit = commandLimit(name, words, ctx.timeout);
      answer = await this.withinLimit(limit, options, name, () => this.answer(ctx, name, words, options));
      if (hooks.afterCommand) await hooks.afterCommand(this.state);
      const notice = this.state.notice;
      this.state.notice = null;
      answer = [answer[0], answer[1], (notice ? `${redact(notice)}\n` : "") + answer[2], ...(answer[3] ? [answer[3]] : [])] as Answer;
      const batchClose = hooks.closeAfterBatch ? hooks.closeAfterBatch(this.state) : false;
      closeAfter = (this.closeAfterBatch || batchClose) && name === "batch" && answer[0] === 0;
      this.closeAfterBatch = false;
    } finally {
      this.running = null;
      this.lock.release();
    }
    if (closeAfter) {
      const steps = active()?.values.get("batch_steps");
      const [closedCode, closedOut, closedErr] = await this.close(ctx, null);
      if (closedCode !== 0) failedStep(typeof steps === "number" ? steps : 0, "close", active()?.errorCode);
      return [Math.max(answer[0], closedCode), joinedBatch(answer[1], closedOut, options), answer[2] + closedErr];
    }
    return answer;
  }

  private async withinLimit(limit: number, options: Options, name: string, run: () => Promise<Answer>): Promise<Answer> {
    const outer = currentSignal();
    const inner = new AbortController();
    const forward = () => inner.abort(new Cancelled());
    outer?.addEventListener("abort", forward, { once: true });
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      inner.abort(new Cancelled());
    }, limit * 1000);
    try {
      return await withSignal(inner.signal, run);
    } catch (error) {
      if (expired && error instanceof Cancelled && !outer?.aborted) return render(options, null, timedOut(name, limit), name);
      throw error;
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", forward);
    }
  }

  busyError(waited: number | boolean = true): BrowseError {
    const running = this.running;
    const age = running?.since ? ` for ${roundHalfEven(monotonic() - running.since)} s` : "";
    let what = running?.name ? `\`${running.name}\`` : "another command";
    const seconds = waited === true ? QUEUE_WAIT : waited;
    const waiting = waited ? `this command waited ${formatG(Number(seconds))} s for it and gave up without running` : "this command didn't run";
    const stuck = [...this.state.pages.values()]
      .filter((page) => page.unansweredAt && monotonic() - page.unansweredAt < 120)
      .map((page) => this.state.tabId(page.targetId));
    if (stuck.length > 0) {
      flag("session_busy_on_stuck_tab", true);
      what += `, which is waiting on [${stuck[0]}], a tab whose page isn't answering (its own scripts keep it busy)`;
    }
    return new BrowseError(
      `This session is still running ${what}${age}; ${waiting}. A session runs one command at a time: wait for it ` +
        "(a long `script` returns when done), or run independent work with `--session <name>`, which gets its own tab",
      null,
      "session_busy",
    );
  }

  async answer(ctx: Ctx, name: string, argv: string[], options: Options): Promise<Answer> {
    let result: Result;
    try {
      result = await this.dispatch(ctx, name, argv);
    } catch (thrown) {
      if (thrown instanceof Cancelled) throw thrown;
      if (thrown instanceof BrowseError) {
        const { error, lost } = settledError(thrown, this.state.browser);
        if (lost) this.state.lost = true;
        if (error instanceof Unreachable && this.state.instance === null) this.state.restarted = true;
        return render(options, null, error, name);
      }
      log.exception(`command ${name} crashed`, thrown);
      reportException(thrown, "browse_daemon", { dataRoot: this.config.dataRoot, testEndpoint: Boolean(this.config.ws || this.config.port) });
      const type = thrown instanceof PyException ? thrown.type : thrown instanceof Error ? thrown.name : "Error";
      const said = thrown instanceof Error ? thrown.message : String(thrown);
      return render(options, null, new BrowseError(`${name} failed: ${type}: ${said}`), name);
    }
    return render(options, result, null, name);
  }

  async dispatch(ctx: Ctx, name: string, argv: string[]): Promise<Result> {
    return dispatch(ctx, name, argv);
  }

  private async lockForClose(): Promise<boolean> {
    this.closing += 1;
    try {
      return await this.lock.acquire(this.closeWait, currentSignal());
    } finally {
      this.closing -= 1;
    }
  }

  async close(ctx: Ctx, caller: Caller | null): Promise<Answer> {
    const state = this.state;
    const tally = { closed: 0, kept: [] as string[] };
    if (!(await this.lockForClose())) return render(ctx.options, null, this.busyError(this.closeWait), "close");
    state.caller = caller ?? state.caller;
    try {
      if (this.stopping) return this.refuseClosing(ctx.options, "close");
      this.enterStopping();
      if (this.watchdogState === "failed") return this.refuseClosing(ctx.options, "close");
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(new Cancelled()), this.closeTimeout * 1000);
      try {
        await within(
          withSignal(deadline.signal, () => this.closeTabs(tally)),
          this.closeTimeout,
        );
      } catch (error) {
        if (!(error instanceof Cancelled)) log.exception("closing the session's tabs failed", error);
      } finally {
        clearTimeout(timer);
        state.forgetSessionTabs();
      }
    } finally {
      this.lock.release();
      if (this.stopping) this.stopNow();
    }
    let text = `✓ Session ${state.session} closed (${tally.closed} tab${tally.closed !== 1 ? "s" : ""} it opened)`;
    if (tally.kept.length > 0) text += `; left open: ${tally.kept.join("; ")}`;
    return render(ctx.options, new Result({ closed: true, tabs: tally.closed, keptOpen: tally.kept }, text), null, "close");
  }

  private async closeTabs(tally: { closed: number; kept: string[] }): Promise<void> {
    const state = this.state;
    const leftovers = state.instance !== null && state.registry.temporaries(state.instance).length > 0;
    if ((state.opened.size === 0 && !leftovers && !state.ownsSessionTabs()) || state.lost) return;
    try {
      await state.connect();
      await state.refreshTargets();
      await state.readoptOpenedTabs();
      await temptabs.sweep(state);
      const registry = state.registry;
      const instance = state.instance;
      for (const targetId of [...state.opened]) {
        if (!state.targetInfos.has(targetId)) {
          state.forgetTarget(targetId);
          continue;
        }
        if (!registry.reserveClose(instance, targetId)) {
          const users = registry.others(instance)[1].get(targetId) ?? ["another session"];
          tally.kept.push(`[${state.tabId(targetId)}], which session ${users.join(", ")} uses`);
          state.forgetTarget(targetId);
          continue;
        }
        try {
          await state.browser?.send("Target.closeTarget", { targetId });
          tally.closed += 1;
        } finally {
          registry.finishClose(instance, targetId);
        }
        state.forgetTarget(targetId);
      }
    } catch (error) {
      if (!(error instanceof BrowseError)) throw error;
    }
  }
}

function within<T>(work: Promise<T>, seconds: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), seconds * 1000);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function plainOf(value: Value): unknown {
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : value;
  if (value instanceof Map) return Object.fromEntries([...value].map(([key, item]) => [key, plainOf(item)]));
  if (Array.isArray(value)) return value.map(plainOf);
  if (value !== null && typeof value === "object") return value.value;
  return value;
}

export function parseRequest(line: Buffer): Request | null {
  let parsed: Value | undefined;
  try {
    parsed = parseText(new TextDecoder("utf-8", { fatal: true }).decode(line));
  } catch (error) {
    log.exception("request failed", error);
    return null;
  }
  if (!(parsed instanceof Map)) {
    log.exception("request failed", new TypeError(parsed === undefined ? "the request isn't JSON" : "the request isn't a JSON object"));
    return null;
  }
  return plainOf(parsed) as Request;
}

export function readRequest(socket: net.Socket): { line: Promise<Buffer>; gone: Promise<void> } {
  const chunks: Buffer[] = [];
  let size = 0;
  let lineDone = false;
  let resolveLine: (line: Buffer) => void = () => {};
  let rejectLine: (error: unknown) => void = () => {};
  let resolveGone: () => void = () => {};
  const line = new Promise<Buffer>((resolve, reject) => {
    resolveLine = resolve;
    rejectLine = reject;
  });
  const gone = new Promise<void>((resolve) => {
    resolveGone = resolve;
  });
  const timer = setTimeout(() => {
    if (!lineDone) {
      lineDone = true;
      rejectLine(new Error("the request didn't arrive within 30 s"));
    }
  }, READ_TIMEOUT * 1000);
  const finishLine = (data: Buffer) => {
    lineDone = true;
    clearTimeout(timer);
    resolveLine(data);
  };
  socket.on("data", (chunk: Buffer) => {
    if (lineDone) {
      resolveGone();
      return;
    }
    const newline = chunk.indexOf(0x0a);
    if (newline >= 0) {
      chunks.push(chunk.subarray(0, newline + 1));
      size += newline + 1;
      if (size > MAX_REQUEST) {
        lineDone = true;
        clearTimeout(timer);
        rejectLine(new Error("the request is over the 16 MB limit"));
        return;
      }
      finishLine(Buffer.concat(chunks));
      if (newline + 1 < chunk.length) resolveGone();
      return;
    }
    chunks.push(chunk);
    size += chunk.length;
    if (size >= MAX_REQUEST) {
      lineDone = true;
      clearTimeout(timer);
      rejectLine(new Error("the request is over the 16 MB limit"));
    }
  });
  const ended = () => {
    if (!lineDone) finishLine(Buffer.concat(chunks));
    resolveGone();
  };
  socket.on("end", ended);
  socket.on("close", ended);
  socket.on("error", ended);
  return { line, gone };
}

function writeAnswer(socket: net.Socket, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.destroyed) {
      reject(new Gone());
      return;
    }
    socket.write(data, (error) => (error ? reject(error) : resolve()));
  });
}
