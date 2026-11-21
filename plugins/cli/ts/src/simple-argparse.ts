import { isatty } from "node:tty";
import { NeedsPython } from "./paths.ts";
import { reprStr } from "./py.ts";

export type OptionSpec = { long: string; short?: string; kind: "help" | "flag" | "value"; choices?: readonly string[]; repeat?: boolean; float?: boolean };
export type ParseExtras = { positionals?: readonly string[]; extrasUsage?: string; extrasProg?: string; usageLine?: string; explicitUsage?: boolean };
export type Parsed = { kind: "ok"; flags: Set<string>; values: Map<string, string>; repeated: Map<string, string[]>; positionals: string[] } | { kind: "exit"; status: number; stdout: string; stderr: string };

const NEGATIVE = /^-\d+$|^-\d*\.\d+$/;

export function terminalColumns(): number {
  const given = process.env.COLUMNS;
  if (given !== undefined) {
    if (/^\s*[+]?\d+\s*$/.test(given)) {
      const columns = Number(given.trim());
      if (columns > 0) return columns;
    } else if (/^\s*[+-]?[\d_]+\s*$/.test(given)) throw new NeedsPython("COLUMNS that only Python's int() reads");
  }
  if (isatty(1)) {
    const columns = process.stdout.columns;
    if (typeof columns === "number" && columns > 0) return columns;
  }
  return 80;
}

export function requireDefaultWidth(): void {
  if (terminalColumns() !== 80) throw new NeedsPython("argparse output wrapped to a width other than 78");
}

function fitted(wrappedAt80: string, line: string): string {
  const columns = terminalColumns();
  if (!line.slice(0, -1).includes("\n") && line.length - 1 <= columns - 2) return line;
  if (columns === 80) return wrappedAt80;
  throw new NeedsPython("a usage line argparse wraps to another width");
}

function argumentName(option: OptionSpec): string {
  return option.short === undefined ? option.long : `${option.short}/${option.long}`;
}

export function parseOptions(argv: readonly string[], options: readonly OptionSpec[], prog: string, usage: string, help: string, more: ParseExtras = {}): Parsed {
  const wanted = more.positionals ?? [];
  const positionals: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const repeated = new Map<string, string[]>();
  const extras: string[] = [];
  const fail = (message: string, top = false): Parsed => {
    const shownUsage = top && more.extrasUsage !== undefined ? fitted(more.extrasUsage, more.extrasUsage) : more.explicitUsage ? usage : fitted(usage, more.usageLine ?? usage);
    const shownProg = top && more.extrasProg !== undefined ? more.extrasProg : prog;
    return { kind: "exit", status: 2, stdout: "", stderr: `${shownUsage}${shownProg}: error: ${message}\n` };
  };
  const positional = (token: string) => {
    if (positionals.length < wanted.length) positionals.push(token);
    else extras.push(token);
  };
  const longMatch = (name: string): OptionSpec | "ambiguous" | undefined => {
    const exact = options.find((option) => option.long === name);
    if (exact !== undefined) return exact;
    const found = options.filter((option) => option.long.startsWith(name));
    if (found.length > 1) return "ambiguous";
    return found[0];
  };
  const optionLike = (token: string): boolean => {
    if (!token.startsWith("-") || token === "-") return false;
    if (token === "--") return true;
    if (options.some((option) => option.long === token || option.short === token)) return true;
    if (token.startsWith("--")) {
      const head = token.split("=", 1)[0] as string;
      const matched = longMatch(head);
      if (matched !== undefined) return true;
    }
    if (NEGATIVE.test(token)) return false;
    return !token.includes(" ");
  };
  for (let at = 0; at < argv.length; at += 1) {
    const token = argv[at] as string;
    if (token === "--") {
      extras.push(...argv.slice(at));
      break;
    }
    if (!token.startsWith("-") || token === "-" || NEGATIVE.test(token)) {
      positional(token);
      continue;
    }
    let option: OptionSpec | undefined;
    let explicit: string | undefined;
    if (token.startsWith("--")) {
      const equals = token.indexOf("=");
      const head = equals < 0 ? token : token.slice(0, equals);
      explicit = equals < 0 ? undefined : token.slice(equals + 1);
      const matched = longMatch(head);
      if (matched === "ambiguous") throw new NeedsPython("an ambiguous abbreviated option");
      option = matched;
    } else if (token.length === 2) {
      option = options.find((candidate) => candidate.short === token);
    } else {
      if (token.includes(" ")) {
        positional(token);
        continue;
      }
      throw new NeedsPython("combined single-dash options");
    }
    if (option === undefined) {
      if (token.includes(" ") && !token.startsWith("--")) positional(token);
      else extras.push(token);
      continue;
    }
    if (option.kind === "help" || option.kind === "flag") {
      if (explicit !== undefined) return fail(`argument ${argumentName(option)}: ignored explicit argument ${reprStr(explicit)}`);
      if (option.kind === "help") {
        requireDefaultWidth();
        return { kind: "exit", status: 0, stdout: help, stderr: "" };
      }
      flags.add(option.long);
      continue;
    }
    let value = explicit;
    if (value === undefined) {
      const next = argv[at + 1];
      if (next === undefined || optionLike(next)) return fail(`argument ${argumentName(option)}: expected one argument`);
      value = next;
      at += 1;
    }
    if (option.float === true && !pythonFloat(value)) return fail(`argument ${argumentName(option)}: invalid float value: ${reprStr(value)}`);
    if (option.choices !== undefined && !option.choices.includes(value)) {
      return fail(`argument ${argumentName(option)}: invalid choice: ${reprStr(value)} (choose from ${option.choices.map(reprStr).join(", ")})`);
    }
    values.set(option.long, value);
    repeated.set(option.long, [...(repeated.get(option.long) ?? []), value]);
  }
  if (positionals.length < wanted.length) return fail(`the following arguments are required: ${wanted.slice(positionals.length).join(", ")}`);
  if (extras.length > 0) return fail(`unrecognized arguments: ${extras.join(" ")}`, true);
  return { kind: "ok", flags, values, repeated, positionals };
}

const FLOAT = /^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|inf|infinity|nan)$/i;

export function pythonFloat(text: string): boolean {
  const trimmed = text.trim();
  if (FLOAT.test(trimmed)) return true;
  if (/[_\u0080-\uffff]/.test(text)) throw new NeedsPython("a float only Python's float() reads");
  return false;
}

export function floatValue(text: string): number {
  const trimmed = text.trim().toLowerCase().replace(/^\+/, "");
  if (/^-?(inf|infinity)$/.test(trimmed)) return trimmed.startsWith("-") ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  if (/^-?nan$/.test(trimmed)) return Number.NaN;
  return Number(trimmed);
}
