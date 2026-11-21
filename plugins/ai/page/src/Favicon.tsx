import { useState } from "react";
import type { TabSummary } from "./api";

function hostOf(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function Favicon({ src, url, title }: { src?: string | null | undefined; url?: string | null | undefined; title?: string | undefined }) {
  const [broken, setBroken] = useState(false);
  if (src && !broken)
    return (
      <span className="fav bare">
        <img src={src} alt="" onError={() => setBroken(true)} />
      </span>
    );
  const letter = (hostOf(url) || title || "?").slice(0, 1).toUpperCase();
  return <span className="fav">{letter}</span>;
}

export type TabIndex = { byId: Map<string, TabSummary>; byUrl: Map<string, TabSummary> };

export function indexTabs(tabs: readonly TabSummary[]): TabIndex {
  const byId = new Map<string, TabSummary>();
  const byUrl = new Map<string, TabSummary>();
  for (const t of tabs) {
    byId.set(t.id, t);
    byUrl.set(t.url.split("#")[0]!, t);
  }
  return { byId, byUrl };
}

export function TabChip({ tab, url, title }: { tab?: TabSummary | null | undefined; url?: string | undefined; title: string }) {
  return (
    <span className="cite" title={tab?.url ?? url}>
      <Favicon src={tab?.favicon} url={tab?.url ?? url} title={title} />
      <span>{title}</span>
    </span>
  );
}
