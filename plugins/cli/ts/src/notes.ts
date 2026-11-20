import { domainToASCII } from "node:url";
import { isSpace, strip } from "./py.ts";
import { isAscii } from "./pylib/unicode.ts";
import { hostnameOf, portOf, urlsplit } from "./pylib/urllib.ts";
import { reprText } from "./pylib/str.ts";
import { BrowseError, Usage } from "./browse/daemon-errors.ts";

export const ACTIONS = ["get", "set", "append", "list", "rm"];
const LABEL = "[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?";
export const HOST = new RegExp(`^(?:${LABEL}(?:\\.${LABEL})*|\\[[0-9a-f:.]+\\])(?::[0-9]{1,5})?$`, "u");
export const DEFAULT_PORTS: Readonly<Record<string, number>> = { http: 80, https: 443 };
export const USAGE = "Usage: ardia notes [get|set|append|list|rm] [SITE] [TEXT|-]";

export type NotesRequest = { action: string; site: string | null; text: string | null };

function badSite(value: string, why = "isn't a host or host:port"): BrowseError {
  return new BrowseError(`${reprText(value)} ${why}`, null, "bad_site");
}

export function siteOf(value: string): string {
  const raw = strip(value, isSpace);
  let host: string;
  let port: number | null;
  if (raw.includes("://")) {
    try {
      const parts = urlsplit(raw);
      host = hostnameOf(parts.netloc) ?? "";
      port = portOf(parts.netloc);
      if (Object.hasOwn(DEFAULT_PORTS, parts.scheme) && port === DEFAULT_PORTS[parts.scheme]) port = null;
    } catch (error) {
      if (error instanceof BrowseError) throw error;
      throw badSite(value, "isn't a URL or host[:port]");
    }
  } else {
    const head = raw.split("/")[0] as string;
    const match = /^(\[[^\]]*\]|[^:]*)(?::([0-9]{1,5}))?$/u.exec(head);
    if (!match) throw badSite(value);
    host = (match[1] as string).replace(/^[[\]]+|[[\]]+$/gu, "");
    port = match[2] ? Number(match[2]) : null;
  }
  host = host.toLowerCase().replace(/\.+$/u, "");
  if (!isAscii(host)) {
    const encoded = domainToASCII(host);
    if (!encoded) throw badSite(value, "has a host name that can't be encoded");
    host = encoded;
  }
  if (host.includes(":")) host = `[${host}]`;
  const site = host + (port !== null ? `:${port}` : "");
  if (!host || !HOST.test(site) || (port !== null && !(port > 0 && port < 65536))) throw badSite(value);
  return site;
}

export function pageSite(url: string | null | undefined): string | null {
  if (!url || !/^https?:\/\//iu.test(url)) return null;
  try {
    return siteOf(url);
  } catch {
    return null;
  }
}

export function looksLikeSite(value: string): boolean {
  if (!value.includes("://") && !/[.:]|^localhost$/u.test(value.split("/")[0] as string)) return false;
  if ([...value].some((char) => isSpace(char))) return false;
  try {
    siteOf(value);
  } catch {
    return false;
  }
  return true;
}

export function parseArgs(args: readonly string[]): NotesRequest {
  const positional = args.filter((arg) => arg !== "--json");
  if (positional.some((arg) => arg.startsWith("--"))) throw new Usage(USAGE);
  const action = positional.length > 0 && ACTIONS.includes(positional[0] as string) ? (positional.shift() as string) : "get";
  if (action === "list") {
    if (positional.length > 0) throw new Usage("Usage: ardia notes list");
    return { action, site: null, text: null };
  }
  if (action === "get" || action === "rm") {
    if (positional.length > 1) throw new Usage(`Usage: ardia notes ${action} [SITE]`);
    return { action, site: positional.length > 0 ? siteOf(positional[0] as string) : null, text: null };
  }
  if (positional.length === 0) throw new Usage(`Usage: ardia notes ${action} [SITE] TEXT|-  (- reads stdin)`);
  if (positional.length >= 2 && looksLikeSite(positional[0] as string)) {
    return { action, site: siteOf(positional[0] as string), text: positional.slice(1).join(" ") };
  }
  return { action, site: null, text: positional.join(" ") };
}
