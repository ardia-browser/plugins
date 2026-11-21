import decimals from "../../py-decimals.txt" with { type: "text" };
export const SPLIT = 0xffff;
export const SPLIT_TEXT = String.fromCharCode(SPLIT);
const SPLIT_AFTER_HIGH = /([\ud800-\udbff])￿/g;

export function isHigh(unit: number): boolean {
  return unit >= 0xd800 && unit < 0xdc00;
}

export function isLow(unit: number): boolean {
  return unit >= 0xdc00 && unit < 0xe000;
}

export function splitsAfterHigh(unit: number): boolean {
  return isLow(unit) || unit === SPLIT;
}

export function joinPy(left: string, right: string): string {
  if (left === "" || right === "") return left + right;
  return isHigh(left.charCodeAt(left.length - 1)) && splitsAfterHigh(right.charCodeAt(0)) ? left + SPLIT_TEXT + right : left + right;
}

export function joinCodePoints(points: string[]): string {
  let out = "";
  for (const point of points) out = joinPy(out, point);
  return out;
}

export function codePoints(text: string): string[] {
  const out: string[] = [];
  for (let at = 0; at < text.length; ) {
    const unit = text.charCodeAt(at);
    if (isHigh(unit)) {
      const next = text.charCodeAt(at + 1);
      if (next === SPLIT) {
        out.push(text[at] as string);
        at += 2;
        continue;
      }
      if (isLow(next)) {
        out.push(text.slice(at, at + 2));
        at += 2;
        continue;
      }
    }
    out.push(text[at] as string);
    at += 1;
  }
  return out;
}

export function codePointCount(text: string): number {
  let count = text.length;
  for (let at = 0; at < text.length - 1; at += 1) {
    if (!isHigh(text.charCodeAt(at))) continue;
    const next = text.charCodeAt(at + 1);
    if (next === SPLIT || isLow(next)) {
      count -= 1;
      at += 1;
    }
  }
  return count;
}

export function plain(text: string): string {
  return text.includes(SPLIT_TEXT) ? text.replace(SPLIT_AFTER_HIGH, "$1") : text;
}

export function utf8(text: string): Buffer {
  return Buffer.from(plain(text), "utf8");
}

const DECIMAL_RANGES: [number, number][] = decimals
  .split("\n")
  .filter((line) => line !== "")
  .map((line) => {
    const [start = "", end = ""] = line.split(" ");
    return [Number.parseInt(start, 16), Number.parseInt(end, 16)];
  });

export function isDecimal(ch: string): boolean {
  const code = ch.codePointAt(0) ?? -1;
  return DECIMAL_RANGES.some(([start, end]) => code >= start && code <= end);
}

export function decimalDigit(ch: string): number | undefined {
  const code = ch.codePointAt(0) ?? -1;
  const range = DECIMAL_RANGES.find(([start, end]) => code >= start && code <= end);
  return range === undefined ? undefined : (code - range[0]) % 10;
}
