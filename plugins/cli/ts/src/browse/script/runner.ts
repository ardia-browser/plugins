import vm from "node:vm";
import { confineProcess, loadLibc, watchLifeline } from "../../libc.ts";
import PRELUDE from "./prelude.js.txt" with { type: "text" };

export { SCRIPT_RUNNER_ARGUMENT } from "../../flush-argument.ts";
export const SOURCE_URL = "ardia-script.js";
export const PRELUDE_URL = "ardia-script-api.js";
export const RUNNER_LIFETIME_MS = 15 * 60 * 1000;
export const LOG_LIMIT = 1024 * 1024;
export const ARGS_LIMIT = 16 * 1024 * 1024;
export const LOG_LINE_LIMIT = 64 * 1024;
export const LOG_TOTAL = LOG_LIMIT * 4;
export const RESULT_LIMIT = 64 * 1024 * 1024;
export const STATE_LIMIT = 16 * 1024 * 1024;

export type StartMessage = { type: "start"; source: string; state: string; readBatch: number; stateLimit: number };
export type ReplyMessage = { type: "reply"; id: number; answer: string };
export type RunnerInbound = StartMessage | ReplyMessage;
export type RunnerOutbound =
  | { type: "ready"; confined: number }
  | { type: "request"; request: string }
  | { type: "log"; line: string }
  | { type: "state"; value: string }
  | { type: "missing"; name: string }
  | { type: "done"; result: string };

type Inbound = (kind: string, first: unknown, second?: unknown) => void;

function scriptSource(source: string): string {
  return `(async function () { ${source}\n})`;
}

function urlParts(url: URL): Record<string, string> {
  const { href, origin, protocol, username, password, host, hostname, port, pathname, search, hash } = url;
  return { href, origin, protocol, username, password, host, hostname, port, pathname, search, hash };
}

const URL_SETTABLE = new Set(["href", "protocol", "username", "password", "host", "hostname", "port", "pathname", "search", "hash"]);

function parseUrlCall(text: string): string {
  try {
    const given = JSON.parse(text) as unknown;
    if (!Array.isArray(given) || typeof given[0] !== "string" || (given[1] !== null && typeof given[1] !== "string")) return JSON.stringify({ error: "Invalid URL" });
    return JSON.stringify(urlParts(given[1] === null ? new URL(given[0]) : new URL(given[0], given[1])));
  } catch {
    return JSON.stringify({ error: "Invalid URL" });
  }
}

function setUrlCall(text: string): string {
  try {
    const given = JSON.parse(text) as unknown;
    if (!Array.isArray(given) || given.length !== 3 || !given.every((part) => typeof part === "string") || !URL_SETTABLE.has(given[1] as string)) {
      return JSON.stringify({ error: "Invalid URL" });
    }
    const url = new URL(given[0] as string);
    Reflect.set(url, given[1] as string, given[2]);
    return JSON.stringify(urlParts(url));
  } catch {
    return JSON.stringify({ error: "Invalid URL" });
  }
}

function base64Call(op: string, text: string): string {
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== "string") return JSON.stringify({ error: "expected a string" });
    if (op === "btoa") {
      if ([...value].some((char) => char.charCodeAt(0) > 0xff)) return JSON.stringify({ error: "The string to be encoded contains characters outside of the Latin1 range." });
      return JSON.stringify({ value: Buffer.from(value, "latin1").toString("base64") });
    }
    const compact = value.replace(/[\t\n\f\r ]/gu, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(compact) || compact.replace(/=+$/u, "").length % 4 === 1) return JSON.stringify({ error: "The string to be decoded is not correctly encoded." });
    return JSON.stringify({ value: Buffer.from(compact, "base64").toString("latin1") });
  } catch {
    return JSON.stringify({ error: "The string to be decoded is not correctly encoded." });
  }
}

export type RunnerLink = { post(message: RunnerOutbound): void; onMessage(listener: (message: RunnerInbound) => void): void };

export function startRunner(link: RunnerLink): void {
  const context = vm.createContext(Object.create(null) as object, { name: "ardia script", codeGeneration: { strings: true, wasm: false } });
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  let inbound: Inbound | null = null;
  let logged = 0;
  let started = false;
  let finished = false;
  const deliver = (kind: string, first: unknown, second?: unknown) => {
    if (inbound === null || finished) return;
    try {
      inbound(kind, first, second);
    } catch {}
  };
  const bridge = (kind: unknown, payload: unknown): string | undefined => {
    try {
      if (typeof kind !== "string" || typeof payload !== "string" || finished) return undefined;
      switch (kind) {
        case "request":
          if (payload.length > ARGS_LIMIT + 64 * 1024) return "";
          link.post({ type: "request", request: payload });
          return "";
        case "log": {
          const line = payload.length > LOG_LINE_LIMIT ? `${payload.slice(0, LOG_LINE_LIMIT)}… [${payload.length - LOG_LINE_LIMIT} more characters]` : payload;
          if (logged + line.length > LOG_TOTAL) return "";
          logged += line.length;
          link.post({ type: "log", line });
          return "";
        }
        case "state":
          if (payload.length > STATE_LIMIT) return "";
          link.post({ type: "state", value: payload });
          return "";
        case "missing":
          link.post({ type: "missing", name: payload });
          return "";
        case "timer": {
          const given = JSON.parse(payload) as unknown;
          if (!Array.isArray(given) || typeof given[0] !== "number" || typeof given[1] !== "number") return undefined;
          const id = given[0];
          clearTimeout(timers.get(id));
          timers.set(id, setTimeout(() => {
            timers.delete(id);
            deliver("timer", id);
          }, Math.min(Math.max(given[1], 0), RUNNER_LIFETIME_MS)));
          return "";
        }
        case "clear": {
          const id = JSON.parse(payload) as unknown;
          if (typeof id === "number") {
            clearTimeout(timers.get(id));
            timers.delete(id);
          }
          return "";
        }
        case "url":
          return parseUrlCall(payload);
        case "urlset":
          return setUrlCall(payload);
        case "atob":
        case "btoa":
          return base64Call(kind, payload);
        case "done":
          finished = true;
          for (const timer of timers.values()) clearTimeout(timer);
          timers.clear();
          link.post({
            type: "done",
            result: payload.length <= RESULT_LIMIT ? payload : JSON.stringify({ kind: "error", message: "the script's result is over 64 MB; return less, or keep it in `state`", name: "Error", line: null, code: null, command: null }),
          });
          return "";
        default:
          return undefined;
      }
    } catch {
      return undefined;
    }
  };
  Object.setPrototypeOf(bridge, null);
  const fail = (message: string, name: string, line: number | null, code: string | null) => {
    finished = true;
    link.post({ type: "done", result: JSON.stringify({ kind: "error", message, name, line, code, command: null }) });
  };
  const contextError = new vm.Script("(message) => new TypeError(message)", { filename: PRELUDE_URL }).runInContext(context) as (message: string) => unknown;
  const refuseImport = () => {
    throw contextError("import() isn't available in scripts: they have no modules, files or network; use read(urls) for pages and return data");
  };
  link.onMessage((message) => {
    if (message.type === "reply") {
      if (typeof message.id === "number" && typeof message.answer === "string") deliver("reply", message.id, message.answer);
      return;
    }
    if (message.type !== "start" || started) return;
    started = true;
    let install: (bridge: unknown, config: string) => Inbound;
    let fn: unknown;
    try {
      install = new vm.Script(PRELUDE, { filename: PRELUDE_URL, importModuleDynamically: refuseImport as never }).runInContext(context) as typeof install;
      inbound = install(bridge, JSON.stringify({ source: SOURCE_URL, readBatch: message.readBatch, stateLimit: message.stateLimit, argsLimit: ARGS_LIMIT, state: message.state }));
    } catch {
      fail("the script's API didn't start", "Error", null, null);
      return;
    }
    try {
      fn = new vm.Script(scriptSource(message.source), { filename: SOURCE_URL, importModuleDynamically: refuseImport as never }).runInContext(context);
    } catch (error) {
      const [text, line] = syntaxError(error);
      fail(text, "", line, "script_syntax");
      return;
    }
    deliver("run", fn);
  });
}

export function syntaxError(error: unknown): [string, number | null] {
  if (error === null || typeof error !== "object") return ["SyntaxError", null];
  const fields = error as { name?: unknown; message?: unknown; line?: unknown };
  const name = typeof fields.name === "string" ? fields.name : "SyntaxError";
  const message = typeof fields.message === "string" ? fields.message : "";
  const line = typeof fields.line === "number" && Number.isInteger(fields.line) && fields.line > 0 ? fields.line : null;
  return [message ? `${name}: ${message}` : name, line];
}

export async function runnerMain(libcFile: string): Promise<number> {
  const send = process.send?.bind(process);
  if (send === undefined) return 2;
  let confined = 0;
  try {
    loadLibc(libcFile);
    watchLifeline(0);
    confined = confineProcess();
  } catch {
    confined = -1;
  }
  if (confined < 0 && process.platform === "darwin") {
    send({ type: "ready", confined } satisfies RunnerOutbound);
    setTimeout(() => process.exit(3), 100);
    return new Promise(() => {});
  }
  setTimeout(() => process.exit(4), RUNNER_LIFETIME_MS).unref();
  process.on("disconnect", () => process.exit(0));
  const listeners: ((message: RunnerInbound) => void)[] = [];
  process.on("message", (message: unknown) => {
    if (message === null || typeof message !== "object") return;
    for (const listener of listeners) listener(message as RunnerInbound);
  });
  startRunner({
    post: (message) => {
      try {
        send(message);
      } catch {
        process.exit(5);
      }
    },
    onMessage: (listener) => listeners.push(listener),
  });
  send({ type: "ready", confined } satisfies RunnerOutbound);
  return new Promise(() => {});
}
