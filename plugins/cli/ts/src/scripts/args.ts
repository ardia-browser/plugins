import { environment } from "../argparse-env.ts";
const NEGATIVE_NUMBER = /^-\p{Nd}+$|^-\p{Nd}*\.\p{Nd}+$/u;

export type Sub = "new" | "test" | "install" | "uninstall" | "list";

export type ScriptsArgs = {
  sub: Sub;
  name?: string;
  file?: string;
  match: string[] | null;
  dataDir?: string;
  json: boolean;
  hoisted?: string[];
  rest?: string[];
};

export const TEST_SPEC = "ardia scripts test";

const SHARED_VALUE_FLAGS = ["--port", "--ws", "--data-dir", "--timeout"];
const SHARED_BOOL_FLAGS = ["--json"];
const TOP_FLAGS = ["-h", "--help", "--version", "--skill"];
const SUBCOMMANDS = ["new", "test", "install", "uninstall", "list"];

type Leaf = { values: string[]; flags: string[]; positional: "name" | "file" | null };

const LEAVES: Record<Exclude<Sub, "test">, Leaf> = {
  new: { values: ["--match"], flags: [], positional: "name" },
  install: { values: ["--data-dir"], flags: [], positional: "file" },
  uninstall: { values: ["--data-dir"], flags: [], positional: "name" },
  list: { values: ["--data-dir"], flags: ["--json"], positional: null },
};

export function testOptions(): string[] {
  return environment().parser(TEST_SPEC).actions.flatMap((action) => action.option_strings);
}

export function allowedFlags(sub: Sub): string[] {
  if (sub === "test") return [...TOP_FLAGS, ...testOptions()];
  const leaf = LEAVES[sub];
  return [...TOP_FLAGS, ...leaf.values, ...leaf.flags];
}

function takeShared(argv: readonly string[], start: number, into: string[]): number | undefined {
  let index = start;
  while (index < argv.length) {
    const token = argv[index] as string;
    const name = token.split("=")[0] as string;
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

function flagName(token: string): string {
  return token.split("=")[0] as string;
}

export function parseScripts(argv: readonly string[]): ScriptsArgs | undefined {
  const hoisted: string[] = [];
  let index = takeShared(argv, 0, hoisted);
  if (index === undefined || argv[index] !== "scripts") return undefined;
  index = takeShared(argv, index + 1, hoisted);
  if (index === undefined) return undefined;
  const sub = argv[index];
  if (sub === undefined || !SUBCOMMANDS.includes(sub)) return undefined;
  if (sub === "test") return { sub, match: null, json: false, hoisted, rest: argv.slice(index + 1) };
  const leaf = LEAVES[sub as Exclude<Sub, "test">];
  const known = [...leaf.values, ...leaf.flags];
  if (hoisted.some((token) => token.startsWith("--") && !known.includes(flagName(token)))) return undefined;
  const parsed: ScriptsArgs = { sub: sub as Sub, match: null, json: false };
  const tokens = [...hoisted, ...argv.slice(index + 1)];
  let positional: string | undefined;
  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at] as string;
    if (token.startsWith("-") && token !== "-" && !NEGATIVE_NUMBER.test(token)) {
      const equals = token.indexOf("=");
      const name = equals < 0 ? token : token.slice(0, equals);
      if (leaf.flags.includes(token)) {
        parsed.json = true;
        continue;
      }
      if (!leaf.values.includes(name)) return undefined;
      let value: string;
      if (equals >= 0) value = token.slice(equals + 1);
      else {
        const next = tokens[at + 1];
        if (next === undefined || (next.startsWith("-") && next !== "-" && !NEGATIVE_NUMBER.test(next))) return undefined;
        value = next;
        at += 1;
      }
      if (name === "--match") (parsed.match ??= []).push(value);
      else parsed.dataDir = value;
      continue;
    }
    if (leaf.positional === null || positional !== undefined) return undefined;
    positional = token;
  }
  if (leaf.positional !== null) {
    if (positional === undefined) return undefined;
    parsed[leaf.positional] = positional;
  }
  return parsed;
}

export function jsonRequested(argv: readonly string[]): boolean {
  const end = argv.indexOf("--");
  return (end < 0 ? argv : argv.slice(0, end)).includes("--json");
}
