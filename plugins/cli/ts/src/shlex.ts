import { NeedsPython } from "./paths.ts";

const WHITESPACE = " \t\r\n";
const QUOTES = "'\"";

export function split(text: string): string[] {
  const out: string[] = [];
  let state = " ";
  let escaped = "a";
  let token = "";
  let quoted = false;
  const emit = () => {
    if (token !== "" || quoted) out.push(token);
    token = "";
    quoted = false;
  };
  for (const ch of text) {
    if (state === " " || state === "a") {
      if (WHITESPACE.includes(ch)) {
        if (state === "a") emit();
        state = " ";
      } else if (ch === "\\") {
        escaped = "a";
        state = "\\";
      } else if (QUOTES.includes(ch)) {
        quoted = true;
        state = ch;
      } else {
        token += ch;
        state = "a";
      }
    } else if (state === "\\") {
      if (QUOTES.includes(escaped) && ch !== escaped && ch !== "\\") token += "\\";
      token += ch;
      state = escaped;
    } else if (ch === state) state = "a";
    else if (ch === "\\" && state === '"') {
      escaped = '"';
      state = "\\";
    } else token += ch;
  }
  if (QUOTES.includes(state)) throw new NeedsPython("an editor variable with no closing quotation");
  if (state === "\\") throw new NeedsPython("an editor variable ending in a backslash");
  if (state === "a" || token !== "" || quoted) emit();
  return out;
}
