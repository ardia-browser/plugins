import { type ArgValue, type Environment, type Exit, helpWith, type Namespace, parseWith, type ParserSpec } from "./argparse.ts";
import { constants, environment, type Overrides, ROOT } from "./argparse-env.ts";
import { floatRepr } from "./json.ts";

const HELP_WITHOUT_SUBCOMMAND: Record<string, string> = {
  skills: "skills_command",
  scripts: "scripts_command",
  hooks: "hooks_command",
  config: "config_command",
  theme: "theme_command",
  plugins: "plugins_command",
};
const COMPUTER_PARSERS: Record<string, string> = { setup: "ardia computer setup", "mcp-config": "ardia computer mcp-config" };

export type Telemetry = { command: string; subcommand?: string; allowedFlags: string[]; errorCode?: string };

export type Served = Exit & Telemetry & { printedHelp: boolean; raisedByCli: boolean };

export type Outcome =
  | { kind: "served"; served: Served }
  | { kind: "parsed"; path: string[]; values: Namespace; program: string[] | null; argv: string[]; telemetry: Telemetry }
  | { kind: "computer"; subcommand: string; values: Namespace; telemetry: Telemetry }
  | { kind: "elsewhere" };

export type Result = { status: number | null; stdout: string; stderr: string; values?: Record<string, unknown> };

class UsageError extends Error {}

function takeShared(argv: readonly string[], start: number, into: string[]): number {
  const { shared_value_flags: valued, shared_bool_flags: bare } = constants();
  let index = start;
  while (index < argv.length) {
    const token = argv[index] as string;
    const name = token.split("=")[0] as string;
    if (valued.includes(name)) {
      if (token.includes("=")) {
        into.push(token);
        index += 1;
        continue;
      }
      if (index + 1 >= argv.length) throw new UsageError(`${name} needs a value`);
      into.push(token, argv[index + 1] as string);
      index += 2;
      continue;
    }
    if (bare.includes(token)) {
      into.push(token);
      index += 1;
      continue;
    }
    break;
  }
  return index;
}

function flagNames(flags: readonly string[]): string[] {
  return flags.filter((token) => token.startsWith("--")).map((token) => token.split("=")[0] as string);
}

function subcommands(spec: ParserSpec): Map<string, string> {
  return new Map(spec.actions.find((action) => action.kind === "parsers")?.parsers ?? []);
}

function optionStrings(spec: ParserSpec): string[] {
  return spec.actions.flatMap((action) => action.option_strings);
}

function arrange(env: Environment, argv: readonly string[]): { path: string[]; hoisted: string[]; rest: string[] } {
  const path: string[] = [];
  const hoisted: string[] = [];
  let index = 0;
  let current = env.parser(ROOT);
  for (let choices = subcommands(current); choices.size > 0; choices = subcommands(current)) {
    index = takeShared(argv, index, hoisted);
    const word = argv[index];
    const prog = word === undefined ? undefined : choices.get(word);
    if (word === undefined || prog === undefined) break;
    path.push(word);
    current = env.parser(prog);
    index += 1;
  }
  return { path, hoisted, rest: argv.slice(index) };
}

function leaf(env: Environment, path: readonly string[]): ParserSpec[] {
  const chain = [env.parser(ROOT)];
  for (const name of path) chain.push(env.parser(subcommands(chain[chain.length - 1] as ParserSpec).get(name) as string));
  return chain;
}

function allowedFlags(env: Environment, path: readonly string[]): string[] {
  return [...new Set(leaf(env, path).flatMap(optionStrings))].sort();
}

function commandLabel(path: readonly string[], rest: readonly string[]): [string, string | undefined] {
  if (path.length > 0) return [path[0] as string, path[1]];
  const first = rest[0];
  if (first !== undefined && !first.startsWith("-")) return [Object.hasOwn(constants().removed_commands, first) ? first : "unknown", undefined];
  return ["none", undefined];
}

function splitProgram(argv: string[]): [string[], string[] | null] {
  if (argv[0] !== "on" || !argv.includes("--")) return [argv, null];
  const index = argv.indexOf("--");
  return [argv.slice(0, index), argv.slice(index + 1)];
}

function telemetryOf(command: string, subcommand: string | undefined, flags: string[], errorCode?: string): Telemetry {
  const telemetry: Telemetry = { command, allowedFlags: flags };
  if (subcommand !== undefined) telemetry.subcommand = subcommand;
  if (errorCode !== undefined) telemetry.errorCode = errorCode;
  return telemetry;
}

function served(exit: Exit, telemetry: Telemetry, printedHelp = false, raisedByCli = false): Outcome {
  return { kind: "served", served: { ...exit, ...telemetry, printedHelp, raisedByCli } };
}

function complaint(message: string, telemetry: Telemetry): Outcome {
  return served({ status: 2, stdout: "", stderr: `ardia: ${message}\n` }, telemetry, false, true);
}

function computer(env: Environment, rest: string[]): Outcome {
  const first = rest[0];
  const prog = first === undefined ? undefined : COMPUTER_PARSERS[first];
  if (first === undefined || prog === undefined) return { kind: "elsewhere" };
  const telemetry = telemetryOf("computer", constants().computer_labels[first] ?? "other", []);
  const parsed = parseWith(env, prog, rest.slice(1));
  if (!parsed.ok) return served(parsed, telemetry);
  return { kind: "computer", subcommand: first, values: parsed.values, telemetry };
}

export function frontEndOutcome(given: readonly string[], overrides: Overrides = {}): Outcome {
  const env = environment(overrides);
  let argv = [...given];
  if (argv.length === 1 && argv[0] === "--version") return { kind: "elsewhere" };
  const leading: string[] = [];
  let index: number;
  try {
    index = takeShared(argv, 0, leading);
  } catch (error) {
    if (error instanceof UsageError) return complaint(error.message, telemetryOf("none", undefined, []));
    throw error;
  }
  const command = argv[index];
  if (command === "--skill") argv = [...argv.slice(0, index), "skills", "get", ...argv.slice(index + 1)];
  if (command === "browse" || command === "notes") return { kind: "elsewhere" };
  if (command === "computer") {
    if (leading.length > 0) return complaint(`computer doesn't take ${flagNames(leading)[0]}`, telemetryOf("none", undefined, []));
    return computer(env, argv.slice(index + 1));
  }
  let arranged: { path: string[]; hoisted: string[]; rest: string[] };
  try {
    arranged = arrange(env, argv);
  } catch (error) {
    if (error instanceof UsageError) return complaint(error.message, telemetryOf("none", undefined, []));
    throw error;
  }
  const { path, hoisted, rest } = arranged;
  const [label, sublabel] = commandLabel(path, rest);
  const flags = allowedFlags(env, path);
  const telemetry = telemetryOf(label, sublabel, flags);
  if (path.length > 0) {
    const takes = optionStrings(leaf(env, path).at(-1) as ParserSpec);
    for (const name of flagNames(hoisted)) if (!takes.includes(name)) return complaint(`${path.join(" ")} doesn't take ${name}`, telemetry);
  }
  const first = rest[0];
  if (path.length === 0 && first !== undefined && !first.startsWith("-")) {
    const removed = constants().removed_commands[first];
    const code = removed === undefined ? "unknown_command" : "removed_command";
    const message = removed ?? `ardia: unknown command '${first}' (see ardia --help)`;
    return served({ status: 2, stdout: "", stderr: `${message}\n` }, { ...telemetry, errorCode: code }, false, true);
  }
  const [parseArgv, program] = splitProgram(path.length > 0 ? [...path, ...hoisted, ...rest] : [...rest]);
  const parsed = parseWith(env, ROOT, parseArgv);
  if (!parsed.ok) return served(parsed, telemetry);
  const chosen = parsed.values.get("command") ?? null;
  if (chosen === null) return served({ status: 0, stdout: helpWith(env, ROOT), stderr: parsed.stderr }, telemetry, true);
  const subDest = HELP_WITHOUT_SUBCOMMAND[chosen as string];
  if (subDest !== undefined && (parsed.values.get(subDest) ?? null) === null) {
    const help = parseWith(env, ROOT, [chosen as string, "--help"]);
    if (!help.ok) return served({ ...help, stderr: parsed.stderr + help.stderr }, telemetry);
  }
  return { kind: "parsed", path, values: parsed.values, program, argv: parseArgv, telemetry };
}

function encoded(value: ArgValue): unknown {
  if (typeof value === "bigint") return { int: value.toString() };
  if (typeof value === "number") return { float: floatRepr(value) };
  if (Array.isArray(value)) return value.map(encoded);
  return value;
}

export function namespaceJson(values: Namespace): Record<string, unknown> {
  return Object.fromEntries([...values].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, value]) => [key, encoded(value)]));
}

export function frontEnd(argv: readonly string[], overrides: Overrides = {}): { outcome: Outcome; result: Result } {
  const outcome = frontEndOutcome(argv, overrides);
  if (outcome.kind === "served") return { outcome, result: { status: outcome.served.status, stdout: outcome.served.stdout, stderr: outcome.served.stderr } };
  if (outcome.kind === "parsed" || outcome.kind === "computer") return { outcome, result: { status: null, stdout: "", stderr: "", values: namespaceJson(outcome.values) } };
  return { outcome, result: { status: null, stdout: "", stderr: "" } };
}

export function canonicalArgv(given: readonly string[], overrides: Overrides = {}): string[] | undefined {
  const env = environment(overrides);
  let arranged: { path: string[]; hoisted: string[]; rest: string[] };
  try {
    arranged = arrange(env, [...given]);
  } catch {
    return undefined;
  }
  if (arranged.path.length === 0) return undefined;
  const takes = optionStrings(leaf(env, arranged.path).at(-1) as ParserSpec).filter((name) => name.startsWith("--"));
  let changed = false;
  let ended = false;
  const argv = given.map((token) => {
    if (ended || !token.startsWith("--") || token === "--") {
      if (token === "--") ended = true;
      return token;
    }
    const equals = token.indexOf("=");
    const name = equals < 0 ? token : token.slice(0, equals);
    if (takes.includes(name)) return token;
    const matches = takes.filter((option) => option.startsWith(name));
    if (matches.length !== 1) return token;
    changed = true;
    return `${matches[0]}${equals < 0 ? "" : token.slice(equals)}`;
  });
  return changed ? argv : undefined;
}
