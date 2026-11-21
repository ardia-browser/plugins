import { encodeUtf8Strict, hostnameOf, portOf, urlsplit } from "../pylib/urllib.ts";
import { PyException } from "../pylib/str.ts";
import { encodeIdna, IdnaFailure, punycodeDecodes } from "./idna.ts";
import { ipv4, ipv6Compressed, NotAnAddress } from "./ip.ts";
import matcherTemplate from "./matcher.js.txt" with { type: "text" };

export const SENTINEL = -1;
const STAR = 42;
const QUESTION = 63;
const BACKSLASH = 92;
export const SCRIPT_SCHEMES = ["http", "https", "file", "ftp"] as const;
const WILDCARD_SCHEMES = ["http", "https"];
const DEFAULT_PORTS = new Map([["http", 80], ["https", 443], ["ftp", 21]]);
const UNESCAPED_ASCII = new Set(Buffer.from('"-<>_~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'));
const MAX_INT_DIGITS = 4300;
export const BANNED_RANGES: readonly (readonly [number, number])[] = [
  [0x0085, 0x0085], [0x00a0, 0x00a0], [0x00ad, 0x00ad], [0x034f, 0x034f], [0x0600, 0x0605], [0x061c, 0x061c],
  [0x06dd, 0x06dd], [0x070f, 0x070f], [0x08e2, 0x08e2], [0x115f, 0x1160], [0x1680, 0x1680], [0x17b4, 0x17b5],
  [0x180b, 0x180e], [0x2000, 0x200f], [0x2028, 0x202f], [0x205f, 0x206f], [0x2800, 0x2800], [0x3000, 0x3000],
  [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xfff0, 0xfffb], [0x110bd, 0x110bd],
  [0x110cd, 0x110cd], [0x13430, 0x13438], [0x1bca0, 0x1bca3], [0x1d173, 0x1d17a], [0x1f50f, 0x1f510],
  [0x1f512, 0x1f513], [0xe0000, 0xe0fff],
];
const IDNA_DEVIATIONS = ["ß", "ς", "‌", "‍"];
const LABEL = /^[a-z0-9_-]+\n?$/;
const HEX_DIGIT = /^[0-9a-fA-F]$/;

export const JS = matcherTemplate.replace("__BANNED__", `[${BANNED_RANGES.map(([low, high]) => `[${low}, ${high}]`).join(", ")}]`);

export class PatternError extends Error {
  override readonly name = "PatternError";
}

export type Spec = {
  all: boolean;
  schemes: string[];
  host: string;
  sub: boolean;
  port: string;
  file: boolean;
  raw: number[];
  utf8: number[];
  utf8Bytes: number[];
};

export type SplitUrl = { scheme: string; host: string; port: string; path: string };

function leadLength(byte: number): number {
  if (byte >= 0xc2 && byte <= 0xdf) return 2;
  if (byte >= 0xe0 && byte <= 0xef) return 3;
  if (byte >= 0xf0 && byte <= 0xf4) return 4;
  return 0;
}

function firstChar(bytes: ArrayLike<number>, start: number, end: number): [number, number] | null {
  if (start >= end) return null;
  const lead = bytes[start] as number;
  if (lead < 0x80) return [lead, 1];
  const size = leadLength(lead);
  if (!size || end - start < size) return null;
  let point = lead & (size === 2 ? 0x1f : size === 3 ? 0x0f : 0x07);
  for (let index = 1; index < size; index += 1) {
    const trail = bytes[start + index] as number;
    if (trail < 0x80 || trail > 0xbf) return null;
    point = (point << 6) | (trail & 0x3f);
  }
  const least = size === 2 ? 0x80 : size === 3 ? 0x800 : 0x10000;
  if (point < least || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return null;
  return [point, size];
}

export function decode(bytes: ArrayLike<number>): number[] {
  const points: number[] = [];
  for (let index = 0; index < bytes.length; ) {
    const found = firstChar(bytes, index, Math.min(bytes.length, index + 4));
    if (found === null) {
      points.push(SENTINEL);
      index += 1;
    } else {
      points.push(found[0]);
      index += found[1];
    }
  }
  return points;
}

function escapedByte(bytes: ArrayLike<number>, index: number): number | null {
  if (index + 2 >= bytes.length || bytes[index] !== 0x25) return null;
  const high = String.fromCharCode(bytes[index + 1] as number);
  const low = String.fromCharCode(bytes[index + 2] as number);
  if (!HEX_DIGIT.test(high) || !HEX_DIGIT.test(low)) return null;
  return parseInt(high + low, 16);
}

function shouldUnescape(point: number): boolean {
  if (point < 0x80) return UNESCAPED_ASCII.has(point);
  return !BANNED_RANGES.some(([low, high]) => point >= low && point <= high);
}

export function unescape(bytes: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let index = 0; index < bytes.length; ) {
    const first = escapedByte(bytes, index);
    let found: [number, number] | null = null;
    if (first !== null) {
      const collected = [first];
      if (first >= 0xc2 && first <= 0xf4) {
        while (collected.length < 4) {
          const trail = escapedByte(bytes, index + collected.length * 3);
          if (trail === null || trail < 0x80 || trail > 0xbf) break;
          collected.push(trail);
        }
      }
      found = firstChar(collected, 0, collected.length);
    }
    if (found === null) {
      if (first !== null) {
        out.push(first);
        index += 3;
      } else {
        out.push(bytes[index] as number);
        index += 1;
      }
      continue;
    }
    const [point, size] = found;
    if (!shouldUnescape(point)) for (let offset = 0; offset < 3 * size; offset += 1) out.push(bytes[index + offset] as number);
    else out.push(...Buffer.from(String.fromCodePoint(point)));
    index += 3 * size;
  }
  return out;
}

function search(pattern: number[], p: number, text: number[], s: number, distance: number): [boolean, number, number] {
  const patternStart = p;
  let textStart = s;
  let escape = false;
  for (;;) {
    if (p === pattern.length) {
      if (s === text.length) return [true, p, s];
    } else {
      const char = pattern[p] as number;
      if (!escape && (char === STAR || char === QUESTION)) return [true, p, s];
      if (!escape && char === BACKSLASH) {
        escape = true;
        p += 1;
        continue;
      }
      escape = false;
      if (s === text.length) return [false, p, s];
      if (char === text[s] && char !== SENTINEL) {
        p += 1;
        s += 1;
        continue;
      }
    }
    if (distance === 0) return [false, p, s];
    distance -= 1;
    p = patternStart;
    textStart += 1;
    s = textStart;
  }
}

export function matchPattern(text: number[], pattern: number[]): boolean {
  let p = 0;
  let s = 0;
  for (;;) {
    let stars = false;
    let questions = 0;
    while (p < pattern.length && (pattern[p] === STAR || pattern[p] === QUESTION)) {
      stars = stars || pattern[p] === STAR;
      questions += pattern[p] === QUESTION ? 1 : 0;
      p += 1;
    }
    const [ok, nextP, nextS] = search(pattern, p, text, s, stars ? -1 : questions);
    if (!ok) return false;
    [p, s] = [nextP, nextS];
    if (p === pattern.length) return true;
  }
}

function isAscii(text: string): boolean {
  return !/[^\x00-\x7f]/.test(text);
}

function idna(host: string): string {
  const labels: string[] = [];
  for (const label of host.split(".")) {
    if (isAscii(label)) {
      const lowered = label.toLowerCase();
      if (lowered.startsWith("xn--") && !punycodeDecodes(lowered.slice(4))) throw new PatternError(`${label} isn't valid punycode`);
      labels.push(lowered);
      continue;
    }
    if (IDNA_DEVIATIONS.some((char) => label.includes(char))) {
      throw new PatternError("the host has ß, ς or a joiner, which browsers convert differently; write it in punycode");
    }
    try {
      labels.push(encodeIdna(label));
    } catch (error) {
      if (error instanceof IdnaFailure) throw new PatternError("the host isn't a valid internationalized name");
      throw error;
    }
  }
  return labels.join(".");
}

function count(text: string, char: string): number {
  return text.split(char).length - 1;
}

export function canonicalHost(host: string): string {
  if (host.includes("%")) throw new PatternError("hosts can't have % (no IPv6 scope ids or escapes)");
  if (host.startsWith("[")) {
    if (!host.endsWith("]") || count(host, "[") !== 1 || count(host, "]") !== 1) throw new PatternError("invalid IPv6 host");
    try {
      return `[${ipv6Compressed(host.slice(1, -1))}]`;
    } catch (error) {
      if (error instanceof NotAnAddress) throw new PatternError("invalid IPv6 address");
      throw error;
    }
  }
  let address: string | null;
  try {
    address = ipv4(host);
  } catch (error) {
    if (error instanceof NotAnAddress) throw new PatternError("not a valid IPv4 address");
    throw error;
  }
  if (address !== null) return address;
  const lowered = idna(host);
  const labels = lowered.replace(/\.+$/, "").split(".");
  if (labels.some((label) => !LABEL.test(label))) throw new PatternError("the host has characters a hostname can't have");
  return lowered;
}

function partition(text: string, separator: string): [string, string, string] {
  const at = text.indexOf(separator);
  return at < 0 ? [text, "", ""] : [text.slice(0, at), separator, text.slice(at + separator.length)];
}

function pathFields(path: string): Pick<Spec, "raw" | "utf8" | "utf8Bytes"> {
  const raw = path.replaceAll("\\", "\\\\").replaceAll("?", "\\?");
  const rawBytes = encodeUtf8Strict(raw);
  const utf8 = unescape(rawBytes);
  return { raw: decode(rawBytes), utf8: decode(utf8), utf8Bytes: utf8 };
}

function checkPort(scheme: string, port: string): void {
  if (port === "*") return;
  if (scheme === "*") throw new PatternError("a pattern with scheme * can't name a port");
  if (!/^[0-9]+$/.test(port)) throw new PatternError("the port is a number or *");
  if (port.length > 1 && port.startsWith("0")) throw new PatternError("write the port without leading zeros");
  if (port.length > MAX_INT_DIGITS) {
    throw new PyException(
      "ValueError",
      `Exceeds the limit (${MAX_INT_DIGITS} digits) for integer string conversion: value has ${port.length} digits; use sys.set_int_max_str_digits() to increase the limit`,
    );
  }
  if (BigInt(port) > 65535n) throw new PatternError("the port must be 0 to 65535");
}

export function parse(pattern: string): Spec {
  if (pattern === "<all_urls>") return { all: true, schemes: [...SCRIPT_SCHEMES], host: "", sub: true, port: "*", file: false, ...pathFields("/*") };
  if (pattern.includes("\0")) throw new PatternError("contains a null character");
  const [scheme, separator, rest] = partition(pattern, "://");
  if (!separator) throw new PatternError("a match pattern is <all_urls> or scheme://host/path");
  if (scheme !== "*" && !(SCRIPT_SCHEMES as readonly string[]).includes(scheme)) {
    throw new PatternError(`content scripts only match ${["*", ...SCRIPT_SCHEMES].join(", ")} URLs`);
  }
  const schemes = scheme === "*" ? [...WILDCARD_SCHEMES] : [scheme];
  if (!rest) throw new PatternError("the host is empty");
  if (scheme === "file") {
    const [host, slash, path] = partition(rest, "/");
    if (!slash) throw new PatternError("add a path, like file:///*");
    if (host && host !== "localhost") throw new PatternError("file patterns have no host (file:///path)");
    return { all: false, schemes, host: "", sub: false, port: "*", file: true, ...pathFields(`/${path}`) };
  }
  const end = rest.indexOf("/");
  if (end === 0) throw new PatternError("the host is empty");
  if (end < 0) throw new PatternError("add a path, like /*");
  const hostAndPort = rest.slice(0, end);
  const path = rest.slice(end);
  let port = "*";
  let host: string;
  if (hostAndPort.startsWith("[")) {
    const close = hostAndPort.indexOf("]");
    if (close < 0) throw new PatternError("invalid IPv6 host");
    if (close === 1) throw new PatternError("the host is empty");
    host = hostAndPort.slice(0, close + 1);
    const tail = hostAndPort.slice(close + 1);
    if (tail) {
      if (!tail.startsWith(":")) throw new PatternError("invalid IPv6 host");
      port = tail.slice(1);
      checkPort(scheme, port);
    }
  } else {
    const [name, colon, portText] = partition(hostAndPort, ":");
    host = name;
    if (colon) {
      checkPort(scheme, portText);
      port = portText;
    }
  }
  if (!host) throw new PatternError("the host is empty");
  let sub = false;
  if (host === "*") [sub, host] = [true, ""];
  else if (host.startsWith("*.")) {
    if (host.length === 2) throw new PatternError("the host is empty");
    [sub, host] = [true, host.slice(2)];
  }
  if (host.includes("*")) throw new PatternError("* only works as the whole host or a *. prefix");
  if (host) host = canonicalHost(host);
  return { all: false, schemes, host, sub, port, file: false, ...pathFields(path) };
}

export function globPoints(glob: string): number[] {
  return decode(encodeUtf8Strict(glob));
}

function sameBytes(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function matchesPath(spec: Spec, test: string): boolean {
  const testBytes = encodeUtf8Strict(test);
  const unescaped = unescape(testBytes);
  if (sameBytes(spec.utf8Bytes, [...unescaped, 0x2f, 0x2a])) return true;
  return matchPattern(decode(unescaped), spec.utf8) || matchPattern(decode(testBytes), spec.raw);
}

function isIp(host: string): boolean {
  return host.startsWith("[") || /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/.test(host);
}

function matchesHost(spec: Spec, host: string): boolean {
  const test = host.replace(/\.+$/, "");
  const pattern = spec.host.replace(/\.+$/, "");
  if (test === pattern) return true;
  if (spec.sub && !pattern) return true;
  if (!spec.sub || isIp(test)) return false;
  return test.length > pattern.length + 1 && test.endsWith(pattern) && test[test.length - pattern.length - 1] === ".";
}

export function split(url: string): SplitUrl | null {
  let netloc: string;
  let parts: ReturnType<typeof urlsplit>;
  let port: number | null;
  try {
    parts = urlsplit(url);
    netloc = parts.netloc;
    port = portOf(netloc);
  } catch (error) {
    if (error instanceof PyException && error.type === "ValueError") return null;
    throw error;
  }
  const scheme = parts.scheme.toLowerCase();
  let host = hostnameOf(netloc) ?? "";
  if (host) {
    try {
      host = canonicalHost(host.includes(":") ? `[${host}]` : host);
    } catch (error) {
      if (error instanceof PatternError) return null;
      throw error;
    }
  }
  const hash = url.indexOf("#");
  const beforeFragment = hash < 0 ? url : url.slice(0, hash);
  let path = parts.path || "/";
  const question = beforeFragment.indexOf("?");
  if (question >= 0) path += `?${beforeFragment.slice(question + 1)}`;
  const effective = port ?? DEFAULT_PORTS.get(scheme) ?? -1;
  return { scheme, host, port: String(effective), path };
}

export function matches(spec: Spec, url: SplitUrl | null): boolean {
  if (url === null || !spec.schemes.includes(url.scheme)) return false;
  if (spec.all) return true;
  if (!spec.file && !matchesHost(spec, url.host)) return false;
  if (spec.port !== "*" && spec.port !== url.port) return false;
  return matchesPath(spec, url.path);
}

export function globMatches(points: number[], url: string): boolean {
  return matchPattern(decode(encodeUtf8Strict(url)), points);
}
