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

export function urlsplit(input: string): SplitResult {
  let start = 0;
  while (start < input.length && input.charCodeAt(start) <= 0x20) start += 1;
  let url = input.slice(start).replace(/[\t\r\n]/g, "");
  let scheme = "";
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
