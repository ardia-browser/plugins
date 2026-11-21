export type Option = {
  names: readonly string[];
  dest: string;
  kind: "value" | "flag" | "append";
  choices?: readonly string[];
  accepts?: (value: string) => boolean;
  group?: string;
};

export type Positional = { dest: string; nargs: "one" | "optional" | "many" | "some" };

export type Spec = { options: readonly Option[]; positionals: readonly Positional[] };

export type Parsed = { values: Map<string, string | undefined>; flags: Set<string>; lists: Map<string, string[]>; seen: Set<string> };

const SHARED_VALUE_FLAGS = ["--port", "--ws", "--data-dir", "--timeout"];
export const TOP_FLAGS = ["-h", "--help", "--version", "--skill"];
const HELP = ["-h", "--help"];

export type Arranged = { path: string[]; hoisted: string[]; rest: string[] };

function takeShared(argv: string[], start: number, into: string[]): number | undefined {
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
      const value = argv[index + 1];
      if (value === undefined || (value.startsWith("-") && value !== "-")) return undefined;
      into.push(token, value);
      index += 2;
      continue;
    }
    if (token === "--json") {
      into.push(token);
      index += 1;
      continue;
    }
    break;
  }
  return index;
}

export function arrange(argv: string[], tree: Map<string, readonly string[] | undefined>): Arranged | undefined {
  const hoisted: string[] = [];
  let index = takeShared(argv, 0, hoisted);
  if (index === undefined) return undefined;
  const command = argv[index];
  if (command === undefined || !tree.has(command)) return undefined;
  const path = [command];
  index += 1;
  const verbs = tree.get(command);
  if (verbs !== undefined) {
    const next = takeShared(argv, index, hoisted);
    if (next === undefined) return undefined;
    index = next;
    const verb = argv[index];
    if (verb === undefined || !verbs.includes(verb)) return undefined;
    path.push(verb);
    index += 1;
  }
  return { path, hoisted, rest: argv.slice(index) };
}

export function hoistedNames(hoisted: string[]): string[] {
  return hoisted.filter((token) => token.startsWith("--")).map((token) => token.split("=")[0] as string);
}

function optionNamed(spec: Spec, name: string): Option | undefined {
  return spec.options.find((option) => option.names.includes(name));
}

export function optionNames(spec: Spec): string[] {
  return [...HELP, ...spec.options.flatMap((option) => option.names)];
}

function looksLikeOption(token: string): boolean {
  return token.startsWith("-") && token !== "-";
}

function assign(spec: Spec, run: string[], parsed: Parsed): boolean {
  const required = spec.positionals.filter((item) => item.nargs === "one" || item.nargs === "some").length;
  const variadic = spec.positionals.some((item) => item.nargs === "many" || item.nargs === "some");
  const most = variadic ? Number.POSITIVE_INFINITY : spec.positionals.length;
  if (run.length < required || run.length > most) return false;
  let spare = run.length - required;
  let at = 0;
  for (const item of spec.positionals) {
    if (item.nargs === "one") parsed.values.set(item.dest, run[at++]);
    else if (item.nargs === "optional") {
      parsed.values.set(item.dest, spare > 0 ? run[at++] : undefined);
      if (spare > 0) spare -= 1;
    } else {
      const take = (item.nargs === "some" ? 1 : 0) + spare;
      parsed.lists.set(item.dest, run.slice(at, at + take));
      at += take;
      spare = 0;
    }
  }
  return at === run.length;
}

export function parse(tokens: string[], spec: Spec): Parsed | undefined {
  const parsed: Parsed = { values: new Map(), flags: new Set(), lists: new Map(), seen: new Set() };
  const run: string[] = [];
  let runEnded = false;
  const groups = new Map<string, string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (!looksLikeOption(token)) {
      if (runEnded && run.length > 0) return undefined;
      run.push(token);
      continue;
    }
    if (run.length > 0) runEnded = true;
    const equals = token.startsWith("--") ? token.indexOf("=") : -1;
    const name = equals < 0 ? token : token.slice(0, equals);
    const option = optionNamed(spec, name);
    if (option === undefined) return undefined;
    if (option.group !== undefined) {
      const holder = groups.get(option.group);
      if (holder !== undefined && holder !== option.dest) return undefined;
      groups.set(option.group, option.dest);
    }
    parsed.seen.add(option.dest);
    if (option.kind === "flag") {
      if (equals >= 0) return undefined;
      parsed.flags.add(option.dest);
      continue;
    }
    let value: string;
    if (equals >= 0) value = token.slice(equals + 1);
    else {
      const next = tokens[index + 1];
      if (next === undefined || looksLikeOption(next)) return undefined;
      value = next;
      index += 1;
    }
    if (option.choices !== undefined && !option.choices.includes(value)) return undefined;
    if (option.accepts !== undefined && !option.accepts(value)) return undefined;
    if (option.kind === "append") parsed.lists.set(option.dest, [...(parsed.lists.get(option.dest) ?? []), value]);
    else parsed.values.set(option.dest, value);
  }
  return assign(spec, run, parsed) ? parsed : undefined;
}

export function leafTokens(arranged: Arranged, spec: Spec): string[] | undefined {
  if (arranged.rest.includes("--")) return undefined;
  const known = optionNames(spec);
  if (hoistedNames(arranged.hoisted).some((name) => !known.includes(name))) return undefined;
  return [...arranged.hoisted, ...arranged.rest];
}
