// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off extendsNativeError:off effectFnOpportunity:off globalFetch:off
import { ANSWERS, type Answer } from "./permissions.ts";
import type { HostApi } from "./browserTools.ts";
import type { PluginValues } from "./host.ts";
import type { PluginState } from "./state.ts";
import type { Counter } from "./telemetry.ts";
import { flattenWorkspace, placeOfChat, summarize } from "./tabs.ts";
import type { TurnLedger } from "./turnLedger.ts";

export type ApiReply = { status: number; body: unknown };

export type ApiDeps = {
  host: HostApi;
  state: PluginState;
  values: () => PluginValues;
  appVersion: string;
  workspaceRoot: string;
  openPage: (path: string, how: { split: boolean; side?: string | undefined }) => Promise<{ tabId: string }>;
  setValue: (key: string, value: string | boolean) => Promise<void>;
  startLogin: (provider: "claude") => Promise<void>;
  count: (counter: Counter) => void;
  turns?: TurnControl | undefined;
  ledger: Pick<TurnLedger, "stop" | "allow">;
};

export type TurnControl = {
  stop(chatId: string): Promise<void>;
};

export function stopChat(deps: Pick<ApiDeps, "state" | "turns" | "ledger">, chatId: string) {
  deps.ledger.stop(chatId);
  deps.state.memory.noteStopped(chatId);
  deps.state.asks.cancelChat(chatId);
  bumpChat(chatId);
  void deps.turns?.stop(chatId).catch(() => undefined);
}

const CHAT_ID = /^[A-Za-z0-9-]{8,64}$/;
export const PROMPT_LIMIT = 600;
export const OPEN_QUERY_LIMIT = 8_000;
const OPEN_TARGET = /^(new|history|[A-Za-z0-9-]{8,64})(?:\?([A-Za-z0-9=&%._~+-]*))?$/;

export function openTargetOf(value: unknown): string | { problem: string } {
  if (typeof value !== "string" || value.length > 80 + OPEN_QUERY_LIMIT) return { problem: "Bad path." };
  const match = OPEN_TARGET.exec(value);
  if (!match || (match[2]?.length ?? 0) > OPEN_QUERY_LIMIT) return { problem: "Bad path." };
  let query: URLSearchParams;
  try {
    query = new URLSearchParams(match[2] ?? "");
  } catch {
    return { problem: "Bad path." };
  }
  for (const [key, text] of query) {
    if (key === "q" && [...text].length > PROMPT_LIMIT) return { problem: `The prompt is too long: ${PROMPT_LIMIT} characters at most.` };
  }
  return value;
}
const TAB_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const POLL_MS = 25_000;
const VALUE_KEYS = new Set(["mode", "side", "newTab", "model"]);

const ok = (body: unknown): ApiReply => ({ status: 200, body });
const bad = (message: string, status = 400): ApiReply => ({ status, body: { error: message } });

type Versions = Map<string, number>;
const versions: Versions = new Map();
let globalVersion = 0;
const waiters = new Set<() => void>();

export function bumpChat(chatId: string | null) {
  if (chatId) versions.set(chatId, (versions.get(chatId) ?? 0) + 1);
  else globalVersion++;
  for (const wake of [...waiters]) wake();
}

const versionOf = (chatId: string) => (versions.get(chatId) ?? 0) + globalVersion;

function chatSnapshot(deps: ApiDeps, chatId: string) {
  return {
    version: versionOf(chatId),
    asks: deps.state.asks.pending(chatId),
    stopped: deps.state.memory.stopped(chatId),
    values: deps.values(),
  };
}

function waitForChange(chatId: string, since: number, signal?: AbortSignal): Promise<void> {
  if (versionOf(chatId) !== since) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      waiters.delete(wake);
      resolve();
    };
    const wake = () => {
      if (versionOf(chatId) !== since) done();
    };
    const timer = setTimeout(done, POLL_MS);
    waiters.add(wake);
    signal?.addEventListener("abort", done, { once: true });
  });
}

const str = (v: unknown, max = 200) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
const tabList = (v: unknown) => (Array.isArray(v) && v.length <= 20 && v.every((t) => typeof t === "string" && TAB_ID.test(t)) ? (v as string[]) : null);

async function tag(deps: ApiDeps, chatId: string, tabs: string[]) {
  if (!tabs.length) return { group: null };
  deps.state.memory.tag(chatId, tabs);
  const snapshot = placeOfChat(flattenWorkspace(await deps.host.workspace()), chatId);
  const chatTab = snapshot.chatTab;
  if (!chatTab) return { group: null };
  const fresh = tabs.filter((t) => t !== chatTab.id && !(snapshot.groupTabs.includes(t) && snapshot.group));
  if (!snapshot.group && snapshot.split) {
    const rest = fresh.filter((t) => !snapshot.splitTabs.includes(t));
    if (!rest.length) return { group: null };
    const { group } = await deps.host.splitToGroup(chatTab.id);
    await deps.host.groupWithChat(chatTab.id, rest);
    deps.count("tag_groups_created");
    return { group };
  }
  if (!fresh.length) return { group: snapshot.group };
  const { group } = await deps.host.groupWithChat(chatTab.id, fresh);
  deps.count(snapshot.group ? "tag_groups_joined" : "tag_groups_created");
  return { group };
}

export async function handleApi(method: string, path: string, query: URLSearchParams, body: unknown, deps: ApiDeps, signal?: AbortSignal): Promise<ApiReply> {
  const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const chat = str(query.get("chat") ?? input.chat, 64);
  if (chat && !CHAT_ID.test(chat)) return bad("Bad chat id.");
  switch (`${method} ${path}`) {
    case "GET /ardia/info":
      return ok({ appVersion: deps.appVersion, values: deps.values(), workspaceRoot: deps.workspaceRoot });
    case "GET /ardia/events": {
      if (!chat) return bad("Needs a chat.");
      const since = Number(query.get("since") ?? "-1");
      await waitForChange(chat, since, signal);
      return ok(chatSnapshot(deps, chat));
    }
    case "POST /ardia/asks/answer": {
      const id = str(input.id, 64);
      const answer = input.answer as Answer;
      if (!chat || !id || !ANSWERS.includes(answer)) return bad("Needs chat, id and answer (allow, always or deny).");
      return deps.state.asks.answer(chat, id, answer) ? ok({ ok: true }) : bad("That question isn't waiting any more.", 404);
    }
    case "GET /ardia/tabs": {
      if (!chat) return bad("Needs a chat.");
      const tabs = flattenWorkspace(await deps.host.workspace());
      const place = placeOfChat(tabs, chat);
      const memory = { opened: deps.state.memory.opened(chat), tagged: deps.state.memory.tagged(chat) };
      return ok({ chatTab: place.chatTab?.id ?? null, group: place.group, split: place.split, splitTabs: place.splitTabs, tabs: summarize(tabs, place, memory) });
    }
    case "POST /ardia/send": {
      if (!chat) return bad("Needs a chat.");
      const tabs = tabList(input.tabs ?? []);
      if (!tabs) return bad("tabs must be a list of up to 20 tab ids.");
      const messageId = str(input.messageId, 100);
      if (!messageId) return bad("Needs the message's id.");
      deps.ledger.allow(chat, messageId);
      deps.state.memory.noteSent(chat);
      if (deps.state.memory.startOnce(chat)) deps.count("chats_started");
      bumpChat(chat);
      return ok(await tag(deps, chat, tabs));
    }
    case "POST /ardia/stop": {
      if (!chat) return bad("Needs a chat.");
      stopChat(deps, chat);
      return ok({ ok: true });
    }
    case "POST /ardia/open": {
      const opened = openTargetOf(input.path);
      if (typeof opened !== "string") return bad(opened.problem);
      const target = opened;
      const split = input.split === true;
      return ok(await deps.openPage(target, { split, side: typeof input.side === "string" ? input.side : undefined }));
    }
    case "POST /ardia/settings": {
      const key = str(input.key, 40);
      const value = input.value;
      if (!key || !VALUE_KEYS.has(key) || (typeof value !== "string" && typeof value !== "boolean")) return bad("Bad setting.");
      await deps.setValue(key, value);
      bumpChat(null);
      return ok({ ok: true });
    }
    case "POST /ardia/login": {
      const provider = input.provider;
      if (provider !== "claude") return bad("The assistant runs on Claude: provider must be claude.");
      await deps.startLogin(provider);
      deps.count("signin_started");
      return ok({ started: true });
    }
  }
  return bad("Not found.", 404);
}
