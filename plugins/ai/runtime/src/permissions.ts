// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off extendsNativeError:off effectFnOpportunity:off globalFetch:off
export type ToolKind = "list" | "read" | "act" | "open" | "close" | "activate" | "group";

export type TabFacts = {
  tabId: string;
  origin: string | null;
  private: boolean;
  internal: boolean;
  isChat: boolean;
  inChatGroup: boolean;
  inChatSplit: boolean;
  openedByAgent: boolean;
  tagged: boolean;
};

export type Grant = { origin: string; kind: "read" | "act" };

export type Decision =
  | { outcome: "allow"; step: string }
  | { outcome: "ask"; grantKind: "read" | "act" | null; origin: string | null; reason: string }
  | { outcome: "refuse"; reason: string };

export const ANSWERS = ["allow", "always", "deny"] as const;
export type Answer = (typeof ANSWERS)[number];

const STEP: Record<ToolKind, string> = {
  list: "Looked at your open tabs",
  read: "Read",
  act: "Used",
  open: "Opened",
  close: "Closed",
  activate: "Switched to",
  group: "Added to this chat's group",
};

export function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function isOpenableUrl(url: string): boolean {
  return originOf(url) !== null;
}

const granted = (grants: readonly Grant[], origin: string | null, kind: Grant["kind"]) =>
  origin !== null && grants.some((g) => g.origin === origin && (g.kind === kind || (kind === "read" && g.kind === "act")));

const inChatsOwnSpace = (tab: TabFacts) => tab.inChatGroup || tab.inChatSplit || tab.tagged;

export function decide(kind: ToolKind, tab: TabFacts | null, grants: readonly Grant[]): Decision {
  if (kind === "list") return { outcome: "allow", step: STEP.list };
  if (!tab) return { outcome: "refuse", reason: "That tab isn't open, or it's in a private window." };
  if (tab.private) return { outcome: "refuse", reason: "Tabs in private windows are never available to the assistant." };
  if (tab.isChat) return { outcome: "refuse", reason: "That tab is a chat, not a page." };
  if (tab.internal && kind !== "activate" && kind !== "group" && kind !== "close") return { outcome: "refuse", reason: "Ardia's own pages can't be read or used." };
  switch (kind) {
    case "read":
      if (inChatsOwnSpace(tab) || tab.openedByAgent || granted(grants, tab.origin, "read")) return { outcome: "allow", step: STEP.read };
      return { outcome: "ask", grantKind: "read", origin: tab.origin, reason: "read" };
    case "act":
      if (granted(grants, tab.origin, "act")) return { outcome: "allow", step: STEP.act };
      return { outcome: "ask", grantKind: "act", origin: tab.origin, reason: "act" };
    case "activate":
      return { outcome: "allow", step: STEP.activate };
    case "close":
    case "group":
      if (tab.openedByAgent || inChatsOwnSpace(tab)) return { outcome: "allow", step: STEP[kind] };
      return { outcome: "ask", grantKind: null, origin: tab.origin, reason: kind };
    case "open":
      return { outcome: "allow", step: STEP.open };
  }
}

export function decideOpen(url: string, chatHasReadPages: boolean): Decision {
  if (!isOpenableUrl(url)) return { outcome: "refuse", reason: "The assistant can only open http and https addresses." };
  if (chatHasReadPages) return { outcome: "ask", grantKind: null, origin: originOf(url), reason: "open" };
  return { outcome: "allow", step: STEP.open };
}

export function grantFor(answer: Answer, decision: Decision): Grant | null {
  if (answer !== "always" || decision.outcome !== "ask" || !decision.origin || !decision.grantKind) return null;
  return { origin: decision.origin, kind: decision.grantKind };
}

export function addGrant(grants: readonly Grant[], grant: Grant | null): Grant[] {
  if (!grant || grants.some((g) => g.origin === grant.origin && g.kind === grant.kind)) return [...grants];
  return [...grants, grant];
}

export function parseGrants(value: unknown): Grant[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (g): g is Grant =>
      !!g && typeof g === "object" && typeof (g as Grant).origin === "string" && originOf((g as Grant).origin) === (g as Grant).origin && ((g as Grant).kind === "read" || (g as Grant).kind === "act"),
  );
}
