import { charCount, isSpace, strip } from "./py.ts";
import { codePoints, joinCodePoints } from "./pystr.ts";

const WS = "[\\t\\n\\x0b\\x0c\\r ]";
const NO_WS = "[^\\t\\n\\x0b\\x0c\\r ]";
const WORD_PUNCT = "[\\p{L}\\p{N}_!\"'&.,?]";
const LETTER = "(?:(?!\\p{Nd})[\\p{L}\\p{N}_])";
const WORD = "[\\p{L}\\p{N}_]";
const WORD_SEPARATOR = new RegExp(
  `(${WS}+|(?<=${WORD_PUNCT})-{2,}(?=${WORD})|${NO_WS}+?(?:-(?:(?<=${LETTER}{2}-)|(?<=${LETTER}-${LETTER}-))(?=${LETTER}-?${LETTER})|(?=${WS}|$)|(?<=${WORD_PUNCT})(?=-{2,}${WORD})))`,
  "u",
);

function chunksOf(text: string): string[] {
  return text.split(WORD_SEPARATOR).filter((chunk) => chunk !== undefined && chunk !== "");
}

function blank(chunk: string): boolean {
  return strip(chunk, isSpace) === "";
}

function handleLongWord(reversed: string[], line: string[], used: number, width: number): void {
  const spaceLeft = width < 1 ? 1 : width - used;
  if (spaceLeft > 0) {
    const chunk = codePoints(reversed[reversed.length - 1] as string);
    let end = spaceLeft;
    if (chunk.length > spaceLeft) {
      const hyphen = chunk.slice(0, spaceLeft).lastIndexOf("-");
      if (hyphen > 0 && chunk.slice(0, hyphen).some((ch) => ch !== "-")) end = hyphen + 1;
    }
    line.push(joinCodePoints(chunk.slice(0, end)));
    reversed[reversed.length - 1] = joinCodePoints(chunk.slice(end));
  } else if (line.length === 0) line.push(reversed.pop() as string);
}

export function wrap(text: string, width: number, initialIndent = "", subsequentIndent = ""): string[] {
  if (width <= 0) throw new RangeError(`invalid width ${width} (must be > 0)`);
  const reversed = chunksOf(text.replace(/[\t\n\x0b\x0c\r]/g, " ")).reverse();
  const lines: string[] = [];
  while (reversed.length > 0) {
    const line: string[] = [];
    let used = 0;
    const indent = lines.length > 0 ? subsequentIndent : initialIndent;
    const room = width - charCount(indent);
    if (lines.length > 0 && blank(reversed[reversed.length - 1] as string)) reversed.pop();
    while (reversed.length > 0) {
      const size = charCount(reversed[reversed.length - 1] as string);
      if (used + size > room) break;
      line.push(reversed.pop() as string);
      used += size;
    }
    if (reversed.length > 0 && charCount(reversed[reversed.length - 1] as string) > room) {
      handleLongWord(reversed, line, used, room);
    }
    if (line.length > 0 && blank(line[line.length - 1] as string)) line.pop();
    if (line.length > 0) lines.push(indent + line.join(""));
  }
  return lines;
}

export function fill(text: string, width: number, initialIndent = "", subsequentIndent = ""): string {
  return wrap(text, width, initialIndent, subsequentIndent).join("\n");
}
