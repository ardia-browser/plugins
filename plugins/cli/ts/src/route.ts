import { type Command, parseCommand } from "./cli-command.ts";
import { emptyListing, type Kind, type Listing } from "./listing.ts";
import { servedTable, type ServingSide } from "./served.ts";

export type Route = { kind: "version" } | { kind: "help" } | { kind: "listing"; what: Kind; listing: Listing } | { kind: "command"; command: Command } | { kind: "python" };

const U64_MAX = (1n << 64n) - 1n;
const PY_INT_MAX_STR_DIGITS = 4300;
const KINDS: readonly string[] = ["tabs", "groups", "windows", "commands"];

class Cursor {
  index = 0;
  constructor(readonly argv: string[]) {}

  valueOf(name: string): string | undefined {
    const token = this.argv[this.index] ?? "";
    if (token.startsWith(`${name}=`)) {
      this.index += 1;
      return token.slice(name.length + 1);
    }
    if (token !== name) return undefined;
    const value = this.argv[this.index + 1];
    if (value === undefined || value.startsWith("-")) return undefined;
    this.index += 2;
    return value;
  }
}

export function labelOf(route: Route): string | undefined {
  if (route.kind === "version") return "--version";
  if (route.kind === "help") return "--help";
  if (route.kind === "command") return route.command.label;
  return route.kind === "listing" ? route.what : undefined;
}

export function route(argv: string[], table: Map<string, ServingSide> = servedTable()): Route {
  const parsed = parseRoute(argv);
  const label = labelOf(parsed);
  return label !== undefined && !table.has(label) ? { kind: "python" } : parsed;
}

function same(argv: string[], words: string[]): boolean {
  return argv.length === words.length && argv.every((word, index) => word === words[index]);
}

export function parseRoute(argv: string[]): Route {
  if (same(argv, ["--version"])) return { kind: "version" };
  if (argv.length === 0 || same(argv, ["--help"]) || same(argv, ["-h"])) return { kind: "help" };
  const command = parseCommand(argv);
  if (command !== undefined) return { kind: "command", command };
  const listing = emptyListing();
  const cursor = new Cursor(argv);
  let kind: Kind | undefined;
  while (kind === undefined) {
    const token = argv[cursor.index];
    if (token === undefined) return { kind: "python" };
    if (token === "--json") {
      listing.json = true;
      cursor.index += 1;
      continue;
    }
    const dataDir = cursor.valueOf("--data-dir");
    if (dataDir !== undefined) {
      listing.dataDir = dataDir;
      continue;
    }
    if (!KINDS.includes(token)) return { kind: "python" };
    kind = token as Kind;
  }
  cursor.index += 1;
  const tabs = kind === "tabs";
  const picks = kind === "tabs" || kind === "groups";
  while (cursor.index < argv.length) {
    const token = argv[cursor.index];
    if (token === "--json") listing.json = true;
    else if (token === "--flat" && tabs) listing.flat = true;
    else if (token === "--usage" && tabs) listing.usage = true;
    else {
      const dataDir = cursor.valueOf("--data-dir");
      if (dataDir !== undefined) {
        listing.dataDir = dataDir;
        continue;
      }
      if (picks) {
        const window = cursor.valueOf("--window");
        if (window !== undefined) {
          listing.window = window;
          continue;
        }
        const profile = cursor.valueOf("--profile");
        if (profile !== undefined) {
          listing.profile = profile;
          continue;
        }
      }
      if (tabs) {
        const pid = cursor.valueOf("--pid");
        if (pid !== undefined) {
          if (!/^[0-9]+$/.test(pid) || pid.length > PY_INT_MAX_STR_DIGITS || BigInt(pid) > U64_MAX) return { kind: "python" };
          listing.pid = BigInt(pid);
          continue;
        }
      }
      return { kind: "python" };
    }
    cursor.index += 1;
  }
  return { kind: "listing", what: kind, listing };
}
