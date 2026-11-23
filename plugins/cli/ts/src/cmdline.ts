export type OptionSpec = {
  name: string;
  dest: string;
  kind: "value" | "flag" | "append";
  choices?: readonly string[];
  type?: "int" | "float";
};

export type CommandSpec = { options: readonly OptionSpec[]; positional?: string };

export type Parsed = Map<string, string | boolean | string[] | number | bigint>;

export const SHARED_VALUE_FLAGS: readonly string[] = ["--port", "--ws", "--data-dir", "--timeout"];
const SHARED_BOOL_FLAGS: readonly string[] = ["--json"];
const NEGATIVE_NUMBER = /^-\d+$|^-\d*\.\d+$/;
const PLAIN_INT = /^[+-]?[0-9]+$/;
const PLAIN_FLOAT = /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;

export type Arranged = { kind: "ok"; hoisted: string[]; rest: string[] } | { kind: "usage"; message: string };

function takeShared(argv: readonly string[], start: number, into: string[]): number | { usage: string } {
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
      if (index + 1 >= argv.length) return { usage: `${name} needs a value` };
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

export function arrange(argv: readonly string[], path: readonly string[], takes: readonly string[]): Arranged | undefined {
  const hoisted: string[] = [];
  let index = 0;
  for (const word of path) {
    const next = takeShared(argv, index, hoisted);
    if (typeof next !== "number") return { kind: "usage", message: next.usage };
    if (argv[next] !== word) return undefined;
    index = next + 1;
  }
  for (const token of hoisted) {
    if (!token.startsWith("--")) continue;
    const name = token.split("=")[0] as string;
    if (!takes.includes(name)) return { kind: "usage", message: `${path.join(" ")} doesn't take ${name}` };
  }
  return { kind: "ok", hoisted, rest: argv.slice(index) };
}

function looksLikeOption(token: string): boolean {
  return token.startsWith("-") && token !== "-" && !NEGATIVE_NUMBER.test(token);
}

function converted(option: OptionSpec, text: string): string | number | bigint | undefined {
  if (option.choices !== undefined && !option.choices.includes(text)) return undefined;
  if (option.type === "int") return PLAIN_INT.test(text) ? BigInt(text) : undefined;
  if (option.type === "float") return PLAIN_FLOAT.test(text) ? Number.parseFloat(text) : undefined;
  return text;
}

export function parseStrict(tokens: readonly string[], spec: CommandSpec): Parsed | undefined {
  const parsed: Parsed = new Map();
  for (const option of spec.options) {
    if (option.kind === "flag") parsed.set(option.dest, false);
    if (option.kind === "append") parsed.set(option.dest, []);
  }
  const positionals: string[] = [];
  let chunks = 0;
  let inChunk = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (token === "--") {
      const after = tokens.slice(index + 1);
      if (after.length > 0) {
        if (!inChunk) chunks += 1;
        positionals.push(...after);
      }
      break;
    }
    if (!looksLikeOption(token)) {
      if (!inChunk) chunks += 1;
      inChunk = true;
      positionals.push(token);
      continue;
    }
    inChunk = false;
    const [name, ...valueParts] = token.split("=");
    const option = spec.options.find((candidate) => candidate.name === name);
    if (option === undefined) return undefined;
    if (option.kind === "flag") {
      if (valueParts.length > 0) return undefined;
      parsed.set(option.dest, true);
      continue;
    }
    let text: string;
    if (valueParts.length > 0) text = valueParts.join("=");
    else {
      const next = tokens[index + 1];
      if (next === undefined || looksLikeOption(next) || next === "--") return undefined;
      text = next;
      index += 1;
    }
    const value = converted(option, text);
    if (value === undefined) return undefined;
    if (option.kind === "append") (parsed.get(option.dest) as string[]).push(String(value));
    else parsed.set(option.dest, value);
  }
  if (spec.positional === undefined) return positionals.length > 0 ? undefined : parsed;
  if (chunks > 1) return undefined;
  parsed.set(spec.positional, positionals);
  return parsed;
}

export function optionNames(spec: CommandSpec): string[] {
  return ["-h", "--help", "--version", "--skill", ...spec.options.map((option) => option.name)];
}
