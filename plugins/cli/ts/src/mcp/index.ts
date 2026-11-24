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
import { agentEnv, type Endpoint, endpointChoice, endpointKey, namespaceName, optionsFrom, Refused, rootOf, sessionKey, sessionName, sessionOwner, splitUrl } from "../browse/request.ts";
import { autoSessionsOn } from "../browse/serve.ts";
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

  claude mcp add ardia -- ardia mcp
  codex mcp add ardia -- ardia mcp

--socket PATH talks to an already running daemon socket instead of starting one.
`;

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

function chooseSession(found: Found): void {
  if (found.value("session") || process.env["AGENT_BROWSER_SESSION"] || !autoSessionsOn(found)) return;
  const id = deriveAutoSession(process.cwd());
  if (id !== null) found.values.set("session", id);
}

function failed(text: string, code: string | null, exit = 1): DaemonAnswer {
  return { exit, out: "", err: `✗ ${text}\n`, code };
}

function answerOf(raw: Buffer): DaemonAnswer {
  const parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
  const exit = Number(parsed["exit"] ?? 1);
  return {
    exit: Number.isFinite(exit) ? exit : 1,
    out: typeof parsed["out"] === "string" ? parsed["out"] : "",
    err: typeof parsed["err"] === "string" ? parsed["err"] : "",
    code: typeof parsed["code"] === "string" ? parsed["code"] : null,
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

export class SessionDaemon implements Daemon {
  readonly root: string;
  readonly key: string;
  readonly session: string;
  private readonly config: JsonObject;

  constructor(
    private readonly found: Found,
    private readonly socket: string | undefined,
  ) {
    chooseSession(found);
    this.session = sessionName(found);
    const namespace = namespaceName(found);
    const endpoint = endpointChoice(found);
    this.root = rootOf(endpoint);
    const keySource = endpointKey(endpoint, this.root);
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

  async run(request: DaemonRequest, signal?: AbortSignal, quickMs?: number): Promise<DaemonAnswer> {
    try {
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
