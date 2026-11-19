
import { HTML5_ENTITIES } from "./unicode-data.ts";

let entities: Map<string, string> | undefined;

function html5(): Map<string, string> {
  entities ??= new Map(Object.entries(JSON.parse(HTML5_ENTITIES) as Record<string, string>));
  return entities;
}

const INVALID_CHARREFS: ReadonlyMap<number, string> = new Map([
  [0x00, "�"], [0x0d, "\r"], [0x80, "€"], [0x81, "\x81"], [0x82, "‚"], [0x83, "ƒ"], [0x84, "„"], [0x85, "…"], [0x86, "†"],
  [0x87, "‡"], [0x88, "ˆ"], [0x89, "‰"], [0x8a, "Š"], [0x8b, "‹"], [0x8c, "Œ"], [0x8d, "\x8d"], [0x8e, "Ž"], [0x8f, "\x8f"],
  [0x90, "\x90"], [0x91, "‘"], [0x92, "’"], [0x93, "“"], [0x94, "”"], [0x95, "•"], [0x96, "–"], [0x97, "—"], [0x98, "˜"],
  [0x99, "™"], [0x9a, "š"], [0x9b, "›"], [0x9c, "œ"], [0x9d, "\x9d"], [0x9e, "ž"], [0x9f, "Ÿ"],
]);

function invalidCodepoint(code: number): boolean {
  if ((code >= 0x1 && code <= 0x8) || (code >= 0xe && code <= 0x1f) || (code >= 0x7f && code <= 0x9f) || (code >= 0xfdd0 && code <= 0xfdef) || code === 0xb) return true;
  return (code & 0xfffe) === 0xfffe && code <= 0x10ffff;
}

function charref(digits: string, hex: boolean): string {
  const trimmed = digits.replace(/^0+(?=.)/, "");
  if (trimmed.length > 8) return "�";
  const num = Number.parseInt(trimmed, hex ? 16 : 10);
  const known = INVALID_CHARREFS.get(num);
  if (known !== undefined) return known;
  if ((num >= 0xd800 && num <= 0xdfff) || num > 0x10ffff) return "�";
  if (invalidCodepoint(num)) return "";
  return String.fromCodePoint(num);
}

const NAME_STOP = new Set([0x09, 0x0a, 0x0c, 0x20, 0x3c, 0x26, 0x23, 0x3b]);

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isHex(code: number): boolean {
  return isDigit(code) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
}

function named(name: string): string {
  const table = html5();
  const whole = table.get(name);
  if (whole !== undefined) return whole;
  const points = [...name];
  for (let size = points.length - 1; size > 1; size -= 1) {
    const prefix = points.slice(0, size).join("");
    const found = table.get(prefix);
    if (found !== undefined) return found + points.slice(size).join("");
  }
  return `&${name}`;
}

export function unescape(text: string): string {
  let at = text.indexOf("&");
  if (at < 0) return text;
  let out = "";
  let copied = 0;
  while (at >= 0) {
    let end = -1;
    let replacement = "";
    if (text.charCodeAt(at + 1) === 0x23) {
      const hex = text.charCodeAt(at + 2) === 0x78 || text.charCodeAt(at + 2) === 0x58;
      const first = at + (hex ? 3 : 2);
      let stop = first;
      while (stop < text.length && (hex ? isHex(text.charCodeAt(stop)) : isDigit(text.charCodeAt(stop)))) stop += 1;
      if (stop > first) {
        end = text.charCodeAt(stop) === 0x3b ? stop + 1 : stop;
        replacement = charref(text.slice(first, stop), hex);
      }
    } else {
      let stop = at + 1;
      let count = 0;
      while (stop < text.length && count < 32 && !NAME_STOP.has(text.charCodeAt(stop))) {
        const code = text.codePointAt(stop) as number;
        stop += code > 0xffff ? 2 : 1;
        count += 1;
      }
      if (count > 0) {
        end = text.charCodeAt(stop) === 0x3b ? stop + 1 : stop;
        replacement = named(text.slice(at + 1, end));
      }
    }
    if (end < 0) {
      at = text.indexOf("&", at + 1);
      continue;
    }
    out += text.slice(copied, at) + replacement;
    copied = end;
    at = text.indexOf("&", end);
  }
  return out + text.slice(copied);
}

export type Attr = [string, string | null];

export type Handler = {
  starttag?(tag: string, attrs: Attr[]): void;
  endtag?(tag: string): void;
  startendtag?(tag: string, attrs: Attr[]): void;
  data?(text: string): void;
  comment?(text: string): void;
  decl?(text: string): void;
  pi?(text: string): void;
  unknownDecl?(text: string): void;
};

const ATTR_CHARREF = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*)[;=]?/g;

export function unescapeAttrValue(value: string): string {
  return value.replace(ATTR_CHARREF, (ref) => {
    if (ref.startsWith("&#")) return unescape(ref);
    if (!ref.endsWith("=") && html5().has(ref.slice(1))) return unescape(ref);
    return ref;
  });
}

