import { isSpace, strip } from "./py.ts";

const LINE_BREAKS = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

export function pyStrip(text: string): string {
  return strip(text, isSpace);
}

export function pySplitlines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(new RegExp(LINE_BREAKS.source, "g"));
  if (lines.length > 0 && lines[lines.length - 1] === "" && LINE_BREAKS.test(text.slice(-2))) lines.pop();
  return lines;
}

export function shellQuote(text: string): string {
  if (text === "") return "''";
  if (!/[^\w@%+=:,./-]/.test(text)) return text;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

export function shellJoin(words: readonly string[]): string {
  return words.map(shellQuote).join(" ");
}
