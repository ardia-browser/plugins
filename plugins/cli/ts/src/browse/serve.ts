import { closeSync, writeSync } from "node:fs";
import { dumps, Float, type JsonObject, object, type Value } from "../json.ts";
import { truthy as pyTruthy } from "../py.ts";
import { codePoints, joinCodePoints } from "../pystr.ts";
import { routedCaller } from "../routed.ts";
import { type Call, shareable } from "../telemetry.ts";
import { noGet } from "./answer.ts";
import { type Found, parseDuration, Usage } from "./args.ts";
import { answerDeadline } from "./deadline.ts";
import { BrowseError, builtinCrash, PythonCrash, unreachable } from "./errors.ts";
import { Absent, CONNECT_WAIT_MS, connect, exchange, type Link, Stalled } from "./exchange.ts";
import { encodeError } from "./output.ts";
import { loadAnswer } from "./pyjson.ts";
import type { Secrets } from "../redact.ts";
import { agentEnv, endpointChoice, endpointKey, namespaceName, optionsFrom, rootOf, sessionKey, sessionName, splitUrl, urlsWithSecrets } from "./request.ts";
import { closeDir } from "../privatefs.ts";
import { checkSocket, NoDaemon, openBrowseDir, osFailure } from "./session.ts";
import { awaitDaemon, type DaemonChoice, DaemonDidNotStart, spawnDaemon } from "./daemon/spawn.ts";
import { decodeLocale, decodeStdin, pythonStdioErrors, readStdin, stdinState } from "./stdio.ts";
import { TAKES_OUT } from "./tables.ts";
import { liveSessions, readStdinNote, readStdinUrls, runLocal, scriptSource, servesHere } from "./local.ts";
import { answerOf, checkCdpFlags, checkCdpParams, daemonErrors, expandScriptPath, localAnswer, readCdpStdin, readsNamedUrls } from "./local-answer.ts";
import { Result } from "./daemon/render.ts";

export const ANSWER_JSON_DEPTH = 9995;
const MAX_REQUEST = 16 * 1024 * 1024;
const SURROGATES = /[\ud800-\udfff]/;
const BESIDE_PREFIX = 59;

export class HandBack extends Error {}

function evalCodeGiven(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] as string;
    if (["--out", "--timeout", "--max-output"].includes(token)) {
      index += 1;
      continue;
    }
    if (!token.startsWith("-") || token === "-") return true;
  }
  return false;
}

function wantsStdin(command: string, args: readonly string[]): boolean {
  if ((command === "eval" || command === "addinitscript") && args.includes("--stdin")) return true;
  const wants = command === "eval" ? !evalCodeGiven(args) : command === "batch" && args.every((arg) => arg.startsWith("--"));
  if (!wants) return false;
  const state = stdinState();
  if (state === "closed") throw builtinCrash("AttributeError", `'NoneType' object has no attribute '${args.includes("--stdin") && command !== "batch" ? "read" : "isatty"}'`);
  return state !== "tty";
}

export function handedBack(rest: readonly string[], browse: readonly string[]): string | undefined {
  const command = rest[0] as string;
  if (TAKES_OUT.includes(command) && browse.some((token) => token === "--out" || token.startsWith("--out="))) return "--out runs on Python";
  return undefined;
}

function checkIdle(found: Found): void {
  const idle = found.value("idle_timeout") || process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS;
  if (!idle) return;
  const parsed = parseDuration(idle);
  if ("invalid" in parsed) throw new Usage("--idle-timeout takes 10s, 3m, 1h or milliseconds");
  if ("infinite" in parsed) throw builtinCrash("OverflowError", "cannot convert float infinity to integer");
}

async function openSession(root: string, key: string, deadline = performance.now() + CONNECT_WAIT_MS): Promise<Link> {
  const dir = openBrowseDir(root);
  try {
    checkSocket(dir, `${key}.sock`);
    return await connect(dir, `${key}.sock`, deadline);
  } catch (error) {
    if (error instanceof Absent) throw new NoDaemon("the socket refused the connection");
    throw error;
  } finally {
    closeDir(dir);
  }
}

async function openIfLive(root: string, key: string): Promise<Link | null> {
  try {
    return await openSession(root, key);
  } catch (error) {
    if (error instanceof NoDaemon) return null;
    throw error;
  }
}

type Start = { root: string; key: string; config: JsonObject; python: string | null; call: Call };

async function ensureSession(start: Start): Promise<Link> {
  const live = await openIfLive(start.root, start.key);
  if (live !== null) return live;
  const choice: DaemonChoice = { kind: "ts", program: process.execPath };
  const dir = openBrowseDir(start.root);
  try {
    const started = performance.now();
    const link = await awaitDaemon(dir.fd, start.key, spawnDaemon(dir.fd, start.key, start.config, choice), () => openIfLive(start.root, start.key));
    start.call.metrics.set("daemon_spawned", true);
    start.call.metrics.set("daemon_start_ms", new Float(performance.now() - started));
    return link;
  } catch (error) {
    if (error instanceof DaemonDidNotStart) throw unreachable(error.message);
    throw error;
  } finally {
    closeDir(dir);
  }
}

function endpointLabel(ws: string | undefined, port: bigint | undefined): string {
  const url = ws ? ws : port !== undefined ? undefined : process.env.ARDIA_CDP_URL;
  if (url) {
    const parts = splitUrl(url);
    return `${parts.netloc}${parts.path}`;
  }
  return port !== undefined ? `--port ${port}` : "Ardia";
}

const STDIN_READY_FD = "ARDIA_TEST_STDIN_READY_FD";

function sayReadingStdin(): void {
  const named = process.env[STDIN_READY_FD] ?? "";
  if (!/^[0-9]{1,5}$/.test(named) || Number(named) < 3) return;
  try {
    writeSync(Number(named), "r");
    closeSync(Number(named));
  } catch {}
}

function oversizedRequest(): BrowseError {
  return unreachable("the ardia browse daemon closed the connection before taking the command (see the session log)");
}

function requestLine(payload: JsonObject): Buffer | PythonCrash {
  const line = `${dumps(payload, "spaced")}\n`;
  const refused = SURROGATES.test(line) ? encodeError(codePoints(line)) : undefined;
  if (refused !== undefined) return refused;
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length - 1 > MAX_REQUEST) throw oversizedRequest();
  return bytes;
}

async function ask(socket: Link, payload: JsonObject, rest: string[], timeout: Value, call: Call, patient = false, built?: Buffer | PythonCrash): Promise<JsonObject> {
  const seconds = answerDeadline(rest, timeout, patient);
  if (seconds instanceof PythonCrash) {
    socket.destroy();
    throw seconds;
  }
  let line: Buffer | PythonCrash;
  try {
    line = built ?? requestLine(payload);
  } catch (error) {
    socket.destroy();
    throw error;
  }
  if (line instanceof PythonCrash) {
    socket.destroy();
    throw line;
  }
  let raw: Buffer;
  try {
    raw = await exchange(socket, line, rest[0] as string, seconds);
  } catch (error) {
    if (error instanceof Stalled) call.metrics.set("daemon_answer_timed_out", true);
    throw error;
  }
  const answer = loadAnswer(raw, ANSWER_JSON_DEPTH);
  if (answer instanceof PythonCrash) throw answer;
  if (!(answer instanceof Map)) throw noGet(answer);
  return answer;
}

type Beside = { root: string; namespace: string; keySource: string; session: string; timeout: Value; config: JsonObject; python: string | null };

async function readBeside(payload: JsonObject, rest: string[], beside: Beside, call: Call): Promise<JsonObject> {
  const name = `${joinCodePoints(codePoints(beside.session).slice(0, BESIDE_PREFIX))}-side`;
  const key = sessionKey(beside.namespace, beside.keySource, name);
  const config = new Map(beside.config);
  config.set("session", name);
  config.set("key", key);
  let socket: Link;
  try {
    socket = await ensureSession({ root: beside.root, key, config, python: beside.python, call });
  } catch (error) {
    if (!(error instanceof NoDaemon)) throw error;
    throw unreachable("the ardia browse daemon asked to run this beside a busy session, and that session's side daemon isn't running");
  }
  const options = new Map(payload.get("options") as JsonObject);
  options.set("_session", name);
  const request: JsonObject = new Map(payload);
  request.set("options", options);
  request.delete("beside_if_busy");
  request.set("patient_queue", true);
  const answer = await ask(socket, request, rest, beside.timeout, call, true);
  const metrics = answer.get("metrics");
  if (metrics === undefined) answer.set("metrics", new Map([["read_beside_busy", true]]));
  else if (metrics instanceof Map) metrics.set("read_beside_busy", true);
  else throw builtinCrash("TypeError", `'${Array.isArray(metrics) ? "list" : typeof metrics === "string" ? "str" : "int"}' object does not support item assignment`);
  return answer;
}

async function closeAll(root: string, options: Record<string, unknown>, timeout: Value, call: Call): Promise<JsonObject> {
  const closed: string[] = [];
  for (const row of liveSessions(root)) {
    let socket: Link;
    try {
      socket = await openSession(root, row.key);
    } catch (error) {
      if (error instanceof NoDaemon) continue;
      throw error;
    }
    try {
      await ask(socket, object([["argv", ["close"]], ["options", new Map()], ["cwd", process.cwd()], ["env", new Map()], ["stdin", null]]), ["close"], timeout, call);
      closed.push(row.session);
    } catch (error) {
      if (!(error instanceof BrowseError)) throw error;
    }
  }
  return answerOf(options, new Result({ closed }, `✓ Closed ${closed.length} session${closed.length !== 1 ? "s" : ""}`), null);
}

export async function roundTrip(found: Found, rest: string[], secrets: Secrets, call: Call, python: string | null): Promise<JsonObject> {
  const { entries: options, timeout } = optionsFrom(found);
  const session = sessionName(found);
  const namespace = namespaceName(found);
  const chosen = endpointChoice(found);
  const endpoint = chosen;
  for (const secret of urlsWithSecrets(endpoint.ws)) secrets.add(secret);
  const root = rootOf(endpoint);
  const keySource = endpointKey(endpoint, root);
  options.set("_session", session);
  const command = rest[0] as string;
  const stdinWanted = wantsStdin(command, rest.slice(1));
  const errors = stdinWanted ? pythonStdioErrors() : "strict";
  checkIdle(found);
  const key = sessionKey(namespace, keySource, session, process.env.ARDIA_BROWSE_FOR_PLUGIN === "1");
  const args = rest.slice(1);
  const plainOptions = Object.fromEntries(options) as Record<string, unknown>;
  if (servesHere(command, args)) {
    const local = await localAnswer(() => runLocal(command, args, root, plainOptions, process.cwd()), plainOptions);
    if (local !== undefined) return local;
  }
  let stdin: Value = null;
  const cdpFlags = command === "cdp" ? await daemonErrors(() => checkCdpFlags(args), plainOptions) : {};
  if (cdpFlags instanceof Map) return cdpFlags;
  if (command === "notes" && args.includes("-")) stdin = await daemonErrors(() => readStdinNote(), plainOptions);
  else if (command === "cdp" && cdpFlags["params"] === "-") stdin = await daemonErrors(() => readCdpStdin(), plainOptions);
  else if (command === "read") stdin = await daemonErrors(() => readStdinUrls(args), plainOptions);
  if (stdin instanceof Map) return stdin;
  if (command === "cdp") {
    const refused = await daemonErrors(() => checkCdpParams(cdpFlags, stdin as string | null), plainOptions);
    if (refused instanceof Map) return refused;
  } else if (command === "script") {
    stdin = await daemonErrors(() => scriptSource(args, process.cwd(), expandScriptPath), plainOptions);
    if (stdin instanceof Map) return stdin;
  }
  if (command === "close" && args.includes("--all")) return closeAll(root, plainOptions, timeout, call);
  if (stdinWanted) {
    sayReadingStdin();
    const raw = await readStdin(MAX_REQUEST);
    if (!(raw instanceof Buffer)) throw osFailure(raw);
    if (raw.length > MAX_REQUEST) throw oversizedRequest();
    const text = errors === undefined ? decodeLocale(raw) : decodeStdin(raw, errors);
    if (text instanceof PythonCrash) throw text;
    stdin = text;
  }
  const payload = object([
    ["argv", rest],
    ["options", options],
    ["cwd", process.cwd()],
    ["env", agentEnv()],
    ["stdin", stdin],
    ["telemetry", shareable()],
    ["caller", routedCaller()],
  ]);
  if (command === "read" && readsNamedUrls(args)) payload.set("beside_if_busy", true);
  const line = requestLine(payload);
  const idle = found.value("idle_timeout") || process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS;
  const idleMs = idle ? parseDuration(idle) : null;
  const config = object([
    ["session", session],
    ["namespace", namespace],
    ["key", key],
    ["data_root", root],
    ["ws", endpoint.ws ?? null],
    ["port", endpoint.port ?? null],
    ["data_dir", endpoint.dataDir ?? null],
    ["endpoint_label", endpointLabel(endpoint.ws, endpoint.port)],
    ["idle_timeout_ms", idleMs !== null && "ms" in idleMs ? idleMs.ms : null],
    ["debug", Boolean(found.flag("debug"))],
    ["no_auto_dialog", options.get("no_auto_dialog") ?? false],
    ["pin_tab", options.get("pin_tab") ?? null],
    ["for_plugin", process.env.ARDIA_BROWSE_FOR_PLUGIN === "1"],
  ]);
  const socket = await ensureSession({ root, key, config, python, call });
  let answer = await ask(socket, payload, rest, timeout, call, false, line);
  if (pyTruthy(answer.get("busy_elsewhere"))) answer = await readBeside(payload, rest, { root, namespace, keySource, session, timeout, config, python }, call);
  return answer;
}
