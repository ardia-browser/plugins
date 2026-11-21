const SPACE_SET = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const WORD_SET = "\\p{L}\\p{N}_";
const WORD = `[${WORD_SET}]`;
const BOUNDARY = `(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`;
const SYNTAX = new Set([..."^$\\.*+?()[]{}|/"]);
const CLASS_SYNTAX = new Set([..."^$\\.*+?()[]{}|/-"]);

function escapeOutside(ch: string, inClass: boolean): string | undefined {
  switch (ch) {
    case "d":
      return "\\p{Nd}";
    case "D":
      return inClass ? undefined : "\\P{Nd}";
    case "s":
      return inClass ? SPACE_SET : `[${SPACE_SET}]`;
    case "S":
      return inClass ? undefined : `[^${SPACE_SET}]`;
    case "w":
      return inClass ? WORD_SET : WORD;
    case "W":
      return inClass ? undefined : `[^${WORD_SET}]`;
    case "b":
      return inClass ? "\\x08" : BOUNDARY;
    case "Z":
      return inClass ? undefined : "$";
    default:
      return undefined;
  }
}

export function pyRegex(pattern: string, flags = ""): RegExp {
  let source = pattern;
  let extra = "";
  const inline = /^\(\?([a-z]+)\)/.exec(source);
  if (inline !== null) {
    if (inline[1]?.includes("i")) extra += "i";
    source = source.slice(inline[0].length);
  }
  let out = "";
  let inClass = false;
  for (let at = 0; at < source.length; at += 1) {
    const ch = source[at] as string;
    if (ch === "\\") {
      const next = source[at + 1] ?? "";
      at += 1;
      if (inClass && next === "S" && out.endsWith(SPACE_SET)) {
        out = `${out.slice(0, -SPACE_SET.length)}\\s\\S`;
        continue;
      }
      const mapped = escapeOutside(next, inClass);
      if (mapped !== undefined) out += mapped;
      else if (/[A-Za-z0-9]/.test(next)) {
        if (["D", "S", "W", "Z"].includes(next)) throw new Error(`pyRegex: \\${next} inside a class isn't supported`);
        out += `\\${next}`;
      } else if ((inClass ? CLASS_SYNTAX : SYNTAX).has(next)) out += `\\${next}`;
      else out += next;
      continue;
    }
    if (ch === "[" && !inClass) {
      inClass = true;
      out += ch;
      if (source[at + 1] === "^") {
        out += "^";
        at += 1;
      }
      if (source[at + 1] === "]") {
        out += "\\]";
        at += 1;
      }
      continue;
    }
    if (ch === "]" && inClass) inClass = false;
    else if (inClass && (ch === "[" || ch === "/" || ch === "{" || ch === "}" || ch === "(" || ch === ")" || ch === "|")) {
      out += `\\${ch}`;
      continue;
    }
    out += ch;
  }
  return new RegExp(out, `u${extra}${flags}`);
}
