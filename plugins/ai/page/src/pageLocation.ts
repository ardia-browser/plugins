import { useEffect, useState } from "react";
import type { ContextTab } from "./Composer";
import { pageHref, pageLocation } from "./pagePath.ts";

export { pageHref, pageLocation, type PageLocation } from "./pagePath.ts";

type ArdiaPage = EventTarget & { context?: unknown };

const ardiaPage = (): ArdiaPage | null => ((globalThis as { ardia?: ArdiaPage }).ardia ?? null);

export const isStaticPage = () => !!ardiaPage();

export const currentPageLocation = () => pageLocation(location.href, !!ardiaPage());

export function replacePagePath(path: string) {
  history.replaceState(history.state, "", pageHref(location.href, path, !!ardiaPage()));
}

export function contextTabOf(context: unknown): ContextTab | null {
  const parsed = typeof context === "string" ? safeParse(context) : context;
  if (!parsed || typeof parsed !== "object") return null;
  const { tabId, title } = parsed as { tabId?: unknown; title?: unknown };
  return typeof tabId === "string" ? { id: tabId, title: typeof title === "string" && title ? title : "This tab" } : null;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function useContextTab(): ContextTab | null {
  const page = ardiaPage();
  const read = () => (page ? contextTabOf(page.context) : contextTabOf(new URLSearchParams(location.search).get("ardiaContext")));
  const [tab, setTab] = useState(read);
  useEffect(() => {
    if (!page) return;
    const update = () => setTab(contextTabOf(page.context));
    page.addEventListener("context", update);
    return () => page.removeEventListener("context", update);
  }, [page]);
  return tab;
}
