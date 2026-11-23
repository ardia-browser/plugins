import { isSpace } from "./py.ts";
import { codePoints } from "./pystr.ts";

const UNPRINTABLE = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]$/u;
const DECIMAL = /^\p{Nd}$/u;
const MAX_STR_DIGITS = 4300;

function hex(code: number, size: number): string {
  return code.toString(16).padStart(size, "0");
}

export function reprText(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    if (ch === quote || ch === "\\") out += `\\${ch}`;
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (code < 0x20 || code === 0x7f) out += `\\x${hex(code, 2)}`;
    else if (code < 0x7f || ch === " ") out += ch;
    else if (!UNPRINTABLE.test(ch)) out += ch;
    else if (code <= 0xff) out += `\\x${hex(code, 2)}`;
    else if (code <= 0xffff) out += `\\u${hex(code, 4)}`;
    else out += `\\U${hex(code, 8)}`;
  }
  return out + quote;
}

function decimalValue(ch: string): number | undefined {
  if (ch >= "0" && ch <= "9") return ch.charCodeAt(0) - 48;
  if (!DECIMAL.test(ch)) return undefined;
  const code = ch.codePointAt(0) as number;
  let start = code;
  while (DECIMAL.test(String.fromCodePoint(start - 1))) start -= 1;
  return (code - start) % 10;
}

function asciiDigits(text: string): string | undefined {
  let out = "";
  for (const ch of text) {
    const digit = decimalValue(ch);
    if (digit !== undefined) out += String(digit);
    else if ((ch.codePointAt(0) as number) < 0x7f) out += ch;
    else if (isSpace(ch)) out += " ";
    else return undefined;
  }
  return out;
}

function asciiStripped(text: string): string | undefined {
  return asciiDigits(text)?.replace(/^[ \t\n\x0b\x0c\r]+|[ \t\n\x0b\x0c\r]+$/g, "");
}

const INT_TEXT = /^[+-]?[0-9](?:_?[0-9])*$/;
const DIGIT_PART = "[0-9](?:_?[0-9])*";
const FLOAT_TEXT = new RegExp(`^[+-]?(?:(?:${DIGIT_PART}(?:\\.(?:${DIGIT_PART})?)?|\\.${DIGIT_PART})(?:[eE][+-]?${DIGIT_PART})?|inf|infinity|nan)$`, "i");

export function pyInt(text: string): bigint | undefined {
  const plain = asciiStripped(text);
  if (plain === undefined || !INT_TEXT.test(plain)) return undefined;
  const digits = plain.replace(/[+_-]/g, "");
  if (digits.length > MAX_STR_DIGITS) return undefined;
  return BigInt(plain.replaceAll("_", "").replace(/^\+/, ""));
}

export function pyFloat(text: string): number | undefined {
  const plain = asciiStripped(text);
  if (plain === undefined || !FLOAT_TEXT.test(plain)) return undefined;
  const bare = plain.replaceAll("_", "").toLowerCase();
  const negative = bare.startsWith("-");
  const unsigned = bare.replace(/^[+-]/, "");
  if (unsigned === "nan") return Number.NaN;
  if (unsigned === "inf" || unsigned === "infinity") return negative ? -Infinity : Infinity;
  return Number(bare);
}

export function codePointLength(text: string): number {
  return codePoints(text).length;
}
