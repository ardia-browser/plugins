import { Database } from "bun:sqlite";
import { chmodSync, closeSync, writeSync, copyFileSync, constants as fsConstants, fstatSync, lstatSync, mkdtempSync, openSync, readdirSync, readSync, rmSync, writeFileSync } from "node:fs";
import { openAt } from "./libc.ts";
import { constants, tmpdir } from "node:os";
import { now } from "./clock.ts";
import { chromiumDir, EndpointError, requireControl } from "./control-file.ts";
import { dumps, Float, type JsonObject, object, parse, type Value } from "./json.ts";
import { spawnSync } from "node:child_process";
import { HISTORY_ARGUMENT } from "./flush-argument.ts";
import { errnoOf, join, LINUX, strerror } from "./paths.ts";
import { O_NOFOLLOW, O_NONBLOCK, O_RDONLY } from "./privatefs.ts";
import { reprStr, strOf, truthy } from "./py.ts";

const DEFAULT_PROFILE_ID = "default";
const WEBKIT_EPOCH_OFFSET = 11644473600;
const HISTORY_BUDGET_S = 20;
const MAX_ROWS = 200_000;
const MAX_SESSION_BYTES = 256 * 1024 * 1024;
const MAX_LINUX_SESSION_BYTES = 8 * 1024 * 1024;
const MAX_LOCAL_STATE_BYTES = 64 * 1024 * 1024;
const LINUX_SESSION = ["Ardia", "linux-session.json"];
const LOCAL_STATE = "Local State";
const LEGACY_PIN_KEYS = ["pinned", "pinnedAsRow", "tileFolder"];
const PRIVATE_PREFIXES = ["incognito", "guest", "private", "System Profile", "Guest Profile"];
const COPY_ATTEMPTS = 3;
const SNAPSHOT_PREFIX = "ardia-history-";
const SNAPSHOT_FILES = ["History", "History-wal", "History-journal"];
const STALE_SNAPSHOT_MS = 60 * 60 * 1000;
const { O_DIRECTORY } = fsConstants;

export class BrowsingDataError extends Error {}
export class OutOfTime extends BrowsingDataError {}
export class NotRunning extends BrowsingDataError {}

export type Row = JsonObject;

function monotonic(): number {
  return performance.now() / 1000;
}

function outOfTime(deadline: number, what: string): void {
  if (monotonic() > deadline) throw new OutOfTime(`${what} ran out of time`);
}

function checkedRoot(root: string): string {
  try {
    requireControl(root);
  } catch (error) {
    if (error instanceof EndpointError) throw new NotRunning(error.message);
    throw error;
  }
  return root;
}

function directoryFlag(): number {
  return O_DIRECTORY;
}

function openBeneath(root: string, parts: string[]): number | undefined {
  const path = join(root, ...parts);
  let folder: number;
  try {
    folder = openSync(root, O_RDONLY | directoryFlag());
  } catch (error) {
    if (errnoOf(error) === constants.errno.ENOENT) return undefined;
    throw new BrowsingDataError(`can't read ${path} (${strerror(errnoOf(error))})`);
  }
  try {
    for (const part of parts.slice(0, -1)) {
      const inner = openAt(folder, part, O_RDONLY | directoryFlag() | O_NOFOLLOW, 0);
      closeSync(folder);
      folder = inner;
    }
    return openAt(folder, parts.at(-1) as string, O_RDONLY | O_NOFOLLOW | O_NONBLOCK, 0);
  } catch (error) {
    if (errnoOf(error) === constants.errno.ENOENT) return undefined;
    throw new BrowsingDataError(`can't read ${path} (${strerror(errnoOf(error))})`);
  } finally {
    closeSync(folder);
  }
}

function readJson(root: string, parts: string[], deadline: number, limit: number): Value | undefined {
  const path = join(root, ...parts);
  const fd = openBeneath(root, parts);
  if (fd === undefined) return undefined;
  const chunks: Buffer[] = [];
  try {
    if (!fstatSync(fd).isFile()) throw new BrowsingDataError(`${path} isn't a regular file`);
    let size = 0;
    for (;;) {
      const chunk = Buffer.alloc(1024 * 1024);
      const got = readSync(fd, chunk, 0, chunk.length, null);
      if (got === 0) break;
      outOfTime(deadline, `reading ${parts.at(-1) as string}`);
      size += got;
      if (size > limit) throw new BrowsingDataError(`${path} is too big`);
      chunks.push(chunk.subarray(0, got));
    }
  } finally {
    closeSync(fd);
  }
  const value = parse(Buffer.concat(chunks), 100_000);
  if (value === undefined) throw new BrowsingDataError(`${path} isn't valid JSON (Ardia may be writing it; try again)`);
  return value;
}

function dict(value: Value | undefined): JsonObject | undefined {
  return value instanceof Map ? value : undefined;
}

function isPrivateName(suffix: string): boolean {
  return PRIVATE_PREFIXES.some((prefix) => suffix.toLowerCase().startsWith(prefix.toLowerCase())) || suffix.includes("@") || suffix.includes(":");
}

export function regularProfileFolder(name: Value | undefined): name is string {
  if (typeof name !== "string" || name.includes("/") || name.includes("\0")) return false;
  if (name === "Default") return true;
  if (!name.startsWith("Profile ") || name === "Profile ") return false;
  return !isPrivateName(name.slice("Profile ".length));
}

function appProfileFolder(root: string, deadline: number): string {
  let localState: Value | undefined;
  try {
    localState = readJson(root, [LOCAL_STATE], deadline, MAX_LOCAL_STATE_BYTES);
  } catch (error) {
    if (error instanceof OutOfTime) throw error;
    if (!(error instanceof BrowsingDataError)) throw error;
    localState = undefined;
  }
  const lastUsed = dict(dict(localState)?.get("profile"))?.get("last_used");
  return regularProfileFolder(lastUsed) ? lastUsed : "Default";
}

function readSession(root: string, deadline: number): JsonObject {
  if (LINUX) {
    const session = readJson(root, [appProfileFolder(root, deadline), ...LINUX_SESSION], deadline, MAX_LINUX_SESSION_BYTES);
    return dict(session) ?? new Map();
  }
  const session = dict(readJson(root, ["session.json"], deadline, MAX_SESSION_BYTES));
  if (session === undefined) return new Map();
  const version = session.get("version");
  return typeof version === "bigint" && version >= 2n ? session : new Map();
}

function isPrivate(profileId: Value | undefined): boolean {
  return typeof profileId !== "string" || profileId.startsWith("incognito:");
}

function profileNames(session: JsonObject): Map<string, Value> {
  const profiles = dict(session.get("profiles"));
  const names = new Map<string, Value>();
  if (profiles === undefined) return names;
  for (const [pid, profile] of profiles) {
    if (profile instanceof Map && !isPrivate(pid)) {
      const name = profile.get("name");
      names.set(pid, truthy(name) ? (name as Value) : pid);
    }
  }
  return names;
}

function entries(value: Value | undefined): JsonObject[] {
  if (value instanceof Map) {
    const out: JsonObject[] = [];
    for (const [key, item] of value) {
      if (!(item instanceof Map)) continue;
      out.push(item.has("id") ? item : new Map<string, Value>([["id", key], ...item]));
    }
    return out;
  }
  if (Array.isArray(value)) return value.filter((item): item is JsonObject => item instanceof Map);
  return [];
}

function strings(value: Value | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function folderName(folder: Value | undefined): Value {
  if (!(folder instanceof Map) || typeof folder.get("name") !== "string") return null;
  return truthy(folder.get("name")) ? (folder.get("name") as Value) : null;
}

type Pin = [string, Value];

function pinOf(tab: JsonObject): Pin | undefined {
  if (LEGACY_PIN_KEYS.some((key) => tab.has(key)) || !tab.has("pin")) {
    if (tab.get("pinned") !== true) return undefined;
    return tab.get("pinnedAsRow") === true ? ["pinned", null] : ["favorite", folderName(tab.get("tileFolder"))];
  }
  const pin = tab.get("pin");
  if (!(pin instanceof Map)) return undefined;
  if (pin.get("as") === "row") return ["pinned", null];
  if (pin.get("as") === "tile") return ["favorite", folderName(pin.get("folder"))];
  return undefined;
}

function hashKey(value: Value | undefined): string {
  if (value instanceof Map || Array.isArray(value)) throw new TypeError("unhashable type");
  if (value === undefined || value === null) return "N";
  if (typeof value === "string") return `s${value}`;
  if (typeof value === "boolean") return value ? "i1" : "i0";
  if (typeof value === "bigint") return `i${value}`;
  return Number.isInteger(value.value) ? `i${BigInt(value.value)}` : `f${value.value}`;
}

function pinnedGroupOf(groups: JsonObject[]): Map<string, JsonObject> {
  const byId = new Map<string, JsonObject>();
  for (const group of groups) {
    const id = group.get("id");
    if (typeof id === "string") byId.set(id, group);
  }
  const depth = (start: JsonObject): number => {
    const seen = new Set<string>();
    let group = start;
    for (;;) {
      const parentId = group.get("parentId");
      if (typeof parentId !== "string" || !byId.has(parentId) || seen.has(parentId)) break;
      seen.add(parentId);
      group = byId.get(parentId) as JsonObject;
    }
    return seen.size;
  };
  const found = new Map<string, JsonObject>();
  const pinned = groups.filter((group) => group.get("pinned") === true).map((group) => ({ group, depth: depth(group) }));
  pinned.sort((a, b) => a.depth - b.depth);
  for (const { group } of pinned) for (const tabId of strings(group.get("tabIds"))) found.set(tabId, group);
  return found;
}

function orderedWindows(session: JsonObject): JsonObject[] {
  const windows = entries(session.get("windows")).filter((window) => !truthy(window.get("incognito")) && (window.has("kind") ? window.get("kind") : "main") === "main");
  const order = new Map<string, number>();
  strings(session.get("windowOrder")).forEach((id, index) => order.set(id, index));
  const rank = (window: JsonObject) => {
    const key = hashKey(window.get("id"));
    const id = window.get("id");
    return typeof id === "string" && order.has(id) && key.startsWith("s") ? (order.get(id) as number) : order.size;
  };
  return windows.map((window) => ({ window, rank: rank(window) })).sort((a, b) => a.rank - b.rank).map(({ window }) => window);
}

export function pinned(root: string): Row[] {
  const deadline = monotonic() + HISTORY_BUDGET_S;
  checkedRoot(root);
  const session = readSession(root, deadline);
  const names = profileNames(session);
  const savedOrder = strings(session.get("profileOrder"));
  const order = [...savedOrder.filter((pid) => names.has(pid)), ...[...names.keys()].filter((pid) => !savedOrder.includes(pid))];
  const tabs = new Map<string, JsonObject>();
  for (const tab of entries(session.get("tabs"))) {
    const id = tab.get("id");
    if (typeof id === "string") tabs.set(id, tab);
  }
  const groupOf = pinnedGroupOf(entries(session.get("groups")));
  const seen = new Set<string>();
  const rows: [number, Row][] = [];
  const add = (profileId: Value | undefined, key: Value | undefined, tab: JsonObject, kind: string, folder: Value, parked: boolean) => {
    if (isPrivate(profileId) || !names.has(profileId as string)) return;
    const seenKey = `${profileId as string}\0${hashKey(key)}`;
    if (seen.has(seenKey)) return;
    seen.add(seenKey);
    const url = [tab.get("url"), tab.get("pinnedUrl")].find(truthy) ?? "";
    const title = [tab.get("customTitle"), tab.get("title")].find(truthy) ?? url;
    rows.push([
      order.indexOf(profileId as string),
      new Map<string, Value>([
        ["title", title],
        ["url", url],
        ["pinned_url", tab.has("pinnedUrl") ? (tab.get("pinnedUrl") as Value) : null],
        ["kind", kind],
        ["folder", folder],
        ["profile", names.get(profileId as string) as Value],
        ["parked", parked],
      ]),
    ]);
  };
  for (const window of orderedWindows(session)) {
    for (const tabId of strings(window.get("tabIds"))) {
      const tab = tabs.get(tabId);
      if (tab === undefined || tab.size === 0) continue;
      const key = truthy(tab.get("pinKey")) ? tab.get("pinKey") : tabId;
      let pin = pinOf(tab);
      const group = groupOf.get(tabId);
      if (group !== undefined && group.size > 0 && !(pin !== undefined && pin[0] === "favorite")) {
        pin = ["pinned", truthy(group.get("name")) ? (group.get("name") as Value) : null];
      }
      if (pin !== undefined) add(tab.has("profileId") ? tab.get("profileId") : "", key, tab, pin[0], pin[1], false);
    }
  }
  const parkedPins = dict(session.get("parkedPins"));
  for (const [profileId, parked] of parkedPins ?? []) {
    if (!(parked instanceof Map)) continue;
    const folders = new Map<string, Value>();
    for (const group of entries(parked.get("groups"))) folders.set(hashKey(group.get("id")), group.has("name") ? (group.get("name") as Value) : null);
    for (const tab of entries(parked.get("tabs"))) {
      const groupId = tab.get("groupId");
      let kind: string;
      let folder: Value;
      if (truthy(groupId)) {
        const name = folders.get(hashKey(groupId));
        [kind, folder] = ["pinned", truthy(name) ? (name as Value) : null];
      } else [kind, folder] = pinOf(tab) ?? ["favorite", null];
      const owner = truthy(tab.get("profileId")) ? tab.get("profileId") : profileId;
      add(owner, tab.has("id") ? tab.get("id") : "", tab, kind, folder, true);
    }
  }
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => a.row[0] - b.row[0] || a.index - b.index)
    .map(({ row }) => row[1]);
}

function profileDirs(root: string, session: JsonObject): [Value, string][] {
  const chromium = chromiumDir(root);
  const names = profileNames(session);
  const profiles = dict(session.get("profiles"));
  const byDir = new Map<string, Value>();
  for (const [pid, name] of names) {
    const profile = dict(profiles?.get(pid));
    const dataId = profile !== undefined && truthy(profile.get("dataId")) ? (profile.get("dataId") as Value) : pid;
    byDir.set(dataId === DEFAULT_PROFILE_ID ? "Default" : `Profile ${strOf(dataId)}`, name);
  }
  let found: string[];
  try {
    found = readdirSync(chromium).sort();
  } catch {
    return [];
  }
  const out: [Value, string][] = [];
  for (const name of found) {
    if (!regularProfileFolder(name)) continue;
    const entry = join(chromium, name);
    try {
      if (!lstatSync(entry).isDirectory()) continue;
      if (!lstatSync(join(entry, "History")).isFile()) continue;
    } catch {
      continue;
    }
    out.push([byDir.has(name) ? (byDir.get(name) as Value) : name, entry]);
  }
  return out;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function pickProfiles(found: [Value, string][], profile: string | undefined): [Value, string][] {
  if (profile === undefined) return found;
  const chosen = found.filter(([label, folder]) => label === profile || baseName(folder) === profile);
  if (chosen.length === 0) {
    const known = [...new Set(found.map(([label]) => strOf(label)))].sort().join(", ") || "none";
    throw new BrowsingDataError(`no profile named ${reprStr(profile)} has history (known: ${known})`);
  }
  return chosen;
}

function check(path: string): void {
  const db = new Database(path);
  try {
    db.query("SELECT count(*) FROM urls").values();
    db.query("SELECT count(*) FROM visits").values();
  } finally {
    db.close();
  }
}

function clear(work: string): void {
  for (const name of SNAPSHOT_FILES) rmSync(join(work, name), { force: true });
}

function ownWorkDir(work: unknown): work is string {
  if (typeof work !== "string" || !work.startsWith(`${tmpdir()}/${SNAPSHOT_PREFIX}`) || work.slice(tmpdir().length + 1).includes("/")) return false;
  try {
    const info = lstatSync(work);
    return info.isDirectory() && info.uid === process.getuid?.() && (info.mode & 0o777) === 0o700;
  } catch {
    return false;
  }
}

function copyRegular(source: string, target: string): void {
  if (!lstatSync(source).isFile()) throw new Error(`${source} isn't a regular file`);
  copyFileSync(source, target, fsConstants.COPYFILE_EXCL);
  chmodSync(target, 0o600);
}

function snapshot(history: string, work: string, deadline: number): string {
  const target = join(work, "History");
  outOfTime(deadline, "reading history");
  try {
    const source = new Database(history, { readonly: true });
    try {
      writeFileSync(target, source.serialize(), { flag: "wx", mode: 0o600 });
    } finally {
      source.close();
    }
    check(target);
    return target;
  } catch {
    clear(work);
  }
  let last: unknown;
  for (let attempt = 0; attempt < COPY_ATTEMPTS; attempt += 1) {
    if (monotonic() >= deadline) break;
    try {
      copyRegular(history, target);
      for (const suffix of ["-wal", "-journal"]) {
        try {
          if (lstatSync(history + suffix).isFile()) copyRegular(history + suffix, target + suffix);
        } catch (error) {
          if (errnoOf(error) !== constants.errno.ENOENT) throw error;
        }
      }
      check(target);
      return target;
    } catch (error) {
      last = error;
      clear(work);
      if (error instanceof OutOfTime) break;
      Bun.sleepSync(Math.min(200 * (attempt + 1), Math.max(0, (deadline - monotonic()) * 1000)));
    }
  }
  throw new BrowsingDataError(`can't read ${history} (${last === undefined ? "out of time" : (last as Error).message})`);
}

function quotient(webkitUs: bigint | number): number {
  if (typeof webkitUs === "number") return webkitUs / 1_000_000;
  const negative = webkitUs < 0n;
  const magnitude = negative ? -webkitUs : webkitUs;
  const text = `${magnitude / 1_000_000n}.${String(magnitude % 1_000_000n).padStart(6, "0")}`;
  return (negative ? -1 : 1) * Number.parseFloat(text);
}

function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  return diff > 0.5 || (diff === 0.5 && floor % 2 !== 0) ? floor + 1 : floor;
}

export function readProfile(folder: string, work: string, cutoff: bigint, deadline: number): Value[][] {
  const path = snapshot(join(folder, "History"), work, deadline);
  let db: Database | undefined;
  try {
    db = new Database(path, { safeIntegers: true });
    return db
      .query(
        `
                    SELECT u.url, u.title, COUNT(v.id), MAX(v.visit_time), u.visit_count
                    FROM visits v JOIN urls u ON u.id = v.url
                    WHERE v.visit_time >= ? AND (v.transition & 255) NOT IN (?, ?) AND u.hidden = 0
                      AND (u.url LIKE 'http://%' OR u.url LIKE 'https://%')
                    GROUP BY u.id
                    `,
      )
      .values(cutoff, 3n, 4n)
      .slice(0, MAX_ROWS)
      .map((row) => row.map(storable));
  } catch (error) {
    if (error instanceof BrowsingDataError) throw error;
    if (monotonic() > deadline) throw new OutOfTime("reading history ran out of time");
    throw new BrowsingDataError(`can't read ${baseName(folder)}'s history (${(error as Error).message})`);
  } finally {
    db?.close();
  }
}

function storable(value: unknown): Value {
  if (typeof value === "string" || typeof value === "bigint" || value === null) return value;
  if (typeof value === "number") return Number.isInteger(value) ? BigInt(value) : new Float(value);
  return null;
}

function inCompiledProgram(): boolean {
  return (process.argv[1] ?? "").startsWith("/$bunfs/");
}

function newWorkDir(): string {
  const work = mkdtempSync(join(tmpdir(), SNAPSHOT_PREFIX));
  chmodSync(work, 0o700);
  return work;
}

function readProfileBounded(folder: string, cutoff: bigint, deadline: number): Value[][] {
  const work = newWorkDir();
  try {
    if (!inCompiledProgram()) return readProfile(folder, work, cutoff, deadline);
    const remaining = Math.max(1, Math.ceil((deadline - monotonic()) * 1000));
    const input = dumps(object([["folder", folder], ["work", work], ["cutoff", cutoff], ["budget_ms", BigInt(remaining)]]), "compact");
    const child = spawnSync(process.execPath, [HISTORY_ARGUMENT], { input, timeout: remaining, killSignal: "SIGKILL", maxBuffer: 1 << 30 });
    if (child.error !== undefined || child.signal !== null) throw new OutOfTime("reading history ran out of time");
    const answer = parse(child.stdout, 100);
    if (!(answer instanceof Map)) throw new BrowsingDataError(`can't read ${baseName(folder)}'s history (the reader gave no answer)`);
    const error = answer.get("error");
    if (typeof error === "string") throw answer.get("kind") === "time" ? new OutOfTime(error) : new BrowsingDataError(error);
    return answer.get("rows") as Value[][];
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function cleanStaleSnapshots(): void {
  const base = tmpdir();
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return;
  }
  const oldest = Date.now() - STALE_SNAPSHOT_MS;
  for (const name of names) {
    if (!name.startsWith(SNAPSHOT_PREFIX)) continue;
    const path = join(base, name);
    try {
      const info = lstatSync(path);
      if (info.isDirectory() && info.uid === process.getuid?.() && info.mtimeMs < oldest) rmSync(path, { recursive: true, force: true });
    } catch {}
  }
}

export async function historyChild(): Promise<number> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const config = parse(Buffer.concat(chunks), 10);
  if (!(config instanceof Map) || !ownWorkDir(config.get("work")) || typeof config.get("folder") !== "string" || typeof config.get("cutoff") !== "bigint" || typeof config.get("budget_ms") !== "bigint") return 2;
  const deadline = monotonic() + Number(config.get("budget_ms") as bigint) / 1000;
  let answer: JsonObject;
  try {
    const rows = readProfile(config.get("folder") as string, config.get("work") as string, config.get("cutoff") as bigint, deadline);
    answer = object([["rows", rows]]);
  } catch (error) {
    if (!(error instanceof BrowsingDataError)) throw error;
    answer = object([["error", error.message], ["kind", error instanceof OutOfTime ? "time" : "data"]]);
  }
  const bytes = Buffer.from(dumps(answer, "compact"), "utf8");
  for (let at = 0; at < bytes.length; ) at += writeSync(1, bytes, at);
  return 0;
}

function localIso(webkitUs: bigint | number): string {
  const seconds = quotient(webkitUs) - WEBKIT_EPOCH_OFFSET;
  let whole = Math.trunc(seconds);
  const micros = roundHalfEven((seconds - whole) * 1e6);
  if (micros >= 1_000_000) whole += 1;
  else if (micros < 0) whole -= 1;
  const at = new Date(whole * 1000);
  const two = (value: number) => String(value).padStart(2, "0");
  const offsetMinutes = -at.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const magnitude = Math.abs(offsetMinutes);
  const year = String(at.getFullYear()).padStart(4, "0");
  return `${year}-${two(at.getMonth() + 1)}-${two(at.getDate())}T${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}${sign}${two(Math.floor(magnitude / 60))}:${two(magnitude % 60)}`;
}

function hostOf(url: string): string {
  const cleaned = url.replace(/^[\x00-\x20]+/, "").replace(/[\t\r\n]/g, "");
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.exec(cleaned);
  const rest = scheme === null ? cleaned : cleaned.slice(scheme[0].length);
  if (!rest.startsWith("//")) return "";
  const after = rest.slice(2);
  const end = after.search(/[/?#]/);
  const netloc = end < 0 ? after : after.slice(0, end);
  const hostinfo = netloc.slice(netloc.lastIndexOf("@") + 1);
  const open = hostinfo.indexOf("[");
  let hostname: string;
  if (open >= 0) {
    const bracketed = hostinfo.slice(open + 1);
    const close = bracketed.indexOf("]");
    hostname = close < 0 ? bracketed : bracketed.slice(0, close);
  } else {
    const colon = hostinfo.indexOf(":");
    hostname = colon < 0 ? hostinfo : hostinfo.slice(0, colon);
  }
  if (hostname === "") return "";
  const percent = hostname.indexOf("%");
  return percent < 0 ? hostname.toLowerCase() : hostname.slice(0, percent).toLowerCase() + hostname.slice(percent);
}

export type HistoryOptions = { days: number; limit: number | undefined; profile: string | undefined; domains: boolean };

export function history(root: string, options: HistoryOptions): Row[] {
  const deadline = monotonic() + HISTORY_BUDGET_S;
  checkedRoot(root);
  const session = readSession(root, deadline);
  const profiles = pickProfiles(profileDirs(root, session), options.profile);
  const cutoff = BigInt(Math.trunc((now() - options.days * 86400 + WEBKIT_EPOCH_OFFSET) * 1_000_000));
  const rows: Row[] = [];
  cleanStaleSnapshots();
  for (const [label, folder] of profiles) {
    outOfTime(deadline, "reading history");
    const found = readProfileBounded(folder, cutoff, deadline);
    for (const [url, title, visits, given, total] of found as [Value, Value, Value, Value, Value][]) {
      const last = given instanceof Float ? BigInt(Math.trunc(given.value)) : (given as bigint);
      rows.push(
        new Map<string, Value>([
          ["url", url],
          ["title", truthy(title) ? title : ""],
          ["visits", visits],
          ["total_visits", total],
          ["last_visit", last],
          ["profile", label],
        ]),
      );
    }
  }
  const lastOf = (row: Row) => row.get("last_visit") as bigint;
  const ordered = rows.map((row, index) => ({ row, index })).sort((a, b) => (lastOf(b.row) > lastOf(a.row) ? 1 : lastOf(b.row) < lastOf(a.row) ? -1 : a.index - b.index)).map(({ row }) => row);
  let result: Row[];
  if (options.domains) {
    const rolled = new Map<string, Row>();
    for (const row of ordered) {
      const host = hostOf(row.get("url") as string).replace(/^www\./, "");
      const key = `${hashKey(row.get("profile"))}\0${host}`;
      let entry = rolled.get(key);
      if (entry === undefined) {
        entry = new Map<string, Value>([
          ["domain", host],
          ["visits", 0n],
          ["pages", 0n],
          ["last_visit", row.get("last_visit") as Value],
          ["top_title", row.get("title") as Value],
          ["profile", row.get("profile") as Value],
        ]);
        rolled.set(key, entry);
      }
      entry.set("visits", (entry.get("visits") as bigint) + (row.get("visits") as bigint));
      entry.set("pages", (entry.get("pages") as bigint) + 1n);
    }
    const compare = (a: Row, b: Row): number => {
      const visits = (b.get("visits") as bigint) - (a.get("visits") as bigint);
      if (visits !== 0n) return visits > 0n ? 1 : -1;
      return lastOf(b) > lastOf(a) ? 1 : lastOf(b) < lastOf(a) ? -1 : 0;
    };
    result = [...rolled.values()].map((row, index) => ({ row, index })).sort((a, b) => compare(a.row, b.row) || a.index - b.index).map(({ row }) => row);
  } else result = ordered;
  if (options.limit !== undefined) result = result.slice(0, options.limit);
  for (const entry of result) entry.set("last_visit", localIso(entry.get("last_visit") as bigint | number));
  return result;
}
