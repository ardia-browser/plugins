import { isSpace, strip } from "../../py.ts";
import { Usage } from "../daemon-errors.ts";

export type Kind = "bool" | "value" | "multi";
export type Flags = Readonly<Record<string, Kind>>;
export type Parsed = Record<string, unknown>;

export const KNOWN_SCHEMES = ["http", "https", "about", "data", "file", "blob", "chrome", "view-source"];
const LOOPBACK = /^(localhost|127\.\p{Nd}+\.\p{Nd}+\.\p{Nd}+|\[::1\])(:\p{Nd}+)?(\/|$)/u;
const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/u;

export function parse(argv: readonly string[], flags: Flags = {}, aliases: Readonly<Record<string, string>> = {}): [Parsed, string[]] {
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
    if (token.startsWith("-") && token.length > 1 && !/^-\p{Nd}/u.test(token)) throw new Usage(`Unknown flag: ${token}`);
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
  if (LOOPBACK.test(url)) return `http://${url}`;
  return `https://${url}`;
}
