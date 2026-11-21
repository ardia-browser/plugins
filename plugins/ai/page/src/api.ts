import type { Ask } from "../../runtime/src/asks.ts";
import type { PluginValues as Values } from "../../runtime/src/host.ts";
import type { TabSummary } from "../../runtime/src/tabs.ts";

export type { Ask, TabSummary, Values };
export type ChatEvents = { version: number; asks: Ask[]; stopped: boolean; values: Values };
export type ChatTabs = { chatTab: string | null; group: string | null; split: string | null; splitTabs: string[]; tabs: TabSummary[] };

export type ApiRequest = (method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal) => Promise<unknown>;

export function fetchRequest(bearer: string): ApiRequest {
  return async (method, path, body, signal) => {
    const init: RequestInit = { method, headers: body === undefined ? { authorization: `Bearer ${bearer}` } : { authorization: `Bearer ${bearer}`, "content-type": "application/json" } };
    if (body !== undefined) init.body = JSON.stringify(body);
    if (signal) init.signal = signal;
    const response = await fetch(path, init);
    const json = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) throw new Error(json.error ?? `The assistant answered ${response.status}.`);
    return json;
  };
}

export class ArdiaApi {
  private readonly transport: ApiRequest;

  constructor(transport: ApiRequest) {
    this.transport = transport;
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const result = await this.transport(method, path, body, signal);
    if (signal?.aborted) throw new Error("aborted");
    return result as T;
  }

  info() {
    return this.request<{ appVersion: string; values: Values; workspaceRoot: string }>("GET", "/ardia/info");
  }

  tabs(chat: string) {
    return this.request<ChatTabs>("GET", `/ardia/tabs?chat=${encodeURIComponent(chat)}`);
  }

  send(chat: string, tabs: string[], messageId: string) {
    return this.request<{ group: string | null }>("POST", "/ardia/send", { chat, tabs, messageId });
  }

  stop(chat: string) {
    return this.request<{ ok: true }>("POST", "/ardia/stop", { chat });
  }

  answer(chat: string, id: string, answer: "allow" | "always" | "deny") {
    return this.request<{ ok: true }>("POST", "/ardia/asks/answer", { chat, id, answer });
  }

  open(path: string, split = false) {
    return this.request<{ tabId: string }>("POST", "/ardia/open", { path, split });
  }

  setValue(key: string, value: string | boolean) {
    return this.request<{ ok: true }>("POST", "/ardia/settings", { key, value });
  }

  login(provider: "claude") {
    return this.request<{ started: true }>("POST", "/ardia/login", { provider });
  }

  watch(chat: string, onChange: (events: ChatEvents) => void, onError: (error: unknown) => void): () => void {
    const controller = new AbortController();
    let since = -1;
    const loop = async () => {
      while (!controller.signal.aborted) {
        try {
          const events = await this.request<ChatEvents>("GET", `/ardia/events?chat=${encodeURIComponent(chat)}&since=${since}`, undefined, controller.signal);
          since = events.version;
          onChange(events);
        } catch (error) {
          if (controller.signal.aborted) return;
          onError(error);
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    };
    void loop();
    return () => controller.abort();
  }
}
