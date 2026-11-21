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
