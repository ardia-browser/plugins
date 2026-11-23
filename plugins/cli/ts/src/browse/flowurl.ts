import { quote as jsonQuote } from "../json.ts";
import { isSpace } from "../py.ts";
import { codePoints } from "../pystr.ts";
import { isIPv6Address } from "../pylib/ipaddress.ts";
import { PyException } from "../pylib/str.ts";
import { decimalValue, isAscii } from "../pylib/unicode.ts";
import { encodeUtf8Strict, quote, quotePlus, unquote, unquotePlus, urlsplit } from "../pylib/urllib.ts";

export const DEFAULT_PORTS: Readonly<Record<string, number>> = { http: 80, https: 443 };
const FORBIDDEN = /[\\\s\x00-\x1f\x7f]/;
const SHAPE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#[\s\S]*)?$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const NUMERIC_LABEL = /^(?:0x[0-9a-f]*|[0-9]+)$/;
const PARAM = /^\{\{([a-z][a-z0-9_]{0,23})\}\}$/;
const PARAMS = /\{\{[a-z][a-z0-9_]{0,23}\}\}/g;
const SHORT = /^[A-Za-z0-9_-]{0,24}$/;
const SEGMENT = /^[A-Za-z0-9_.-]{0,24}$/;
const QUERY_KEY = /^[A-Za-z0-9_.[\]-]{1,40}$/;
export const HIDDEN = "<hidden>";
export const CREDENTIAL_WORDS = new Set([
  "token", "auth", "apikey", "key", "sig", "signature", "secret", "password", "passwd", "pwd", "pass", "csrf", "xsrf", "session", "sessionid", "sid", "jwt",
  "otp", "nonce", "credential", "credentials", "bearer", "hmac", "accesstoken",
]);

export class Unsafe extends Error {}

export class Url {
  constructor(
    readonly scheme: string,
    readonly host: string,
    readonly port: number,
    readonly path: string,
    readonly query: string,
    readonly literal: boolean,
  ) {}

  get origin(): string {
    return `${this.scheme}://${this.host}` + (this.port === DEFAULT_PORTS[this.scheme] ? "" : `:${this.port}`);
  }

  get text(): string {
    return this.origin + (this.path || "/") + (this.query ? `?${this.query}` : "");
  }
}

function partition(text: string, separator: string): [string, string, string] {
  const at = text.indexOf(separator);
  return at < 0 ? [text, "", ""] : [text.slice(0, at), separator, text.slice(at + separator.length)];
}

export function parse(url: unknown): Url {
  if (typeof url !== "string" || !isAscii(url)) throw new Unsafe("it isn't a plain ASCII URL");
  if (FORBIDDEN.test(url)) throw new Unsafe("it has a backslash, a space or a control character");
  const match = SHAPE.exec(url);
  if (match === null) throw new Unsafe("it isn't an absolute URL");
  const scheme = (match[1] as string).toLowerCase();
  if (!Object.hasOwn(DEFAULT_PORTS, scheme)) throw new Unsafe("it isn't http or https");
  const authority = match[2] as string;
  if (!authority || authority.includes("@")) throw new Unsafe("its address has no host or carries user info");
  let portText = "";
  let host: string;
  let literal: boolean;
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close < 0) throw new Unsafe("its IPv6 host isn't closed");
    const inner = authority.slice(1, close);
    const rest = authority.slice(close + 1);
    if (!isIPv6Address(inner)) throw new Unsafe("its IPv6 host doesn't parse");
    host = `[${inner.toLowerCase()}]`;
    literal = true;
    if (rest) {
      if (!rest.startsWith(":")) throw new Unsafe("its host is followed by something other than a port");
      portText = rest.slice(1);
    }
  } else {
    const [name, sep, port] = partition(authority, ":");
    if (sep && !port) throw new Unsafe("it has an empty port");
    portText = port;
    host = name.toLowerCase();
    const labels = host.split(".");
    if (!labels.every((label) => LABEL.test(label))) throw new Unsafe("its host isn't a plain DNS name");
    literal = NUMERIC_LABEL.test(labels.at(-1) as string);
  }
  let port: number;
  if (portText) {
    if (!/^[0-9]{1,5}$/.test(portText) || !(Number(portText) > 0 && Number(portText) < 65536)) throw new Unsafe("its port isn't a number from 1 to 65535");
    port = Number(portText);
  } else port = DEFAULT_PORTS[scheme] as number;
  return new Url(scheme, host, port, match[3] || "/", match[4] || "", literal);
}

function separates(point: string): boolean {
  return point === "_" || point === "-" || point === "." || point === "[" || point === "]" || isSpace(point);
}

function isLowerAscii(point: string | undefined): boolean {
  return point !== undefined && point >= "a" && point <= "z";
}

function isUpperAscii(point: string | undefined): boolean {
  return point !== undefined && point >= "A" && point <= "Z";
}

function splitWords(text: string): string[] {
  const words: string[] = [];
  let word = "";
  let previous: string | undefined;
  for (const point of codePoints(text)) {
    if (separates(point)) {
      words.push(word);
      word = "";
    } else {
      if (isLowerAscii(previous) && isUpperAscii(point)) {
        words.push(word);
        word = "";
      }
      word += point;
    }
    previous = point;
  }
  words.push(word);
  return words.filter((part) => part);
}

export function credentialKey(key: string): boolean {
  const text = unquotePlus(key);
  const words = splitWords(text).map((word) => word.toLowerCase());
  for (const word of [...words]) if (word.endsWith("s")) words.push(word.slice(0, -1));
  return words.some((word) => CREDENTIAL_WORDS.has(word)) || CREDENTIAL_WORDS.has(text.toLowerCase().replaceAll("-", "").replaceAll("_", ""));
}

function digitRun(points: string[], from: number, most: number): number {
  let at = from;
  while (at < points.length && at - from < most && decimalValue((points[at] as string).codePointAt(0) as number) >= 0) at += 1;
  return at - from;
}

export function isDecimalLiteral(value: string): boolean {
  const points = codePoints(value);
  let at = points[0] === "-" ? 1 : 0;
  const whole = digitRun(points, at, 15);
  if (whole === 0) return false;
  at += whole;
  if (at === points.length) return true;
  if (points[at] !== ".") return false;
  const fraction = digitRun(points, at + 1, 9);
  return fraction > 0 && at + 1 + fraction === points.length;
}

export function literalOk(value: string, segment = false): boolean {
  if (PARAM.test(value) || isDecimalLiteral(value)) return true;
  if (value.includes("@")) return false;
  if (segment) return !value.includes("..") && SEGMENT.test(value.replace(PARAMS, ""));
  return SHORT.test(value);
}

export function encodings(secret: string): Set<string> {
  const raw = encodeUtf8Strict(secret);
  const encoded = raw.toString("base64");
  const hex = raw.toString("hex");
  return new Set([
    secret, quote(secret, ""), quotePlus(secret), jsonQuote(secret, false).slice(1, -1), encoded, encoded.replace(/=+$/, ""),
    raw.toString("base64url"), hex, hex.toUpperCase(), [...raw].join(","),
  ]);
}

export function carries(text: string | null | undefined, secret: string): boolean {
  if (!text || !secret) return false;
  const lowered = text.toLowerCase();
  for (const form of encodings(secret)) if (form && (text.includes(form) || lowered.includes(form.toLowerCase()))) return true;
  return false;
}

export function queryPairs(query: string): [string, string][] {
  if (!query) return [];
  return query.split("&").map((pair) => {
    const [key, , value] = partition(pair, "=");
    return [unquotePlus(key), unquotePlus(value)];
  });
}

export function problem(url: Url, secrets: readonly string[] = []): string | null {
  if (secrets.some((secret) => carries(url.path, secret) || carries(url.query, secret))) return "its URL carries a value typed into a secret field";
  for (const segment of url.path.split("/").slice(1)) {
    const decoded = unquote(segment);
    if (!literalOk(decoded, true)) return "its URL path holds a value that isn't a param, a number or a short word";
    if (!PARAM.test(decoded) && credentialKey(decoded.replace(PARAMS, ""))) return "its URL path names a credential";
  }
  for (const [key, value] of queryPairs(url.query)) {
    if (!QUERY_KEY.test(key)) return "its URL query has an unusual key";
    if (!literalOk(value)) return "its URL query holds a value that isn't a param, a number or a short word";
    if (value && !PARAM.test(value) && credentialKey(key)) return "its URL query sends a credential";
  }
  return null;
}

export function checked(url: string, secrets: readonly string[] = []): Url {
  const parsed = parse(url);
  const why = problem(parsed, secrets);
  if (why) throw new Unsafe(why);
  return parsed;
}

function splitOrNull(url: string): ReturnType<typeof urlsplit> | null {
  try {
    return urlsplit(url);
  } catch (error) {
    if (error instanceof PyException && error.type === "ValueError") return null;
    throw error;
  }
}

function hostOf(netloc: string): string {
  return netloc.slice(netloc.lastIndexOf("@") + 1).toLowerCase();
}

export function hostLabel(url: string): string {
  const parts = splitOrNull(url);
  if (parts === null) return "(unparseable)";
  const scheme = parts.scheme.toLowerCase();
  if (!Object.hasOwn(DEFAULT_PORTS, scheme)) return `${scheme || "no"}:`;
  return codePoints(hostOf(parts.netloc)).slice(0, 80).join("") || "(no host)";
}

export function mask(url: string, secrets: readonly string[] = []): string {
  const hidden = (value: string) => secrets.some((secret) => carries(value, secret));
  const parts = splitOrNull(url);
  if (parts === null) return HIDDEN;
  const scheme = parts.scheme.toLowerCase();
  if (!Object.hasOwn(DEFAULT_PORTS, scheme)) return scheme ? `${scheme}:…` : HIDDEN;
  const segments = parts.path.split("/").map((segment) => {
    const decoded = unquote(segment);
    return !decoded || (literalOk(decoded, true) && !hidden(decoded)) ? segment : HIDDEN;
  });
  const pairs = queryPairs(parts.query).map(([key, value]) => {
    const shownKey = QUERY_KEY.test(key) && !hidden(key) ? key : HIDDEN;
    const shown = literalOk(value) && !(value && credentialKey(key)) && !hidden(value) ? value : HIDDEN;
    return value ? `${quote(shownKey, "[]<>")}=${quote(shown, "{}<>")}` : quote(shownKey, "[]<>");
  });
  let netloc = hostOf(parts.netloc);
  if (hidden(netloc)) netloc = HIDDEN;
  return `${scheme}://${netloc}${segments.join("/") || "/"}` + (pairs.length ? `?${pairs.join("&")}` : "");
}
