import { hostnameOf, portOf, urlsplit } from "../../pylib/urllib.ts";
import { BrowseError } from "../daemon-errors.ts";

export const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function originOf(url: string): string {
  const parts = urlsplit(url);
  const host = (hostnameOf(parts.netloc) ?? "").toLowerCase();
  if (parts.scheme === "https" || (parts.scheme === "http" && LOOPBACK_HOSTS.has(host))) {
    const port = portOf(parts.netloc);
    return `${parts.scheme}://${host}${port ? `:${port}` : ""}`;
  }
  throw new BrowseError(`A credential is bound to https origins (http only for localhost); ${url} isn't one`);
}
