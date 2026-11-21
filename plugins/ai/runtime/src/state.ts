// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off extendsNativeError:off effectFnOpportunity:off globalFetch:off
import * as Fs from "node:fs";
import * as Path from "node:path";
import { Asks } from "./asks.ts";
import type { ChatMemoryStore, GrantStore, ToolUse } from "./browserTools.ts";
import { parseGrants, type Grant } from "./permissions.ts";
import { countersForUse, Telemetry } from "./telemetry.ts";

const VERSION = 2;

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(Fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const doc = parsed as Record<string, unknown>;
    return doc.version === VERSION ? doc : null;
  } catch {
    return null;
  }
}

function writeJson(file: string, data: Record<string, unknown>) {
  Fs.mkdirSync(Path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  Fs.writeFileSync(tmp, JSON.stringify({ ...data, version: VERSION }), { mode: 0o600 });
  Fs.renameSync(tmp, file);
}

export function fileGrantStore(dataDir: string): GrantStore {
  const file = Path.join(dataDir, "grants.json");
  let grants: Grant[] = parseGrants(readJson(file)?.grants);
  return {
    list: () => grants,
    save: (next) => {
      grants = parseGrants(next);
      writeJson(file, { grants });
    },
  };
}

export type ChatMemory = ChatMemoryStore & {
  noteOpened(chatId: string, tabId: string, origin: string | null): void;
  tag(chatId: string, tabIds: readonly string[]): void;
  untag(chatId: string, tabId: string): void;
  forgetTab(tabId: string): void;
  stopped(chatId: string): boolean;
  noteStopped(chatId: string): void;
  noteSent(chatId: string): void;
  startOnce(chatId: string): boolean;
};

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export function fileChatMemory(dataDir: string): ChatMemory {
  const file = Path.join(dataDir, "chats.json");
  const opened = new Map<string, Map<string, string | null>>();
  const readPages = new Set<string>();
  const tagged = new Map<string, Set<string>>();
  const started = new Set<string>();
  const stopped = new Set<string>();
  const saved = readJson(file)?.chats;
  if (saved && typeof saved === "object") {
    for (const [chatId, entry] of Object.entries(saved as Record<string, { opened?: unknown; tagged?: unknown; readPages?: unknown }>)) {
      if (!ID.test(chatId)) continue;
      const ids = (v: unknown) => new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && ID.test(x)) : []);
      const openedEntries = entry?.opened && typeof entry.opened === "object" && !Array.isArray(entry.opened) ? Object.entries(entry.opened as Record<string, unknown>) : [];
      opened.set(chatId, new Map(openedEntries.filter(([id, origin]) => ID.test(id) && (origin === null || typeof origin === "string")) as Array<[string, string | null]>));
      if (entry?.readPages === true) readPages.add(chatId);
      started.add(chatId);
      tagged.set(chatId, ids(entry?.tagged));
    }
  }
  const persist = () => {
    const chats: Record<string, { opened: Record<string, string | null>; tagged: string[]; readPages: boolean }> = {};
    for (const chatId of new Set([...opened.keys(), ...tagged.keys(), ...started])) {
      chats[chatId] = { opened: Object.fromEntries(opened.get(chatId) ?? []), tagged: [...(tagged.get(chatId) ?? [])], readPages: readPages.has(chatId) };
    }
    writeJson(file, { chats });
  };
  const setOf = (map: Map<string, Set<string>>, chatId: string) => {
    let set = map.get(chatId);
    if (!set) map.set(chatId, (set = new Set()));
    return set;
  };
  return {
    opened: (chatId) => {
      let map = opened.get(chatId);
      if (!map) opened.set(chatId, (map = new Map()));
      return map;
    },
    tagged: (chatId) => setOf(tagged, chatId),
    noteOpened: (chatId, tabId, origin) => {
      if (!ID.test(tabId)) return;
      let map = opened.get(chatId);
      if (!map) opened.set(chatId, (map = new Map()));
      map.set(tabId, origin);
      persist();
    },
    hasReadPages: (chatId) => readPages.has(chatId),
    noteReadPages: (chatId) => {
      if (readPages.has(chatId)) return;
      readPages.add(chatId);
      persist();
    },
    tag: (chatId, tabIds) => {
      for (const id of tabIds) if (ID.test(id)) setOf(tagged, chatId).add(id);
      persist();
    },
    untag: (chatId, tabId) => {
      setOf(tagged, chatId).delete(tabId);
      persist();
    },
    forgetTab: (tabId) => {
      for (const map of opened.values()) map.delete(tabId);
      for (const set of tagged.values()) set.delete(tabId);
      persist();
    },
    stopped: (chatId) => stopped.has(chatId),
    noteStopped: (chatId) => void stopped.add(chatId),
    noteSent: (chatId) => void stopped.delete(chatId),
    startOnce: (chatId) => {
      if (started.has(chatId)) return false;
      started.add(chatId);
      persist();
      return true;
    },
  };
}

export type UsageCounts = Record<string, number>;

export type PluginState = {
  asks: Asks;
  grants: GrantStore;
  memory: ChatMemory;
  counts: UsageCounts;
  telemetry: Telemetry;
  banners: Map<string, string>;
  notes: Set<(chatId: string, note: { type: string }) => void>;
};

let state: PluginState | null = null;

export function pluginState(dataDir: string): PluginState {
  if (!state) {
    state = { asks: new Asks(), grants: fileGrantStore(dataDir), memory: fileChatMemory(dataDir), counts: {}, telemetry: new Telemetry(null), banners: new Map(), notes: new Set() };
  }
  return state;
}

export function countUse(state: PluginState, use: ToolUse) {
  for (const counter of countersForUse(use)) state.telemetry.count(counter);
}

export function notifyChat(s: PluginState, chatId: string, type: string) {
  for (const listener of s.notes) listener(chatId, { type });
}
