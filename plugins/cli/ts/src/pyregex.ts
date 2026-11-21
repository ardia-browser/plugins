import { NeedsPython } from "./paths.ts";
import { codePoints } from "./pystr.ts";

const UNICODE_SPACES = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005,
  0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
];
const ASCII_SPACES = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20];
const SIMPLE_ESCAPES: Record<string, number> = { n: 0x0a, t: 0x09, r: 0x0d, f: 0x0c, v: 0x0b, a: 0x07 };
const QUANTIFIER = /^\{(\d*)(,(\d*))?\}/u;
const GROUP_OPENERS = ["(?:", "(?=", "(?!", "(?<=", "(?<!"];

type Item = { kind: "char"; code: number } | { kind: "set"; body: string } | { kind: "negset"; body: string };

function literal(code: number): string {
  return `\\u{${code.toString(16)}}`;
}

function spacesBody(ascii: boolean): string {
  return (ascii ? ASCII_SPACES : UNICODE_SPACES).map(literal).join("");
}

function classEscape(letter: string, ascii: boolean): Item | undefined {
  switch (letter) {
    case "d":
      return { kind: "set", body: ascii ? "0-9" : "\\p{Nd}" };
    case "D":
      return ascii ? { kind: "negset", body: "0-9" } : { kind: "set", body: "\\P{Nd}" };
    case "s":
      return { kind: "set", body: spacesBody(ascii) };
    case "S":
      return { kind: "negset", body: spacesBody(ascii) };
    case "w":
      return { kind: "set", body: ascii ? "A-Za-z0-9_" : "\\p{L}\\p{N}_" };
    case "W":
      return { kind: "negset", body: ascii ? "A-Za-z0-9_" : "\\p{L}\\p{N}_" };
    default:
      return undefined;
  }
}

function unsupported(what: string): never {
  throw new NeedsPython(`a pattern with ${what}`);
}

function hexEscape(points: string[], at: number, digits: number): [number, number] {
  const text = points.slice(at, at + digits).join("");
  if (text.length !== digits || !/^[0-9a-fA-F]+$/u.test(text)) unsupported("a short hex escape");
  return [Number.parseInt(text, 16), at + digits];
}

function escapedCode(points: string[], at: number, inClass: boolean): [number, number] | undefined {
  const letter = points[at] as string;
  if (letter === "x") return hexEscape(points, at + 1, 2);
  if (letter === "u") return hexEscape(points, at + 1, 4);
  if (letter === "U") return hexEscape(points, at + 1, 8);
  if (inClass && letter === "b") return [0x08, at + 1];
  const simple = SIMPLE_ESCAPES[letter];
  if (simple !== undefined) return [simple, at + 1];
  if (/^[\p{L}\p{N}]$/u.test(letter)) return undefined;
  return [letter.codePointAt(0) as number, at + 1];
}

function classItems(points: string[], start: number, ascii: boolean): [Item[], boolean, number] {
  let at = start;
  const negated = points[at] === "^";
  if (negated) at += 1;
  const items: Item[] = [];
  const pending: (Item | "-")[] = [];
  let first = true;
  for (;;) {
    const point = points[at];
    if (point === undefined) unsupported("an unterminated class");
    if (point === "]" && !first) {
      at += 1;
      break;
    }
    first = false;
    if (point === "\\") {
      const next = points[at + 1];
      if (next === undefined) unsupported("a trailing backslash");
      const set = classEscape(next, ascii);
      if (set !== undefined) {
        pending.push(set);
        at += 2;
        continue;
      }
      const code = escapedCode(points, at + 1, true);
      if (code === undefined) unsupported(`\\${next} in a class`);
      pending.push({ kind: "char", code: code[0] });
      at = code[1];
      continue;
    }
    if (point === "-" && pending.length > 0 && points[at + 1] !== "]" && pending[pending.length - 1] !== "-") {
      pending.push("-");
      at += 1;
      continue;
    }
    if (point === "[" && points[at + 1] === ":") unsupported("a POSIX class");
    pending.push({ kind: "char", code: point.codePointAt(0) as number });
    at += 1;
  }
  for (let index = 0; index < pending.length; index += 1) {
    const item = pending[index] as Item | "-";
    if (item === "-") unsupported("a dangling range");
    if (pending[index + 1] === "-") {
      const end = pending[index + 2];
      if (item.kind !== "char" || end === undefined || end === "-" || end.kind !== "char") unsupported("a bad character range");
      if (end.code < item.code) unsupported("a reversed character range");
      items.push({ kind: "set", body: `${literal(item.code)}-${literal(end.code)}` });
      index += 2;
      continue;
    }
    items.push(item);
  }
  return [items, negated, at];
}

function emitClass(items: Item[], negated: boolean): string {
  const positive = items
    .filter((item) => item.kind !== "negset")
    .map((item) => (item.kind === "char" ? literal(item.code) : (item as { body: string }).body))
    .join("");
  const negatives = items.filter((item): item is { kind: "negset"; body: string } => item.kind === "negset");
  if (negatives.length === 0) return negated ? `[^${positive}]` : `[${positive}]`;
  if (negated) unsupported("a negated class holding a negated escape");
  const parts = negatives.map((item) => `[^${item.body}]`);
  if (positive !== "") parts.unshift(`[${positive}]`);
  return `(?:${parts.join("|")})`;
}

export function translate(pattern: string, ascii: boolean): string {
  const points = codePoints(pattern);
  const out: string[] = [];
  let at = 0;
  while (at < points.length) {
    const point = points[at] as string;
    if (point === "\\") {
      const next = points[at + 1];
      if (next === undefined) unsupported("a trailing backslash");
      const set = classEscape(next, ascii);
      if (set !== undefined) {
        out.push(emitClass([set], false));
        at += 2;
        continue;
      }
      if (next === "A") {
        out.push("^");
        at += 2;
        continue;
      }
      if (next === "Z") {
        out.push("$");
        at += 2;
        continue;
      }
      if (next === "b" || next === "B") {
        if (!ascii) unsupported("a Unicode word boundary");
        out.push(`\\${next}`);
        at += 2;
        continue;
      }
      if (/^[1-9]$/u.test(next)) unsupported("a back reference");
      const code = escapedCode(points, at + 1, false);
      if (code === undefined) unsupported(`\\${next}`);
      out.push(literal(code[0]));
      at = code[1];
      continue;
    }
    if (point === "[") {
      const [items, negated, end] = classItems(points, at + 1, ascii);
      out.push(emitClass(items, negated));
      at = end;
      continue;
    }
    if (point === "(") {
      if (points[at + 1] === "?") {
        const opener = GROUP_OPENERS.find((candidate) => points.slice(at, at + candidate.length).join("") === candidate);
        if (opener === undefined) unsupported("a group extension");
        out.push(opener);
        at += opener.length;
        continue;
      }
      out.push("(");
      at += 1;
      continue;
    }
    if (point === ".") {
      out.push("[^\\n]");
      at += 1;
      continue;
    }
    if (point === "{") {
      const rest = points.slice(at, at + 32).join("");
      const quantifier = QUANTIFIER.exec(rest);
      if (quantifier !== null && (quantifier[1] !== "" || quantifier[2] !== undefined)) {
        const low = quantifier[1] === "" ? "0" : quantifier[1];
        out.push(quantifier[2] === undefined ? `{${low}}` : `{${low},${quantifier[3]}}`);
        at += codePoints(quantifier[0]).length;
        continue;
      }
      out.push(literal(0x7b));
      at += 1;
      continue;
    }
    if (point === "}" || point === "]") {
      out.push(literal(point.codePointAt(0) as number));
      at += 1;
      continue;
    }
    out.push(point);
    at += 1;
  }
  return out.join("");
}

const COMPILED = new Map<string, RegExp>();

export function compile(pattern: string, ascii: boolean): RegExp {
  const key = `${ascii ? "a" : "u"}:${pattern}`;
  const known = COMPILED.get(key);
  if (known !== undefined) return known;
  let compiled: RegExp;
  try {
    compiled = new RegExp(translate(pattern, ascii), "u");
  } catch (error) {
    if (error instanceof NeedsPython) throw error;
    throw new NeedsPython("a pattern this port can't translate");
  }
  COMPILED.set(key, compiled);
  return compiled;
}

export function search(pattern: string, ascii: boolean, text: string): boolean {
  return compile(pattern, ascii).test(text);
}
