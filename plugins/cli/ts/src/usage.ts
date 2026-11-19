import { mkdirSync } from "node:fs";
import { now } from "./clock.ts";
import { dumps, Float, type JsonObject, parse, TELEMETRY_JSON_DEPTH, type Value } from "./json.ts";
import { envSet, expandUser, home, join, purePath } from "./paths.ts";
import { close, closeDir, type Dir, openPrivate, readPrivate, takeLockRetrying, writePrivate } from "./privatefs.ts";
import { iterateOrEmpty, truthy } from "./py.ts";
import type { Call } from "./telemetry.ts";
import { isDevBuild } from "./version.ts";

const FOLDER = "Usage";
const STATE = "usage.json";
const LOCK = "usage.lock";
const MAX_STATE_BYTES = 64 * 1024;
const MAX_RECENT = 5;
const TASK_GAP_S = 30 * 60;
const NOT_RECORDED = ["feedback", "star", "none"];

export function cliHome(): string {
  const chosen = envSet("ARDIA_CLI_HOME") ?? join(home(), "Library", "Application Support", "Ardia", "CLI");
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

function remember(state: JsonObject, name: string, status: number): void {
  const recent = iterateOrEmpty(state.get("recent") ?? null).filter((entry) => typeof entry === "string");
  recent.push(status === 0 ? name : `${name} (exit ${status})`);
  state.set("recent", recent.slice(Math.max(0, recent.length - MAX_RECENT)));
}

function closeStaleTask(tasks: JsonObject, at: number): void {
  if (truthy(tasks.get("open")) && at - numberIn(tasks.get("last_at")) > TASK_GAP_S) {
    tasks.set("done", intOf(tasks.get("done")) + 1n);
    tasks.set("open", false);
  }
}

export function note(state: JsonObject, name: string, status: number, at: number): void {
  remember(state, name, status);
  const existing = state.get("tasks");
  const tasks: JsonObject = existing instanceof Map ? new Map(existing) : new Map();
  closeStaleTask(tasks, at);
  state.set("tasks", tasks);
}

export function recordUsage(call: Call, status: number): void {
  const where = recordingHome();
  if (where === undefined || NOT_RECORDED.includes(call.command)) return;
  const name = [call.command, call.subcommand].filter((part): part is string => part !== undefined && part !== "").join(" ");
  try {
    mkdirSync(where, { recursive: true });
  } catch {
    return;
  }
  let dir: Dir | undefined;
  let lock: number | undefined;
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
    note(state, name, status, now());
    try {
      writePrivate(STATE, dir, Buffer.from(dumps(state, "spaced"), "utf8"));
    } catch {}
  } catch {
    return;
  } finally {
    close(lock);
    closeDir(dir);
  }
}
