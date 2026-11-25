export type TurnItem = {
  id: string;
  type: string;
  ordinal: number;
  status?: string;
  text?: string;
  streaming?: boolean;
  toolName?: string | null;
  input?: unknown;
  output?: unknown;
  failure?: { class?: string; code?: string; message?: string; resetAt?: unknown };
  message?: string;
  level?: string;
  patterns?: readonly string[];
  title?: string | null;
};

export type Run = { id: string; status: string; ordinal: number };

export type Chat = {
  threadId: string;
  title: string;
  items: Record<string, TurnItem>;
  runs: Record<string, Run>;
  synced: boolean;
};

export type StreamItem =
  | { kind: "snapshot"; projection: { thread?: { title?: string }; turnItems?: readonly TurnItem[]; runs?: readonly Run[] } }
  | { kind: "event"; event: { type: string; payload?: unknown } }
  | { kind: "synchronized" }
  | { kind: string };

export const emptyChat = (threadId: string): Chat => ({ threadId, title: "", items: {}, runs: {}, synced: false });

const ACTIVE_RUN = new Set(["preparing", "queued", "starting", "running", "waiting"]);

export function applyStream(chat: Chat, item: StreamItem): Chat {
  if (item.kind === "synchronized") return chat.synced ? chat : { ...chat, synced: true };
  if (item.kind === "snapshot" && "projection" in item) {
    const p = item.projection;
    const items: Record<string, TurnItem> = {};
    for (const t of p.turnItems ?? []) items[t.id] = t;
    const runs: Record<string, Run> = {};
    for (const r of p.runs ?? []) runs[r.id] = r;
    return { ...chat, title: p.thread?.title ?? chat.title, items, runs };
  }
  if (item.kind === "event" && "event" in item) {
    const { type, payload } = item.event;
    if (type === "turn-item.updated" && payload && typeof payload === "object" && "id" in payload) {
      const t = payload as TurnItem;
      return { ...chat, items: { ...chat.items, [t.id]: t } };
    }
    if ((type === "run.created" || type === "run.updated") && payload && typeof payload === "object" && "id" in payload) {
      const r = payload as Run;
      return { ...chat, runs: { ...chat.runs, [r.id]: r } };
    }
    if (type === "thread.created" || type === "thread.updated" || type === "thread.meta-updated") {
      const title = (payload as { title?: unknown } | undefined)?.title;
      if (typeof title === "string" && title) return { ...chat, title };
    }
  }
  return chat;
}

export function toolNameOf(item: TurnItem): string | null {
  const raw = item.toolName ?? null;
  if (!raw) return null;
  const at = raw.lastIndexOf("__");
  return at >= 0 ? raw.slice(at + 2) : raw;
}

export type Step = { kind: "step"; id: string; tool: string; label: string; status: "running" | "done" | "failed" | "refused"; tabId: string | null; url: string | null };
export type Entry =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; streaming: boolean }
  | { kind: "steps"; id: string; steps: Step[] }
  | { kind: "error"; id: string; failureClass: string; message: string }
  | { kind: "notice"; id: string; message: string };

const STEP_VERBS: Record<string, [string, string]> = {
  ardia_chat_context: ["Looking at this chat's tabs", "Looked at this chat's tabs"],
  ardia_list_tabs: ["Looking at your open tabs", "Looked at your open tabs"],
  ardia_read_tab: ["Reading", "Read"],
  ardia_click: ["Clicking on", "Clicked on"],
  ardia_type: ["Typing on", "Typed on"],
  ardia_open_tab: ["Opening", "Opened"],
  ardia_close_tab: ["Closing", "Closed"],
  ardia_activate_tab: ["Switching to", "Switched to"],
  ardia_add_to_chat_group: ["Adding to this chat's group", "Added to this chat's group"],
  ardia_split_to_group: ["Turning the split into a group", "Turned the split into a group"],
  send_to_user: ["Writing", "Wrote"],
  WebSearch: ["Searching the web", "Searched the web"],
  WebFetch: ["Fetching a page", "Fetched a page"],
};

function parsed(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    if (Array.isArray(v.content)) {
      const text = (v.content as Array<{ type?: string; text?: string }>).find((c) => c.type === "text")?.text;
      if (text) return parsed(text);
    }
    if (v.structuredContent && typeof v.structuredContent === "object") return v.structuredContent as Record<string, unknown>;
    return v;
  }
  if (typeof value === "string") {
    try {
      return parsed(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return null;
}

function hostOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function stepObject(item: TurnItem, input: Record<string, unknown> | null, output: Record<string, unknown> | null): string {
  const title = output?.title;
  if (typeof title === "string" && title) return title;
  const host = hostOf(input?.url) ?? hostOf(output?.url);
  if (host) return host;
  if (typeof input?.tab === "string") return "a tab";
  if (Array.isArray(input?.tabs)) return `${(input.tabs as unknown[]).length} tab${(input.tabs as unknown[]).length === 1 ? "" : "s"}`;
  return item.title ?? "";
}

export function stepOf(item: TurnItem): Step | null {
  const tool = item.type === "dynamic_tool" ? toolNameOf(item) : item.type === "web_search" ? "WebSearch" : null;
  if (!tool) return null;
  const verbs = STEP_VERBS[tool] ?? ["Using a tool", "Used a tool"];
  const failed = item.status === "failed" || item.status === "declined";
  const done = item.status === "completed" || failed;
  const input = parsed(item.input);
  const output = parsed(item.output);
  const refused = /capability_denied|said no|never available|can't be read|stopped you/i.test(JSON.stringify(item.output ?? ""));
  const object = tool.startsWith("ardia_") && !["ardia_chat_context", "ardia_list_tabs", "ardia_split_to_group", "ardia_add_to_chat_group"].includes(tool) ? stepObject(item, input, output) : "";
  const verb = done ? verbs[1] : verbs[0];
  const tabId = typeof input?.tab === "string" ? input.tab : typeof output?.tab === "string" ? output.tab : null;
  const url = typeof output?.url === "string" ? output.url : typeof input?.url === "string" ? input.url : null;
  return { kind: "step", id: item.id, tool, label: object ? `${verb} ${object}` : verb, status: refused ? "refused" : failed ? "failed" : done ? "done" : "running", tabId, url };
}

const sortItems = (chat: Chat) => Object.values(chat.items).sort((a, b) => a.ordinal - b.ordinal);

export function entriesOf(chat: Chat): Entry[] {
  const out: Entry[] = [];
  for (const item of sortItems(chat)) {
    if (item.type === "user_message") out.push({ kind: "user", id: item.id, text: item.text ?? "" });
    else if (item.type === "assistant_message") {
      if ((item.text ?? "").trim() || item.streaming) out.push({ kind: "assistant", id: item.id, text: item.text ?? "", streaming: !!item.streaming });
    } else if (item.type === "error") out.push({ kind: "error", id: item.id, failureClass: item.failure?.class ?? "unknown", message: item.failure?.message ?? "Something went wrong." });
    else if (item.type === "system_notice" && item.level !== "debug") out.push({ kind: "notice", id: item.id, message: item.message ?? "" });
    else {
      const step = stepOf(item);
      if (!step) continue;
      const last = out[out.length - 1];
      if (last?.kind === "steps") last.steps.push(step);
      else out.push({ kind: "steps", id: `steps-${item.id}`, steps: [step] });
    }
  }
  return out;
}

export const isWorking = (chat: Chat) => Object.values(chat.runs).some((r) => ACTIVE_RUN.has(r.status));

export function activeRun(chat: Chat): Run | null {
  return Object.values(chat.runs).filter((r) => ACTIVE_RUN.has(r.status)).sort((a, b) => b.ordinal - a.ordinal)[0] ?? null;
}

export type ProviderAuth = "authenticated" | "unauthenticated" | "unknown";

export type Screen = "connecting" | "runtime-stopped" | "not-signed-in" | "empty" | "working" | "asking" | "answered" | "limit-reached";

export function screenOf(input: { connected: boolean | null; providerAuth: ProviderAuth | null; chat: Chat | null; asks: number }): Screen {
  if (input.connected === false) return "runtime-stopped";
  if (input.connected === null || input.providerAuth === null) return "connecting";
  const entries = input.chat ? entriesOf(input.chat) : [];
  if (input.providerAuth === "unauthenticated" && !(input.chat && isWorking(input.chat))) return "not-signed-in";
  if (input.asks > 0) return "asking";
  if (input.chat && isWorking(input.chat)) return "working";
  const last = entries[entries.length - 1];
  if (last?.kind === "error" && last.failureClass === "usage_limit") return "limit-reached";
  return entries.some((e) => e.kind === "user") ? "answered" : "empty";
}
