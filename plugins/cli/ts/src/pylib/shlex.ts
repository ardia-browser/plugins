import { codePoints, joinPy } from "../pystr.ts";
import { PyException } from "./str.ts";

const UNSAFE = /[^A-Za-z0-9_@%+=:,./-]/;

export function shlexQuote(text: string): string {
  if (!text) return "''";
  if (!UNSAFE.test(text)) return text;
  return `'${text.replaceAll("'", "'\"'\"'")}'`;
}

const WHITESPACE = new Set([" ", "\t", "\r", "\n"]);

export function shlexSplit(text: string): string[] {
  const chars = codePoints(text);
  const out: string[] = [];
  let at = 0;
  let state: string | null = " ";
  for (;;) {
    let quoted = false;
    let escapedState = " ";
    let token = "";
    for (;;) {
      const next = at < chars.length ? (chars[at] as string) : "";
      at += 1;
      if (state === null) {
        token = "";
        break;
      }
      if (state === " ") {
        if (!next) {
          state = null;
          break;
        }
        if (WHITESPACE.has(next)) {
          if (token || quoted) break;
          continue;
        }
        if (next === "\\") {
          escapedState = "a";
          state = next;
        } else if (next === "'" || next === '"') state = next;
        else {
          token = next;
          state = "a";
        }
      } else if (state === "'" || state === '"') {
        quoted = true;
        if (!next) throw new PyException("ValueError", "No closing quotation");
        if (next === state) state = "a";
        else if (next === "\\" && state === '"') {
          escapedState = state;
          state = next;
        } else token = joinPy(token, next);
      } else if (state === "\\") {
        if (!next) throw new PyException("ValueError", "No escaped character");
        if ((escapedState === "'" || escapedState === '"') && next !== state && next !== escapedState) token = joinPy(token, state);
        token = joinPy(token, next);
        state = escapedState;
      } else {
        if (!next) {
          state = null;
          break;
        }
        if (WHITESPACE.has(next)) {
          state = " ";
          if (token || quoted) break;
          continue;
        }
        if (next === "'" || next === '"') state = next;
        else if (next === "\\") {
          escapedState = "a";
          state = next;
        } else token = joinPy(token, next);
      }
    }
    if (!quoted && token === "") return out;
    out.push(token);
  }
}
