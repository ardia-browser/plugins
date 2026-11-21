import { PythonError } from "./py.ts";
import { crashValue } from "./crash.ts";
import { constants } from "node:os";
import { errnoOf, NeedsPython } from "./paths.ts";
import { effects } from "./pyos.ts";
import { inert, jsonSafe, toStderr, writeAll } from "./printable.ts";
import { Call, finish } from "./telemetry.ts";

const SHARED_VALUE_FLAGS = ["--port", "--ws", "--data-dir", "--timeout"];
const SHARED_BOOL_FLAGS = ["--json"];
const TOP_FLAGS = ["-h", "--help", "--version", "--skill"];
const NEGATIVE_NUMBER = /^-\d+$|^-\d*\.\d+$/u;
const EPIPE = constants.errno.EPIPE;
const LONE_SURROGATES = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;

type OptionKind = "flag" | "value";
type Leaf = { options: Record<string, [string, OptionKind]>; positionals: [string, boolean][] };

const DATA_DIR: Record<string, [string, OptionKind]> = { "--data-dir": ["data_dir", "value"] };
const JSON_FLAG: Record<string, [string, OptionKind]> = { "--json": ["json", "flag"] };
const THEME: Record<string, [string, OptionKind]> = { "--theme": ["theme", "value"] };

function leaf(options: Record<string, [string, OptionKind]>, ...positionals: [string, boolean][]): Leaf {
  return { options: { ...DATA_DIR, ...options }, positionals };
}

const LEAVES: Record<string, Record<string, Leaf>> = {
  config: {
    path: leaf({}),
    init: leaf({}),
    get: leaf(JSON_FLAG, ["key", true]),
    set: leaf({}, ["key", false], ["value", false]),
    unset: leaf({}, ["key", false]),
    list: leaf(JSON_FLAG),
    edit: leaf({}),
    check: leaf(JSON_FLAG),
  },
  theme: {
    new: leaf({ "--from": ["source", "value"] }, ["name", false]),
    use: leaf({}, ["name", false]),
    list: leaf(JSON_FLAG),
    check: leaf(JSON_FLAG, ["target", true]),
    get: leaf({ ...JSON_FLAG, ...THEME }, ["key", true]),
    set: leaf(THEME, ["key", false], ["value", false]),
    unset: leaf(THEME, ["key", false]),
  },
  plugins: {
    list: leaf(JSON_FLAG),
    install: leaf({ "--force": ["force", "flag"] }, ["source", false]),
    check: leaf(JSON_FLAG, ["target", true]),
    remove: leaf({}, ["name", false]),
    enable: leaf({}, ["name", false]),
    disable: leaf({}, ["name", false]),
    call: leaf({}, ["name", false], ["tool", false], ["input", true]),
    path: leaf({}),
  },
};

export const COMMAND_GROUPS = Object.keys(LEAVES);

export type Args = Record<string, string | boolean | undefined>;
export type Command = { group: string; verb: string; label: string; args: Args; argv: string[] };

function takeShared(argv: string[], start: number, into: string[]): number | undefined {
  let index = start;
  while (index < argv.length) {
    const token = argv[index] as string;
    const name = token.split("=", 1)[0] as string;
    if (SHARED_VALUE_FLAGS.includes(name)) {
      if (token.includes("=")) {
        into.push(token);
        index += 1;
        continue;
      }
      if (index + 1 >= argv.length) return undefined;
      into.push(token, argv[index + 1] as string);
      index += 2;
      continue;
    }
    if (SHARED_BOOL_FLAGS.includes(token)) {
      into.push(token);
      index += 1;
      continue;
    }
    break;
  }
  return index;
}

function looksLikeOption(token: string): boolean {
  return token.startsWith("-") && token !== "-" && !NEGATIVE_NUMBER.test(token);
}

export function parseCommand(argv: string[]): Command | undefined {
  if (argv.some((token) => LONE_SURROGATES.test(token))) return undefined;
  const hoisted: string[] = [];
  let index = takeShared(argv, 0, hoisted);
  if (index === undefined) return undefined;
  const group = argv[index];
  if (group === undefined || !Object.hasOwn(LEAVES, group)) return undefined;
  index = takeShared(argv, index + 1, hoisted);
  if (index === undefined) return undefined;
  const verb = argv[index];
  const leaves = LEAVES[group] as Record<string, Leaf>;
  if (verb === undefined || !Object.hasOwn(leaves, verb)) return undefined;
  const spec = leaves[verb] as Leaf;
  const tokens = [...hoisted, ...argv.slice(index + 1)];
  const args: Args = {};
  for (const [dest, kind] of Object.values(spec.options)) args[dest] = kind === "flag" ? false : undefined;
  const positionals: string[] = [];
  let onlyPositionals = false;
  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at] as string;
    if (onlyPositionals || !looksLikeOption(token)) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      onlyPositionals = true;
      continue;
    }
    const equals = token.indexOf("=");
    const name = equals < 0 ? token : token.slice(0, equals);
    const option = Object.hasOwn(spec.options, name) ? spec.options[name] : undefined;
    if (option === undefined) return undefined;
    const [dest, kind] = option;
    if (kind === "flag") {
      if (equals >= 0) return undefined;
      args[dest] = true;
      continue;
    }
    if (equals >= 0) {
      args[dest] = token.slice(equals + 1);
      continue;
    }
    const value = tokens[at + 1];
    if (value === undefined || value.startsWith("-")) return undefined;
    args[dest] = value;
    at += 1;
  }
  const required = spec.positionals.filter(([, optional]) => !optional).length;
  if (positionals.length < required || positionals.length > spec.positionals.length) return undefined;
  spec.positionals.forEach(([name], position) => {
    args[name] = positionals[position];
  });
  return { group, verb, label: `${group} ${verb}`, args, argv };
}

export function allowedFlags(command: Command): string[] {
  const leafSpec = (LEAVES[command.group] as Record<string, Leaf>)[command.verb] as Leaf;
  return [...TOP_FLAGS, ...Object.keys(leafSpec.options)];
}

export class StdoutBroken extends Error {}

function wellFormed(text: string): string {
  return LONE_SURROGATES.test(text) ? Buffer.from(text, "utf16le").toString("utf16le").replace(/[\ud800-\udfff]/gu, "�") : text;
}

export class Io {
  broken = false;
  committed = false;
  readonly call: Call;

  constructor(
    readonly json: boolean,
    argv: string[],
  ) {
    this.call = new Call(argv);
  }

  commit(): void {
    this.committed = true;
  }

  write(text: string): void {
    this.committed = true;
    if (this.broken) throw new StdoutBroken();
    try {
      writeAll(1, this.json ? jsonSafe(text) : inert(text));
    } catch (error) {
      if (errnoOf(error) === EPIPE) {
        this.broken = true;
        throw new StdoutBroken();
      }
      throw error;
    }
  }

  say(text: string): void {
    this.write(`${wellFormed(text)}\n`);
  }

  complain(text: string): void {
    this.committed = true;
    if (this.broken) throw new StdoutBroken();
    toStderr(`${inert(wellFormed(text))}\n`);
  }

  noteError(code: string): void {
    this.call.noteErrorCode(code);
  }
}

export type Handler = (args: Args, io: Io) => Promise<number> | number;

export async function serveCommand(command: Command, handler: Handler, python: string | null): Promise<number | undefined> {
  const json = command.argv.slice(0, command.argv.includes("--") ? command.argv.indexOf("--") : undefined).includes("--json");
  const io = new Io(json, command.argv);
  io.call.command = command.group;
  io.call.subcommand = command.verb;
  io.call.allowedFlags = allowedFlags(command);
  let status: number;
  try {
    status = await handler(command.args, io);
  } catch (error) {
    if (error instanceof NeedsPython && !io.committed && !effects.done) return undefined;
    if (error instanceof PythonError) {
      toStderr(`${error.message}\n`);
      finish(io.call, 1, python, { kind: error.kind, value: crashValue(error.kind, error.text) });
      return 1;
    }
    if (!(error instanceof StdoutBroken)) throw error;
    status = 141;
  }
  if (io.broken) {
    io.call.noteErrorCode("stdout_closed");
    status = 141;
  }
  finish(io.call, status, python);
  return status;
}
