import { home } from "./paths.ts";
import { scrub } from "./scrub.ts";

export const PATH_PLACEHOLDER = "/<path>";
const WHOLE_URL = /\b([a-zA-Z][a-zA-Z0-9+.-]{1,15}:\/\/)([^\s/?#<>"'`@]*@)?([^\s/?#<>"'`]*)([^\s<>"'`]*)/g;
const BARE_URL = /(?<![\w@/.:-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24})([/?][^\s<>"'`]+)/gi;
const HOME_NAME = /^[A-Za-z0-9._-]{3,64}$/;
const CATEGORIES: readonly (readonly [string, RegExp])[] = [
  ["secrets", /<(?:redacted|secret)>/g],
  ["emails", /<email>/g],
  ["card numbers", /<number>/g],
  ["home folder names", /[/~]<user>/g],
];
export const URL_CATEGORY = "URL logins, paths and queries";
export const CATEGORY_ORDER: readonly string[] = [...CATEGORIES.map(([name]) => name), URL_CATEGORY];

export type Removed = Map<string, number>;

export function emptyRemoved(): Removed {
  return new Map(CATEGORY_ORDER.map((name) => [name, 0]));
}

export function addRemoved(into: Removed, more: Removed): void {
  for (const [name, count] of more) into.set(name, (into.get(name) ?? 0) + count);
}

function occurrences(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

export function hostOnlyUrls(text: string): [string, number] {
  let cut = 0;
  const out = text.replace(WHOLE_URL, (whole, scheme: string, login: string | undefined, host: string, rest: string) => {
    const keepsRest = rest === "" || rest === "/" || rest === PATH_PLACEHOLDER;
    if (login === undefined && keepsRest) return whole;
    cut += 1;
    return `${scheme}${host}${keepsRest ? rest : PATH_PLACEHOLDER}`;
  });
  return [out, cut];
}

export function bareUrlPaths(text: string): [string, number] {
  let cut = 0;
  const out = text.replace(BARE_URL, (_whole, host: string) => {
    cut += 1;
    return `${host}${PATH_PLACEHOLDER}`;
  });
  return [out, cut];
}

function homeName(): string | undefined {
  const mine = home().replace(/\/+$/, "");
  const name = mine.slice(mine.lastIndexOf("/") + 1);
  return HOME_NAME.test(name) ? name : undefined;
}

export function homeNameSegments(text: string, name: string | undefined = homeName()): string {
  if (name === undefined) return text;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`(?<=[/~])${escaped}(?=[/\\s"'\`:,;)\\]]|$)`, "gm"), "<user>");
}

export function triageScrub(text: string): { text: string; removed: Removed } {
  const [hosted, urls] = hostOnlyUrls(text);
  const [pathless, bareUrls] = bareUrlPaths(hosted);
  const scrubbed = homeNameSegments(scrub(pathless));
  const removed = emptyRemoved();
  for (const [name, pattern] of CATEGORIES) removed.set(name, Math.max(0, occurrences(scrubbed, pattern) - occurrences(text, pattern)));
  removed.set(URL_CATEGORY, urls + bareUrls);
  return { text: scrubbed, removed };
}

export function removedLines(removed: Removed): string[] {
  const lines = CATEGORY_ORDER.filter((name) => (removed.get(name) ?? 0) > 0).map((name) => `  ${name}: ${removed.get(name)}`);
  return lines.length > 0 ? lines : ["  nothing"];
}
