import { createHash } from "node:crypto";
import { dumps, Float, type JsonObject, type Value } from "../../json.ts";
import { strOf, truthy } from "../../py.ts";
import { groupThousands } from "../../pylib/format.ts";
import { BrowseError } from "../daemon-errors.ts";
import { closeFd, entryInfo, listNames, lockWithin, lockHeld, openPrivateFile, PathError, readPrivateJson, unlinkQuietly, writePrivateJson } from "../paths.ts";
import { tokenHex, wallSeconds } from "../tokens.ts";

export const LOCK = "tabs.lock";
export const STALE_FILE_SECONDS = 3 * 24 * 3600;
export const VERSION = 3n;
export const MAX_IDS = 1500;
export const MAX_TEMPORARIES = 32;
export const MAX_FILE = 8 * 1024 * 1024;
export const FILE_BUDGET = 1024 * 1024;
export const CLOSE_HOLD = 30.0;
export const HOLD_MARK = "#";
export const SESSION_TABS = "session-tabs.json";
export const SESSION_TABS_VERSION = 1n;
export const MAX_SESSION_TABS = 256;
export const MAX_SESSIONS = 64;

export type Instance = string | null;
type Data = JsonObject;
type Table = "opened" | "using" | "closing" | "ids";

function table(data: Data, name: Table): JsonObject {
  return data.get(name) as JsonObject;
}

export function nonceOf(slot: string): string {
  return slot.slice("SLOT".length).toLowerCase();
}

export function temporaryLimit(): BrowseError {
  return new BrowseError(
    `Ardia already has ${MAX_TEMPORARIES} tabs open for ardia browse reads and scripts; let them finish, or end ` +
      "idle sessions with `ardia browse close --all`",
    null,
    "temporary_limit",
  );
}

function map(value: Value | undefined): JsonObject {
  return value instanceof Map ? value : new Map();
}

function num(value: Value | undefined): number {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Float) return value.value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return 0;
}

function text(value: Value | undefined, fallback = ""): string {
  return typeof value === "string" ? value : value === undefined ? fallback : strOf(value);
}

function now(): Float {
  return new Float(wallSeconds());
}

function encodedSize(value: Value): number {
  return Buffer.byteLength(dumps(value, "spaced"), "utf8");
}

function fresh(instance: Instance): Data {
  return new Map<string, Value>([
    ["version", VERSION],
    ["instance", instance],
    ["next", 1n],
    ["ids", new Map()],
    ["opened", new Map()],
    ["using", new Map()],
    ["closing", new Map()],
  ]);
}

function wellShaped(data: Value | undefined, instance: Instance): data is Data {
  if (!(data instanceof Map) || data.get("instance") !== instance || data.get("version") !== VERSION) return false;
  return ["ids", "opened", "using", "closing"].every((key) => data.get(key) instanceof Map) && data.has("next");
}

function sessionTabsShaped(data: Value | undefined): data is Data {
  if (!(data instanceof Map) || data.get("version") !== SESSION_TABS_VERSION) return false;
  const sessions = data.get("sessions");
  return sessions instanceof Map && [...sessions.values()].every((tabs) => tabs instanceof Map);
}

function newest<T>(entries: Iterable<[string, T]>, at: (value: T) => number, keep: number): [string, T][] {
  return [...entries].sort((a, b) => at(b[1]) - at(a[1])).slice(0, keep);
}

function latest(tabs: Value): number {
  return Math.max(0, ...[...map(tabs).values()].map(num));
}

export class Registry {
  readonly run: string;
  readonly instances = new Set<Instance>();

  constructor(
    readonly browseFd: number | null,
    readonly key: string,
    readonly session: string,
    readonly owner: string = key,
  ) {
    this.run = tokenHex(8);
  }

  static fileFor(instance: Instance): string {
    return `tabs-${createHash("sha256").update(Buffer.from(strOf(instance), "utf8")).digest("hex").slice(0, 20)}.json`;
  }

  private pruneFiles(dir: number, keep: string): void {
    const cutoff = wallSeconds() - STALE_FILE_SECONDS;
    for (const name of listNames(dir)) {
      if (!name.startsWith("tabs-") || !name.endsWith(".json") || name === keep) continue;
      try {
        if (entryInfo(dir, name).mtime < cutoff) unlinkQuietly(name, dir);
      } catch {}
    }
  }

  private open<T>(instance: Instance, use: (data: Data) => T): T {
    const dir = this.browseFd as number;
    const name = Registry.fileFor(instance);
    this.instances.add(instance);
    const lock = openPrivateFile(LOCK, dir);
    try {
      lockWithin(lock, "The tab registry");
      let loaded: Value | undefined;
      try {
        loaded = readPrivateJson(name, dir, MAX_FILE);
      } catch (error) {
        if (!(error instanceof PathError)) throw error;
        loaded = undefined;
      }
      let data: Data;
      if (wellShaped(loaded, instance) && this.withinCaps(loaded)) data = loaded;
      else {
        this.pruneFiles(dir, name);
        data = fresh(instance);
      }
      const before = dumps(data, "compact");
      const result = use(data);
      if (dumps(data, "compact") !== before) {
        this.compact(data);
        writePrivateJson(name, dir, data);
      }
      return result;
    } finally {
      closeFd(lock);
    }
  }

  private withinCaps(data: Data): boolean {
    let temporaries = 0;
    for (const owner of table(data, "opened").values()) if (truthy(map(owner).get("temporary"))) temporaries += 1;
    return temporaries <= MAX_TEMPORARIES;
  }

  static owner(key: string): string {
    const cut = key.indexOf(HOLD_MARK);
    return cut < 0 ? key : key.slice(0, cut);
  }

  live(given: string): boolean {
    const key = Registry.owner(given);
    return key === this.key || lockHeld(`${key}.lock`, this.browseFd as number);
  }

  private compact(data: Data): void {
    const using = table(data, "using");
    const opened = table(data, "opened");
    const closing = table(data, "closing");
    for (const key of [...using.keys()]) if (!this.live(key)) using.delete(key);
    for (const [target, owner] of [...opened]) {
      const fields = map(owner);
      if (!truthy(fields.get("temporary")) && !this.live(text(fields.get("key")))) opened.delete(target);
    }
    const at = wallSeconds();
    for (const [target, entry] of [...closing]) {
      const fields = map(entry);
      const key = text(fields.get("key"));
      if (!this.live(key) || at - num(fields.get("at")) > CLOSE_HOLD || (fields.get("key") === this.key && fields.get("run") !== this.run)) {
        closing.delete(target);
      }
    }
    const ids = table(data, "ids");
    if (ids.size > MAX_IDS) {
      const keep = new Set<string>([...opened.keys()]);
      for (const entry of using.values()) keep.add(text(map(entry).get("target")));
      const order = [...ids.keys()].sort((a, b) => num(seenOf(ids, a)) - num(seenOf(ids, b)));
      for (const target of order) {
        if (ids.size <= MAX_IDS) break;
        if (!keep.has(target)) ids.delete(target);
      }
    }
    this.fit(data);
  }

  private fit(data: Data): void {
    let size = encodedSize(data);
    const ids = table(data, "ids");
    const labels = table(data, "opened");
    const protectedTargets = new Set<string>();
    for (const [target, owner] of labels) if (truthy(map(owner).get("temporary"))) protectedTargets.add(target);
    for (const target of table(data, "closing").keys()) protectedTargets.add(target);
    for (const entry of table(data, "using").values()) protectedTargets.add(text(map(entry).get("target")));
    const unused = [...ids.keys()]
      .filter((target) => !protectedTargets.has(target) && !labels.has(target))
      .map((target): [number, string] => [num(seenOf(ids, target)), target])
      .sort(byPair);
    const attributed = [...labels]
      .filter(([target]) => !protectedTargets.has(target))
      .map(([target, owner]): [number, string] => [num(map(owner).get("at") ?? 0n), target])
      .sort(byPair);
    for (const [table, order] of [
      [ids, unused],
      [labels, attributed],
    ] as const) {
      for (const [, target] of order) {
        if (size <= FILE_BUDGET) break;
        size -= encodedSize(new Map([[target, table.get(target) ?? null]]));
        table.delete(target);
        if (table === labels) ids.delete(target);
      }
      size = encodedSize(data);
    }
    if (size > FILE_BUDGET) {
      throw new BrowseError(
        `The tab registry would be ${groupThousands(String(size))} bytes with only owned tabs left (the limit is ${groupThousands(String(FILE_BUDGET))})`,
        null,
        "registry_full",
      );
    }
  }

  numbers(instance: Instance, targets: Iterable<string>, present?: Iterable<string> | null, takenAt?: number | null): Map<string, string> {
    const wanted = [...targets];
    if (this.browseFd === null) return new Map();
    const at = wallSeconds();
    return this.open(instance, (data) => {
      const ids = table(data, "ids");
      if (present !== undefined && present !== null && takenAt !== undefined && takenAt !== null) {
        const alive = new Set([...present, ...wanted]);
        for (const [target, entry] of [...ids]) {
          if (!alive.has(target) && num(seenOf(ids, target, entry)) < takenAt) {
            ids.delete(target);
            table(data, "opened").delete(target);
          }
        }
      }
      for (const target of wanted) {
        const entry = ids.get(target);
        if (entry === undefined) {
          ids.set(target, [data.get("next") ?? 1n, new Float(at)]);
          data.set("next", (typeof data.get("next") === "bigint" ? (data.get("next") as bigint) : 1n) + 1n);
        } else if (takenAt !== undefined && takenAt !== null && Array.isArray(entry) && num(entry[1]) < takenAt) {
          entry[1] = new Float(takenAt);
        }
      }
      const out = new Map<string, string>();
      for (const target of wanted) {
        const entry = ids.get(target);
        if (Array.isArray(entry)) out.set(target, `t${strOf(entry[0] ?? null)}`);
      }
      return out;
    });
  }

  targetOf(instance: Instance, tab: string): string | null {
    if (this.browseFd === null || !/^[0-9]+$/.test(tab.slice(1))) return null;
    return this.open(instance, (data) => {
      const number = BigInt(tab.slice(1));
      for (const [target, entry] of table(data, "ids")) if (Array.isArray(entry) && entry[0] === number) return target;
      return null;
    });
  }

  noteOpened(instance: Instance, target: string): void {
    if (this.browseFd === null) return;
    this.open(instance, (data) => {
      table(data, "opened").set(target, new Map<string, Value>([["key", this.key], ["session", this.session], ["at", now()]]));
    });
  }

  sessionTabs(): Set<string> {
    if (this.browseFd === null) return new Set();
    return this.withSessionTabs((sessions) => new Set(map(sessions.get(this.owner)).keys()));
  }

  updateSessionTabs(add: readonly string[], drop: readonly string[]): void {
    if (this.browseFd === null || (add.length === 0 && drop.length === 0)) return;
    this.withSessionTabs((sessions) => {
      const tabs = new Map(map(sessions.get(this.owner)));
      for (const app of drop) tabs.delete(app);
      for (const app of add) tabs.set(app, now());
      const kept = new Map(newest(tabs, num, MAX_SESSION_TABS));
      if (kept.size > 0) sessions.set(this.owner, kept);
      else sessions.delete(this.owner);
      const capped = newest(sessions, latest, MAX_SESSIONS);
      sessions.clear();
      for (const [session, entry] of capped) sessions.set(session, entry);
    });
  }

  private withSessionTabs<T>(use: (sessions: JsonObject) => T): T {
    const dir = this.browseFd as number;
    const lock = openPrivateFile(LOCK, dir);
    try {
      lockWithin(lock, "The tab registry");
      let loaded: Value | undefined;
      try {
        loaded = readPrivateJson(SESSION_TABS, dir, FILE_BUDGET);
      } catch (error) {
        if (!(error instanceof PathError)) throw error;
        loaded = undefined;
      }
      const data: Data = sessionTabsShaped(loaded) ? loaded : new Map<string, Value>([["version", SESSION_TABS_VERSION], ["sessions", new Map()]]);
      const sessions = data.get("sessions") as JsonObject;
      const before = dumps(data, "compact");
      const cutoff = wallSeconds() - STALE_FILE_SECONDS;
      for (const [session, tabs] of [...sessions]) {
        const fresh = [...map(tabs)].filter(([, at]) => num(at) >= cutoff);
        if (fresh.length > 0) sessions.set(session, new Map(fresh));
        else sessions.delete(session);
      }
      const result = use(sessions);
      if (dumps(data, "compact") !== before) writePrivateJson(SESSION_TABS, dir, data);
      return result;
    } finally {
      closeFd(lock);
    }
  }

  private temporaryRecord(): JsonObject {
    return new Map<string, Value>([
      ["key", this.key],
      ["session", this.session],
      ["temporary", true],
      ["run", this.run],
      ["at", now()],
    ]);
  }

  reserveTemporary(instance: Instance): string | null {
    if (this.browseFd === null) return null;
    return this.open(instance, (data) => {
      const opened = table(data, "opened");
      if ([...opened.values()].filter((owner) => truthy(map(owner).get("temporary"))).length >= MAX_TEMPORARIES) throw temporaryLimit();
      const slot = `SLOT${tokenHex(14).toUpperCase()}`;
      opened.set(slot, new Map([...this.temporaryRecord(), ["nonce", nonceOf(slot)]]));
      return slot;
    });
  }

  noteTemporary(instance: Instance, target: string, slot: string | null = null): void {
    if (this.browseFd === null) return;
    this.open(instance, (data) => {
      const opened = table(data, "opened");
      const held = [...opened].filter(([other, owner]) => truthy(map(owner).get("temporary")) && other !== target && other !== slot);
      if (held.length >= MAX_TEMPORARIES) throw temporaryLimit();
      if (slot !== null) opened.delete(slot);
      opened.set(target, this.temporaryRecord());
    });
  }

  temporaries(instance: Instance): string[] {
    if (this.browseFd === null) return [];
    return this.open(instance, (data) =>
      [...table(data, "opened")].filter(([, owner]) => truthy(map(owner).get("temporary")) && map(owner).get("key") === this.key).map(([target]) => target),
    );
  }

  nonces(instance: Instance): Map<string, string> {
    if (this.browseFd === null) return new Map();
    return this.open(instance, (data) => {
      const found = new Map<string, string>();
      for (const [slot, owner] of table(data, "opened")) {
        const fields = map(owner);
        const nonce = fields.get("nonce");
        if (truthy(fields.get("temporary")) && fields.get("key") === this.key && typeof nonce === "string") found.set(slot, nonce);
      }
      return found;
    });
  }

  claimOrphans(instance: Instance): string[] {
    if (this.browseFd === null) return [];
    return this.open(instance, (data) => {
      const claimed: string[] = [];
      for (const [target, owner] of table(data, "opened")) {
        const fields = map(owner);
        if (!truthy(fields.get("temporary"))) continue;
        if (fields.get("key") !== this.key && !this.live(text(fields.get("key")))) {
          fields.set("key", this.key);
          fields.set("session", this.session);
          fields.set("run", null);
        }
        if (fields.get("key") === this.key && fields.get("run") !== this.run) claimed.push(target);
      }
      return claimed;
    });
  }

  dropTemporary(instance: Instance, target: string): void {
    if (this.browseFd === null) return;
    this.open(instance, (data) => {
      const opened = table(data, "opened");
      const owner = opened.get(target);
      if (owner instanceof Map && owner.size > 0 && truthy(owner.get("temporary")) && owner.get("key") === this.key) opened.delete(target);
    });
  }

  private refusal(data: Data, target: string): string | null {
    const closing = table(data, "closing").get(target);
    if (closing instanceof Map && closing.size > 0 && closing.get("key") !== this.key && this.live(text(closing.get("key")))) {
      return `session ${strOf(closing.get("session") ?? null)} is closing it`;
    }
    const owner = table(data, "opened").get(target);
    if (owner instanceof Map && owner.size > 0 && truthy(owner.get("temporary")) && owner.get("key") !== this.key) {
      return `session ${strOf(owner.get("session") ?? null)} opened it only to read it and will close it`;
    }
    return null;
  }

  noteUsing(instance: Instance, target: string | null): void {
    if (this.browseFd === null) return;
    this.open(instance, (data) => {
      if (target === null) {
        table(data, "using").delete(this.key);
        return;
      }
      const why = this.refusal(data, target);
      if (why) throw new BrowseError(`That tab can't be used: ${why}`, { targetId: target }, "tab_closing");
      table(data, "using").set(this.key, new Map<string, Value>([["session", this.session], ["target", target]]));
    });
  }

  async holding<T>(instance: Instance, target: string, run: () => Promise<T>): Promise<T> {
    if (this.browseFd === null) return run();
    const hold = `${this.key}${HOLD_MARK}${target}`;
    this.open(instance, (data) => {
      const why = this.refusal(data, target);
      if (why) throw new BrowseError(`That tab can't be used: ${why}`, { targetId: target }, "tab_closing");
      table(data, "using").set(hold, new Map<string, Value>([["session", this.session], ["target", target]]));
    });
    try {
      return await run();
    } finally {
      this.open(instance, (data) => {
        table(data, "using").delete(hold);
      });
    }
  }

  reserveClose(instance: Instance, target: string): boolean {
    if (this.browseFd === null) return true;
    return this.open(instance, (data) => {
      const held = map(table(data, "closing").get(target));
      if (this.refusal(data, target) || (held.get("key") === this.key && held.get("run") === this.run)) return false;
      for (const [key, entry] of table(data, "using")) {
        if (Registry.owner(key) !== this.key && map(entry).get("target") === target && this.live(key)) return false;
      }
      table(data, "closing").set(
        target,
        new Map<string, Value>([["key", this.key], ["session", this.session], ["run", this.run], ["at", now()]]),
      );
      return true;
    });
  }

  releaseClose(instance: Instance, target: string): void {
    if (this.browseFd === null) return;
    this.open(instance, (data) => {
      if (map(table(data, "closing").get(target)).get("key") === this.key) table(data, "closing").delete(target);
      const owner = table(data, "opened").get(target);
      if (owner instanceof Map && owner.size > 0 && truthy(owner.get("temporary")) && owner.get("key") === this.key) owner.set("run", null);
    });
  }

  finishClose(instance: Instance, target: string): void {
    if (this.browseFd === null) return;
    this.open(instance, (data) => {
      if (map(table(data, "closing").get(target)).get("key") === this.key) table(data, "closing").delete(target);
      const owner = table(data, "opened").get(target);
      if (owner instanceof Map && owner.size > 0 && owner.get("key") === this.key) table(data, "opened").delete(target);
      if (map(table(data, "using").get(this.key)).get("target") === target) table(data, "using").delete(this.key);
    });
  }

  forget(): void {
    if (this.browseFd === null) return;
    for (const instance of [...this.instances]) {
      this.open(instance, (data) => {
        const using = table(data, "using");
        for (const key of [...using.keys()]) if (Registry.owner(key) === this.key) using.delete(key);
        const opened = table(data, "opened");
        for (const [target, owner] of [...opened]) {
          if (map(owner).get("key") === this.key && !truthy(map(owner).get("temporary"))) opened.delete(target);
        }
      });
    }
  }

  others(instance: Instance): [Map<string, string>, Map<string, string[]>] {
    if (this.browseFd === null) return [new Map(), new Map()];
    return this.open(instance, (data) => {
      const opened = new Map<string, string>();
      for (const [target, owner] of table(data, "opened")) {
        const fields = map(owner);
        if (fields.get("key") !== this.key && !truthy(fields.get("temporary")) && this.live(text(fields.get("key")))) {
          opened.set(target, text(fields.get("session")));
        }
      }
      const using = new Map<string, string[]>();
      for (const [key, entry] of table(data, "using")) {
        if (Registry.owner(key) === this.key || !this.live(key)) continue;
        const fields = map(entry);
        const target = text(fields.get("target"));
        using.set(target, [...(using.get(target) ?? []), text(fields.get("session"))]);
      }
      return [opened, using];
    });
  }

  hidden(instance: Instance): Set<string> {
    if (this.browseFd === null) return new Set();
    return this.open(instance, (data) => {
      const out = new Set<string>();
      for (const [target, owner] of table(data, "opened")) if (truthy(map(owner).get("temporary"))) out.add(target);
      for (const [target, entry] of table(data, "closing")) if (map(entry).get("key") !== this.key) out.add(target);
      return out;
    });
  }
}

function seenOf(ids: JsonObject, target: string, entry: Value | undefined = ids.get(target)): Value | undefined {
  return Array.isArray(entry) ? entry[1] : undefined;
}

function byPair(a: [number, string], b: [number, string]): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
}
