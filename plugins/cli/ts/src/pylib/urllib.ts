import { utf8 } from "../pystr.ts";
import { isIPv4Address, isIPv6Address } from "./ipaddress.ts";
import { PyException, reprText } from "./str.ts";

const UTF8 = new TextDecoder("utf-8", { ignoreBOM: true });

function alwaysSafe(byte: number): boolean {
  return (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || byte === 0x5f || byte === 0x2e || byte === 0x2d || byte === 0x7e;
}

export function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit < 0xdc00) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next < 0xe000) index += 1;
      else return true;
    } else if (unit >= 0xdc00 && unit < 0xe000) return true;
  }
  return false;
}

export function encodeUtf8Strict(text: string): Buffer {
  if (hasLoneSurrogate(text)) throw new PyException("UnicodeEncodeError", "'utf-8' codec can't encode character: surrogates not allowed");
  return utf8(text);
}

const HEX = "0123456789ABCDEF";

export function quote(text: string, safe = "/"): string {
  if (text === "") return text;
  const bytes = encodeUtf8Strict(text);
  const extra = new Set<number>();
  for (let index = 0; index < safe.length; index += 1) {
    const unit = safe.charCodeAt(index);
    if (unit < 0x80) extra.add(unit);
  }
  let out = "";
  for (const byte of bytes) {
    out += alwaysSafe(byte) || extra.has(byte) ? String.fromCharCode(byte) : `%${HEX[byte >> 4]}${HEX[byte & 15]}`;
  }
  return out;
}

export function quotePlus(text: string, safe = ""): string {
  if (!text.includes(" ")) return quote(text, safe);
  return quote(text, `${safe} `).replaceAll(" ", "+");
}

function hexValue(unit: number): number {
  if (unit >= 0x30 && unit <= 0x39) return unit - 0x30;
  if (unit >= 0x41 && unit <= 0x46) return unit - 0x37;
  if (unit >= 0x61 && unit <= 0x66) return unit - 0x57;
  return -1;
}

function unquoteAscii(run: string): string {
  if (!run.includes("%")) return run;
  const bytes: number[] = [];
  for (let index = 0; index < run.length; index += 1) {
    const unit = run.charCodeAt(index);
    if (unit === 0x25) {
      const high = hexValue(run.charCodeAt(index + 1));
      const low = hexValue(run.charCodeAt(index + 2));
      if (high >= 0 && low >= 0) {
        bytes.push(high * 16 + low);
        index += 2;
        continue;
      }
    }
    bytes.push(unit);
  }
  return UTF8.decode(Uint8Array.from(bytes));
}

export function unquote(text: string): string {
  if (!text.includes("%")) return text;
  let out = "";
  let start = 0;
  while (start < text.length) {
    let end = start;
    const ascii = text.charCodeAt(start) < 0x80;
    while (end < text.length && text.charCodeAt(end) < 0x80 === ascii) end += 1;
    const run = text.slice(start, end);
    out += ascii ? unquoteAscii(run) : run;
    start = end;
  }
  return out;
}

export function unquotePlus(text: string): string {
  return unquote(text.replaceAll("+", " "));
}

export type SplitResult = { scheme: string; netloc: string; path: string; query: string; fragment: string };

const SCHEME_CHARS = /^[A-Za-z0-9+\-.]*$/;
const IPV_FUTURE = /^[vV][a-fA-F0-9]+\.[^\n]+$/;

function partition(text: string, separator: string): [string, string, string] {
  const at = text.indexOf(separator);
  return at < 0 ? [text, "", ""] : [text.slice(0, at), separator, text.slice(at + separator.length)];
}

function invalid(message: string): PyException {
  return new PyException("ValueError", message);
}

function checkBracketedHost(hostname: string): void {
  if (hostname.startsWith("v") || hostname.startsWith("V")) {
    if (!IPV_FUTURE.test(hostname)) throw invalid("IPvFuture address is invalid");
    return;
  }
  if (isIPv4Address(hostname)) throw invalid("An IPv4 address cannot be in brackets");
  if (!isIPv6Address(hostname)) throw invalid(`${reprText(hostname)} does not appear to be an IPv4 or IPv6 address`);
}

function checkBracketedNetloc(netloc: string): void {
  const hostAndPort = netloc.slice(netloc.lastIndexOf("@") + 1);
  const [before, open, bracketed] = partition(hostAndPort, "[");
  let hostname: string;
  if (open) {
    if (before) throw invalid("Invalid IPv6 URL");
    const [inside, , port] = partition(bracketed, "]");
    if (port && !port.startsWith(":")) throw invalid("Invalid IPv6 URL");
    hostname = inside;
  } else hostname = partition(hostAndPort, ":")[0];
  checkBracketedHost(hostname);
}

function checkNetloc(netloc: string): void {
  if (!netloc || !/[^\x00-\x7f]/.test(netloc)) return;
  const stripped = netloc.replaceAll("@", "").replaceAll(":", "").replaceAll("#", "").replaceAll("?", "");
  const normalized = stripped.normalize("NFKC");
  if (stripped === normalized) return;
  for (const ch of "/?#@:") {
    if (normalized.includes(ch)) throw invalid(`netloc '${netloc}' contains invalid characters under NFKC normalization`);
  }
}

export function urlsplit(input: string, defaultScheme = ""): SplitResult {
  let start = 0;
  while (start < input.length && input.charCodeAt(start) <= 0x20) start += 1;
  let url = input.slice(start).replace(/[\t\r\n]/g, "");
  let from = 0;
  let to = defaultScheme.length;
  while (from < to && defaultScheme.charCodeAt(from) <= 0x20) from += 1;
  while (to > from && defaultScheme.charCodeAt(to - 1) <= 0x20) to -= 1;
  let scheme = defaultScheme.slice(from, to).replace(/[\t\r\n]/g, "");
  let netloc = "";
  let query = "";
  let fragment = "";
  const colon = url.indexOf(":");
  if (colon > 0 && /^[A-Za-z]/.test(url) && SCHEME_CHARS.test(url.slice(0, colon))) {
    scheme = url.slice(0, colon).toLowerCase();
    url = url.slice(colon + 1);
  }
  if (url.startsWith("//")) {
    let end = url.length;
    for (const delimiter of "/?#") {
      const at = url.indexOf(delimiter, 2);
      if (at >= 0) end = Math.min(end, at);
    }
    netloc = url.slice(2, end);
    url = url.slice(end);
    const open = netloc.includes("[");
    const close = netloc.includes("]");
    if (open !== close) throw invalid("Invalid IPv6 URL");
    if (open && close) checkBracketedNetloc(netloc);
  }
  const hash = url.indexOf("#");
  if (hash >= 0) {
    fragment = url.slice(hash + 1);
    url = url.slice(0, hash);
  }
  const question = url.indexOf("?");
  if (question >= 0) {
    query = url.slice(question + 1);
    url = url.slice(0, question);
  }
  checkNetloc(netloc);
  return { scheme, netloc, path: url, query, fragment };
}

export function hostInfo(netloc: string): [string, string | null] {
  const hostinfo = netloc.slice(netloc.lastIndexOf("@") + 1);
  const [, open, bracketed] = partition(hostinfo, "[");
  let hostname: string;
  let port: string;
  if (open) {
    const [inside, , rest] = partition(bracketed, "]");
    hostname = inside;
    port = partition(rest, ":")[2];
  } else {
    const [name, , after] = partition(hostinfo, ":");
    hostname = name;
    port = after;
  }
  return [hostname, port ? port : null];
}

export function hostnameOf(netloc: string): string | null {
  const [hostname] = hostInfo(netloc);
  if (!hostname) return null;
  const [name, percent, zone] = partition(hostname, "%");
  return name.toLowerCase() + percent + zone;
}

export function portOf(netloc: string): number | null {
  const [, port] = hostInfo(netloc);
  if (port === null) return null;
  if (!/^[0-9]+$/.test(port)) throw invalid(`Port could not be cast to integer value as ${reprText(port)}`);
  const value = Number(port);
  if (!(value >= 0 && value <= 65535)) throw invalid("Port out of range 0-65535");
  return value;
}

export function parseQsl(query: string, keepBlank = false): [string, string][] {
  if (!query) return [];
  const out: [string, string][] = [];
  for (const nameValue of query.split("&")) {
    if (!nameValue) continue;
    const [name, , value] = partition(nameValue, "=");
    if (value || keepBlank) out.push([unquotePlus(name), unquotePlus(value)]);
  }
  return out;
}

const USES_RELATIVE = new Set(["", "ftp", "http", "gopher", "nntp", "imap", "wais", "file", "https", "shttp", "mms", "prospero", "rtsp", "rtsps", "rtspu", "sftp", "svn", "svn+ssh", "ws", "wss"]);
const USES_NETLOC = new Set(["", "ftp", "http", "gopher", "nntp", "telnet", "imap", "wais", "file", "mms", "https", "shttp", "snews", "prospero", "rtsp", "rtsps", "rtspu", "rsync", "svn", "svn+ssh", "sftp", "nfs", "git", "git+ssh", "ws", "wss", "itms-services"]);
const USES_PARAMS = new Set(["", "ftp", "hdl", "prospero", "http", "imap", "https", "shttp", "rtsp", "rtsps", "rtspu", "sip", "sips", "mms", "sftp", "tel"]);

type Parsed = { scheme: string; netloc: string; path: string; params: string; query: string; fragment: string };

export function urlparse(url: string, defaultScheme = ""): Parsed {
  const split = urlsplit(url, defaultScheme);
  let path = split.path;
  let params = "";
  if (USES_PARAMS.has(split.scheme) && path.includes(";")) {
    let at: number;
    if (path.includes("/")) at = path.indexOf(";", path.lastIndexOf("/"));
    else at = path.indexOf(";");
    if (at >= 0) {
      params = path.slice(at + 1);
      path = path.slice(0, at);
    }
  }
  return { scheme: split.scheme, netloc: split.netloc, path, params, query: split.query, fragment: split.fragment };
}

export function urlunsplit(scheme: string, netloc: string, path: string, query: string, fragment: string): string {
  let url = path;
  if (netloc) {
    if (url && !url.startsWith("/")) url = `/${url}`;
    url = `//${netloc}${url}`;
  } else if (url.startsWith("//")) url = `//${url}`;
  else if (scheme && USES_NETLOC.has(scheme) && (!url || url.startsWith("/"))) url = `//${url}`;
  if (scheme) url = `${scheme}:${url}`;
  if (query) url = `${url}?${query}`;
  if (fragment) url = `${url}#${fragment}`;
  return url;
}

function urlunparse(parts: Parsed): string {
  return urlunsplit(parts.scheme, parts.netloc, parts.params ? `${parts.path};${parts.params}` : parts.path, parts.query, parts.fragment);
}

export function urljoin(base: string, url: string): string {
  if (!base) return url;
  if (!url) return base;
  const from = urlparse(base);
  const to = urlparse(url, from.scheme);
  if (to.scheme !== from.scheme || !USES_RELATIVE.has(to.scheme)) return url;
  let netloc = to.netloc;
  if (USES_NETLOC.has(to.scheme)) {
    if (netloc) return urlunparse(to);
    netloc = from.netloc;
  }
  if (!to.path && !to.params) {
    return urlunparse({ ...to, netloc, path: from.path, params: from.params, query: to.query || from.query });
  }
  const baseParts = from.path.split("/");
  if (baseParts.at(-1) !== "") baseParts.pop();
  let segments: string[];
  if (to.path.startsWith("/")) segments = to.path.split("/");
  else {
    segments = [...baseParts, ...to.path.split("/")];
    if (segments.length > 2) segments = [segments[0] as string, ...segments.slice(1, -1).filter((segment) => segment), segments.at(-1) as string];
  }
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === "..") resolved.pop();
    else if (segment !== ".") resolved.push(segment);
  }
  if (segments.at(-1) === "." || segments.at(-1) === "..") resolved.push("");
  return urlunparse({ ...to, netloc, path: resolved.join("/") || "/" });
}
