import { pageHref, pageLocation } from "./pagePath.ts";

export class OpeningPrompts {
  private readonly offered = new Map<string, string>();
  private readonly consumed = new Set<string>();

  offer(chatId: string, text: string | null) {
    if (text && !this.consumed.has(chatId)) this.offered.set(chatId, text);
  }

  peek(chatId: string): string | null {
    return this.offered.get(chatId) ?? null;
  }

  take(chatId: string): string | null {
    const text = this.offered.get(chatId);
    if (text === undefined) return null;
    this.offered.delete(chatId);
    this.consumed.add(chatId);
    return text;
  }
}

export const openingPrompts = new OpeningPrompts();

const CHAT_ID = /^[A-Za-z0-9-]{8,64}$/;

export function resolveOpening(href: string, staticPage: boolean, newChatId: () => string, prompts: OpeningPrompts): string | null {
  const here = pageLocation(href, staticPage);
  const path = here.path.replace(/^\/+|\/+$/g, "");
  const prompt = new URLSearchParams(here.search).get("q");
  if (staticPage && (path === "" || path === "new")) {
    const chatId = newChatId();
    prompts.offer(chatId, prompt);
    return pageHref(href, `/${chatId}`, true);
  }
  if (CHAT_ID.test(path) && path !== "history" && path !== "welcome" && prompt !== null) {
    prompts.offer(path, prompt);
    return pageHref(href, `/${path}`, staticPage);
  }
  return null;
}
