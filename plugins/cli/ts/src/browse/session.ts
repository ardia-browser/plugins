import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, constants as fsConstants, lstatSync, readFileSync, realpathSync, type Stats } from "node:fs";
import { readPrivateJson, writePrivateJson } from "./paths.ts";
import { constants } from "node:os";
import { codeOf, errnoOf, join, uid } from "../paths.ts";
import { close, type Dir, O_CREAT, O_RDONLY, O_RDWR, openPrivate, openPrivateFile, PathError } from "../privatefs.ts";
import { BrowseError, PythonCrash } from "./errors.ts";
import { osCrash } from "../crash.ts";
import { pythonOsError } from "../printable.ts";
import { flock, socketInfoAt, strerror } from "../libc.ts";

export const DIR_NAME = "Browse";
const { ELOOP, ENOTDIR, ENOENT } = constants.errno;
const { S_IFMT, S_IFSOCK } = fsConstants;

export class NoDaemon extends Error {}

export function osFailure(error: unknown): PythonCrash {
  const errno = errnoOf(error);
  return new PythonCrash(osCrash(errno), `${pythonOsError(errno)}: [Errno ${errno}] ${strerror(errno)}`);
}

function rootRefusal(root: string): BrowseError | undefined {
  let info: Stats;
  try {
    info = lstatSync(root);
  } catch (error) {
    if (errnoOf(error) === ENOENT) return new BrowseError(`${root} doesn't exist`, 1, undefined, "unsafe_path");
    if (errnoOf(error) === ENOTDIR) return new BrowseError(`${root} is a symbolic link or not a folder`, 1, undefined, "unsafe_path");
    throw osFailure(error);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return new BrowseError(`${root} is a symbolic link or not a folder`, 1, undefined, "unsafe_path");
  if (info.uid !== uid()) return new BrowseError(`${root} belongs to another user`, 1, undefined, "unsafe_path");
  return undefined;
}

function browseRefusal(root: string): BrowseError | undefined {
  let info: Stats;
  try {
    info = lstatSync(join(root, DIR_NAME));
  } catch (error) {
    if (errnoOf(error) === ELOOP || errnoOf(error) === ENOTDIR) return new BrowseError(`${DIR_NAME} is a symbolic link or not a folder`, 1, undefined, "unsafe_path");
    throw osFailure(error);
  }
  if (info.isSymbolicLink()) return new BrowseError(`${DIR_NAME} is a symbolic link or not a folder`, 1, undefined, "unsafe_path");
  if (!info.isDirectory()) return new BrowseError(`${DIR_NAME} is a symbolic link or not a folder`, 1, undefined, "unsafe_path");
  if (info.uid !== uid()) return new BrowseError(`${DIR_NAME} belongs to another user`, 1, undefined, "unsafe_path");
  if ((info.mode & 0o077) !== 0) return new BrowseError(`${DIR_NAME} must be private (mode 0700)`, 1, undefined, "unsafe_path");
  return undefined;
}

export function openBrowseDir(root: string): Dir {
  try {
    return openPrivate(root, [DIR_NAME], true);
  } catch (error) {
    if (!(error instanceof PathError)) {
      if (codeOf(error) === "ENOENT") throw new BrowseError(`${root} doesn't exist`, 1, undefined, "unsafe_path");
      throw osFailure(error);
    }
    throw rootRefusal(root) ?? browseRefusal(root) ?? new BrowseError(`${root} is a symbolic link or not a folder`, 1, undefined, "unsafe_path");
  }
}

export function checkSocket(dir: Dir, name: string): void {
  let info: { mode: number; uid: number };
  try {
    info = socketInfoAt(dir.fd, name);
  } catch (error) {
    if (errnoOf(error) === ENOENT) throw new NoDaemon("no socket");
    throw osFailure(error);
  }
  let why: string | undefined;
  if ((info.mode & S_IFMT) !== S_IFSOCK) why = `${name} isn't a socket`;
  else if (info.uid !== uid()) why = `${name} belongs to another user`;
  else if ((info.mode & 0o077) !== 0) why = `${name} must be mode 0600`;
  if (why !== undefined) throw new BrowseError(`Refusing the session socket: ${why}`, 1, undefined, "socket_refused");
}

export function lockHeld(dir: Dir, key: string): boolean {
  let fd: number;
  try {
    fd = openPrivateFile(`${key}.lock`, dir, O_RDONLY);
  } catch {
    return false;
  }
  try {
    return !flock(fd, false, false);
  } finally {
    close(fd);
  }
}

export const AUTO_SESSION_CAP = 8;
export const AUTO_PREFIX = "a";
export const AUTO_REGISTRY = ".auto-sessions.json";
export const EVICTED_KEEP = 64;
const MAX_WALK = 24;
const WRAPPERS = new Set([
  "sh", "bash", "zsh", "fish", "dash", "ksh", "mksh", "tcsh", "csh", "nu", "elvish", "xonsh", "pwsh", "env", "timeout", "gtimeout", "nohup", "nice",
  "xargs", "time", "sudo", "doas", "login", "script", "caffeinate", "stdbuf", "unbuffer", "direnv", "mise", "asdf", "rtx", "chronic", "flock",
]);

export type ProcessRow = { pid: number; ppid: number; started: string; name: string };

export function parsePs(text: string): Map<number, ProcessRow> {
  const rows = new Map<number, ProcessRow>();
  for (const line of text.split("\n")) {
    const found = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/u.exec(line);
    if (found === null) continue;
    const pid = Number(found[1]);
    rows.set(pid, { pid, ppid: Number(found[2]), started: found[3] as string, name: (found[4] as string).trim() });
  }
  return rows;
}

function procRows(): Map<number, ProcessRow> | null {
  if (!existsSync("/proc/self/stat")) return null;
  const rows = new Map<number, ProcessRow>();
  let pid = process.ppid;
  for (let step = 0; step < MAX_WALK && pid > 1; step += 1) {
    let stat: string;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch {
      break;
    }
    const close = stat.lastIndexOf(")");
    const name = stat.slice(stat.indexOf("(") + 1, close);
    const fields = stat.slice(close + 2).split(" ");
    const ppid = Number(fields[1]);
    rows.set(pid, { pid, ppid, started: fields[19] ?? "", name });
    pid = ppid;
  }
  return rows;
}

export function processRows(): Map<number, ProcessRow> {
  const fromProc = procRows();
  if (fromProc !== null) return fromProc;
  const done = spawnSync("/bin/ps", ["-A", "-o", "pid=,ppid=,lstart=,comm="], { encoding: "utf8", timeout: 5000, env: { ...process.env, LC_ALL: "C" } });
  return done.error === undefined && typeof done.stdout === "string" ? parsePs(done.stdout) : new Map();
}

export function baseName(name: string): string {
  const tail = name.split("/").pop() ?? name;
  return tail.replace(/^-/u, "");
}

export function isWrapper(name: string): boolean {
  const base = baseName(name).toLowerCase();
  return WRAPPERS.has(base) || base.startsWith("ardia");
}

export function launcherOf(rows: ReadonlyMap<number, ProcessRow>, start: number): ProcessRow | null {
  let pid = start;
  for (let step = 0; step < MAX_WALK && pid > 1; step += 1) {
    const row = rows.get(pid);
    if (row === undefined) return null;
    if (!isWrapper(row.name)) return row;
    pid = row.ppid;
  }
  return null;
}

export function worktreeRoot(cwd: string): string {
  const done = spawnSync(process.platform === "darwin" ? "/usr/bin/git" : "git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", timeout: 10_000 });
  const found = done.error === undefined && done.status === 0 && typeof done.stdout === "string" ? done.stdout.trim() : "";
  const base = found || cwd;
  try {
    return realpathSync(base);
  } catch {
    return base;
  }
}

export function agentSalt(env: NodeJS.ProcessEnv = process.env): string {
  return (env["ARDIA_AGENT_ID"] ?? "").trim().slice(0, 200);
}

export function autoSessionId(launcher: ProcessRow, worktree: string, salt = ""): string {
  const seed = `${launcher.pid}\0${launcher.started}\0${baseName(launcher.name)}\0${worktree}${salt ? `\0${salt}` : ""}`;
  const digest = createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 10);
  return `${AUTO_PREFIX}-${digest}`;
}

export function deriveAutoSession(cwd: string, rows: ReadonlyMap<number, ProcessRow> = processRows(), parent = process.ppid, salt = agentSalt()): string | null {
  const launcher = launcherOf(rows, parent);
  if (launcher === null) return null;
  return autoSessionId(launcher, worktreeRoot(cwd), salt);
}

export type AutoRegistry = { sessions: Record<string, number>; evicted: Record<string, number>; reserved?: Record<string, number> };

export function readRegistry(dir: number): AutoRegistry {
  let raw: unknown;
  try {
    raw = readPrivateJson(AUTO_REGISTRY, dir);
  } catch {
    raw = undefined;
  }
  const plain = (value: unknown): Record<string, number> => {
    const out: Record<string, number> = {};
    if (!(value instanceof Map)) return out;
    for (const [key, item] of value) if (typeof key === "string" && (typeof item === "bigint" || typeof item === "number")) out[key] = Number(item);
    return out;
  };
  return raw instanceof Map
    ? { sessions: plain(raw.get("sessions")), evicted: plain(raw.get("evicted")), reserved: plain(raw.get("reserved")) }
    : { sessions: {}, evicted: {}, reserved: {} };
}

export function writeRegistry(dir: number, registry: AutoRegistry): void {
  const asMap = (record: Record<string, number>) => new Map(Object.entries(record).map(([key, value]): [string, bigint] => [key, BigInt(Math.trunc(value))]));
  writePrivateJson(AUTO_REGISTRY, dir, new Map([["sessions", asMap(registry.sessions)], ["evicted", asMap(registry.evicted)], ["reserved", asMap(registry.reserved ?? {})]]));
}

export const AUTO_LOCK = ".auto-sessions.lock";
export const STARTING_GRACE = 120;

export function withRegistry<T>(dir: Dir, change: (registry: AutoRegistry) => { registry: AutoRegistry | null; value: T }): T {
  const fd = openPrivateFile(AUTO_LOCK, dir, O_RDWR | O_CREAT);
  try {
    flock(fd, true, true);
    const { registry, value } = change(readRegistry(dir.fd));
    if (registry !== null) writeRegistry(dir.fd, registry);
    return value;
  } finally {
    close(fd);
  }
}

export const RESERVATION_TTL = 120;
export const EVICT_TOKEN = "evict_token";

export function reservedAt(token: number): number {
  return Math.floor(token / 1000);
}

export function reservationHolds(registry: AutoRegistry, daemonKey: string, token: unknown, now: number = Math.trunc(Date.now() / 1000)): boolean {
  if (typeof token !== "string" && typeof token !== "number" && typeof token !== "bigint") return false;
  const held = registry.reserved?.[daemonKey];
  if (held === undefined || String(held) !== String(token)) return false;
  return now - reservedAt(held) < RESERVATION_TTL;
}

export type Reservation = { id: string; token: number };
export type AutoUse = { registry: AutoRegistry; reset: boolean; evict: Reservation[]; overCap: boolean };

export function useAutoSession(
  registry: AutoRegistry,
  id: string,
  now: number,
  live: (id: string) => boolean,
  cap = AUTO_SESSION_CAP,
  token: () => number = () => now * 1000 + Math.floor(Math.random() * 1000),
): AutoUse {
  const sessions: Record<string, number> = {};
  const running = new Set<string>();
  for (const [key, at] of Object.entries(registry.sessions)) {
    if (key === id) continue;
    if (live(key)) running.add(key);
    if (running.has(key) || now - at < STARTING_GRACE) sessions[key] = at;
  }
  const reserved: Record<string, number> = {};
  for (const [key, at] of Object.entries(registry.reserved ?? {})) {
    if (key !== id && Object.hasOwn(sessions, key) && now - reservedAt(at) < RESERVATION_TTL) reserved[key] = at;
  }
  const evicted = { ...registry.evicted };
  const reset = Object.hasOwn(evicted, id);
  const seen = registry.sessions[id];
  const existing = live(id) || (seen !== undefined && now - seen < STARTING_GRACE);
  if (existing) {
    delete evicted[id];
    sessions[id] = now;
    return { registry: { sessions, evicted, reserved }, reset, evict: [], overCap: false };
  }
  let open = Object.keys(sessions).length + 1 - Object.keys(reserved).length;
  const candidates = Object.entries(sessions)
    .filter(([key]) => running.has(key) && !Object.hasOwn(reserved, key))
    .sort((a, b) => a[1] - b[1]);
  const evict: Reservation[] = [];
  const claimed: Record<string, number> = { ...reserved };
  for (const [key] of candidates) {
    if (open <= cap) break;
    const held = token();
    claimed[key] = held;
    evict.push({ id: key, token: held });
    open -= 1;
  }
  if (open > cap) return { registry: { sessions, evicted: registry.evicted, reserved }, reset: false, evict: [], overCap: true };
  delete evicted[id];
  sessions[id] = now;
  return { registry: { sessions, evicted, reserved: claimed }, reset, evict, overCap: false };
}

export function withoutSession(registry: AutoRegistry, daemonKey: string): AutoRegistry {
  const sessions = { ...registry.sessions };
  delete sessions[daemonKey];
  return { ...registry, sessions };
}

export function settleEviction(registry: AutoRegistry, victim: Reservation, closed: boolean, now: number): AutoRegistry {
  const sessions = { ...registry.sessions };
  const evicted = { ...registry.evicted };
  const reserved = { ...(registry.reserved ?? {}) };
  const stillOurs = reserved[victim.id] === victim.token;
  if (stillOurs) delete reserved[victim.id];
  if (stillOurs && closed) {
    delete sessions[victim.id];
    evicted[victim.id] = now;
  }
  const kept = Object.entries(evicted).sort((a, b) => b[1] - a[1]).slice(0, EVICTED_KEEP);
  return { sessions, evicted: Object.fromEntries(kept), reserved };
}

export function resetNotice(id: string, cap = AUTO_SESSION_CAP): string {
  return `session_reset: automatic session ${id} was closed earlier as the least recently used of ${cap}, so its tabs, refs and captures are gone; open the page again`;
}
