// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off extendsNativeError:off effectFnOpportunity:off globalFetch:off
import { originOf, type TabFacts } from "./permissions.ts";

export const CHAT_URL = /^ardia:\/\/ai\/([A-Za-z0-9-]{8,64})(?:[/?#]|$)/;

export type WorkspaceTab = {
  type: "tab";
  id: string;
  url: string;
  title: string;
  customTitle?: string | null;
  favicon?: string | null;
  group: string | null;
  split: string | null;
  active?: boolean;
  pinned?: boolean;
  private?: boolean;
};

export type WorkspaceGroup = { type: "group"; id: string; name?: string; label?: string; parent?: string | null; items: WorkspaceNode[] };
export type WorkspaceNode = WorkspaceTab | WorkspaceGroup | { type: "folder"; id: string; items: WorkspaceNode[] };

export type WorkspaceSpace = { profile: string; shown?: boolean; topApps?: WorkspaceNode[]; pinned?: WorkspaceNode[]; tabs?: WorkspaceNode[] };
export type WorkspaceWindow = { id: string; kind?: string; focused?: boolean; profile?: string; activeTab?: string | null; spaces?: WorkspaceSpace[] };
export type Workspace = { windows: WorkspaceWindow[] };

export type FlatTab = WorkspaceTab & { windowId: string; groups: string[] };

function walk(nodes: readonly WorkspaceNode[] | undefined, windowId: string, groups: string[], out: FlatTab[]) {
  for (const node of nodes ?? []) {
    if (node.type === "tab") out.push({ ...node, windowId, groups });
    else if (node.type === "group") walk(node.items, windowId, [...groups, node.id], out);
    else walk(node.items, windowId, groups, out);
  }
}

export function flattenWorkspace(workspace: Workspace): FlatTab[] {
  const out: FlatTab[] = [];
  for (const window of workspace.windows ?? []) {
    for (const space of window.spaces ?? []) {
      walk(space.topApps, window.id, [], out);
      walk(space.pinned, window.id, [], out);
      walk(space.tabs, window.id, [], out);
    }
  }
  return out;
}

export function chatIdOf(url: string | null | undefined): string | null {
  return (url && CHAT_URL.exec(url)?.[1]) || null;
}

export type ChatPlace = { chatTab: FlatTab | null; group: string | null; split: string | null; splitTabs: string[]; groupTabs: string[] };

export function placeOfChat(tabs: readonly FlatTab[], chatId: string): ChatPlace {
  const chatTabs = tabs.filter((t) => chatIdOf(t.url) === chatId);
  const chatTab = chatTabs.find((t) => t.active) ?? chatTabs[0] ?? null;
  if (!chatTab) return { chatTab: null, group: null, split: null, splitTabs: [], groupTabs: [] };
  const group = chatTab.group;
  const split = chatTab.split;
  return {
    chatTab,
    group,
    split,
    splitTabs: split ? tabs.filter((t) => t.split === split && t.id !== chatTab.id).map((t) => t.id) : [],
    groupTabs: group ? tabs.filter((t) => t.groups.includes(group) && t.id !== chatTab.id).map((t) => t.id) : [],
  };
}

export type ChatMemory = { opened: ReadonlyMap<string, string | null>; tagged: ReadonlySet<string> };

export function factsFor(tab: FlatTab | undefined, place: ChatPlace, memory: ChatMemory): TabFacts | null {
  if (!tab) return null;
  const isChat = chatIdOf(tab.url) !== null;
  const origin = originOf(tab.url);
  return {
    tabId: tab.id,
    origin,
    private: tab.private === true,
    internal: !isChat && origin === null,
    isChat,
    inChatGroup: !!place.group && tab.groups.includes(place.group),
    inChatSplit: !!place.split && tab.split === place.split,
    openedByAgent: memory.opened.has(tab.id) && memory.opened.get(tab.id) === origin,
    tagged: memory.tagged.has(tab.id),
  };
}

export type TabSummary = { id: string; title: string; url: string; favicon: string | null; window: string; active: boolean; inChatGroup: boolean; inChatSplit: boolean; tagged: boolean; openedByYou: boolean };

export function summarize(tabs: readonly FlatTab[], place: ChatPlace, memory: ChatMemory): TabSummary[] {
  return tabs
    .filter((t) => chatIdOf(t.url) === null)
    .map((t) => ({
      id: t.id,
      title: t.customTitle || t.title,
      url: t.url,
      favicon: typeof t.favicon === "string" && /^(https?:|data:image\/)/.test(t.favicon) ? t.favicon : null,
      window: t.windowId,
      active: !!t.active,
      inChatGroup: !!place.group && t.groups.includes(place.group),
      inChatSplit: !!place.split && t.split === place.split,
      tagged: memory.tagged.has(t.id),
      openedByYou: memory.opened.has(t.id),
    }));
}
