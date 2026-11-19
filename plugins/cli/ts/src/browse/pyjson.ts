import { decodeJsonBytes } from "../json-bytes.ts";
import { parseText, TooDeep, type Value } from "../json.ts";
import { codePoints } from "../pystr.ts";
import { builtinCrash, PythonCrash } from "./errors.ts";

const PY_INT_MAX_STR_DIGITS = 4300;
const SPACE = new Set([" ", "\t", "\n", "\r"]);
const ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);

class Failed {
  constructor(
    readonly message: string,
    readonly at: number,
  ) {}
}

class Stop {
  constructor(readonly at: number) {}
}

const digit = (ch: string | undefined) => ch !== undefined && ch >= "0" && ch <= "9";
const hex = (ch: string | undefined) => ch !== undefined && /^[0-9a-fA-F]$/.test(ch);

class Scanner {
  depth = 0;
  constructor(
    readonly cp: string[],
    readonly depthLimit: number,
  ) {}

  space(at: number): number {
    while (at < this.cp.length && SPACE.has(this.cp[at] as string)) at += 1;
    return at;
  }

  word(at: number, word: string): boolean {
    return this.cp.slice(at, at + word.length).join("") === word;
  }

  value(at: number): number {
    const ch = this.cp[at];
    if (ch === undefined) throw new Stop(at);
    if (ch === '"') return this.string(at + 1);
    if (ch === "{" || ch === "[") {
      this.depth += 1;
      if (this.depth > this.depthLimit) {
        const what = ch === "{" ? "object" : "array";
        throw builtinCrash("RecursionError", `maximum recursion depth exceeded while decoding a JSON ${what} from a unicode string`);
      }
      const end = ch === "{" ? this.object(at + 1) : this.array(at + 1);
      this.depth -= 1;
      return end;
    }
    for (const word of ["null", "true", "false", "NaN", "Infinity", "-Infinity"]) {
      if (ch === word[0] && this.word(at, word)) return at + word.length;
    }
    return this.number(at);
  }

  number(start: number): number {
    let at = start;
    if (this.cp[at] === "-") at += 1;
    if (this.cp[at] !== undefined && this.cp[at] !== "0" && digit(this.cp[at])) while (digit(this.cp[at])) at += 1;
    else if (this.cp[at] === "0") at += 1;
    else throw new Stop(start);
    let float = false;
    if (this.cp[at] === "." && digit(this.cp[at + 1])) {
      float = true;
      at += 2;
      while (digit(this.cp[at])) at += 1;
    }
    if (this.cp[at] === "e" || this.cp[at] === "E") {
      const mark = at;
      at += 1;
      if (this.cp[at] === "-" || this.cp[at] === "+") at += 1;
      const digits = at;
      while (digit(this.cp[at])) at += 1;
      if (at > digits) float = true;
      else at = mark;
    }
    const count = at - start - (this.cp[start] === "-" ? 1 : 0);
    if (!float && count > PY_INT_MAX_STR_DIGITS) {
      throw builtinCrash(
        "ValueError",
        `Exceeds the limit (${PY_INT_MAX_STR_DIGITS} digits) for integer string conversion: value has ${count} digits; use sys.set_int_max_str_digits() to increase the limit`,
      );
    }
    return at;
  }

  quad(at: number): number | undefined {
    if (at + 4 > this.cp.length) return undefined;
    const digits = this.cp.slice(at, at + 4);
    return digits.every(hex) ? Number.parseInt(digits.join(""), 16) : undefined;
  }

  string(at: number): number {
    const begin = at - 1;
    for (;;) {
      let ch: string | undefined;
      for (; at < this.cp.length; at += 1) {
        ch = this.cp[at] as string;
        if (ch === '"' || ch === "\\") break;
        if (ch.length === 1 && ch.charCodeAt(0) <= 0x1f) throw new Failed("Invalid control character at", at);
      }
      if (at >= this.cp.length) throw new Failed("Unterminated string starting at", begin);
      at += 1;
      if (ch === '"') return at;
      if (at >= this.cp.length) throw new Failed("Unterminated string starting at", begin);
      const escape = this.cp[at] as string;
      if (escape !== "u") {
        if (!ESCAPES.has(escape)) throw new Failed("Invalid \\escape", at - 1);
        at += 1;
        continue;
      }
      const unit = this.quad(at + 1);
      if (unit === undefined) throw new Failed("Invalid \\uXXXX escape", at);
      at += 5;
      if (unit >= 0xd800 && unit < 0xdc00 && this.cp[at] === "\\" && this.cp[at + 1] === "u") {
        const low = this.quad(at + 2);
        if (low === undefined) throw new Failed("Invalid \\uXXXX escape", at + 1);
        if (low >= 0xdc00 && low < 0xe000) at += 6;
      }
    }
  }

  object(at: number): number {
    at = this.space(at);
    if (this.cp[at] === "}") return at + 1;
    for (;;) {
      if (this.cp[at] !== '"') throw new Failed("Expecting property name enclosed in double quotes", at);
      at = this.space(this.string(at + 1));
      if (this.cp[at] !== ":") throw new Failed("Expecting ':' delimiter", at);
      at = this.space(this.value(this.space(at + 1)));
      if (this.cp[at] === "}") return at + 1;
      if (this.cp[at] !== ",") throw new Failed("Expecting ',' delimiter", at);
      const comma = at;
      at = this.space(at + 1);
      if (this.cp[at] === "}") throw new Failed("Illegal trailing comma before end of object", comma);
    }
  }

  array(at: number): number {
    at = this.space(at);
    if (this.cp[at] === "]") return at + 1;
    for (;;) {
      at = this.space(this.value(at));
      if (this.cp[at] === "]") return at + 1;
      if (this.cp[at] !== ",") throw new Failed("Expecting ',' delimiter", at);
      const comma = at;
      at = this.space(at + 1);
      if (this.cp[at] === "]") throw new Failed("Illegal trailing comma before end of array", comma);
    }
  }
}

function decodeError(cp: string[], message: string, at: number): PythonCrash {
  const before = cp.slice(0, at);
  const line = before.filter((ch) => ch === "\n").length + 1;
  const column = at - before.lastIndexOf("\n");
  return new PythonCrash(
    { kind: "JSONDecodeError", value: "JSONDecodeError" },
    `json.decoder.JSONDecodeError: ${message}: line ${line} column ${column} (char ${at})`,
  );
}

function locate(text: string, depthLimit: number): PythonCrash | undefined {
  const cp = codePoints(text);
  const scanner = new Scanner(cp, depthLimit);
  try {
    const start = scanner.space(0);
    let end: number;
    try {
      end = scanner.value(start);
    } catch (error) {
      if (error instanceof Stop) return decodeError(cp, "Expecting value", error.at);
      throw error;
    }
    end = scanner.space(end);
    return end === cp.length ? undefined : decodeError(cp, "Extra data", end);
  } catch (error) {
    if (error instanceof Failed) return decodeError(cp, error.message, error.at);
    if (error instanceof Stop) return decodeError(cp, "Expecting value", error.at);
    if (error instanceof PythonCrash) return error;
    throw error;
  }
}

function needed(lead: number): [number, number, number] {
  if (lead >= 0xc2 && lead <= 0xdf) return [1, 0x80, 0xbf];
  if (lead === 0xe0) return [2, 0xa0, 0xbf];
  if (lead === 0xed) return [2, 0x80, 0xbf];
  if (lead >= 0xe1 && lead <= 0xef) return [2, 0x80, 0xbf];
  if (lead === 0xf0) return [3, 0x90, 0xbf];
  if (lead === 0xf4) return [3, 0x80, 0x8f];
  if (lead >= 0xf1 && lead <= 0xf3) return [3, 0x80, 0xbf];
  return [0, 0, 0];
}

function utf8Error(bytes: Uint8Array): PythonCrash {
  for (let at = 0; at < bytes.length; ) {
    const lead = bytes[at] as number;
    if (lead < 0x80) {
      at += 1;
      continue;
    }
    const [more, low, high] = needed(lead);
    let reason = "invalid start byte";
    let end = at + 1;
    if (more > 0) {
      reason = "";
      for (let index = 1; index <= more; index += 1) {
        const byte = bytes[at + index];
        const [min, max] = index === 1 ? [low, high] : [0x80, 0xbf];
        if (byte === undefined) {
          reason = "unexpected end of data";
          end = bytes.length;
          break;
        }
        if (byte < min || byte > max) {
          reason = "invalid continuation byte";
          end = at + index;
          break;
        }
      }
      if (reason === "") {
        at += more + 1;
        continue;
      }
    }
    const where = end - at === 1 ? `byte 0x${lead.toString(16).padStart(2, "0")} in position ${at}` : `bytes in position ${at}-${end - 1}`;
    return builtinCrash("UnicodeDecodeError", `'utf-8' codec can't decode ${where}: ${reason}`);
  }
  return builtinCrash("UnicodeDecodeError", "'utf-8' codec can't decode the answer");
}

export function loadAnswer(raw: Uint8Array, depthLimit: number): Value | PythonCrash {
  const text = decodeJsonBytes(raw);
  if (text === undefined) return utf8Error(raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? raw.subarray(3) : raw);
  try {
    const value = parseText(text, depthLimit);
    if (value !== undefined) return value;
  } catch (error) {
    if (!(error instanceof TooDeep)) throw error;
  }
  return locate(text, depthLimit) ?? builtinCrash("ValueError", "the answer isn't JSON");
}
