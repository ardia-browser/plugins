import { isatty } from "node:tty";
import { charCount, isWhitespace, left, strip } from "./py.ts";

const DESCRIPTION =
  "Control a running Ardia from the terminal. ardia browse drives the browser (ardia browse --help); ardia computer operates native Mac apps through the bundled cua-driver (ardia computer --help). Agents: skip if an ardia skill is already in your context; otherwise run ardia --skill.";

const EPILOG = `Shared options go before the command or after it, for the commands that take them:
  --port N        a plain DevTools server on 127.0.0.1:N (testing; $ARDIA_PORT)
  --ws URL        a browser WebSocket URL ($ARDIA_WS)
  --data-dir DIR  the Ardia data dir ($ARDIA_DATA_DIR, else the installed app's)
  --timeout S     and --json
A flag wins over its environment variable.

Examples:
  ardia --port 9222 browse snapshot -i
  ardia browse --port 9222 snapshot -i
  ardia windows --json
  ardia tabs --json
  ardia groups create tab-1 tab-2 --name Work --icon \u{1f680}
  ardia methods
  ardia call run -p command=newTab
`;

const COMMANDS: [string, string][] = [
  ["browse", "drive the browser with agent-browser's commands (ardia browse --help)"],
  ["notes", "read and write notes (ardia notes --help)"],
  ["computer", "operate native Mac apps through the bundled cua-driver: computer use (ardia computer --help)"],
  ["pinned", "list favorites and pinned tabs"],
  ["history", "list recent history"],
  ["skills", "print or install the ardia agent skill"],
  ["scripts", "write, test and install userscripts"],
  ["config", "read, write and check config.json"],
  ["theme", "make, pick, edit and check themes"],
  ["run", "run one of Ardia's commands"],
  ["commands", "list the commands ardia run can run"],
  ["windows", "list Ardia's windows and their tabs"],
  ["events", "print events as they happen"],
  ["on", "run a program for each event"],
  ["hooks", "run hooks from hooks.json, at login if you like"],
  ["tabs", "list and organize tabs"],
  ["groups", "list and organize tab groups"],
  ["apply", "apply several tab and group operations at once (JSON)"],
  ["call", "send any method to Ardia's control socket (ardia methods lists them)"],
  ["methods", "list the methods ardia call can send"],
  ["plugins", "install, list and manage plugins"],
  ["feedback", "report a problem or idea to Ardia's developer (agents welcome)"],
  ["star", "star the Ardia repo on GitHub, only after the user says yes"],
];

const OPTIONS: [string, string][] = [
  ["-h, --help", "show this help message and exit"],
  ["--version", "show program's version number and exit"],
  ["--skill", "print the agent skill that ships with this ardia (SKILL.md) and exit; same as ardia skills get"],
];

const I64_MAX = (1n << 63n) - 1n;
const U64_MAX = (1n << 64n) - 1n;
const USAGE = "ardia [-h] [--version] [--skill] <command> ...";

function isLetter(ch: string | undefined): boolean {
  return ch !== undefined && /^[\p{Alphabetic}\p{N}_]$/u.test(ch) && !/^\p{N}$/u.test(ch);
}

function chunks(text: string): string[] | undefined {
  const out: string[] = [];
  const words = text.split(" ");
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (index > 0) out.push(" ");
    if (word.includes("--") && !word.startsWith("--")) return undefined;
    const chars = [...word];
    let start = 0;
    for (let at = 1; at < chars.length; at += 1) {
      if (chars[at] !== "-" || at < 2 || at - start < 1) continue;
      const before = isLetter(chars[at - 1]) && isLetter(chars[at - 2]);
      const alternate = at >= 3 && isLetter(chars[at - 1]) && chars[at - 2] === "-" && isLetter(chars[at - 3]);
      const next = isLetter(chars[at + 1]) && (isLetter(chars[at + 2]) || (chars[at + 2] === "-" && isLetter(chars[at + 3])));
      if ((before || alternate) && next) {
        out.push(chars.slice(start, at + 1).join(""));
        start = at + 1;
      }
    }
    out.push(chars.slice(start).join(""));
  }
  return out.filter((chunk) => chunk !== "");
}

const blank = (chunk: string | undefined) => chunk !== undefined && strip(chunk, isWhitespace) === "";

function wrap(text: string, width: number): string[] | undefined {
  const pending = chunks(text)?.reverse();
  if (pending === undefined) return undefined;
  const lines: string[] = [];
  while (pending.length > 0) {
    const line: string[] = [];
    let size = 0;
    if (lines.length > 0 && blank(pending[pending.length - 1])) pending.pop();
    for (let chunk = pending[pending.length - 1]; chunk !== undefined; chunk = pending[pending.length - 1]) {
      const length = charCount(chunk);
      if (size + length > width) break;
      size += length;
      line.push(chunk);
      pending.pop();
    }
    const last = pending[pending.length - 1];
    if (last !== undefined && charCount(last) > width) return undefined;
    if (blank(line[line.length - 1])) line.pop();
    if (line.length > 0) lines.push(line.join(""));
  }
  return lines;
}

function columns(): number | undefined {
  const fromEnv = process.env.COLUMNS === undefined ? undefined : strip(process.env.COLUMNS, isWhitespace);
  const linesText = process.env.LINES === undefined ? undefined : strip(process.env.LINES, isWhitespace);
  const linesSet = linesText !== undefined && /^[+-]?[0-9]+$/.test(linesText) && BigInt(linesText) > 0n && BigInt(linesText) <= I64_MAX;
  let parsed = 0;
  if (fromEnv !== undefined && fromEnv !== "") {
    const digits = fromEnv.startsWith("+") ? fromEnv.slice(1) : fromEnv;
    if (digits === "" || !/^[0-9]+$/.test(digits)) {
      const negative = /^-[0-9]+$/.test(fromEnv);
      if (!negative && /\p{N}/u.test(fromEnv)) return undefined;
    } else {
      const value = BigInt(digits);
      if (value > U64_MAX) return undefined;
      parsed = Number(value);
    }
  }
  if (parsed > 0 && linesSet) return parsed;
  const terminal = isatty(1);
  if (parsed > 0) return parsed;
  const width = terminal ? (process.stdout.columns ?? 0) : 0;
  return terminal && width > 0 ? width : 80;
}

export function render(): string | undefined {
  const width = columns();
  return width === undefined ? undefined : renderAt(width);
}

export function renderAt(columnCount: number): string | undefined {
  if (columnCount < 2) return undefined;
  const width = columnCount - 2;
  const maxHelpPosition = Math.min(24, Math.max(width - 20, 4));
  const longest = Math.max(
    ...COMMANDS.map(([name]) => charCount(name) + 4),
    ...OPTIONS.map(([name]) => charCount(name) + 2),
    "<command>".length + 2,
  );
  const helpPosition = Math.min(longest + 2, maxHelpPosition);
  const helpWidth = Math.max(width - helpPosition, 11);
  if ("usage: ".length + USAGE.length > width) return undefined;
  const item = (indent: number, name: string, help: string): string | undefined => {
    const actionWidth = helpPosition - (indent + 2);
    if (actionWidth < 0) return undefined;
    const lines = wrap(help, helpWidth);
    const first = lines?.[0];
    if (lines === undefined || first === undefined) return undefined;
    let out =
      charCount(name) <= actionWidth
        ? `${" ".repeat(indent)}${left(name, actionWidth)}  ${first}\n`
        : `${" ".repeat(indent)}${name}\n${" ".repeat(helpPosition)}${first}\n`;
    for (const line of lines.slice(1)) out += `${" ".repeat(helpPosition)}${line}\n`;
    return out;
  };
  let text = `usage: ${USAGE}\n\n${DESCRIPTION}\n\n\npositional arguments:\n  <command>\n`;
  for (const [name, help] of COMMANDS) {
    const shown = item(4, name, help);
    if (shown === undefined) return undefined;
    text += shown;
  }
  text += "\n\noptions:\n";
  for (const [name, help] of OPTIONS) {
    const shown = item(2, name, help);
    if (shown === undefined) return undefined;
    text += shown;
  }
  text += `\n${EPILOG}\n\n`;
  while (text.includes("\n\n\n")) text = text.replaceAll("\n\n\n", "\n\n");
  return `${text.replace(/^\n+/, "").replace(/\n+$/, "")}\n`;
}
