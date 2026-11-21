import { flag } from "../metrics.ts";
import { isSpace, strip } from "../../py.ts";
import { decimalValue } from "../../pylib/unicode.ts";
import { Usage } from "../daemon-errors.ts";

export type Kind = "bool" | "value" | "multi";
export type Flags = Readonly<Record<string, Kind>>;
export type Parsed = Record<string, unknown>;

export const KNOWN_SCHEMES = ["http", "https", "about", "data", "file", "blob", "chrome", "chrome-extension", "chrome-untrusted", "devtools", "view-source"];
const LOOPBACK = /^(localhost|127\.[0-9]+\.[0-9]+\.[0-9]+|\[::1\])(:[0-9]+)?(\/|$)/u;

function pyDigit(point: string | undefined): boolean {
  return point !== undefined && decimalValue(point.codePointAt(0) as number) >= 0;
}

function digitsAsZero(text: string): string {
  let mapped = "";
  for (const point of text) mapped += (point.codePointAt(0) as number) >= 0x80 && pyDigit(point) ? "0" : point;
  return mapped;
}
const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/u;

export const SELECTOR_FLAG: Flags = { "--selector": "value" };
export const SELECTOR_ALIAS: Readonly<Record<string, string>> = { "-s": "--selector" };

export function withSelector(options: Parsed, args: string[], at = 0, extra = Number.POSITIVE_INFINITY): string[] {
  const given = options["selector"];
  if (typeof given !== "string") return args;
  if (given === "" || given === "--") throw new Usage("-s/--selector needs a selector");
  if (args.length > at + extra) throw new Usage("give the selector once: as a word or with -s/--selector, not both");
  flag("guessed_syntax", true);
  return [...args.slice(0, at), given, ...args.slice(at)];
}

export function isSelectorFlag(token: string): boolean {
  return token === "-s" || token === "--selector" || token.startsWith("--selector=");
}

export function leadingSelector(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token === "--" || !token.startsWith("-")) return [...out, ...argv.slice(index)];
    if (!isSelectorFlag(token)) {
      out.push(token);
      continue;
    }
    const value = token.startsWith("--selector=") ? token.slice("--selector=".length) : argv[index + 1];
    if (value === undefined || value === "" || value === "--") throw new Usage("-s/--selector needs a selector");
    flag("guessed_syntax", true);
    return [...out, value, ...argv.slice(token.startsWith("--selector=") ? index + 1 : index + 2)];
  }
  return out;
}

export function parse(
  argv: readonly string[],
  flags: Flags = {},
  aliases: Readonly<Record<string, string>> = {},
  opaque: ((positionals: readonly string[]) => boolean) | null = null,
): [Parsed, string[]] {
  const options: Parsed = {};
  const positionals: string[] = [];
  let index = 0;
  while (index < argv.length) {
    const token = argv[index] as string;
    index += 1;
    if (token === "--") {
      for (let rest = index; rest < argv.length; rest += 1) positionals.push(argv[rest] as string);
      break;
    }
    if (opaque !== null && opaque(positionals)) {
      positionals.push(token);
      continue;
    }
    const split = token.startsWith("--") && token.includes("=");
    let name = split ? token.slice(0, token.indexOf("=")) : token;
    let inline: string | null = split ? token.slice(token.indexOf("=") + 1) : null;
    name = Object.hasOwn(aliases, name) ? (aliases[name] as string) : name;
    if (Object.hasOwn(flags, name)) {
      const kind = flags[name] as Kind;
      const key = name.replace(/^-+/u, "").replaceAll("-", "_");
      if (kind === "bool") options[key] = true;
      else {
        if (inline === null) {
          if (index >= argv.length) throw new Usage(`${name} needs a value`);
          inline = argv[index] as string;
          index += 1;
        }
        if (kind === "multi") {
          const values = options[key];
          if (Array.isArray(values)) values.push(inline);
          else options[key] = [inline];
        } else options[key] = inline;
      }
      continue;
    }
    if (token.startsWith("-") && token.length > 1 && !pyDigit([...token.slice(1, 3)][0])) throw new Usage(`Unknown flag: ${name}`);
    positionals.push(token);
  }
  return [options, positionals];
}

export function need(positionals: readonly string[], count: number, usage: string): void {
  if (positionals.length < count) throw new Usage(`Usage: ardia browse ${usage}`);
}

export function normalizeUrl(given: string): string {
  const url = strip(given, isSpace);
  const match = SCHEME.exec(url);
  if (match && KNOWN_SCHEMES.includes((match[1] as string).toLowerCase())) return url;
  if (LOOPBACK.test(digitsAsZero(url))) return `http://${url}`;
  return `https://${url}`;
}
