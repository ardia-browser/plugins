import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { peerUid } from "../../libc.ts";
import { LINUX, uid } from "../../paths.ts";
import { Cancelled, currentSignal } from "../cdp/cancel.ts";
import { BrowseError } from "../daemon-errors.ts";
import { announcePath, type Caller, PROTOCOL, SOCKET_FILE, wire } from "../daemon/announce.ts";
import type { Endpoint } from "../endpoint.ts";
import { record } from "./records.ts";

export const APP_TAB = /^tab-[A-Za-z0-9_-]{1,80}$/u;
export const WINDOWS_TIMEOUT = 3.0;
const SUN_PATH_MAX = LINUX ? 107 : 104;
const MAX_LINE = 4 * 1024 * 1024;

export type AppTabState = {
  readonly endpoint: Endpoint | null;
  readonly caller: Caller | null;
  readonly dataDir: string | null;
  readonly targetInfos: ReadonlyMap<string, Record<string, unknown>>;
  readonly appTabs: Map<string, string>;
  readonly appGenerations: Map<string, unknown>;
  noteAppTabs?(paired: ReadonlyMap<string, string>, present?: ReadonlySet<string> | null): void;
};

export type AppRow = Record<string, unknown> & { id: string };
export type Found = {
  target?: string;
  url?: unknown;
  title?: unknown;
  generation?: unknown;
  error?: string;
  code?: string;
  asleep?: boolean;
  candidates?: unknown[];
};

export class ControlRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class NotConnected extends ControlRefused {
  constructor(message: string) {
    super("not_connected", message);
  }
}

export class MethodUnknown extends ControlRefused {
  constructor(message: string) {
    super("unknown_method", message);
  }
}

export function controlSocket(state: AppTabState): string | null {
  const found = state.endpoint;
  const source = found?.source;
  if (typeof source !== "string") return null;
  if (found?.explicit === false) return announcePath(source);
  const root = state.dataDir ? state.dataDir.replace(/^~(?=\/|$)/u, process.env["HOME"] ?? "~") : null;
  if (root === null || !(source.startsWith("--port") || source.startsWith("ARDIA_PORT"))) return null;
  return path.join(root, SOCKET_FILE);
}

function socketProblem(file: string): "missing" | "unsafe" | null {
  if (Buffer.byteLength(file) > SUN_PATH_MAX) return "missing";
  try {
    const info = fs.lstatSync(file);
    return info.isSocket() && info.uid === uid() ? null : "unsafe";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM" ? "missing" : "unsafe";
  }
}

export function controlCall(
  file: string,
  caller: Caller | null,
  method: string,
  params: Record<string, unknown> | null,
  timeout: number,
  signal: AbortSignal | null = currentSignal(),
): Promise<unknown> {
  if (signal?.aborted) return Promise.reject(new Cancelled());
  const problem = socketProblem(file);
  if (problem === "missing") return Promise.reject(new NotConnected("the control socket isn't there"));
  if (problem === "unsafe") return Promise.reject(new ControlRefused("unsafe", "the control socket isn't a socket the user owns"));
  return new Promise<unknown>((resolve, reject) => {
    const socket = net.connect(file);
    let buffer = Buffer.alloc(0);
    let finished = false;
    let connected = false;
    let greeted = false;
    const cancel = () => finish(new Cancelled());
    const finish = (error: Error | null, value?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new ControlRefused("timeout", `the control socket didn't answer ${method} in time`)), timeout * 1000);
    signal?.addEventListener("abort", cancel, { once: true });
    socket.on("error", (error) => finish(connected ? new ControlRefused("unreachable", error.message) : new NotConnected(error.message)));
    socket.on("close", () => finish(new ControlRefused("unreachable", "the control socket closed")));
    socket.once("connect", () => {
      connected = true;
      const fd = (socket as unknown as { _handle?: { fd?: unknown } })._handle?.fd;
      let peer: number | null = null;
      try {
        peer = typeof fd === "number" ? peerUid(fd) : null;
      } catch {}
      if (peer !== uid()) {
        finish(new ControlRefused("unreachable", "the control socket is served by another user"));
        return;
      }
      const hello: Record<string, unknown> = { protocol: PROTOCOL };
      if (caller !== null) hello["caller"] = wire(caller);
      socket.write(`${JSON.stringify({ id: 1, method: "hello", params: hello })}\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_LINE) {
        finish(new ControlRefused("too_long", "the control socket's answer is too long"));
        return;
      }
      for (let at = buffer.indexOf(0x0a); at >= 0; at = buffer.indexOf(0x0a)) {
        const line = buffer.subarray(0, at).toString("utf8");
        buffer = buffer.subarray(at + 1);
        let reply: Record<string, unknown>;
        try {
          reply = record(JSON.parse(line));
        } catch {
          finish(new ControlRefused("bad_reply", "the control socket's answer isn't JSON"));
          return;
        }
        const failed = record(reply["error"]);
        if (reply["id"] === null && reply["error"] !== undefined) {
          finish(new ControlRefused("refused", String(failed["message"] || "Ardia turned this program away")));
          return;
        }
        if (reply["id"] === 1) {
          if (reply["error"] !== undefined || record(reply["result"])["app"] !== "Ardia") {
            finish(new ControlRefused("unreachable", "something other than Ardia answers on the control socket"));
            return;
          }
          greeted = true;
          const request: Record<string, unknown> = { id: 2, method };
          if (params !== null) request["params"] = params;
          socket.write(`${JSON.stringify(request)}\n`);
        } else if (reply["id"] === 2 && greeted) {
          const code = String(failed["code"] || "failed");
          const message = String(failed["message"] || "failed");
          if (reply["error"] !== undefined) finish(code === "unknown_method" ? new MethodUnknown(message) : new ControlRefused(code === "not_connected" ? "failed" : code, message));
          else finish(null, reply["result"] ?? null);
          return;
        }
      }
    });
  });
}

export async function appCall(state: AppTabState, method: string, params: Record<string, unknown> | null, timeout = WINDOWS_TIMEOUT): Promise<unknown> {
  const file = controlSocket(state);
  if (file === null) throw new ControlRefused("unreachable", "this connection has no control socket");
  return controlCall(file, state.caller, method, params, timeout);
}

export async function appWindows(state: AppTabState, timeout = WINDOWS_TIMEOUT * 2): Promise<unknown[] | null> {
  const file = controlSocket(state);
  if (file === null) return null;
  let windows: unknown;
  try {
    windows = await controlCall(file, state.caller, "windows", null, timeout);
  } catch (error) {
    if (error instanceof ControlRefused) return null;
    throw error;
  }
  return Array.isArray(windows) ? windows : null;
}

export function appTabRows(windows: unknown[] | null): AppRow[] {
  const rows: AppRow[] = [];
  for (const window of windows ?? []) {
    const tabs = record(window)["tabs"];
    for (const tab of Array.isArray(tabs) ? tabs : []) {
      const row = record(tab);
      if (row["id"]) rows.push(row as AppRow);
    }
  }
  return rows;
}

export function reportsTargets(rows: AppRow[]): boolean {
  return rows.some((row) => Object.hasOwn(row, "targetId"));
}

export function pairByTarget(rows: AppRow[], targetInfos: ReadonlyMap<string, unknown>): Map<string, { app: string; generation: unknown }> {
  const paired = new Map<string, { app: string; generation: unknown }>();
  for (const row of rows) {
    const target = row["targetId"];
    if (typeof target === "string" && targetInfos.has(target)) paired.set(target, { app: row.id, generation: row["pageGeneration"] ?? null });
  }
  return paired;
}

export async function whereAppHas(state: AppTabState, targetId: string): Promise<string | null> {
  const windows = await appWindows(state);
  if (windows === null) return null;
  const rows = appTabRows(windows);
  if (!reportsTargets(rows)) return null;
  const row = rows.find((candidate) => candidate["targetId"] === targetId);
  if (row === undefined) {
    return "`ardia windows` lists no tab with that page: Ardia closed it, unloaded it, or keeps it in a private window or one of its own";
  }
  return `Ardia has it open as ${row.id} at ${row["url"] || "no address yet"}`;
}

export async function appTabMap(state: AppTabState, timeout = WINDOWS_TIMEOUT * 2): Promise<Map<string, string>> {
  const windows = await appWindows(state, timeout);
  if (windows === null) return new Map();
  const rows = appTabRows(windows);
  const paired = pairByTarget(rows, state.targetInfos);
  for (const [target, entry] of paired) {
    state.appTabs.set(target, entry.app);
    state.appGenerations.set(target, entry.generation);
  }
  const apps = new Map([...paired].map(([target, entry]) => [target, entry.app]));
  state.noteAppTabs?.(apps, new Set(rows.map((row) => row.id)));
  return apps;
}

export async function appTabTarget(state: AppTabState, appTab: string): Promise<Found> {
  const windows = await appWindows(state);
  if (windows === null) {
    return { error: `Couldn't read Ardia's tab list to look up ${appTab}; use the [tN] ids \`ardia browse tab list\` prints`, code: "tab_not_found" };
  }
  const rows = appTabRows(windows);
  const tab = rows.find((row) => row.id === appTab);
  if (tab === undefined) return { error: `Ardia has no tab ${appTab} (\`ardia windows\` lists them; private windows are left out)`, code: "tab_not_found" };
  if (!reportsTargets(rows)) {
    return {
      error: `This Ardia doesn't say which page belongs to ${appTab} (an update adds it); use the [tN] ids \`ardia browse tab list\` prints`,
      code: "tab_not_found",
    };
  }
  const target = tab["targetId"];
  if (typeof target !== "string") {
    return {
      error:
        `${appTab} is open in Ardia but its page isn't loaded (Ardia keeps background tabs asleep until they're shown), ` +
        "so there's nothing to drive yet; click it in Ardia, or `ardia browse open <url>` for a copy",
      code: "tab_asleep",
      asleep: true,
    };
  }
  if (!state.targetInfos.has(target)) return { error: `${appTab}'s page isn't one the ardia command can drive (an Ardia page, or not a web page)`, code: "tab_not_found" };
  state.appTabs.set(target, appTab);
  state.appGenerations.set(target, tab["pageGeneration"] ?? null);
  state.noteAppTabs?.(new Map([[target, appTab]]));
  return { target, url: tab["url"] ?? null, title: tab["title"] ?? null, generation: tab["pageGeneration"] ?? null };
}

export function appTabError(found: Found, appTab: string): BrowseError {
  return new BrowseError(found.error ?? "", { appTabId: appTab, candidates: found.candidates ?? [] }, found.code ?? "tab_not_found");
}
