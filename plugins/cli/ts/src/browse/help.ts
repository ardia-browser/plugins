import { isSpace, strip } from "../py.ts";
import { COMMANDS, OVERVIEW } from "./help-text.ts";

const PY_SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const LABEL = /^[A-Z][A-Za-z ]*:/;

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

function words(text: string): string[] {
  return text.split(new RegExp(`[${PY_SPACE}]+`)).filter((word) => word !== "");
}

export function commandHelp(name: string | undefined): string {
  if (!name) return OVERVIEW;
  if (Object.hasOwn(COMMANDS, name)) return COMMANDS[name] as string;
  const word = new RegExp(`(?:^|[${PY_SPACE}:,|])${escaped(name)}(?=$|[${PY_SPACE},|<\\[])`, "u");
  for (const line of OVERVIEW.split("\n")) {
    if (line.startsWith(" ") || line.slice(0, 13).includes(":")) {
      if (word.test(line)) return `ardia browse ${words(strip(line, isSpace).replace(LABEL, "")).join(" ")}\nflags: none`;
    }
  }
  return OVERVIEW;
}
