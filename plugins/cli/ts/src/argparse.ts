import { isatty } from "node:tty";
import { charCount, isSpace, strip } from "./py.ts";
import { pyFloat, pyInt, reprText } from "./pyrepr.ts";
import { codePoints, joinCodePoints } from "./pystr.ts";
import { fill, wrap } from "./textwrap.ts";

export const SUPPRESS = "==SUPPRESS==";
const OPTIONAL = "?";
const ZERO_OR_MORE = "*";
const ONE_OR_MORE = "+";
const PARSER = "A...";
const REMAINDER = "...";

export type Encoded = null | boolean | string | { int: string } | { float: string } | Encoded[];
export type ArgValue = null | boolean | string | bigint | number | ArgValue[];
export type Namespace = Map<string, ArgValue>;

export type ChoiceSpec = { dest: string; metavar: string; help: string | null; expanded_help: string | null };

export type ActionSpec = {
  kind: "help" | "version" | "store" | "store_const" | "store_true" | "store_false" | "append" | "append_const" | "count" | "extend" | "parsers";
  option_strings: string[];
  dest: string;
  nargs: null | string | number;
  const: Encoded;
  default: Encoded;
  type: null | "int" | "float" | "timeout_seconds";
  choices: string[] | null;
  required: boolean;
  help: string | null;
  expanded_help: string | null;
  metavar: string | string[] | null;
  deprecated: boolean;
  version?: string | null;
  parsers?: [string, string][];
  deprecated_parsers?: string[];
  choices_actions?: ChoiceSpec[];
};

export type ParserSpec = {
  prog: string;
  usage: string | null;
  description: string | null;
  epilog: string | null;
  formatter: "plain" | "raw_description";
  allow_abbrev: boolean;
  defaults: Record<string, Encoded>;
  actions: ActionSpec[];
  groups: { title: string | null; description: string | null; actions: number[] }[];
  mutually_exclusive: { required: boolean; actions: number[] }[];
  negative_number_options: boolean;
};

export type Environment = {
  parser(prog: string): ParserSpec;
  columns(): number;
  text(text: string): string;
  maxTimeout: number;
  maxTimeoutShown: string;
};

export type Exit = { status: number; stdout: string; stderr: string };

export class ParserExit extends Error {
  constructor(readonly exit: Exit) {
    super(`exit ${exit.status}`);
  }
}

class ArgumentError extends Error {
  readonly argumentName: string | null;
  constructor(
    action: ActionSpec | null,
    readonly text: string,
  ) {
    super(text);
    this.argumentName = actionName(action);
  }

  shown(): string {
    return this.argumentName === null ? this.text : `argument ${this.argumentName}: ${this.text}`;
  }
}

class ArgumentTypeError extends Error {}

export function decode(value: Encoded): ArgValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(decode);
  if ("int" in value) return BigInt(value.int);
  return Number(value.float);
}

function actionName(action: ActionSpec | null): string | null {
  if (action === null) return null;
  if (action.option_strings.length > 0) return action.option_strings.join("/");
  if (action.metavar !== null && action.metavar !== SUPPRESS) {
    const metavar = action.metavar;
    if (!Array.isArray(metavar)) return metavar;
    if (action.nargs === ZERO_OR_MORE && metavar.length === 2) return `${metavar[0]}[, ${metavar[1]}]`;
    if (action.nargs === ONE_OR_MORE) return `${metavar[0]}[, ${metavar[1]}]`;
    return metavar.join(", ");
  }
  if (action.dest !== SUPPRESS) return action.dest;
  if (action.choices !== null && action.choices.length > 0) return `{${action.choices.join(",")}}`;
  return null;
}

function first(text: string): string {
  return codePoints(text)[0] ?? "";
}

function after(text: string, count: number): string {
  return joinCodePoints(codePoints(text).slice(count));
}

function upTo(text: string, count: number): string {
  return joinCodePoints(codePoints(text).slice(0, count));
}

function partition(text: string, separator: string): [string, string, string] {
  const at = text.indexOf(separator);
  return at < 0 ? [text, "", ""] : [text.slice(0, at), separator, text.slice(at + separator.length)];
}

function pyLines(text: string, keepEnds: boolean): string[] {
  const lines: string[] = [];
  const breaks = /\r\n|[\n\r\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029]/g;
  let start = 0;
  for (const found of text.matchAll(breaks)) {
    const end = (found.index as number) + found[0].length;
    lines.push(text.slice(start, keepEnds ? end : found.index));
    start = end;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

function pad(count: number): string {
  return " ".repeat(Math.max(0, count));
}

type Item = () => string;

class Section {
  readonly items: Item[] = [];
  constructor(
    readonly formatter: Formatter,
    readonly parent: Section | null,
    readonly heading: string | null = null,
  ) {}

  formatHelp(): string {
    if (this.parent !== null) this.formatter.indent();
    const itemHelp = joinParts(this.items.map((item) => item()));
    if (this.parent !== null) this.formatter.dedent();
    if (itemHelp === "") return "";
    const heading = this.heading !== SUPPRESS && this.heading !== null ? `${pad(this.formatter.currentIndent)}${this.heading}:\n` : "";
    return joinParts(["\n", heading, itemHelp, "\n"]);
  }
}

function joinParts(parts: string[]): string {
  return parts.filter((part) => part !== "" && part !== SUPPRESS).join("");
}

type Group = { required: boolean; actions: ActionSpec[] };

class Formatter {
  readonly indentIncrement = 2;
  readonly maxHelpPosition: number;
  readonly width: number;
  currentIndent = 0;
  level = 0;
  actionMaxLength = 0;
  readonly root: Section;
  current: Section;

  constructor(
    readonly prog: string,
    readonly raw: boolean,
    columns: number,
  ) {
    this.width = columns - 2;
    this.maxHelpPosition = Math.min(24, Math.max(this.width - 20, this.indentIncrement * 2));
    this.root = new Section(this, null);
    this.current = this.root;
  }

  indent(): void {
    this.currentIndent += this.indentIncrement;
    this.level += 1;
  }

  dedent(): void {
    this.currentIndent -= this.indentIncrement;
    this.level -= 1;
  }

  startSection(heading: string | null): void {
    this.indent();
    const section = new Section(this, this.current, heading);
    this.current.items.push(() => section.formatHelp());
    this.current = section;
  }

  endSection(): void {
    this.current = this.current.parent as Section;
    this.dedent();
  }

  addText(text: string | null | undefined): void {
    if (text !== SUPPRESS && text !== null && text !== undefined) this.current.items.push(() => this.formatText(text));
  }

  addUsage(usage: string | null, actions: ActionSpec[], groups: Group[], prefix: string | null = null): void {
    if (usage !== SUPPRESS) this.current.items.push(() => this.formatUsage(usage, actions, groups, prefix));
  }

  addArgument(action: ActionSpec | ChoiceSpec): void {
    if (action.help === SUPPRESS) return;
    const lengths = [charCount(invocation(action)) + this.currentIndent];
    const subs = this.subactions(action);
    if (subs.length > 0) {
      this.indent();
      for (const sub of subs) lengths.push(charCount(invocation(sub)) + this.currentIndent);
      this.dedent();
    }
    this.actionMaxLength = Math.max(this.actionMaxLength, ...lengths);
    this.current.items.push(() => this.formatAction(action));
  }

  formatHelp(): string {
    let help = this.root.formatHelp();
    if (help !== "") {
      help = help.replace(/\n\n\n+/g, "\n\n");
      help = `${help.replace(/^\n+/, "").replace(/\n+$/, "")}\n`;
    }
    return help;
  }

  subactions(action: ActionSpec | ChoiceSpec): ChoiceSpec[] {
    if (!("kind" in action) || action.kind !== "parsers") return [];
    return action.choices_actions ?? [];
  }

  formatUsage(given: string | null, actions: ActionSpec[], groups: Group[], prefixGiven: string | null): string {
    const prefix = prefixGiven ?? "usage: ";
    let usage: string;
    if (given !== null) usage = given;
    else if (actions.length === 0) usage = this.prog;
    else {
      const prog = this.prog;
      const optionals = actions.filter((action) => action.option_strings.length > 0);
      const positionals = actions.filter((action) => action.option_strings.length === 0);
      const actionUsage = usageParts([...optionals, ...positionals], groups).parts.join(" ");
      usage = [prog, actionUsage].filter((part) => part !== "").join(" ");
      const textWidth = this.width - this.currentIndent;
      if (charCount(prefix) + charCount(usage) > textWidth) {
        const { parts, positionalStart } = usageParts([...optionals, ...positionals], groups, optionals.length);
        const optParts = parts.slice(0, positionalStart);
        const posParts = parts.slice(positionalStart);
        const getLines = (items: string[], indent: string, linePrefix: string | null = null): string[] => {
          const lines: string[] = [];
          let line: string[] = [];
          const indentLength = charCount(indent);
          let lineLength = linePrefix !== null ? charCount(linePrefix) - 1 : indentLength - 1;
          for (const part of items) {
            if (lineLength + 1 + charCount(part) > textWidth && line.length > 0) {
              lines.push(indent + line.join(" "));
              line = [];
              lineLength = indentLength - 1;
            }
            line.push(part);
            lineLength += charCount(part) + 1;
          }
          if (line.length > 0) lines.push(indent + line.join(" "));
          if (linePrefix !== null) lines[0] = after(lines[0] as string, indentLength);
          return lines;
        };
        let lines: string[];
        if (charCount(prefix) + charCount(prog) <= 0.75 * textWidth) {
          const indent = pad(charCount(prefix) + charCount(prog) + 1);
          if (optParts.length > 0) {
            lines = getLines([prog, ...optParts], indent, prefix);
            lines.push(...getLines(posParts, indent));
          } else if (posParts.length > 0) lines = getLines([prog, ...posParts], indent, prefix);
          else lines = [prog];
        } else {
          const indent = pad(charCount(prefix));
          lines = getLines([...optParts, ...posParts], indent);
          if (lines.length > 1) lines = [...getLines(optParts, indent), ...getLines(posParts, indent)];
          lines = [prog, ...lines];
        }
        usage = lines.join("\n");
      }
    }
    return `${prefix}${usage}\n\n`;
  }

  formatText(given: string): string {
    const textWidth = Math.max(this.width - this.currentIndent, 11);
    const indent = pad(this.currentIndent);
    return `${this.fillText(given, textWidth, indent)}\n\n`;
  }

  fillText(text: string, width: number, indent: string): string {
    if (this.raw) return pyLines(text, true).map((line) => indent + line).join("");
    return fill(collapse(text), width, indent, indent);
  }

  formatAction(action: ActionSpec | ChoiceSpec): string {
    const helpPosition = Math.min(this.actionMaxLength + 2, this.maxHelpPosition);
    const helpWidth = Math.max(this.width - helpPosition, 11);
    const actionWidth = helpPosition - this.currentIndent - 2;
    let header = invocation(action);
    let indentFirst = 0;
    if (!action.help) header = `${pad(this.currentIndent)}${header}\n`;
    else if (charCount(header) <= actionWidth) {
      header = `${pad(this.currentIndent)}${header}${pad(actionWidth - charCount(header))}  `;
      indentFirst = 0;
    } else {
      header = `${pad(this.currentIndent)}${header}\n`;
      indentFirst = helpPosition;
    }
    const parts = [header];
    if (action.help && strip(action.help, isSpace) !== "") {
      const helpText = action.expanded_help ?? "";
      if (helpText !== "") {
        const lines = wrap(collapse(helpText), helpWidth);
        parts.push(`${pad(indentFirst)}${lines[0]}\n`);
        for (const line of lines.slice(1)) parts.push(`${pad(helpPosition)}${line}\n`);
      }
    } else if (!header.endsWith("\n")) parts.push("\n");
    const subs = this.subactions(action);
    if (subs.length > 0) {
      this.indent();
      for (const sub of subs) parts.push(this.formatAction(sub));
      this.dedent();
    }
    return joinParts(parts);
  }
}

function collapse(text: string): string {
  return strip(text.replace(/[\t\n\x0b\x0c\r ]+/g, " "), isSpace);
}

function metavarFormatter(action: ActionSpec | ChoiceSpec, fallback: string): (size: number) => string[] {
  let result: string | string[];
  if (action.metavar !== null) result = action.metavar;
  else if ("choices" in action && action.choices !== null) result = `{${action.choices.join(",")}}`;
  else result = fallback;
  return (size) => (Array.isArray(result) ? result : Array.from({ length: size }, () => result as string));
}

function formatArgs(action: ActionSpec, fallback: string): string {
  const get = metavarFormatter(action, fallback);
  const nargs = action.nargs;
  if (nargs === null) return get(1)[0] as string;
  if (nargs === OPTIONAL) return `[${get(1)[0]}]`;
  if (nargs === ZERO_OR_MORE) {
    const metavar = get(1);
    return metavar.length === 2 ? `[${metavar[0]} [${metavar[1]} ...]]` : `[${metavar[0]} ...]`;
  }
  if (nargs === ONE_OR_MORE) {
    const metavar = get(2);
    return `${metavar[0]} [${metavar[1]} ...]`;
  }
  if (nargs === REMAINDER) return "...";
  if (nargs === PARSER) return `${get(1)[0]} ...`;
  if (nargs === SUPPRESS) return "";
  if (typeof nargs !== "number") throw new Error("invalid nargs value");
  return get(nargs).slice(0, nargs).join(" ");
}

function invocation(action: ActionSpec | ChoiceSpec): string {
  if (!("kind" in action)) return action.metavar;
  if (action.option_strings.length === 0) return metavarFormatter(action, action.dest)(1).join(" ");
  if (action.nargs === 0) return action.option_strings.join(", ");
  return `${action.option_strings.join(", ")} ${formatArgs(action, action.dest.toUpperCase())}`;
}

function usageParts(actions: ActionSpec[], groups: Group[], optCount?: number): { parts: string[]; positionalStart: number } {
  const groupActions = new Set<ActionSpec>();
  const inserts = new Map<string, { start: number; end: number; group: Group }>();
  for (const group of groups) {
    if (group.actions.length === 0) throw new Error("empty group");
    if (group.actions.every((action) => action.help === SUPPRESS)) continue;
    const start = actions.indexOf(group.actions[0] as ActionSpec);
    if (start < 0) continue;
    const end = start + group.actions.length;
    const slice = actions.slice(start, end);
    if (slice.length === group.actions.length && slice.every((action, at) => action === group.actions[at])) {
      for (const action of group.actions) groupActions.add(action);
      inserts.set(`${start},${end}`, { start, end, group });
    }
  }
  const parts: (string | null)[] = [];
  for (const action of actions) {
    let part: string | null;
    if (action.help === SUPPRESS) part = null;
    else if (action.option_strings.length === 0) {
      part = formatArgs(action, action.dest);
      if (groupActions.has(action) && part.startsWith("[") && part.endsWith("]")) part = part.slice(1, -1);
    } else {
      const optionString = action.option_strings[0] as string;
      if (action.nargs === 0) part = optionString;
      else part = `${optionString} ${formatArgs(action, action.dest.toUpperCase())}`;
      if (!action.required && !groupActions.has(action)) part = `[${part}]`;
    }
    parts.push(part);
  }
  const separated = new Set<number>();
  const ordered = [...inserts.values()].sort((a, b) => b.start - a.start || b.end - a.end);
  for (const { start, end, group } of ordered) {
    const groupParts = parts.slice(start, end).filter((item): item is string => item !== null);
    const size = groupParts.length;
    let open: string;
    let close: string;
    if (group.required) [open, close] = size > 1 ? ["(", ")"] : ["", ""];
    else [open, close] = ["[", "]"];
    groupParts[0] = open + groupParts[0];
    groupParts[size - 1] = groupParts[size - 1] + close;
    groupParts.slice(0, -1).forEach((part, offset) => {
      const at = start + offset;
      if (!separated.has(at)) {
        parts[at] = `${part} |`;
        separated.add(at);
      }
    });
    parts[start + size - 1] = groupParts[size - 1] as string;
    for (let at = start + size; at < end; at += 1) parts[at] = null;
  }
  const positionalStart = optCount === undefined ? 0 : parts.slice(0, optCount).filter((part) => part !== null).length;
  return { parts: parts.filter((part): part is string => part !== null), positionalStart };
}

type OptionTuple = [ActionSpec | null, string, string | null, string | null];

function nargsPattern(action: ActionSpec): string {
  const nargs = action.nargs;
  const option = action.option_strings.length > 0;
  if (nargs === null) return option ? "([A])" : "(-*A-*)";
  if (nargs === OPTIONAL) return option ? "(A?)" : "(-*A?-*)";
  if (nargs === ZERO_OR_MORE) return option ? "(A*)" : "(-*[A-]*)";
  if (nargs === ONE_OR_MORE) return option ? "(A+)" : "(-*A[A-]*)";
  if (nargs === REMAINDER) return option ? "([AO]*)" : "(.*)";
  if (nargs === PARSER) return option ? "(A[AO]*)" : "(-*A[-AO]*)";
  if (nargs === SUPPRESS) return option ? "()" : "(-*)";
  return option ? `([AO]{${nargs}})` : `((?:-*A){${nargs}}-*)`;
}

const NEGATIVE_NUMBER = /^-\p{Nd}+\n?$|^-\p{Nd}*\.\p{Nd}+\n?$/u;

function negativeNumber(text: string): boolean {
  return NEGATIVE_NUMBER.test(text);
}

class Parser {
  readonly actions: ActionSpec[];
  readonly optionMap = new Map<string, ActionSpec>();
  readonly groups: Group[];

  constructor(
    readonly spec: ParserSpec,
    readonly env: Environment,
  ) {
    this.actions = spec.actions;
    for (const action of this.actions) for (const name of action.option_strings) this.optionMap.set(name, action);
    this.groups = spec.mutually_exclusive.map((group) => ({ required: group.required, actions: group.actions.map((index) => this.actions[index] as ActionSpec) }));
  }

  get prog(): string {
    return this.env.text(this.spec.prog);
  }

  formatter(): Formatter {
    return new Formatter(this.prog, this.spec.formatter === "raw_description", this.env.columns());
  }

  formatUsage(): string {
    const formatter = this.formatter();
    formatter.addUsage(this.usage(), this.actions, this.groups);
    return formatter.formatHelp();
  }

  usage(): string | null {
    return this.spec.usage === null ? null : this.env.text(this.spec.usage);
  }

  formatHelp(): string {
    const formatter = this.formatter();
    formatter.addUsage(this.usage(), this.actions, this.groups);
    formatter.addText(this.spec.description === null ? null : this.env.text(this.spec.description));
    for (const group of this.spec.groups) {
      formatter.startSection(group.title);
      formatter.addText(group.description);
      for (const index of group.actions) formatter.addArgument(this.actions[index] as ActionSpec);
      formatter.endSection();
    }
    formatter.addText(this.spec.epilog === null ? null : this.env.text(this.spec.epilog));
    return formatter.formatHelp();
  }

  error(message: string, stderrSoFar: string): never {
    throw new ParserExit({ status: 2, stdout: "", stderr: `${stderrSoFar}${this.formatUsage()}${this.prog}: error: ${message}\n` });
  }

  parseArgs(args: string[], out: Output): Namespace {
    const [namespace, extras] = this.parseKnownArgs(args, new Map(), out);
    if (extras.length > 0) this.error(`unrecognized arguments: ${extras.join(" ")}`, out.stderr);
    return namespace;
  }

  parseKnownArgs(args: string[], namespace: Namespace, out: Output): [Namespace, string[]] {
    for (const action of this.actions) {
      if (action.dest !== SUPPRESS && !namespace.has(action.dest) && action.default !== SUPPRESS) namespace.set(action.dest, decode(action.default));
    }
    for (const [dest, value] of Object.entries(this.spec.defaults)) if (!namespace.has(dest)) namespace.set(dest, decode(value));
    let extras: string[];
    try {
      extras = this.parseKnown(args, namespace, out);
    } catch (error) {
      if (error instanceof ArgumentError) this.error(error.shown(), out.stderr);
      throw error;
    }
    const unrecognized = out.unrecognized.get(namespace);
    if (unrecognized !== undefined) {
      extras.push(...unrecognized);
      out.unrecognized.delete(namespace);
    }
    return [namespace, extras];
  }

  parseOptional(argString: string): OptionTuple[] | null {
    if (argString === "") return null;
    if (!argString.startsWith("-")) return null;
    const exact = this.optionMap.get(argString);
    if (exact !== undefined) return [[exact, argString, null, null]];
    if (codePoints(argString).length === 1) return null;
    const [optionString, sep, explicit] = partition(argString, "=");
    if (sep !== "") {
      const action = this.optionMap.get(optionString);
      if (action !== undefined) return [[action, optionString, sep, explicit]];
    }
    const tuples = this.optionTuples(argString);
    if (tuples.length > 0) return tuples;
    if (negativeNumber(argString) && !this.spec.negative_number_options) return null;
    if (argString.includes(" ")) return null;
    return [[null, argString, null, null]];
  }

  optionTuples(optionString: string): OptionTuple[] {
    const result: OptionTuple[] = [];
    const chars = codePoints(optionString);
    if (chars[0] === "-" && chars[1] === "-") {
      if (this.spec.allow_abbrev) {
        const [prefix, sepFound, explicitFound] = partition(optionString, "=");
        const sep = sepFound === "" ? null : sepFound;
        const explicit = sepFound === "" ? null : explicitFound;
        for (const [name, action] of this.optionMap) if (name.startsWith(prefix)) result.push([action, name, sep, explicit]);
      }
    } else if (chars[0] === "-") {
      const [prefix, sepFound, explicitFound] = partition(optionString, "=");
      const sep = sepFound === "" ? null : sepFound;
      const explicit = sepFound === "" ? null : explicitFound;
      const shortPrefix = upTo(optionString, 2);
      const shortExplicit = after(optionString, 2);
      for (const [name, action] of this.optionMap) {
        if (name === shortPrefix) result.push([action, name, "", shortExplicit]);
        else if (this.spec.allow_abbrev && name.startsWith(prefix)) result.push([action, name, sep, explicit]);
      }
    } else throw new ArgumentError(null, `unexpected option string: ${optionString}`);
    return result;
  }

  matchArgument(action: ActionSpec, pattern: string): number {
    const found = new RegExp(`^${nargsPattern(action)}`).exec(pattern);
    if (found === null) {
      const messages: Record<string, string> = { null: "expected one argument", [OPTIONAL]: "expected at most one argument", [ONE_OR_MORE]: "expected at least one argument" };
      let message = messages[String(action.nargs)];
      if (message === undefined) message = action.nargs === 1 ? `expected ${action.nargs} argument` : `expected ${action.nargs} arguments`;
      throw new ArgumentError(action, message);
    }
    return (found[1] as string).length;
  }

  matchPartial(actions: ActionSpec[], pattern: string): number[] {
    for (let count = actions.length; count > 0; count -= 1) {
      const regex = new RegExp(`^${actions.slice(0, count).map(nargsPattern).join("")}`);
      const found = regex.exec(pattern);
      if (found !== null) {
        const result = found.slice(1).map((group) => (group ?? "").length);
        const end = found[0].length;
        if (end < pattern.length && pattern[end] === "O") while (result.length > 0 && result[result.length - 1] === 0) result.pop();
        return result;
      }
    }
    return [];
  }

  getValue(action: ActionSpec, text: string): ArgValue {
    if (action.type === null) return text;
    if (action.type === "int") {
      const value = pyInt(text);
      if (value === undefined) throw new ArgumentError(action, `invalid int value: ${reprText(text)}`);
      return value;
    }
    const value = pyFloat(text);
    if (action.type === "float") {
      if (value === undefined) throw new ArgumentError(action, `invalid float value: ${reprText(text)}`);
      return value;
    }
    try {
      if (value === undefined) throw new ArgumentTypeError(`takes seconds, like 30 or 2.5, not ${text}`);
      if (!Number.isFinite(value) || value <= 0 || value > this.env.maxTimeout) {
        throw new ArgumentTypeError(`takes seconds above 0 and up to ${this.env.maxTimeoutShown}, not ${text}`);
      }
      return value;
    } catch (error) {
      if (error instanceof ArgumentTypeError) throw new ArgumentError(action, error.message);
      throw error;
    }
  }

  checkValue(action: ActionSpec, value: ArgValue): void {
    const choices = action.choices;
    if (choices === null) return;
    if (typeof value === "string" && choices.includes(value)) return;
    const shown = typeof value === "string" ? value : String(value);
    throw new ArgumentError(action, `invalid choice: ${reprText(shown)} (choose from ${choices.map(reprText).join(", ")})`);
  }

  getValues(action: ActionSpec, strings: string[]): ArgValue | typeof SUPPRESS_VALUE {
    if (strings.length === 0 && action.nargs === OPTIONAL) {
      let value = action.option_strings.length > 0 ? decode(action.const) : decode(action.default);
      if (typeof value === "string" && value !== SUPPRESS) {
        value = this.getValue(action, value);
        this.checkValue(action, value);
      }
      return value;
    }
    if (strings.length === 0 && action.nargs === ZERO_OR_MORE && action.option_strings.length === 0) {
      const fallback = decode(action.default);
      if (fallback !== null) {
        this.checkValue(action, fallback);
        return fallback;
      }
      return [];
    }
    if (strings.length === 1 && (action.nargs === null || action.nargs === OPTIONAL)) {
      const value = this.getValue(action, strings[0] as string);
      this.checkValue(action, value);
      return value;
    }
    if (action.nargs === REMAINDER) return strings.map((text) => this.getValue(action, text));
    if (action.nargs === PARSER) {
      const values = strings.map((text) => this.getValue(action, text));
      this.checkValue(action, values[0] as ArgValue);
      return values;
    }
    if (action.nargs === SUPPRESS) return SUPPRESS_VALUE;
    const values = strings.map((text) => this.getValue(action, text));
    for (const value of values) this.checkValue(action, value);
    return values;
  }

  apply(action: ActionSpec, namespace: Namespace, values: ArgValue, out: Output): void {
    switch (action.kind) {
      case "store":
        namespace.set(action.dest, values);
        return;
      case "store_const":
      case "store_true":
      case "store_false":
        namespace.set(action.dest, decode(action.const));
        return;
      case "append":
      case "extend":
      case "append_const": {
        const items = copyItems(namespace.get(action.dest) ?? null);
        if (action.kind === "append") items.push(values);
        else if (action.kind === "extend") items.push(...(values as ArgValue[]));
        else items.push(decode(action.const));
        namespace.set(action.dest, items);
        return;
      }
      case "count": {
        const count = namespace.get(action.dest) ?? null;
        namespace.set(action.dest, (count === null ? 0n : (count as bigint)) + 1n);
        return;
      }
      case "help":
        throw new ParserExit({ status: 0, stdout: this.formatHelp(), stderr: out.stderr });
      case "version": {
        const formatter = this.formatter();
        formatter.addText(this.env.text(action.version ?? ""));
        throw new ParserExit({ status: 0, stdout: formatter.formatHelp(), stderr: out.stderr });
      }
      case "parsers": {
        const list = values as string[];
        const name = list[0] as string;
        if (action.dest !== SUPPRESS) namespace.set(action.dest, name);
        const prog = action.parsers?.find(([choice]) => choice === name)?.[1];
        if (prog === undefined) {
          throw new ArgumentError(action, `unknown parser ${reprText(name)} (choices: ${(action.parsers ?? []).map(([choice]) => choice).join(", ")})`);
        }
        if (action.deprecated_parsers?.includes(name)) out.warn(this.prog, `command '${name}' is deprecated`);
        const sub = new Parser(this.env.parser(prog), this.env);
        const [subNamespace, rest] = sub.parseKnownArgs(list.slice(1), new Map(), out);
        for (const [key, value] of subNamespace) namespace.set(key, value);
        if (rest.length > 0) {
          const pending = out.unrecognized.get(namespace) ?? [];
          pending.push(...rest);
          out.unrecognized.set(namespace, pending);
        }
        return;
      }
    }
  }

  parseKnown(argStrings: string[], namespace: Namespace, out: Output): string[] {
    const conflicts = new Map<ActionSpec, ActionSpec[]>();
    for (const group of this.groups) {
      group.actions.forEach((action, at) => {
        const list = conflicts.get(action) ?? [];
        list.push(...group.actions.slice(0, at), ...group.actions.slice(at + 1));
        conflicts.set(action, list);
      });
    }
    const optionIndices = new Map<number, OptionTuple[]>();
    const patternParts: string[] = [];
    for (let index = 0; index < argStrings.length; index += 1) {
      const argString = argStrings[index] as string;
      if (argString === "--") {
        patternParts.push("-");
        for (index += 1; index < argStrings.length; index += 1) patternParts.push("A");
        break;
      }
      const tuples = this.parseOptional(argString);
      if (tuples === null) patternParts.push("A");
      else {
        optionIndices.set(index, tuples);
        patternParts.push("O");
      }
    }
    const pattern = patternParts.join("");
    const seen = new Set<ActionSpec>();
    const seenNonDefault = new Set<ActionSpec>();
    const warned = new Set<string>();
    const takeAction = (action: ActionSpec, strings: string[]): void => {
      seen.add(action);
      const values = this.getValues(action, strings);
      if (action.option_strings.length > 0 || strings.length > 0) {
        seenNonDefault.add(action);
        for (const conflict of conflicts.get(action) ?? []) {
          if (seenNonDefault.has(conflict)) throw new ArgumentError(action, `not allowed with argument ${actionName(conflict)}`);
        }
      }
      if (values !== SUPPRESS_VALUE) this.apply(action, namespace, values as ArgValue, out);
    };
    const extras: string[] = [];
    const consumeOptional = (startIndex: number): number => {
      const tuples = optionIndices.get(startIndex) as OptionTuple[];
      if (tuples.length > 1) {
        const options = tuples.map((tuple) => tuple[1]).join(", ");
        throw new ArgumentError(null, `ambiguous option: ${argStrings[startIndex]} could match ${options}`);
      }
      let [action, optionString, sep, explicit] = tuples[0] as OptionTuple;
      const actionTuples: [ActionSpec, string[], string][] = [];
      let stop: number;
      while (true) {
        if (action === null) {
          extras.push(argStrings[startIndex] as string);
          return startIndex + 1;
        }
        if (explicit !== null) {
          const argCount = this.matchArgument(action, "A");
          if (argCount === 0 && codePoints(optionString)[1] !== "-" && explicit !== "") {
            if (sep || first(explicit) === "-") throw new ArgumentError(action, `ignored explicit argument ${reprText(explicit)}`);
            actionTuples.push([action, [], optionString]);
            const char = first(optionString);
            optionString = char + first(explicit);
            const next = this.optionMap.get(optionString);
            if (next !== undefined) {
              action = next;
              explicit = after(explicit, 1);
              if (explicit === "") sep = explicit = null;
              else if (first(explicit) === "=") {
                sep = "=";
                explicit = after(explicit, 1);
              } else sep = "";
            } else {
              extras.push(char + explicit);
              stop = startIndex + 1;
              break;
            }
          } else if (argCount === 1) {
            stop = startIndex + 1;
            actionTuples.push([action, [explicit], optionString]);
            break;
          } else throw new ArgumentError(action, `ignored explicit argument ${reprText(explicit)}`);
        } else {
          const start = startIndex + 1;
          const argCount = this.matchArgument(action, pattern.slice(start));
          stop = start + argCount;
          actionTuples.push([action, argStrings.slice(start, stop), optionString]);
          break;
        }
      }
      for (const [taken, args, name] of actionTuples) {
        if (taken.deprecated && !warned.has(name)) {
          out.warn(this.prog, `option '${name}' is deprecated`);
          warned.add(name);
        }
        takeAction(taken, args);
      }
      return stop;
    };
    const positionals = this.actions.filter((action) => action.option_strings.length === 0);
    const consumePositionals = (from: number): number => {
      let startIndex = from;
      const counts = this.matchPartial(positionals, pattern.slice(startIndex));
      counts.forEach((count, at) => {
        const action = positionals[at] as ActionSpec;
        const args = argStrings.slice(startIndex, startIndex + count);
        if (action.nargs === PARSER) {
          if (pattern[startIndex] === "-") args.splice(args.indexOf("--"), 1);
        } else if (action.nargs !== REMAINDER) {
          if (pattern.slice(startIndex, startIndex + count).includes("-")) args.splice(args.indexOf("--"), 1);
        }
        startIndex += count;
        if (args.length > 0 && action.deprecated && !warned.has(action.dest)) {
          out.warn(this.prog, `argument '${action.dest}' is deprecated`);
          warned.add(action.dest);
        }
        takeAction(action, args);
      });
      positionals.splice(0, counts.length);
      return startIndex;
    };
    let startIndex = 0;
    const maxOption = optionIndices.size > 0 ? Math.max(...optionIndices.keys()) : -1;
    while (startIndex <= maxOption) {
      let nextOption = startIndex;
      while (nextOption <= maxOption && !optionIndices.has(nextOption)) nextOption += 1;
      if (startIndex !== nextOption) {
        const end = consumePositionals(startIndex);
        if (end > startIndex) {
          startIndex = end;
          continue;
        }
        startIndex = end;
      }
      if (!optionIndices.has(startIndex)) {
        extras.push(...argStrings.slice(startIndex, nextOption));
        startIndex = nextOption;
      }
      startIndex = consumeOptional(startIndex);
    }
    const stopIndex = consumePositionals(startIndex);
    extras.push(...argStrings.slice(stopIndex));
    const required: string[] = [];
    for (const action of this.actions) {
      if (seen.has(action)) continue;
      if (action.required) required.push(actionName(action) as string);
      else if (typeof action.default === "string" && action.default !== null && namespace.get(action.dest) === action.default && !this.writtenBy(action, seen)) {
        namespace.set(action.dest, this.getValue(action, action.default));
      }
    }
    if (required.length > 0) throw new ArgumentError(null, `the following arguments are required: ${required.join(", ")}`);
    for (const group of this.groups) {
      if (!group.required) continue;
      if (group.actions.some((action) => seenNonDefault.has(action))) continue;
      const names = group.actions.filter((action) => action.help !== SUPPRESS).map(actionName);
      throw new ArgumentError(null, `one of the arguments ${names.join(" ")} is required`);
    }
    return extras;
  }

  writtenBy(action: ActionSpec, seen: Set<ActionSpec>): boolean {
    for (const other of seen) if (other !== action && other.dest === action.dest) return true;
    return false;
  }
}

const SUPPRESS_VALUE = Symbol("suppress");

function copyItems(items: ArgValue): ArgValue[] {
  if (items === null) return [];
  if (Array.isArray(items)) return [...items];
  return [items];
}

class Output {
  stderr = "";
  readonly unrecognized = new Map<Namespace, string[]>();

  warn(prog: string, message: string): void {
    this.stderr += `${prog}: warning: ${message}\n`;
  }
}

export type Parsed = { ok: true; values: Namespace; stderr: string } | ({ ok: false } & Exit);

export function parseWith(env: Environment, prog: string, argv: readonly string[]): Parsed {
  const out = new Output();
  try {
    const values = new Parser(env.parser(prog), env).parseArgs([...argv], out);
    return { ok: true, values, stderr: out.stderr };
  } catch (error) {
    if (error instanceof ParserExit) return { ok: false, ...error.exit };
    throw error;
  }
}

export function helpWith(env: Environment, prog: string): string {
  return new Parser(env.parser(prog), env).formatHelp();
}

export function usageWith(env: Environment, prog: string): string {
  return new Parser(env.parser(prog), env).formatUsage();
}

export function errorWith(env: Environment, prog: string, message: string): Exit {
  const parser = new Parser(env.parser(prog), env);
  return { status: 2, stdout: "", stderr: `${parser.formatUsage()}${parser.prog}: error: ${message}\n` };
}

export function terminalColumns(): number {
  const fromEnv = process.env.COLUMNS;
  const parsed = fromEnv === undefined ? undefined : pyInt(fromEnv);
  const columns = parsed === undefined ? 0 : parsed > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(parsed);
  if (columns > 0) return columns;
  const width = isatty(1) ? (process.stdout.columns ?? 0) : 0;
  return width > 0 ? width : 80;
}
