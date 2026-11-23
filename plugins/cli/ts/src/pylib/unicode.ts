import { ALPHA, CASEFOLD, DECIMAL_ZEROS, DIGIT, NOT_PRINTABLE, WORD } from "./unicode-data.ts";

type Ranges = { starts: Uint32Array; ends: Uint32Array };

function unpack(text: string): Ranges {
  const spans = text.split(" ");
  const starts = new Uint32Array(spans.length);
  const ends = new Uint32Array(spans.length);
  spans.forEach((span, index) => {
    const [start = "", end = start] = span.split("-");
    starts[index] = Number.parseInt(start, 16);
    ends[index] = Number.parseInt(end, 16);
  });
  return { starts, ends };
}

function lazyRanges(text: string): (code: number) => boolean {
  let table: Ranges | undefined;
  return (code) => {
    table ??= unpack(text);
    let low = 0;
    let high = table.starts.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (code < (table.starts[middle] as number)) high = middle - 1;
      else if (code > (table.ends[middle] as number)) low = middle + 1;
      else return true;
    }
    return false;
  };
}

const notPrintable = lazyRanges(NOT_PRINTABLE);
const digit = lazyRanges(DIGIT);
const word = lazyRanges(WORD);
const alpha = lazyRanges(ALPHA);

export function isPrintableCode(code: number): boolean {
  return !notPrintable(code);
}

export function isDigitCode(code: number): boolean {
  return code >= 0x30 && code <= 0x39 ? true : code < 0x80 ? false : digit(code);
}

export function isWordCode(code: number): boolean {
  if (code < 0x80) return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x5f;
  return word(code);
}

export function isAlphaCode(code: number): boolean {
  if (code < 0x80) return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
  return alpha(code);
}

let zeros: Uint32Array | undefined;

export function decimalValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code < 0x80) return -1;
  zeros ??= Uint32Array.from(DECIMAL_ZEROS.split(" "), (zero) => Number.parseInt(zero, 16));
  let low = 0;
  let high = zeros.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((zeros[middle] as number) <= code) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  if (found < 0) return -1;
  const value = code - (zeros[found] as number);
  return value <= 9 ? value : -1;
}

let folds: Map<number, string> | undefined;

function foldTable(): Map<number, string> {
  if (folds) return folds;
  folds = new Map();
  for (const pair of CASEFOLD.split(" ")) {
    const [code = "", parts = ""] = pair.split(":");
    folds.set(Number.parseInt(code, 16), String.fromCodePoint(...parts.split(",").map((part) => Number.parseInt(part, 16))));
  }
  return folds;
}

function asciiOnly(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) > 0x7f) return false;
  return true;
}

export function casefold(text: string): string {
  if (asciiOnly(text)) return text.toLowerCase();
  const table = foldTable();
  let out = "";
  for (let index = 0; index < text.length; ) {
    const code = text.codePointAt(index) as number;
    const width = code > 0xffff ? 2 : 1;
    out += table.get(code) ?? text.slice(index, index + width);
    index += width;
  }
  return out;
}

export function isAscii(text: string): boolean {
  return asciiOnly(text);
}
