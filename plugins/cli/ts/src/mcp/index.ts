import { connect as bunConnect } from "bun";
import { lstatSync, writeSync } from "node:fs";
import { dumps, type JsonObject, object, type Value } from "../json.ts";
import { closeDir } from "../privatefs.ts";
import { uid } from "../paths.ts";
import { routedCaller } from "../routed.ts";
import { shareable } from "../telemetry.ts";
import { cliVersion } from "../version.ts";
import { Found } from "../browse/args.ts";
import { answerDeadline } from "../browse/deadline.ts";
import { awaitDaemon, DaemonDidNotStart, spawnDaemon } from "../browse/daemon/spawn.ts";
import { BrowseError, PythonCrash } from "../browse/errors.ts";
import { Absent, CONNECT_WAIT_MS, connect, exchange, Link } from "../browse/exchange.ts";
import { pluginMode } from "../browse/route.ts";
import { agentEnv, type Endpoint, endpointChoice, endpointKey, envSession, namespaceName, optionsFrom, Refused, rootOf, sessionKey, sessionName, sessionOwner, splitUrl } from "../browse/request.ts";
import { autoSessionsOn, claimAutoSession } from "../browse/serve.ts";
import { Call } from "../telemetry.ts";
import { type ManageArgs, manageMain, MCP_MANAGE_HELP, parseManage } from "./install.ts";
import { type DisplayRef, MAX_DISPLAY_IMAGES } from "./tools.ts";
import { checkSocket, deriveAutoSession, NoDaemon, openBrowseDir } from "../browse/session.ts";
import { stripLoneSurrogates } from "../browse/untrusted.ts";
import { McpServer, serveStdio } from "./server.ts";
import type { Daemon, DaemonAnswer, DaemonRequest } from "./tools.ts";

const VALUE_FLAGS: Readonly<Record<string, string>> = {
  "--port": "port",
  "--ws": "ws",
  "--data-dir": "data_dir",
  "--session": "session",
  "--namespace": "namespace",
  "--cdp": "cdp",
  "--timeout": "timeout",
};
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const FALLBACK_DEADLINE_S = 960;
const PLUGIN_REFUSED = 77;
const USAGE_STATUS = 2;

export const MCP_HELP = `Usage: ardia [--port N] [--session S] mcp [--port N] [--session S] [--namespace NS] [--data-dir DIR] [--socket PATH]

Runs a Model Context Protocol server on stdin/stdout (newline-delimited JSON-RPC or Content-Length framing)
that drives the Ardia browser through the browse daemon, with two tools: browser_repl and browser_act.

  ardia mcp install            (adds it to Claude Code, Codex and Cursor; see ardia mcp install --help)
  claude mcp add ardia -- ardia mcp
  codex mcp add ardia -- ardia mcp

--socket PATH talks to an already running daemon socket instead of starting one.
`;

export const MANAGE_ACTIONS: ReadonlySet<string> = new Set(["install", "uninstall", "status"]);
export const CLAIM_EVERY_MS = 5_000;

export type McpArgs = { found: Found; socket: string | undefined; help: boolean };

function takeFlags(argv: readonly string[], from: number, found: Found, allowSocket: boolean): { at: number; socket: string | undefined; help: boolean } | { error: string } {
  let at = from;
  let socket: string | undefined;
  let help = false;
  while (at < argv.length) {
    const token = argv[at] as string;
    if (token === "--json") {
      at += 1;
      continue;
    }
    if (allowSocket && (token === "--help" || token === "-h")) {
      help = true;
      at += 1;
      continue;
    }
    const equals = token.indexOf("=");
    const name = token.startsWith("--") && equals > 0 ? token.slice(0, equals) : token;
    const known = VALUE_FLAGS[name] ?? (allowSocket && name === "--socket" ? "socket" : undefined);
    if (known === undefined) {
      if (allowSocket) return { error: `ardia mcp doesn't take ${token}` };
      break;
    }
    let value: string;
    if (equals > 0 && token.startsWith("--")) value = token.slice(equals + 1);
    else {
      if (at + 1 >= argv.length) return { error: `${name} needs a value` };
      value = argv[at + 1] as string;
      at += 1;
    }
    at += 1;
    if (known === "socket") socket = value;
    else found.values.set(known, value);
  }
  return { at, socket, help };
}

export type ManageCall = { manage: ManageArgs };

export function mcpManageArgv(argv: readonly string[]): ManageCall | { error: string } | undefined {
  const leading = takeFlags(argv, 0, new Found(), false);
  if ("error" in leading || argv[leading.at] !== "mcp") return undefined;
  const action = argv[leading.at + 1];
  if (action === undefined || !MANAGE_ACTIONS.has(action)) return undefined;
  const managed = parseManage(argv.slice(leading.at + 1));
  return "error" in managed ? { error: managed.error } : { manage: managed };
}

export function mcpArgv(argv: readonly string[]): McpArgs | { error: string } | undefined {
  const found = new Found();
  const leading = takeFlags(argv, 0, found, false);
  if ("error" in leading || argv[leading.at] !== "mcp") return undefined;
  const trailing = takeFlags(argv, leading.at + 1, found, true);
  if ("error" in trailing) return trailing;
  return { found, socket: trailing.socket, help: trailing.help };
}

function endpointLabel(endpoint: Endpoint): string {
  const url = endpoint.ws ? endpoint.ws : endpoint.port !== undefined ? undefined : process.env["ARDIA_CDP_URL"];
  if (url) {
    const parts = splitUrl(url);
    return `${parts.netloc}${parts.path}`;
  }
  return endpoint.port !== undefined ? `--port ${endpoint.port}` : "Ardia";
}

function chooseSession(found: Found, derive: (cwd: string) => string | null = deriveAutoSession): string | null {
  if (found.value("session") || envSession() || !autoSessionsOn(found)) return null;
  const id = derive(process.cwd());
  if (id !== null) found.values.set("session", id);
  return id;
}

export function displayRefs(value: unknown): DisplayRef[] {
  if (!Array.isArray(value)) return [];
  const out: DisplayRef[] = [];
  for (const item of value.slice(0, MAX_DISPLAY_IMAGES)) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record["path"] !== "string") continue;
    const size = (given: unknown) => {
      if (given === null || typeof given !== "object") return null;
      const box = given as Record<string, unknown>;
      const width = Number(box["width"]);
      const height = Number(box["height"]);
      return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height } : null;
    };
    const positive = (given: unknown) => (typeof given === "number" && Number.isFinite(given) && given > 0 ? given : null);
    const region = (given: unknown) => {
      if (given === null || typeof given !== "object") return null;
      const box = given as Record<string, unknown>;
      const [x, y, width, height] = [box["x"], box["y"], box["width"], box["height"]].map(Number) as [number, number, number, number];
      return [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0 ? { x, y, width, height } : null;
    };
    const digits = (given: unknown) => (typeof given === "string" && /^\d{1,40}$/u.test(given) ? given : null);
    const bytes = typeof record["size"] === "number" && Number.isSafeInteger(record["size"]) && record["size"] >= 0 ? record["size"] : null;
    out.push({ path: record["path"], scale: positive(record["scale"]), dpr: positive(record["dpr"]), viewport: size(record["viewport"]), image: size(record["image"]), region: region(record["region"]), dev: digits(record["dev"]), ino: digits(record["ino"]), size: bytes });
  }
  return out;
}

function failed(text: string, code: string | null, exit = 1): DaemonAnswer {
  return { exit, out: "", err: `✗ ${text}\n`, code };
}

function answerOf(raw: Buffer): DaemonAnswer {
  const parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
  const exit = Number(parsed["exit"] ?? 1);
  const display = displayRefs(parsed["display"]);
  return {
    exit: Number.isFinite(exit) ? exit : 1,
    out: typeof parsed["out"] === "string" ? parsed["out"] : "",
    err: typeof parsed["err"] === "string" ? parsed["err"] : "",
    code: typeof parsed["code"] === "string" ? parsed["code"] : null,
    ...(display.length > 0 ? { display } : {}),
  };
}

async function socketLink(path: string): Promise<Link> {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    throw new BrowseError(`No daemon socket at ${path}`, 1, "daemon_unreachable");
  }
  if (!info.isSocket() || info.uid !== uid()) throw new BrowseError(`Refusing ${path}: it isn't a socket owned by you`, 1, "socket_refused");
  const link = new Link();
  try {
    link.socket = await bunConnect({
      unix: path,
      allowHalfOpen: true,
      socket: {
        data: (_socket, chunk) => link.received(chunk),
        drain: () => link.drain(),
        end: () => link.ended(),
        close: () => link.ended(),
        error: (_socket, error) => link.ended(error.message),
      },
    });
  } catch (error) {
    throw new BrowseError(`Can't reach the daemon at ${path}: ${error instanceof Error ? error.message : String(error)}`, 1, "daemon_unreachable");
  }
  return link;
}

export type SessionClaim = (root: string, namespace: string, keySource: string, id: string, timeout: Value, signal?: AbortSignal) => Promise<{ notice: string | null }>;

const claimRegistry: SessionClaim = (root, namespace, keySource, id, timeout, signal) => claimAutoSession(root, namespace, keySource, timeout, new Call(["mcp"]), id, signal);

export class SessionDaemon implements Daemon {
  readonly root: string;
  readonly key: string;
  readonly session: string;
  readonly auto: string | null;
  readonly namespace: string;
  readonly keySource: string;
  private readonly config: JsonObject;
  private claimedAt = -Infinity;
  private claiming: { promise: Promise<string | null>; controller: AbortController; waiters: number; aborted: boolean } | null = null;
  private cleanup: Promise<void> | null = null;

  constructor(
    private readonly found: Found,
    private readonly socket: string | undefined,
    derive: (cwd: string) => string | null = deriveAutoSession,
    private readonly claim: SessionClaim = claimRegistry,
  ) {
    this.auto = chooseSession(found, derive);
    this.session = sessionName(found);
    const namespace = namespaceName(found);
    this.namespace = namespace;
    const endpoint = endpointChoice(found);
    this.root = rootOf(endpoint);
    const keySource = endpointKey(endpoint, this.root);
    this.keySource = keySource;
    const forPlugin = process.env["ARDIA_BROWSE_FOR_PLUGIN"] === "1";
    this.key = sessionKey(namespace, keySource, this.session, forPlugin);
    this.config = object([
      ["session", this.session],
      ["namespace", namespace],
      ["key", this.key],
      ["data_root", this.root],
      ["ws", endpoint.ws ?? null],
      ["port", endpoint.port ?? null],
      ["data_dir", endpoint.dataDir ?? null],
      ["endpoint_label", endpointLabel(endpoint)],
      ["idle_timeout_ms", null],
      ["debug", false],
      ["no_auto_dialog", false],
      ["pin_tab", null],
      ["for_plugin", forPlugin],
      ["owner", sessionOwner(namespace, keySource, this.session, forPlugin)],
    ]);
  }

  private async openIfLive(): Promise<Link | null> {
    const dir = openBrowseDir(this.root);
    try {
      checkSocket(dir, `${this.key}.sock`);
      return await connect(dir, `${this.key}.sock`, performance.now() + CONNECT_WAIT_MS);
    } catch (error) {
      if (error instanceof NoDaemon || error instanceof Absent) return null;
      throw error;
    } finally {
      closeDir(dir);
    }
  }

  private async link(signal?: AbortSignal): Promise<Link> {
    if (signal?.aborted) throw new BrowseError("cancelled", 130, "interrupted");
    if (this.socket !== undefined) return socketLink(this.socket);
    const live = await this.openIfLive();
    if (live !== null) return live;
    if (signal?.aborted) throw new BrowseError("cancelled", 130, "interrupted");
    const dir = openBrowseDir(this.root);
    try {
      return await awaitDaemon(dir.fd, this.key, spawnDaemon(dir.fd, this.key, this.config, { kind: "ts", program: process.execPath }), () => this.openIfLive());
    } finally {
      closeDir(dir);
    }
  }

  private payload(request: DaemonRequest): { line: Buffer; timeout: Value } {
    const { entries, timeout: defaultTimeout } = optionsFrom(this.found);
    let timeout: Value = defaultTimeout;
    const givenTimeout = this.found.value("timeout");
    if (givenTimeout !== undefined) {
      const parsed = Number(givenTimeout);
      if (!Number.isInteger(parsed) || parsed <= 0) throw new BrowseError("--timeout takes a positive whole number of milliseconds", 2, "usage");
      timeout = BigInt(parsed);
      entries.set("timeout_ms", timeout);
    }
    entries.set("json", request.json);
    entries.set("full", request.full);
    if (request.maxOutput !== null) entries.set("max_output", BigInt(request.maxOutput));
    entries.set("content_boundaries", true);
    entries.set("_session", this.session);
    const payload = object([
      ["argv", request.argv],
      ["options", entries],
      ["cwd", process.cwd()],
      ["env", agentEnv()],
      ["stdin", request.stdin === null ? null : stripLoneSurrogates(request.stdin)],
      ["telemetry", shareable()],
      ["caller", routedCaller()],
    ]);
    return { line: Buffer.from(`${dumps(payload, "spaced")}\n`, "utf8"), timeout };
  }

  private awaitCleanup(signal?: AbortSignal): Promise<void> {
    const pending = this.cleanup;
    if (pending === null) return Promise.resolve();
    if (signal === undefined) return pending;
    if (signal.aborted) return Promise.reject(new BrowseError("cancelled", 130, "interrupted"));
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(new BrowseError("cancelled", 130, "interrupted"));
      signal.addEventListener("abort", onAbort, { once: true });
      pending.then(() => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) reject(new BrowseError("cancelled", 130, "interrupted"));
        else resolve();
      });
    });
  }

  async register(now = Date.now(), signal?: AbortSignal): Promise<string | null> {
    if (this.auto === null || this.socket !== undefined) return null;
    if (signal?.aborted) throw new BrowseError("cancelled", 130, "interrupted");
    while (this.claiming === null && this.cleanup !== null) await this.awaitCleanup(signal);
    if (signal?.aborted) throw new BrowseError("cancelled", 130, "interrupted");
    let current = this.claiming;
    if (current === null || current.aborted) {
      if (now - this.claimedAt < CLAIM_EVERY_MS) return null;
      const controller = new AbortController();
      const entry: { promise: Promise<string | null>; controller: AbortController; waiters: number; aborted: boolean } = {
        controller,
        waiters: 0,
        aborted: false,
        promise: Promise.resolve(null),
      };
      entry.promise = (async () => {
        try {
          const claimed = await this.claim(this.root, this.namespace, this.keySource, this.auto as string, optionsFrom(this.found).timeout, controller.signal);
          if (!controller.signal.aborted) this.claimedAt = now;
          return claimed.notice;
        } finally {
          if (this.claiming === entry) this.claiming = null;
        }
      })();
      this.claiming = entry;
      current = entry;
    }
    current.waiters += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      current.waiters -= 1;
      if (current.waiters <= 0 && !current.aborted) {
        current.aborted = true;
        if (this.claiming === current) this.claiming = null;
        const tail = current.promise.then(() => undefined, () => undefined);
        const chained = (this.cleanup ?? Promise.resolve()).then(() => tail);
        this.cleanup = chained;
        void chained.finally(() => {
          if (this.cleanup === chained) this.cleanup = null;
        });
        current.controller.abort();
      }
    };
    if (signal === undefined) {
      try {
        return await current.promise;
      } finally {
        released = true;
        current.waiters -= 1;
      }
    }
    return new Promise<string | null>((resolve, reject) => {
      const onAbort = () => {
        release();
        reject(new BrowseError("cancelled", 130, "interrupted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      current.promise.then(
        (notice) => {
          signal.removeEventListener("abort", onAbort);
          if (!released) {
            released = true;
            current.waiters -= 1;
          }
          if (signal.aborted) reject(new BrowseError("cancelled", 130, "interrupted"));
          else resolve(notice);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          if (!released) {
            released = true;
            current.waiters -= 1;
          }
          reject(error);
        },
      );
    });
  }

  async run(request: DaemonRequest, signal?: AbortSignal, quickMs?: number): Promise<DaemonAnswer> {
    try {
      if (signal?.aborted) return failed("cancelled", "interrupted", 130);
      const notice = await this.register(Date.now(), signal);
      if (signal?.aborted) return failed("cancelled", "interrupted", 130);
      if (notice) {
        const answer = await this.run(request, signal, quickMs);
        return { ...answer, err: `${notice}\n${answer.err}` };
      }
      const { line, timeout } = this.payload(request);
      if (line.length - 1 > MAX_REQUEST_BYTES) return failed("The request is over 16 MB", "request_too_large");
      const deadline = answerDeadline(request.argv, timeout);
      const seconds = quickMs !== undefined ? quickMs / 1000 : typeof deadline === "number" ? deadline : FALLBACK_DEADLINE_S;
      if (signal?.aborted) return failed("cancelled", "interrupted", 130);
      const link = await this.link(signal);
      if (signal?.aborted) {
        link.destroy();
        return failed("cancelled", "interrupted", 130);
      }
      const abort = () => {
        link.destroy();
        link.ended("ECANCELED");
      };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        if (signal?.aborted) {
          abort();
          return failed("cancelled", "interrupted", 130);
        }
        return answerOf(await exchange(link, line, request.argv[0] ?? "", seconds));
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    } catch (error) {
      if (error instanceof BrowseError) return failed(error.text, error.code ?? error.fallback, error.exit);
      if (error instanceof DaemonDidNotStart) return failed(error.message, "daemon_unreachable");
      if (error instanceof Refused) return failed(error.message, "invalid_name");
      if (error instanceof PythonCrash) return failed(error.line, "internal_error");
      if (error instanceof SyntaxError) return failed("The daemon's answer wasn't JSON", "internal_error");
      throw error;
    }
  }
}

function stderr(text: string): void {
  try {
    writeSync(2, text);
  } catch {}
}

export function mcpManageMain(parsed: ManageCall | { error: string }): number {
  if ("error" in parsed) {
    stderr(`ardia: ${parsed.error}\n\n${MCP_MANAGE_HELP}`);
    return USAGE_STATUS;
  }
  if (pluginMode()) {
    stderr("ardia: mcp isn't available to plugins\n");
    return PLUGIN_REFUSED;
  }
  return manageMain(parsed.manage, (text) => process.stdout.write(text));
}

export async function mcpMain(parsed: McpArgs | { error: string }): Promise<number> {
  if ("error" in parsed) {
    stderr(`ardia: ${parsed.error}\n${MCP_HELP}`);
    return USAGE_STATUS;
  }
  if (parsed.help) {
    process.stdout.write(MCP_HELP);
    return 0;
  }
  if (pluginMode()) {
    stderr("ardia: mcp isn't available to plugins\n");
    return PLUGIN_REFUSED;
  }
  let daemon: SessionDaemon;
  try {
    daemon = new SessionDaemon(parsed.found, parsed.socket);
  } catch (error) {
    stderr(`ardia: ${error instanceof Error ? error.message : String(error)}\n`);
    return USAGE_STATUS;
  }
  const server = new McpServer({ daemon, version: cliVersion(), log: (line) => stderr(`${line}\n`) });
  const session = serveStdio(server, process.stdin, (bytes) => new Promise((resolve, reject) => process.stdout.write(bytes, (error) => (error ? reject(error) : resolve()))));
  const stop = () => session.stop();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.once("SIGHUP", stop);
  process.stdout.on("error", stop);
  await session.done;
  return 0;
}
