import { closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { now } from "./clock.ts";
import { dumps, Float, type JsonObject, parse, TELEMETRY_JSON_DEPTH, type Value } from "./json.ts";
import { envSet, expandUser, home, join, LINUX, purePath, xdgDir } from "./paths.ts";
import { close, closeDir, type Dir, openPrivate, readPrivate, takeLockRetrying, writePrivate } from "./privatefs.ts";
import { isSpace, iterateOrEmpty, strip, truthy } from "./py.ts";
import { type Call, dataDirArg, leadingTokens, namesTestEndpoint, TEST_ENDPOINT_ENV } from "./telemetry.ts";
import { installedDataDir } from "./control.ts";
import { realpath } from "./paths.ts";
import { writeAll } from "./printable.ts";
import { STAR_PROMPT, TASK_COMMANDS } from "./browse/tables.ts";
import { isDevBuild } from "./version.ts";
import { utf8 } from "./pystr.ts";

const FOLDER = "Usage";
const STATE = "usage.json";
const LOCK = "usage.lock";
const MAX_STATE_BYTES = 64 * 1024;
const MAX_RECENT = 5;
const TASK_GAP_S = 30 * 60;
const NOT_RECORDED = ["feedback", "star", "none"];
const TASKS_BEFORE_ASKING = 5;
const OFF_VALUES = ["0", "false", "off", "no"];
const CI_ENV = ["CI", "GITHUB_ACTIONS", "BUILDKITE", "JENKINS_URL"];

function lowered(name: string): string {
  return strip(process.env[name] ?? "", isSpace).toLowerCase();
}

function promptAllowed(): boolean {
  if (OFF_VALUES.includes(lowered("ARDIA_STAR_PROMPT"))) return false;
  return !CI_ENV.some((name) => !["", "0", "false"].includes(lowered(name)));
}

function isTestContext(argv: string[]): boolean {
  const tokens = leadingTokens(argv);
  if (namesTestEndpoint(tokens) || TEST_ENDPOINT_ENV.some((name) => envSet(name) !== undefined)) return true;
  const dataDir = dataDirArg(tokens) ?? envSet("ARDIA_DATA_DIR");
  if (dataDir === undefined) return false;
  try {
    return realpath(expandUser(dataDir)) !== realpath(installedDataDir());
  } catch {
    return true;
  }
}

function dictIn(state: JsonObject, key: string): JsonObject {
  const value = state.get(key);
  return value instanceof Map ? value : new Map();
}

function dueForPrompt(state: JsonObject): boolean {
  const star = dictIn(state, "star");
  return !truthy(star.get("prompted_at")) && !truthy(star.get("done_at")) && numberIn(dictIn(state, "tasks").get("done")) >= TASKS_BEFORE_ASKING;
}

const CARRIED_FORWARD = [["skills.json"], [FOLDER, STATE]];
let carried = false;

function carryForward(from: string, to: string): void {
  if (carried) return;
  carried = true;
  for (const parts of CARRIED_FORWARD) {
    const target = join(to, ...parts);
    const source = join(from, ...parts);
    const staged = `${target}.carried-${process.pid}`;
    let created = false;
    try {
      if (existsSync(target)) continue;
      const info = lstatSync(source);
      if (!info.isFile() || info.uid !== process.getuid?.()) continue;
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      const fd = openSync(staged, "wx", 0o600);
      created = true;
      try {
        writeFileSync(fd, readFileSync(source));
      } finally {
        closeSync(fd);
      }
      linkSync(staged, target);
    } catch {
      continue;
    } finally {
      if (created) {
        try {
          rmSync(staged, { force: true });
        } catch {}
      }
    }
  }
}

export function defaultCliHome(linux: boolean = LINUX): string {
  const mac = join(home(), "Library", "Application Support", "Ardia", "CLI");
  if (!linux) return mac;
  const xdg = join(xdgDir("XDG_DATA_HOME", ".local", "share"), "ardia", "cli");
  carryForward(mac, xdg);
  return xdg;
}

export function cliHome(linux: boolean = LINUX): string {
  const chosen = envSet("ARDIA_CLI_HOME") ?? defaultCliHome(linux);
  return purePath(expandUser(chosen));
}

function recordingHome(): string | undefined {
  if (isDevBuild() && envSet("ARDIA_CLI_HOME") === undefined) return undefined;
  return cliHome();
}

function numberIn(value: Value | undefined): number {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Float) return value.value;
  return 0;
}

function intOf(value: Value | undefined): bigint {
  if (typeof value === "bigint") return value;
  if (value instanceof Float && Number.isFinite(value.value)) return BigInt(Math.trunc(value.value));
  return 0n;
}

function remember(state: JsonObject, name: string, status: number | bigint): void {
  const recent = iterateOrEmpty(state.get("recent") ?? null).filter((entry) => typeof entry === "string");
  recent.push(BigInt(status) === 0n ? name : `${name} (exit ${status})`);
  state.set("recent", recent.slice(Math.max(0, recent.length - MAX_RECENT)));
}

function closeStaleTask(tasks: JsonObject, at: number): void {
  if (truthy(tasks.get("open")) && at - numberIn(tasks.get("last_at")) > TASK_GAP_S) {
    tasks.set("done", intOf(tasks.get("done")) + 1n);
    tasks.set("open", false);
  }
}

export function note(state: JsonObject, name: string, status: number | bigint, at: number, task = false, ask = false): boolean {
  remember(state, name, status);
  const existing = state.get("tasks");
  const tasks: JsonObject = existing instanceof Map ? existing : new Map();
  if (!(existing instanceof Map)) state.set("tasks", tasks);
  closeStaleTask(tasks, at);
  if (!task) return false;
  closeStaleTask(tasks, at);
  tasks.set("open", true);
  tasks.set("last_at", new Float(at));
  if (!ask || !dueForPrompt(state)) return false;
  const star = state.get("star");
  if (star !== undefined && !(star instanceof Map)) throw new Error("usage.json's star isn't an object");
  const kept: JsonObject = star ?? new Map();
  if (star === undefined) state.set("star", kept);
  kept.set("prompted_at", new Float(at));
  return true;
}

export function recordUsage(call: Call, status: number | bigint): void {
  const where = recordingHome();
  if (where === undefined || NOT_RECORDED.includes(call.command)) return;
  const name = call.usageWord !== undefined ? `${call.command} ${call.usageWord}` : [call.command, call.subcommand].filter((part): part is string => part !== undefined && part !== "").join(" ");
  try {
    mkdirSync(where, { recursive: true });
  } catch {
    return;
  }
  let dir: Dir | undefined;
  let lock: number | undefined;
  let prompt = false;
  try {
    dir = openPrivate(where, [FOLDER], true);
    lock = takeLockRetrying(LOCK, dir);
    if (lock === undefined) return;
    let raw: Buffer | undefined;
    try {
      raw = readPrivate(STATE, dir, MAX_STATE_BYTES);
    } catch {
      raw = undefined;
    }
    const parsed = raw === undefined ? undefined : parse(raw, TELEMETRY_JSON_DEPTH);
    const state: JsonObject = parsed instanceof Map ? parsed : new Map();
    const task = BigInt(status) === 0n && call.command === "browse" && TASK_COMMANDS.includes(call.subcommand ?? "") && !isTestContext(call.argv);
    prompt = note(state, name, status, now(), task, promptAllowed());
    try {
      writePrivate(STATE, dir, utf8(dumps(state, "spaced")));
    } catch {}
  } catch {
    return;
  } finally {
    close(lock);
    closeDir(dir);
  }
  if (prompt) {
    try {
      writeAll(2, `${STAR_PROMPT}\n`);
    } catch {}
  }
}
