import { ALIASES } from "./tables.ts";

export type Kind = "bool" | "value" | "multi";
export type Grammar = { flags: Readonly<Record<string, Kind>>; aliases: Readonly<Record<string, string>> };
export type Parsed = { options: Map<string, string | true | string[]>; positionals: string[] } | { usage: string };

export const DAEMON_GRAMMAR: Readonly<Record<string, Grammar>> = {
  click: { flags: { "--button": "value", "--new-tab": "bool", "--no-humanize": "bool" }, aliases: {} },
  fill: { flags: { "--no-humanize": "bool" }, aliases: {} },
  find: { flags: { "--exact": "bool", "--name": "value", "--no-humanize": "bool", "--partial": "bool" }, aliases: {} },
  get: { flags: {}, aliases: {} },
  is: { flags: {}, aliases: {} },
  open: {
    flags: { "--capture-console": "bool", "--enable": "multi", "--headers": "value", "--init-script": "multi", "--label": "value", "--read": "bool", "--show": "bool" },
    aliases: {},
  },
  press: { flags: { "--no-humanize": "bool" }, aliases: {} },
  scroll: { flags: { "--no-humanize": "bool", "--selector": "value" }, aliases: { "-s": "--selector" } },
  snapshot: {
    flags: { "--compact": "bool", "--cursor": "bool", "--depth": "value", "--diff": "bool", "--interactive": "bool", "--selector": "value", "--urls": "bool" },
    aliases: { "-C": "--cursor", "-c": "--compact", "-d": "--depth", "-i": "--interactive", "-s": "--selector", "-u": "--urls" },
  },
  tab: { flags: { "--label": "value", "--show": "bool" }, aliases: {} },
  type: { flags: { "--delay": "value", "--no-humanize": "bool" }, aliases: {} },
  wait: {
    flags: { "--download": "bool", "--fn": "value", "--load": "value", "--state": "value", "--text": "value", "--timeout": "value", "--url": "value" },
    aliases: { "-f": "--fn", "-l": "--load", "-t": "--text", "-u": "--url" },
  },
};

export const PLUGIN_FLAGS: Readonly<Record<string, readonly string[]>> = {
  snapshot: ["--compact", "--depth", "--diff", "--interactive", "--selector", "--urls"],
  get: [],
  click: ["--button", "--no-humanize"],
  fill: ["--no-humanize"],
  press: ["--no-humanize"],
  type: ["--delay", "--no-humanize"],
  scroll: ["--no-humanize", "--selector"],
  wait: ["--load", "--state", "--text", "--timeout", "--url"],
  find: ["--exact", "--name", "--no-humanize", "--partial"],
  is: [],
  tab: [],
};

const GET_KINDS = ["text", "html", "value", "attr", "title", "url", "count", "box"];
const TAB_ACTIONS = ["new", "close", "active"];
const NEGATIVE_NUMBER = /^-\p{Nd}/u;

function keyOf(name: string): string {
  return name.replace(/^-+/, "").replaceAll("-", "_");
}

export function daemonParse(argv: readonly string[], grammar: Grammar): Parsed {
  const options = new Map<string, string | true | string[]>();
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; ) {
    const token = argv[index] as string;
    index += 1;
    if (token === "--") {
      positionals.push(...argv.slice(index));
      break;
    }
    const split = token.startsWith("--") && token.includes("=");
    const equals = token.indexOf("=");
    let name = split ? token.slice(0, equals) : token;
    let inline: string | undefined = split ? token.slice(equals + 1) : undefined;
    name = grammar.aliases[name] ?? name;
    const kind = grammar.flags[name];
    if (kind !== undefined) {
      const key = keyOf(name);
      if (kind === "bool") {
        const word = inline?.toLowerCase();
        if (word !== undefined && !["true", "1", "yes", "on"].includes(word)) return { usage: `${name} takes no value: give ${name}, or leave it out` };
        options.set(key, true);
        continue;
      }
      if (inline === undefined) {
        if (index >= argv.length) return { usage: `${name} needs a value` };
        inline = argv[index] as string;
        index += 1;
      }
      if (kind === "multi") {
        const list = options.get(key);
        options.set(key, Array.isArray(list) ? [...list, inline] : [inline]);
      } else options.set(key, inline);
      continue;
    }
    if (token.startsWith("-") && token.length > 1 && !NEGATIVE_NUMBER.test(token)) return { usage: `Unknown flag: ${token}` };
    positionals.push(token);
  }
  return { options, positionals };
}

export type Verdict = { allowed: true } | { allowed: false; why: string; nested: boolean };

function positionalRefusal(name: string, positionals: readonly string[]): string | undefined {
  if (name === "get" && positionals.length > 0 && !GET_KINDS.includes(positionals[0] as string)) return `\`get ${positionals[0]}\``;
  if (name === "tab" && (positionals.length > 1 || TAB_ACTIONS.includes(positionals[0] ?? ""))) return `\`tab ${positionals.join(" ")}\``;
  return undefined;
}

const HELP_WORDS = ["help", "--help", "-h"];
const VERSION_WORDS = ["--version", "-V"];

function answeredByTheClient(rest: readonly string[]): boolean {
  if (rest.length === 0 || HELP_WORDS.includes(rest[0] as string) || VERSION_WORDS.includes(rest[0] as string)) return true;
  return rest.slice(1).some((word) => word === "--help" || word === "-h");
}

export function pluginVerdict(rest: readonly string[]): Verdict {
  if (answeredByTheClient(rest)) return { allowed: true };
  const command = rest[0] ?? "";
  const name = ALIASES[command] ?? command;
  const argv = rest.slice(1);
  if (name === "batch") return { allowed: false, why: `\`${command}\``, nested: true };
  if (name === "open") {
    const parsed = daemonParse(argv, DAEMON_GRAMMAR.open as Grammar);
    if ("options" in parsed && parsed.options.get("read") === true) return { allowed: false, why: `\`${command} --read\``, nested: true };
  }
  const allowed = PLUGIN_FLAGS[name];
  const grammar = DAEMON_GRAMMAR[name];
  if (allowed === undefined || grammar === undefined) return { allowed: false, why: `\`${command}\``, nested: false };
  const parsed = daemonParse(argv, grammar);
  if ("usage" in parsed) return { allowed: false, why: `\`${command}\` with arguments the plugin guard can't read (${parsed.usage})`, nested: false };
  for (const key of parsed.options.keys()) {
    const flag = Object.keys(grammar.flags).find((candidate) => keyOf(candidate) === key) as string;
    if (!allowed.includes(flag)) return { allowed: false, why: `\`${command} ${flag}\``, nested: false };
  }
  const refused = positionalRefusal(name, parsed.positionals);
  return refused === undefined ? { allowed: true } : { allowed: false, why: refused, nested: false };
}
