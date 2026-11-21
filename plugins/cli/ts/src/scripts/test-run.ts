import crypto from "node:crypto";
import fs from "node:fs";
import { Cancelled } from "../browse/cdp/cancel.ts";
import { ATTACH_METHODS } from "../browse/cdp/guard.ts";
import { CdpFailure, CdpLink, ConnectionLost } from "../browse/cdp/link.ts";
import { pyText, pyTruthy } from "../browse/cdp/pyvalue.ts";
import { announce, announcePath } from "../browse/daemon/announce.ts";
import { type Endpoint, EndpointError, unreachableMessage } from "../browse/endpoint.ts";
import { currentCaller } from "../caller.ts";
import { NOT_REACHABLE } from "../control.ts";
import { dumps, Float, type Value } from "../json.ts";
import path from "node:path";
import { baseName, expandUser, purePath } from "../paths.ts";
import { osErrorText } from "../pyerr.ts";
import { splitlines } from "../pylib/str.ts";
import { redact } from "../redact.ts";
import { JS as MATCHER } from "../urlmatch/urlmatch.ts";
import type { Build } from "./build.ts";
import { SourceMap } from "./sourcemap.ts";
import { metaId, metaWorld, rules } from "./userscript.ts";

const CONNECT_TIMEOUT = 10;
const RUN_TIMEOUT = 30;
const LOAD_GRACE = 10;
const CLEANUP_TIMEOUT = 5;
const EXPECT_POLL = 0.1;
const SEND_TIMEOUT = 15;
const MAX_PAGE_ERRORS = 5;
const MAX_ATTACHES = 64;
const MAX_TEXT = 2000;
const SOURCE_URL_PREFIX = "ardia-userscript:///";
const LEVELS: Record<string, string> = { warning: "warn", startGroup: "group", startGroupCollapsed: "groupCollapsed", endGroup: "groupEnd" };

const PRELUDE = (mark: string, rulesJson: string) => `(() => {
const mark = ${mark};
const rules = ${rulesJson};
const debug = console.debug.bind(console);
const href = location.href;
const top = window.top === window;
const verdict = (${MATCHER})(rules, href);
if (rules.noframes && !top) { debug(mark, "skip", href, top, "@noframes"); return; }
if (verdict !== "run") { debug(mark, "skip", href, top, verdict); return; }
const run = () => {
debug(mark, "start", href, top, "");
try {
`;

const POSTLUDE = (sourceUrl: string) => `} finally {
debug(mark, "done", href, top, "");
}
};
const afterDomReady = (next) => document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", next, { once: true }) : next();
const idle = () => {
let ran = false;
const go = () => { if (!ran) { ran = true; run(); } };
if (document.readyState === "complete") go();
else { window.addEventListener("load", go, { once: true }); setTimeout(go, 200); }
};
if (rules.runAt === "document-start") run();
else if (rules.runAt === "document-end") afterDomReady(run);
else afterDomReady(idle);
})();
//# sourceURL=${sourceUrl}
`;

const EXPECT_WRAPPER = (expression: string) => `(async () => {
const value = await (
${expression}
);
let shown;
if (value === undefined) shown = { undefined: true };
else if (value === null || ["string", "number", "boolean"].includes(typeof value)) shown = { value };
else if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") shown = { value: String(value) };
else {
try { shown = { value: JSON.parse(JSON.stringify(value)) }; } catch { shown = { value: Object.prototype.toString.call(value) }; }
if (typeof Node !== "undefined" && value instanceof Node) shown = { value: value.nodeName ? \`<\${value.nodeName.toLowerCase()}>\` : String(value) };
}
return { truthy: Boolean(value), ...shown };
})()`;

type Plain = Record<string, unknown>;
type Frame = { url: unknown; top: boolean; state: unknown; detail: unknown };
type ConsoleEntry = { level: string; text: string; at: string; frame: string | null };
type ErrorEntry = { text: string; frame: string | null; at?: string };
type Expect = { error?: string; truthy?: boolean; value?: unknown; undefined?: true; expression?: string };

function plain(value: unknown): Plain {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Plain) : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function orElse(value: unknown, fallback: unknown): unknown {
  return pyTruthy(value) ? value : fallback;
}

export function toValue(value: unknown): Value {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return Number.isSafeInteger(value) ? BigInt(value) : new Float(value);
  if (Array.isArray(value)) return value.map(toValue);
  if (value instanceof Map) return new Map([...value].map(([key, inner]) => [String(key), toValue(inner)]));
  return new Map(Object.entries(value as Plain).filter(([, inner]) => inner !== undefined).map(([key, inner]) => [key, toValue(inner)]));
}

function jsonText(value: unknown, ensureAscii: boolean): string {
  return dumps(toValue(value), "spaced", ensureAscii);
}

export function clip(text: string): string {
  const points = [...text];
  return points.length <= MAX_TEXT ? text : `${points.slice(0, MAX_TEXT).join("")}… (${points.length - MAX_TEXT} more characters)`;
}

function preview(data: Plain): string {
  const items: string[] = [];
  for (const raw of list(data["properties"])) {
    const prop = plain(raw);
    let value: unknown = Object.hasOwn(prop, "value") ? prop["value"] : Object.hasOwn(prop, "type") ? prop["type"] : "?";
    if (prop["type"] === "string") value = jsonText(value, false);
    items.push(data["subtype"] === "array" ? pyText(value) : `${pyText(prop["name"])}: ${pyText(value)}`);
  }
  if (pyTruthy(data["overflow"])) items.push("…");
  if (data["subtype"] === "array") return `[${items.join(", ")}]`;
  const subtype = data["subtype"];
  const description = data["description"];
  if (data["type"] === "object" && (subtype === undefined || subtype === null || subtype === "") && (description === "Object" || description === undefined || description === null)) {
    return `{${items.join(", ")}}`;
  }
  const head = pyText(orElse(description, Object.hasOwn(data, "type") ? data["type"] : "?"));
  return items.length > 0 ? `${head} {${items.join(", ")}}` : head;
}

export function describe(arg: Plain): string {
  if (pyTruthy(arg["preview"])) return preview(plain(arg["preview"]));
  if (Object.hasOwn(arg, "value")) {
    const value = arg["value"];
    return typeof value === "string" ? value : jsonText(value, true);
  }
  if (Object.hasOwn(arg, "unserializableValue")) return pyText(arg["unserializableValue"]);
  if (arg["type"] === "undefined") return "undefined";
  return pyText(orElse(arg["description"], orElse(arg["className"], Object.hasOwn(arg, "type") ? arg["type"] : "?")));
}

function lineCount(text: string): number {
  let count = 0;
  for (const char of text) if (char === "\n") count += 1;
  return count;
}

export class Report {
  finalUrl: string | null = null;
  frames: Frame[] = [];
  console: ConsoleEntry[] = [];
  exceptions: ErrorEntry[] = [];
  pageErrors: ErrorEntry[] = [];
  pageConsole = 0;
  expect: Expect | null = null;
  screenshot: string | null = null;
  warnings: string[] = [];
  error: string | null = null;
  kept: string | null = null;

  constructor(
    readonly script: string,
    readonly url: string,
    readonly runAt: string,
  ) {}

  get ran(): boolean {
    return this.frames.some((frame) => frame.state === "start" || frame.state === "done");
  }

  get unsettled(): number {
    const starts = this.frames.filter((frame) => frame.state === "start").length;
    const dones = this.frames.filter((frame) => frame.state === "done").length;
    return Math.max(0, starts - dones);
  }

  get ok(): boolean {
    if (this.error || !this.ran || this.exceptions.length > 0 || this.unsettled) return false;
    return this.expect === null || (!pyTruthy(this.expect.error) && pyTruthy(this.expect.truthy));
  }

  toValue(): Value {
    const entries: [string, unknown][] = [
      ["ok", this.ok],
      ["ran", this.ran],
      ["unfinished_passes", this.unsettled],
      ["script", this.script],
      ["url", this.url],
      ["final_url", this.finalUrl],
      ["run_at", this.runAt],
      ["frames", this.frames],
      ["console", this.console],
      ["exceptions", this.exceptions],
      ["page_errors", this.pageErrors],
      ["page_console_messages", this.pageConsole],
      ["expect", this.expect],
      ["screenshot", this.screenshot],
      ["warnings", this.warnings],
      ["error", this.error],
      ["kept_target", this.kept],
    ];
    return new Map(entries.map(([key, value]) => [key, toValue(value)]));
  }
}

export function wrap(build: Build, mark: string): [string, string, number] {
  const sourceUrl = `${SOURCE_URL_PREFIX}${metaId(build.meta)}.user.js`;
  const head = PRELUDE(dumps(mark, "spaced", true), dumps(toValue(rules(build.meta)), "spaced", true));
  const body = build.js.endsWith("\n") ? build.js : `${build.js}\n`;
  return [head + body + POSTLUDE(sourceUrl), sourceUrl, lineCount(head)];
}

class Flag {
  isSet = false;
  private release: () => void = () => {};
  readonly whenSet: Promise<void> = new Promise((resolve) => {
    this.release = resolve;
  });

  set(): void {
    this.isSet = true;
    this.release();
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function now(): number {
  return performance.now() / 1000;
}

class Run {
  readonly mark = crypto.randomBytes(12).toString("hex");
  readonly source: string;
  readonly sourceUrl: string;
  readonly map: SourceMap;
  readonly bodyStart: number;
  readonly bodyEnd: number;
  readonly location: RegExp;
  topSession: string | null = null;
  readonly topSettled = new Flag();
  readonly loaded = new Flag();
  readonly children = new Set<AbortController>();

  constructor(
    readonly build: Build,
    readonly report: Report,
    readonly cdp: Cdp,
  ) {
    const [source, sourceUrl, offset] = wrap(build, this.mark);
    this.source = source;
    this.sourceUrl = sourceUrl;
    this.map = new SourceMap(build.sourcemap, offset);
    this.bodyStart = offset;
    this.bodyEnd = offset + lineCount(build.js) + (build.js.endsWith("\n") ? 0 : 1);
    this.location = new RegExp(`${escapeRegExp(sourceUrl)}:(\\d+):(\\d+)`, "g");
  }

  mapped(line: number, column: number): string {
    if (!(Number.isInteger(line) && line >= this.bodyStart && line < this.bodyEnd)) return "ardia test wrapper";
    const found = this.map.lookup(line, column);
    if (found) return `${found[0]}:${found[1]}:${found[2]}`;
    return `${baseName(this.build.path)} (compiled):${line - this.bodyStart + 1}:${column + 1}`;
  }

  mapText(text: string): string {
    return text.replace(this.location, (_, line: string, column: string) => this.mapped(Number(line) - 1, Number(column) - 1));
  }

  ours(frames: unknown[]): Plain | null {
    for (const frame of frames) if (plain(frame)["url"] === this.sourceUrl) return plain(frame);
    return null;
  }

  frameOf(session: unknown): string | null {
    return session === this.topSession ? null : "iframe";
  }

  onEvent(method: string, params: Plain, session: unknown): void {
    if (method === "Runtime.consoleAPICalled") this.onConsole(params, session);
    else if (method === "Runtime.exceptionThrown") this.onException(plain(orElse(params["exceptionDetails"], {})), session);
    else if (method === "Page.loadEventFired" && session === this.topSession) this.loaded.set();
    else if (method === "Target.attachedToTarget" && pyTruthy(session) && pyTruthy(params["sessionId"]) && params["sessionId"] !== this.topSession) {
      void this.setupChild(params["sessionId"] as string, pyTruthy(params["waitingForDebugger"]));
    }
  }

  onConsole(params: Plain, session: unknown): void {
    const args = list(orElse(params["args"], [])).map(plain);
    if (args.length > 0 && (args[0] as Plain)["value"] === this.mark) {
      const values = args.slice(1, 5).map((arg) => arg["value"]);
      const [state, href, top, detail] = [values[0] ?? null, values[1] ?? null, values[2] ?? null, values[3] ?? null];
      this.report.frames.push({ url: href, top: pyTruthy(top), state, detail: orElse(detail, null) });
      if (pyTruthy(top) && (state === "done" || state === "skip")) this.topSettled.set();
      return;
    }
    const frames = list(orElse(plain(orElse(params["stackTrace"], {}))["callFrames"], []));
    const frame = this.ours(frames);
    if (frame === null) {
      this.report.pageConsole += 1;
      return;
    }
    const type = Object.hasOwn(params, "type") ? params["type"] : "log";
    const level = typeof type === "string" && Object.hasOwn(LEVELS, type) ? (LEVELS[type] as string) : pyText(type);
    this.report.console.push({
      level,
      text: clip(this.mapText(args.map(describe).join(" "))),
      at: this.mapped(numberOr(frame["lineNumber"]), numberOr(frame["columnNumber"])),
      frame: this.frameOf(session),
    });
  }

  onException(details: Plain, session: unknown): void {
    const exception = plain(orElse(details["exception"], {}));
    const description = orElse(exception["description"], exception["value"]);
    const text = orElse(details["text"], "Uncaught");
    const message = pyTruthy(description) && (text === "Uncaught" || text === "Uncaught (in promise)") ? `${pyText(text)} ${pyText(description)}` : orElse(description, text);
    const frames = list(orElse(plain(orElse(details["stackTrace"], {}))["callFrames"], []));
    const frame = this.ours(frames);
    const messageText = pyText(message);
    const ours = frame !== null || details["url"] === this.sourceUrl || messageText.includes(this.sourceUrl);
    const entry: ErrorEntry = { text: clip(this.mapText(messageText)), frame: this.frameOf(session) };
    if (frame !== null) entry.at = this.mapped(numberOr(frame["lineNumber"]), numberOr(frame["columnNumber"]));
    else if (details["url"] === this.sourceUrl) entry.at = this.mapped(numberOr(details["lineNumber"]), numberOr(details["columnNumber"]));
    if (ours) this.report.exceptions.push(entry);
    else if (this.report.pageErrors.length < MAX_PAGE_ERRORS) this.report.pageErrors.push(entry);
  }

  async setupChild(session: string, waiting: boolean): Promise<void> {
    const controller = new AbortController();
    this.children.add(controller);
    const send = (method: string, params: Plain = {}) => this.cdp.send(method, params, session, SEND_TIMEOUT, controller.signal);
    try {
      await send("Runtime.enable");
      await send("Page.enable");
      await send("Page.addScriptToEvaluateOnNewDocument", { source: this.source });
      await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    } catch {
    } finally {
      if (waiting && !controller.signal.aborted) {
        try {
          await send("Runtime.runIfWaitingForDebugger");
        } catch {}
      }
      this.children.delete(controller);
    }
  }
}

function numberOr(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return 0;
}

class Cdp {
  readonly link: CdpLink;

  constructor(
    url: string,
    readonly stop: AbortSignal,
  ) {
    this.link = new CdpLink(url);
  }

  get closed(): boolean {
    return this.link.lost;
  }

  async send(method: string, params: Plain = {}, session: string | null = null, timeout = SEND_TIMEOUT, signal: AbortSignal | null = this.stop): Promise<Plain> {
    const command: Plain = { method, params };
    if (session) command["sessionId"] = session;
    let reply;
    try {
      const ident = ATTACH_METHODS.has(method) ? (this.link.reserveAttach(MAX_ATTACHES) ?? undefined) : undefined;
      reply = await this.link.execute(command, timeout, ident, signal);
    } catch (error) {
      if (error instanceof CdpFailure || error instanceof ConnectionLost || error instanceof Cancelled) throw error;
      if (this.closed) throw new ConnectionLost();
      throw new CdpFailure(`${method}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return plain(orElse(reply["result"], {}));
  }
}

function waitAny(signal: AbortSignal, seconds: number, ...events: Promise<unknown>[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, Math.max(0, seconds) * 1000);
    const cancel = () => {
      clearTimeout(timer);
      reject(new Cancelled());
    };
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      resolve();
    }
    if (signal.aborted) return cancel();
    signal.addEventListener("abort", cancel, { once: true });
    for (const event of events) event.then(done, done);
  });
}

async function settle(run: Run, cdp: Cdp): Promise<void> {
  const started = now();
  await waitAny(cdp.stop, RUN_TIMEOUT, cdp.link.whenLost(), run.topSettled.whenSet);
  if (cdp.closed) throw new ConnectionLost();
  if (!run.topSettled.isSet) return;
  const remaining = Math.max(0, Math.min(LOAD_GRACE, RUN_TIMEOUT - (now() - started)));
  await waitAny(cdp.stop, remaining, cdp.link.whenLost(), run.loaded.whenSet);
  if (cdp.closed) throw new ConnectionLost();
}

async function sleepOrLost(cdp: Cdp, seconds: number): Promise<void> {
  await waitAny(cdp.stop, seconds, cdp.link.whenLost());
  if (cdp.closed) throw new ConnectionLost();
}

async function evaluatePlain(cdp: Cdp, session: string, expression: string): Promise<unknown> {
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, session);
  return plain(orElse(result["result"], {}))["value"];
}

async function checkFrames(cdp: Cdp, session: string, report: Report): Promise<void> {
  const counted = await evaluatePlain(cdp, session, 'document.querySelectorAll("iframe, frame").length');
  const frames = typeof counted === "boolean" ? Number(counted) : typeof counted === "number" && Number.isInteger(counted) ? counted : 0;
  const reported = report.frames.filter((frame) => !frame.top && (frame.state === "done" || frame.state === "skip")).length;
  if (frames > reported) {
    report.warnings.push(
      `${frames - reported} of the page's ${frames} iframes never reported back: they hadn't loaded, or they show ` +
        "an extension's or the browser's own page, which Ardia's control connection never reaches (a --port test " +
        "server does)",
    );
  }
}

async function finalUrl(cdp: Cdp, target: string): Promise<string | null> {
  let info: Plain;
  try {
    info = await cdp.send("Target.getTargetInfo", { targetId: target });
  } catch (error) {
    if (error instanceof CdpFailure) return null;
    throw error;
  }
  const url = plain(orElse(info["targetInfo"], {}))["url"];
  return url === undefined ? null : (url as string | null);
}

async function evaluate(cdp: Cdp, session: string, expression: string): Promise<Expect> {
  const result = await cdp.send("Runtime.evaluate", { expression: EXPECT_WRAPPER(expression), returnByValue: true, awaitPromise: true, userGesture: false }, session);
  if (Object.hasOwn(result, "exceptionDetails")) {
    const details = plain(result["exceptionDetails"]);
    const exception = plain(orElse(details["exception"], {}));
    return { error: clip(pyText(orElse(exception["description"], orElse(details["text"], "threw")))) };
  }
  const raw = plain(orElse(result["result"], {}))["value"];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { error: "the expression's value couldn't be read" };
  const value = raw as Plain;
  const outcome: Expect = { truthy: pyTruthy(value["truthy"]), value: value["value"] ?? null };
  if (pyTruthy(value["undefined"])) outcome.undefined = true;
  return outcome;
}

async function listen(cdp: Cdp, session: string, expression: string | null, wait: number): Promise<Expect | null> {
  const deadline = now() + Math.max(wait, 0);
  let outcome: Expect | null = null;
  while (expression !== null) {
    outcome = await evaluate(cdp, session, expression);
    outcome.expression = expression;
    if ((!pyTruthy(outcome.error) && pyTruthy(outcome.truthy)) || now() >= deadline) break;
    await sleepOrLost(cdp, EXPECT_POLL);
  }
  const remaining = deadline - now();
  if (remaining > 0) await sleepOrLost(cdp, remaining);
  return outcome;
}

async function capture(cdp: Cdp, session: string, given: string, report: Report): Promise<string | null> {
  try {
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, session, 10);
    const target = purePath(expandUser(given));
    if (!Object.hasOwn(shot, "data")) throw new KeyError("data");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(String(shot["data"]), "base64"));
    return target;
  } catch (error) {
    if (error instanceof ConnectionLost || error instanceof Cancelled) throw error;
    const text = error instanceof CdpFailure ? error.message : error instanceof KeyError ? `'${error.message}'` : osErrorText(error);
    report.warnings.push(`no screenshot: ${text}`);
    return null;
  }
}

class KeyError extends Error {}

async function cleanup(cdp: Cdp, run: Run, target: string | null, scriptId: unknown, keep: boolean, report: Report): Promise<void> {
  const steps = async () => {
    for (const child of run.children) child.abort();
    if (target && keep) {
      report.kept = target;
      return;
    }
    if (pyTruthy(scriptId) && run.topSession) {
      try {
        await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: scriptId }, run.topSession, CLEANUP_TIMEOUT, null);
      } catch {}
    }
    if (target) {
      try {
        await cdp.send("Target.closeTarget", { targetId: target }, null, CLEANUP_TIMEOUT, null);
      } catch {}
    }
  };
  const never = new AbortController().signal;
  try {
    await Promise.race([steps(), waitAny(never, CLEANUP_TIMEOUT * 2)]);
  } catch {}
  await cdp.link.close();
}

async function announceCaller(endpoint: Endpoint, signal: AbortSignal): Promise<void> {
  if (!endpoint.explicit) {
    const caller = currentCaller();
    await announce(announcePath(endpoint.source), { name: caller.name, app: caller.app ?? null }, undefined, signal);
  }
}

export type TestOptions = { expect: string | null; wait: number; screenshot: string | null; keep: boolean };

export async function runTest(build: Build, url: string, endpoint: Endpoint, options: TestOptions, stop: AbortSignal): Promise<Report> {
  const report = new Report(build.path, url, build.meta.run_at);
  report.warnings.push(...build.meta.warnings, ...build.warnings);
  if (metaWorld(build.meta) === "ISOLATED") {
    report.warnings.push(
      "@inject-into content: this test runs the script in the page's world (ardia command connections can't " +
        "create isolated worlds); installed, it runs in an isolated world and can't see page globals",
    );
  }
  const cdp = new Cdp(endpoint.ws, stop);
  const run = new Run(build, report, cdp);
  const announcing = announceCaller(endpoint, stop);
  try {
    await cdp.link.open(CONNECT_TIMEOUT, stop);
    await announcing;
  } catch (error) {
    await announcing.catch(() => {});
    if (error instanceof Cancelled) throw error;
    throw new EndpointError(endpoint.explicit ? unreachableMessage(endpoint, error) : NOT_REACHABLE);
  }
  cdp.link.listeners.push((method, params, session) => run.onEvent(method, plain(params), session));
  let target: string | null = null;
  let scriptId: unknown = null;
  try {
    try {
      const created = await cdp.send("Target.createTarget", { url: "about:blank", background: true });
      target = created["targetId"] as string;
      const attached = await cdp.send("Target.attachToTarget", { targetId: target, flatten: true });
      const session = attached["sessionId"] as string;
      run.topSession = session;
      await cdp.send("Runtime.enable", {}, session);
      await cdp.send("Page.enable", {}, session);
      scriptId = (await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: run.source }, session))["identifier"] ?? null;
      if (!build.meta.noframes) await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, session);
      const navigated = await cdp.send("Page.navigate", { url }, session, RUN_TIMEOUT);
      if (pyTruthy(navigated["errorText"])) {
        report.error = `couldn't open ${url}: ${pyText(navigated["errorText"])}`;
        return report;
      }
      await settle(run, cdp);
      if (!run.topSettled.isSet) {
        report.error = report.unsettled
          ? `the script's first pass in the top frame didn't finish within ${RUN_TIMEOUT}s (an endless loop?)`
          : `the top frame didn't run or skip the script within ${RUN_TIMEOUT}s`;
        return report;
      }
      report.finalUrl = await finalUrl(cdp, target);
      report.expect = await listen(cdp, session, options.expect, options.wait);
      if (!build.meta.noframes) await checkFrames(cdp, session, report);
      if (options.screenshot) report.screenshot = await capture(cdp, session, options.screenshot, report);
    } catch (error) {
      if (error instanceof ConnectionLost) throw new EndpointError(endpoint.explicit ? redact(`lost the connection to ${endpoint.source}`) : NOT_REACHABLE);
      if (error instanceof CdpFailure) report.error = redact(error.message);
      else throw error;
    }
    return report;
  } finally {
    await cleanup(cdp, run, target, scriptId, options.keep, report);
  }
}

function failure(report: Report): string {
  if (report.error) return report.error;
  if (!report.ran) return "the script didn't run on this page";
  if (report.exceptions.length > 0) return `${report.exceptions.length} uncaught exception${report.exceptions.length > 1 ? "s" : ""}`;
  if (report.unsettled) return "the script's first pass never finished in some frame (an endless loop?)";
  return "--expect wasn't truthy";
}

export function formatReport(report: Report): string {
  const lines = report.warnings.map((warning) => `warning: ${warning}`);
  lines.push(`url: ${report.finalUrl || report.url}`);
  const top = report.frames.filter((frame) => frame.top);
  const sub = report.frames.filter((frame) => !frame.top);
  if (top.length > 0) {
    const last = top[top.length - 1] as Frame;
    if (last.state === "skip") lines.push(`top frame: skipped (${pyText(last.detail)})`);
    else if (last.state === "start") lines.push(`top frame: ran at ${report.runAt}, but its first pass never finished`);
    else lines.push(`top frame: ran at ${report.runAt}`);
  } else if (!report.error) lines.push("top frame: the script never ran");
  if (sub.length > 0) {
    const ran = sub.filter((frame) => frame.state === "done").length;
    const skipped = sub.filter((frame) => frame.state === "skip").length;
    lines.push(`iframes: ran in ${ran}, skipped ${skipped}`);
  }
  for (const entry of report.console) lines.push(`console.${entry.level}: ${entry.text}  (${entry.at}${entry.frame ? ", iframe" : ""})`);
  for (const entry of report.exceptions) {
    const where = entry.at && !entry.text.includes(entry.at) ? `  (${entry.at})` : "";
    lines.push(`exception${entry.frame ? " in iframe" : ""}: ${entry.text}${where}`);
  }
  for (const entry of report.pageErrors) {
    const first = entry.text ? (splitlines(entry.text)[0] ?? "") : "";
    lines.push(`page error (not from the script): ${first}`);
  }
  if (report.expect !== null) {
    if (pyTruthy(report.expect.error)) lines.push(`expect: ${report.expect.expression} threw ${report.expect.error}`);
    else {
      const value = report.expect.undefined ? "undefined" : jsonText(report.expect.value ?? null, false);
      lines.push(`expect: ${report.expect.expression} -> ${clip(value)} (${pyTruthy(report.expect.truthy) ? "truthy" : "falsy"})`);
    }
  }
  if (report.screenshot) lines.push(`screenshot: ${report.screenshot}`);
  if (report.kept) lines.push(`kept the tab open (target ${report.kept})`);
  lines.push(report.ok ? "ok" : `failed: ${failure(report)}`);
  return redact(lines.join("\n"));
}

export function reportJson(report: Report): string {
  return dumps(report.toValue(), "indented", false);
}
