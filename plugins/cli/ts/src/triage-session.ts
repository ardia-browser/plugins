import { lstatSync, mkdirSync } from "node:fs";
import { iso, now } from "./clock.ts";
import { dumps, type JsonObject, object, parse, type Value } from "./json.ts";
import { envSet, join, LINUX, purePath, abspath, expandUser } from "./paths.ts";
import { closeDir, type Dir, notFound, openPrivate, readPrivate, unlinkQuietly, writePrivate } from "./privatefs.ts";
import { utf8 } from "./pystr.ts";
import { recordingHome } from "./usage-store.ts";

export const TRIAGE_FOLDER = "triage";
export const SOURCE_FOLDER = "source";
const CONSENT_FILE = "consent.json";
const SESSION_FILE = "session.json";
const MAX_STATE_BYTES = 4 * 1024 * 1024;
export const SESSION_ENV = "ARDIA_TRIAGE_SESSION";
export const MODE_ENV = "ARDIA_TRIAGE";
export const AGENT_ENV = "ARDIA_TRIAGE_AGENT";
const STAMP_TRIES = 50;

export class TriageRefused extends Error {
  constructor(
    message: string,
    readonly status = 2,
  ) {
    super(message);
  }
}

export function machineWord(): string {
  return LINUX ? "this computer" : "this Mac";
}

export function triageHome(): string {
  const home = recordingHome();
  if (home === undefined) throw new TriageRefused("this ardia is a checkout build, which keeps triage sessions only with ARDIA_CLI_HOME set");
  return home;
}

export function triageRoot(home: string): string {
  return join(home, TRIAGE_FOLDER);
}

export function sourceCache(home: string): string {
  return join(triageRoot(home), SOURCE_FOLDER);
}

function openTriage(home: string, parts: string[] = []): Dir {
  mkdirSync(home, { recursive: true });
  return openPrivate(home, [TRIAGE_FOLDER, ...parts], true);
}

export function readJsonIn(dir: Dir, name: string): JsonObject | undefined {
  let raw: Buffer | undefined;
  try {
    raw = readPrivate(name, dir, MAX_STATE_BYTES);
  } catch {
    return undefined;
  }
  if (raw === undefined) return undefined;
  try {
    const parsed = parse(raw, 16);
    return parsed instanceof Map ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function writeJsonIn(dir: Dir, name: string, document: JsonObject): void {
  writePrivate(name, dir, utf8(`${dumps(document, "indented")}\n`));
}

function existingTriage(home: string): Dir | undefined {
  try {
    lstatSync(triageRoot(home));
  } catch (error) {
    if (notFound(error)) return undefined;
    throw error;
  }
  return openTriage(home);
}

export function consentSaved(home: string): boolean {
  const dir = existingTriage(home);
  if (dir === undefined) return false;
  try {
    return readJsonIn(dir, CONSENT_FILE)?.get("accepted") === true;
  } finally {
    closeDir(dir);
  }
}

export function forgetConsent(home: string): void {
  const dir = existingTriage(home);
  if (dir === undefined) return;
  try {
    unlinkQuietly(CONSENT_FILE, dir);
  } finally {
    closeDir(dir);
  }
}

export function saveConsent(home: string): void {
  const dir = openTriage(home);
  try {
    writeJsonIn(dir, CONSENT_FILE, object([["accepted", true], ["at", iso(now())]]));
  } finally {
    closeDir(dir);
  }
}

function stampOf(seconds: number): string {
  return `${iso(seconds).slice(0, 19).replaceAll(":", "-")}Z`;
}

export type Session = { home: string; dir: string; name: string };

export function newSession(home: string): Session {
  const root = openTriage(home);
  closeDir(root);
  const stamp = stampOf(now());
  for (let attempt = 0; attempt < STAMP_TRIES; attempt += 1) {
    const name = attempt === 0 ? stamp : `${stamp}-${attempt + 1}`;
    const dir = join(triageRoot(home), name);
    try {
      lstatSync(dir);
      continue;
    } catch (error) {
      if (!notFound(error)) throw error;
    }
    closeDir(openTriage(home, [name]));
    return { home, dir, name };
  }
  throw new TriageRefused("couldn't pick a new session folder name; try again in a second", 1);
}

export function openSessionPart(session: Session, parts: string[]): Dir {
  return openTriage(session.home, [session.name, ...parts]);
}

export function writeSessionRecord(session: Session, record: JsonObject): void {
  const dir = openSessionPart(session, []);
  try {
    writeJsonIn(dir, SESSION_FILE, record);
  } finally {
    closeDir(dir);
  }
}

export type OpenSession = { session: Session; record: JsonObject; dir: Dir };

export function openExistingSession(given: string | undefined): OpenSession {
  const named = given ?? envSet(SESSION_ENV);
  if (named === undefined) throw new TriageRefused("ardia triage file runs inside a triage session: start one with ardia triage, or pass --session DIR");
  const home = triageHome();
  const dir = abspath(purePath(expandUser(named)));
  const root = triageRoot(home);
  const name = dir.startsWith(`${root}/`) ? dir.slice(root.length + 1) : "";
  if (name === "" || name.includes("/") || name === SOURCE_FOLDER) throw new TriageRefused(`${dir} isn't a triage session folder (they live in ${root})`);
  const session = { home, dir, name };
  let opened: Dir;
  try {
    opened = openTriage(home, [name]);
  } catch {
    throw new TriageRefused(`${dir} isn't a triage session folder`);
  }
  const record = readJsonIn(opened, SESSION_FILE);
  if (record === undefined) {
    closeDir(opened);
    throw new TriageRefused(`${dir} has no session.json, so it isn't a triage session`);
  }
  return { session, record, dir: opened };
}

export function stringIn(record: JsonObject, key: string): string | undefined {
  const value: Value | undefined = record.get(key);
  return typeof value === "string" ? value : undefined;
}
