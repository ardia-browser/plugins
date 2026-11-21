// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off extendsNativeError:off effectFnOpportunity:off globalFetch:off
import type { BrowseResult, HostApi } from "./browserTools.ts";
import type { Channel } from "./channel.ts";
import type { Workspace } from "./tabs.ts";

type ApplyReply = { ok: boolean; results?: Array<{ tabs?: string[]; group?: string }>; error?: { message?: string } };

export function channelHost(channel: Channel): HostApi {
  const apply = async (ops: unknown[], signal?: AbortSignal) => {
    const reply = await channel.request<ApplyReply>("apply", { ops }, 60_000, signal);
    if (!reply.ok) throw new Error(reply.error?.message ?? "Ardia couldn't change the tabs.");
    return reply;
  };
  return {
    workspace: () => channel.request<Workspace>("workspace", {}),
    browse: (tab, argv, signal) => channel.request<BrowseResult>("browse", { tab, argv }, 90_000, signal),
    openTab: async (url, activate, signal) => {
      const reply = await channel.request<{ ok: boolean; tabs?: string[] }>("open", { urls: [url], ...(activate ? { activate: true } : {}) }, 60_000, signal);
      const tabId = reply.tabs?.[0];
      if (!reply.ok || !tabId) throw new Error("Ardia didn't say which tab it opened.");
      return { tabId };
    },
    closeTab: async (tabId, signal) => void (await apply([{ op: "tab.close", tabs: [tabId] }], signal)),
    activateTab: async (tabId, signal) => void (await apply([{ op: "tab.activate", tab: tabId }], signal)),
    groupWithChat: (chatTabId, tabIds, signal) => channel.request<{ group: string }>("group.withPage", { tab: chatTabId, tabs: tabIds }, undefined, signal),
    splitToGroup: (chatTabId, signal) => channel.request<{ group: string }>("split.toGroup", { tab: chatTabId }, undefined, signal),
    banner: async (tabId, text) => void (await channel.request("tab.banner", { tab: tabId, text })),
  };
}
