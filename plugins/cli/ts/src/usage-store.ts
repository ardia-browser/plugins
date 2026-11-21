import { mkdirSync } from "node:fs";
import { dumps, Float, type JsonObject, parse, TELEMETRY_JSON_DEPTH, type Value } from "./json.ts";
import { join } from "./paths.ts";
import { close, closeDir, type Dir, openPrivate, readPrivate, takeLockRetrying, writePrivate } from "./privatefs.ts";
import { iterateOrEmpty } from "./py.ts";
import { utf8 } from "./pystr.ts";
import { cliHome } from "./usage.ts";
import { envSet } from "./paths.ts";
import { isDevBuild } from "./version.ts";

export const FOLDER = "Usage";
const STATE = "usage.json";
const LOCK = "usage.lock";
const MAX_STATE_BYTES = 64 * 1024;
const MAX_RECENT = 5;

export function recordingHome(): string | undefined {
  if (isDevBuild() && envSet("ARDIA_CLI_HOME") === undefined) return undefined;
  return cliHome();
}

export function openUsageFolder(home: string): Dir {
  mkdirSync(home, { recursive: true });
  return openPrivate(home, [FOLDER], true);
}

export function usagePath(home: string, name: string): string {
  return join(home, FOLDER, name);
}

function readState(dir: Dir): JsonObject {
  let raw: Buffer | undefined;
  try {
    raw = readPrivate(STATE, dir, MAX_STATE_BYTES);
  } catch {
    return new Map();
  }
  const parsed = raw === undefined ? undefined : parse(raw, TELEMETRY_JSON_DEPTH);
  return parsed instanceof Map ? parsed : new Map();
}

export function locked<T>(home: string, change: (state: JsonObject) => T): T | undefined {
  const dir = openUsageFolder(home);
  try {
    const lock = takeLockRetrying(LOCK, dir);
    if (lock === undefined) return undefined;
    try {
      const state = readState(dir);
      const result = change(state);
      writePrivate(STATE, dir, utf8(dumps(state, "spaced")));
      return result;
    } finally {
      close(lock);
    }
  } finally {
    closeDir(dir);
  }
}

function numberOf(value: Value | undefined): number {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Float) return value.value;
  return 0;
}

export function recentCommands(home: string): string[] {
  let recent: Value | undefined;
  try {
    recent = locked(home, (state) => state.get("recent"));
  } catch {
    return [];
  }
  let entries: Value[];
  try {
    entries = iterateOrEmpty(recent ?? null);
  } catch {
    return [];
  }
  const texts = entries.filter((entry): entry is string => typeof entry === "string");
  return texts.slice(Math.max(0, texts.length - MAX_RECENT));
}

function sentReports(state: JsonObject): Value[] {
  const value = state.get("feedback");
  return Array.isArray(value) ? value : [];
}

export function takeFeedbackSlot(home: string, digest: string, limit: number, windowS: number, at: number): string {
  const result = locked(home, (state) => {
    const sent = sentReports(state).filter((entry) => entry instanceof Map && at - numberOf(entry.get("at")) < windowS) as JsonObject[];
    state.set("feedback", sent);
    if (sent.some((entry) => entry.get("digest") === digest)) return "duplicate";
    if (sent.length >= limit) return "limited";
    sent.push(new Map<string, Value>([["at", new Float(at)], ["digest", digest]]));
    return "ok";
  });
  return result ?? "busy";
}

export function releaseFeedbackSlot(home: string, digest: string): void {
  try {
    locked(home, (state) => {
      state.set("feedback", sentReports(state).filter((entry) => entry instanceof Map && entry.get("digest") !== digest));
    });
  } catch {}
}
