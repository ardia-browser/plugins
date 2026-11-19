import type { Socket } from "node:net";
import { dumps, type JsonObject, object, type Value } from "../json.ts";
import { truthy as pyTruthy } from "../py.ts";
import { codePoints, joinCodePoints } from "../pystr.ts";
import { routedCaller } from "../routed.ts";
import { type Call, shareable } from "../telemetry.ts";
import { noGet } from "./answer.ts";
import { type Found, parseDuration, Usage } from "./args.ts";
import { answerDeadline } from "./deadline.ts";
import { builtinCrash, PythonCrash, unreachable } from "./errors.ts";
import { Absent, connect, exchange, Stalled } from "./exchange.ts";
import { encodeError } from "./output.ts";
import { checkEndpointFree, loaderRefusal, pluginEndpointKey, takeExpectLoader } from "./plugin.ts";
import { loadAnswer } from "./pyjson.ts";
import type { Secrets } from "./redact.ts";
import { agentEnv, endpointChoice, endpointKey, namespaceName, optionsFrom, rootOf, sessionKey, sessionName, urlsWithSecrets } from "./request.ts";
import { checkSocket, NoDaemon, openBrowseDir, osFailure, socketPath } from "./session.ts";
import { decodeStdin, pythonStdioErrors, readStdin, stdinState } from "./stdio.ts";
import { TAKES_OUT } from "./tables.ts";

export const ANSWER_JSON_DEPTH = 9991;
const HAND_BACK_COMMANDS = ["auth", "notes", "flow", "plugin", "read", "session", "script"];
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
  if (state === "closed") throw new HandBack("stdin is closed");
  return state !== "tty";
}

export function handedBack(rest: readonly string[], browse: readonly string[]): string | undefined {
  const command = rest[0] as string;
  if (HAND_BACK_COMMANDS.includes(command)) return `${command} runs on Python`;
  if (command === "close" && rest.slice(1).includes("--all")) return "close --all runs on Python";
  if (TAKES_OUT.includes(command) && browse.some((token) => token === "--out" || token.startsWith("--out="))) return "--out runs on Python";
  return undefined;
}

function checkIdle(found: Found): void {
  const idle = found.value("idle_timeout") || process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS;
  if (!idle) return;
  const parsed = parseDuration(idle);
  if ("invalid" in parsed) throw new Usage(`--idle-timeout takes 10s, 3m, 1h or milliseconds, not ${idle}`);
  if ("infinite" in parsed) throw builtinCrash("OverflowError", "cannot convert float infinity to integer");
}

async function openSession(root: string, key: string): Promise<Socket> {
  openBrowseDir(root);
  const path = socketPath(root, key);
  checkSocket(path, `${key}.sock`);
  try {
    return await connect(path);
  } catch (error) {
    if (error instanceof Absent) throw new NoDaemon("the socket refused the connection");
    throw error;
  }
}

async function ask(socket: Socket, payload: JsonObject, rest: string[], timeout: Value, call: Call, patient = false): Promise<JsonObject> {
  const seconds = answerDeadline(rest, timeout, patient);
  if (seconds instanceof PythonCrash) {
    socket.destroy();
    throw seconds;
  }
  const line = `${dumps(payload, "spaced")}\n`;
  const refused = encodeError(codePoints(line));
  if (refused !== undefined) {
    socket.destroy();
    throw refused;
  }
  let raw: Buffer;
  try {
    raw = await exchange(socket, Buffer.from(line, "utf8"), rest[0] as string, seconds);
  } catch (error) {
    if (error instanceof Stalled) call.metrics.set("daemon_answer_timed_out", true);
    throw error;
  }
  const answer = loadAnswer(raw, ANSWER_JSON_DEPTH);
  if (answer instanceof PythonCrash) throw answer;
  if (!(answer instanceof Map)) throw noGet(answer);
  return answer;
}

type Beside = { root: string; namespace: string; keySource: string; session: string; timeout: Value };

async function readBeside(payload: JsonObject, rest: string[], beside: Beside, call: Call): Promise<JsonObject> {
  const name = `${joinCodePoints(codePoints(beside.session).slice(0, BESIDE_PREFIX))}-side`;
  let socket: Socket;
  try {
    socket = await openSession(beside.root, sessionKey(beside.namespace, beside.keySource, name));
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

export async function roundTrip(found: Found, given: string[], secrets: Secrets, call: Call, credential: string | undefined): Promise<JsonObject> {
  const plugin = credential !== undefined;
  let rest = given;
  let loader: string | undefined;
  if (plugin) {
    checkEndpointFree(found.values);
    ({ argv: rest, loader } = takeExpectLoader(rest));
  }
  const { entries: options, timeout } = optionsFrom(found);
  const session = sessionName(found);
  const namespace = namespaceName(found);
  const endpoint = endpointChoice(found);
  for (const secret of urlsWithSecrets(endpoint.ws)) secrets.add(secret);
  const root = rootOf(endpoint);
  const keySource = credential === undefined ? endpointKey(endpoint, root) : pluginEndpointKey(credential);
  options.set("_session", session);
  const command = rest[0] as string;
  const stdinWanted = wantsStdin(command, rest.slice(1));
  const errors = stdinWanted ? pythonStdioErrors() : "strict";
  if (errors === undefined) throw new HandBack("stdin's encoding isn't UTF-8");
  checkIdle(found);
  const socket = await openSession(root, sessionKey(namespace, keySource, session));
  let stdin: Value = null;
  try {
    if (stdinWanted) {
      const raw = await readStdin();
      if (!(raw instanceof Buffer)) throw osFailure(raw);
      const text = decodeStdin(raw, errors);
      if (text instanceof PythonCrash) throw text;
      stdin = text;
    }
  } catch (error) {
    socket.destroy();
    throw error;
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
  if (credential !== undefined) payload.set("plugin_credential", credential);
  if (loader !== undefined) payload.set("expect_loader", loader);
  let answer = await ask(socket, payload, rest, timeout, call);
  if (pyTruthy(answer.get("busy_elsewhere"))) answer = await readBeside(payload, rest, { root, namespace, keySource, session, timeout }, call);
  if (loader !== undefined) {
    const refused = loaderRefusal(answer, loader);
    if (refused !== undefined) throw refused;
  }
  return answer;
}
