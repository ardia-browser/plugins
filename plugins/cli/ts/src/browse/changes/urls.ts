import { headPoints, PyException, pyLen } from "../../pylib/str.ts";
import { decimalValue, isWordCode } from "../../pylib/unicode.ts";
import { hostnameOf, parseQsl, portOf, type SplitResult, unquote, urlsplit } from "../../pylib/urllib.ts";
import { redact } from "../../redact.ts";

export const MAX_PATH = 200;
const SAFE_KEY = /^[A-Za-z0-9_.[\]-]{1,40}$/;
const SENSITIVE_KEY = /code|token|pass|pwd|secret|key|sig|auth|session|cred|otp|state|nonce|ticket|jwt/iu;

function splitOrNull(url: string): SplitResult | null {
  try {
    return urlsplit(url);
  } catch (error) {
    if (error instanceof PyException && error.type === "ValueError") return null;
    throw error;
  }
}

function portOrError(netloc: string): number | null | undefined {
  try {
    return portOf(netloc);
  } catch (error) {
    if (error instanceof PyException && error.type === "ValueError") return undefined;
    throw error;
  }
}

function hasDigit(text: string): boolean {
  for (const point of text) if (decimalValue(point.codePointAt(0) as number) >= 0) return true;
  return false;
}

export function secretLike(segment: string): boolean {
  if (segment.includes(":") || segment.toLowerCase().includes("%3a")) return true;
  return pyLen(segment) >= 20 && hasDigit(segment) && /[A-Za-z]/.test(segment);
}

export function cleanUrl(input: string): string {
  const url = redact(input);
  const parts = splitOrNull(url);
  if (parts === null) return "(unparseable URL)";
  const port = portOrError(parts.netloc);
  if (port === undefined) return "(unparseable URL)";
  const scheme = parts.scheme.toLowerCase();
  if (!["http", "https", "ws", "wss"].includes(scheme)) return scheme ? `${scheme}:…` : "(no URL)";
  let host = hostnameOf(parts.netloc) ?? "";
  if (host.includes(":")) host = `[${host}]`;
  const netloc = host + (port !== null ? `:${port}` : "");
  let path = (parts.path || "/").split("/").map((segment) => (secretLike(segment) ? "…" : segment)).join("/");
  if (pyLen(path) > MAX_PATH) path = `${headPoints(path, MAX_PATH)}…`;
  const keys = parseQsl(parts.query, true).map(([name, value]) => (SAFE_KEY.test(name) ? name : "…") + (value ? "=…" : ""));
  return `${scheme}://${netloc}${path}` + (keys.length ? `?${keys.join("&")}` : "");
}

export function maskedPair(part: string): string {
  const at = part.indexOf("=");
  if (at < 0) return part;
  const name = part.slice(0, at);
  const value = part.slice(at + 1);
  if (value && SENSITIVE_KEY.test(unquote(name))) return `${name}=…`;
  return part;
}

export function maskedUrl(input: string): string {
  const url = redact(input);
  const parts = splitOrNull(url);
  if (parts === null) return "(unparseable URL)";
  if (!["http", "https"].includes(parts.scheme.toLowerCase())) return !parts.query && !parts.fragment ? url : `${parts.scheme}:…`;
  let netloc = hostnameOf(parts.netloc) ?? "";
  if (netloc.includes(":")) netloc = `[${netloc}]`;
  const port = portOf(parts.netloc);
  if (port !== null) netloc += `:${port}`;
  const query = parts.query.split("&").filter((part) => part).map(maskedPair).join("&");
  const fragment = parts.fragment.includes("=") ? "…" : parts.fragment;
  return `${parts.scheme}://${netloc}${parts.path}` + (query ? `?${query}` : "") + (fragment ? `#${fragment}` : "");
}

export function stripInlineRefs(text: string): string {
  let out = "";
  let copied = 0;
  let at = text.indexOf(" [@e");
  while (at >= 0) {
    let end = at + 4;
    while (end < text.length) {
      const code = text.codePointAt(end) as number;
      if (decimalValue(code) < 0) break;
      end += code > 0xffff ? 2 : 1;
    }
    if (end > at + 4 && text[end] === "]") {
      out += text.slice(copied, at);
      copied = end + 1;
      at = text.indexOf(" [@e", copied);
    } else at = text.indexOf(" [@e", at + 1);
  }
  return out + text.slice(copied);
}

export function wordCount(text: string): number {
  let count = 0;
  for (const point of text) {
    const code = point.codePointAt(0) as number;
    if (code !== 0x5f && isWordCode(code)) count += 1;
  }
  return count;
}
