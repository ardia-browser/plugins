import { codePoints } from "../pystr.ts";
import { decimalValue } from "./unicode.ts";

export const PY_SPACE_CLASS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const OTHER = "";

export type PyMatch = { groups: (string | undefined)[]; digits: (string | undefined)[] };

export class DigitPattern {
  private readonly pattern: RegExp;

  constructor(source: string, flags = "") {
    this.pattern = new RegExp(`^(?:${source.replaceAll("\\s", `[${PY_SPACE_CLASS}]`)})$`, `${flags}d`);
  }

  fullmatch(text: string): PyMatch | undefined {
    const points = codePoints(text);
    let mapped = "";
    let digits = "";
    for (const point of points) {
      const code = point.codePointAt(0) as number;
      const value = code < 0x80 ? -1 : decimalValue(code);
      if (value >= 0) {
        mapped += String.fromCharCode(0x30 + value);
        digits += String.fromCharCode(0x30 + value);
      } else {
        const unit = point.length === 1 ? point : OTHER;
        mapped += unit;
        digits += unit;
      }
    }
    const match = this.pattern.exec(mapped);
    if (match === null || match.indices === undefined) return undefined;
    const groups: (string | undefined)[] = [];
    const ascii: (string | undefined)[] = [];
    for (let index = 1; index < match.length; index += 1) {
      const span = match.indices[index];
      groups.push(span === undefined ? undefined : points.slice(span[0], span[1]).join(""));
      ascii.push(span === undefined ? undefined : digits.slice(span[0], span[1]));
    }
    return { groups, digits: ascii };
  }
}
