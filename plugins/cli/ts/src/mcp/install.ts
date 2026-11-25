import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Client = "claude" | "codex" | "cursor";
export const CLIENTS: readonly Client[] = ["claude", "codex", "cursor"];
export const SERVER_NAME = "ardia";
export const CLIENT_NAMES: Readonly<Record<Client, string>> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor" };

export type ServerEntry = { command: string; args: string[] };
export type Action = "install" | "uninstall" | "status";
export type Change = "added" | "updated" | "unchanged" | "removed" | "absent";
export type Outcome = { client: Client; name: string; path: string; change: Change; written: boolean; entry: ServerEntry | null; matches: boolean };
export type ManageArgs = { action: Action; clients: Client[] | null; dryRun: boolean; json: boolean; command: string | null; help: boolean };

export class ConfigError extends Error {}

export const MCP_MANAGE_HELP = `Usage: ardia mcp install|uninstall [--client claude|codex|cursor|all] [--command PATH] [--dry-run] [--json]
       ardia mcp status [--client ...] [--json]

install adds the ardia MCP server (\`ardia mcp\`) to each client's config, keeping every other server and
setting as it was: Claude Code (~/.claude.json), Codex (~/.codex/config.toml) and Cursor (~/.cursor/mcp.json).
Without --client it sets up the clients whose config already exists. Running it again changes nothing.
uninstall removes only the ardia entry; status shows where it is set up.

ARDIA_MCP_CLAUDE_CONFIG, ARDIA_MCP_CODEX_CONFIG and ARDIA_MCP_CURSOR_CONFIG point at other config files.
`;

export function configPaths(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): Record<Client, string> {
  const codexHome = env["CODEX_HOME"] || path.join(home, ".codex");
  return {
    claude: env["ARDIA_MCP_CLAUDE_CONFIG"] || path.join(home, ".claude.json"),
    codex: env["ARDIA_MCP_CODEX_CONFIG"] || path.join(codexHome, "config.toml"),
    cursor: env["ARDIA_MCP_CURSOR_CONFIG"] || path.join(home, ".cursor", "mcp.json"),
  };
}

export function serverEntry(command: string | null = null): ServerEntry {
  return { command: command && command.trim() ? command : SERVER_NAME, args: ["mcp"] };
}

export function parseManage(argv: readonly string[]): ManageArgs | { error: string } {
  const action = argv[0] as Action;
  const out: ManageArgs = { action, clients: null, dryRun: false, json: false, command: null, help: false };
  for (let at = 1; at < argv.length; at += 1) {
    const token = argv[at] as string;
    const equals = token.startsWith("--") ? token.indexOf("=") : -1;
    const name = equals > 0 ? token.slice(0, equals) : token;
    const value = (): string | null => {
      if (equals > 0) return token.slice(equals + 1);
      const next = argv[at + 1];
      if (next === undefined) return null;
      at += 1;
      return next;
    };
    if (name === "--dry-run") out.dryRun = true;
    else if (name === "--json") out.json = true;
    else if (name === "--help" || name === "-h") out.help = true;
    else if (name === "--client") {
      const given = value();
      if (given === null) return { error: "--client needs claude, codex, cursor or all" };
      const picked: Client[] = [];
      for (const part of given.split(",").map((item) => item.trim().toLowerCase())) {
        if (part === "all") picked.push(...CLIENTS);
        else if ((CLIENTS as readonly string[]).includes(part)) picked.push(part as Client);
        else return { error: `--client takes claude, codex, cursor or all, not ${part}` };
      }
      out.clients = [...new Set([...(out.clients ?? []), ...picked])];
    } else if (name === "--command" && action !== "status") {
      const given = value();
      if (given === null || !given.trim()) return { error: "--command needs the path of the ardia command" };
      out.command = given;
    } else return { error: `ardia mcp ${action} doesn't take ${token}` };
  }
  return out;
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ConfigError(`Can't read ${file}: ${(error as Error).message}`);
  }
}

export function writeAtomic(file: string, text: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let mode = 0o600;
  try {
    const info = fs.lstatSync(file);
    if (info.isSymbolicLink()) {
      const real = fs.realpathSync(file);
      writeAtomic(real, text);
      return;
    }
    mode = info.mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temp = path.join(dir, `.${path.basename(file)}.ardia-${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
  const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, mode);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(temp, { force: true });
    throw error;
  }
  fs.closeSync(fd);
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

function sameEntry(found: unknown, wanted: ServerEntry): boolean {
  if (found === null || typeof found !== "object" || Array.isArray(found)) return false;
  const record = found as Record<string, unknown>;
  return record["command"] === wanted.command && JSON.stringify(record["args"] ?? []) === JSON.stringify(wanted.args);
}

function entryOf(found: unknown): ServerEntry | null {
  if (found === null || typeof found !== "object" || Array.isArray(found)) return null;
  const record = found as Record<string, unknown>;
  if (typeof record["command"] !== "string") return null;
  const args = Array.isArray(record["args"]) ? record["args"].map(String) : [];
  return { command: record["command"], args };
}

function parseJsonConfig(file: string, text: string | null): Record<string, unknown> {
  if (text === null || text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${file} isn't valid JSON (${(error as Error).message}), so it was left alone`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new ConfigError(`${file} doesn't hold a JSON object, so it was left alone`);
  return parsed as Record<string, unknown>;
}

function jsonServers(file: string, config: Record<string, unknown>): Record<string, unknown> {
  const servers = config["mcpServers"];
  if (servers === undefined) return {};
  if (servers === null || typeof servers !== "object" || Array.isArray(servers)) throw new ConfigError(`${file} has an mcpServers that isn't an object, so it was left alone`);
  return servers as Record<string, unknown>;
}

export function editJson(file: string, text: string | null, action: Action, wanted: ServerEntry, client: Client): { text: string | null; change: Change; entry: ServerEntry | null } {
  const config = parseJsonConfig(file, text);
  const servers = jsonServers(file, config);
  const found = Object.hasOwn(servers, SERVER_NAME) ? servers[SERVER_NAME] : undefined;
  if (action === "status") return { text: null, change: found === undefined ? "absent" : "unchanged", entry: entryOf(found) };
  if (action === "uninstall") {
    if (found === undefined) return { text: null, change: "absent", entry: null };
    const rest = { ...servers };
    delete rest[SERVER_NAME];
    return { text: `${JSON.stringify({ ...config, mcpServers: rest }, null, 2)}\n`, change: "removed", entry: null };
  }
  if (found !== undefined && sameEntry(found, wanted)) return { text: null, change: "unchanged", entry: entryOf(found) };
  const kept = found !== null && typeof found === "object" && !Array.isArray(found) ? (found as Record<string, unknown>) : {};
  const next: Record<string, unknown> = client === "claude" ? { type: "stdio", ...kept, command: wanted.command, args: wanted.args } : { ...kept, command: wanted.command, args: wanted.args };
  if (client === "claude" && next["env"] === undefined) next["env"] = {};
  const merged = { ...config, mcpServers: { ...servers, [SERVER_NAME]: next } };
  return { text: `${JSON.stringify(merged, null, 2)}\n`, change: found === undefined ? "added" : "updated", entry: wanted };
}

const TABLE_HEADER = /^[ \t]*\[\[?[ \t]*([^\]\r\n]+?)[ \t]*\]\]?[ \t]*(?:#.*)?$/u;
const OUR_NAME = String.raw`mcp_servers[ \t]*\.[ \t]*(?:ardia|"ardia"|'ardia')`;
const OUR_TABLE = new RegExp(`^${OUR_NAME}(?:[ \\t]*\\..*)?$`, "u");
const OUR_MAIN = new RegExp(`^${OUR_NAME}$`, "u");
const TOML_KEY_LINE = /^[ \t]*(command|args)[ \t]*=[ \t]*(.+?)[ \t]*$/u;

type Section = { start: number; end: number; main: boolean };

function tomlSections(lines: readonly string[]): Section[] {
  const found: Section[] = [];
  let open: { start: number; main: boolean } | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const header = TABLE_HEADER.exec(lines[index] as string);
    if (header === null) continue;
    if (open !== null) {
      found.push({ ...open, end: index });
      open = null;
    }
    const name = (header[1] as string).trim();
    if (OUR_TABLE.test(name)) open = { start: index, main: OUR_MAIN.test(name) };
  }
  if (open !== null) found.push({ ...open, end: lines.length });
  return found.map((section) => {
    let end = section.end;
    while (end > section.start + 1 && (lines[end - 1] as string).trim() === "") end -= 1;
    return { ...section, end };
  });
}

function tomlValue(text: string): unknown {
  const body = text.replace(/[ \t]+#.*$/u, "");
  try {
    return JSON.parse(body);
  } catch {
    if (/^'[^']*'$/u.test(body)) return body.slice(1, -1);
    if (/^\[.*\]$/u.test(body)) {
      try {
        return JSON.parse(body.replace(/'([^']*)'/gu, (_whole, inner: string) => JSON.stringify(inner)).replace(/,\s*\]$/u, "]"));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function sectionEntry(lines: readonly string[], section: Section | undefined): ServerEntry | null {
  if (section === undefined) return null;
  const values: Record<string, unknown> = {};
  for (const line of lines.slice(section.start + 1, section.end)) {
    const found = TOML_KEY_LINE.exec(line);
    if (found !== null) values[found[1] as string] = tomlValue(found[2] as string);
  }
  return entryOf(values);
}

function splitLines(text: string | null): { lines: string[]; newline: string } {
  const source = text ?? "";
  return { lines: source === "" ? [] : source.split(/\r?\n/u), newline: source.includes("\r\n") ? "\r\n" : "\n" };
}

export function tomlEntry(text: string | null): ServerEntry | null {
  const { lines } = splitLines(text);
  return sectionEntry(lines, tomlSections(lines).find((section) => section.main));
}

export function tomlBlock(entry: ServerEntry): string[] {
  return [`[mcp_servers.${SERVER_NAME}]`, `command = ${JSON.stringify(entry.command)}`, `args = ${JSON.stringify(entry.args).replaceAll(",", ", ")}`];
}

function finished(lines: readonly string[], newline: string): string {
  const joined = lines.join(newline).replace(/(?:\r?\n)+$/u, "");
  return joined === "" ? "" : `${joined}${newline}`;
}

export function editToml(text: string | null, action: Action, wanted: ServerEntry): { text: string | null; change: Change; entry: ServerEntry | null } {
  const { lines, newline } = splitLines(text);
  const sections = tomlSections(lines);
  const main = sections.find((section) => section.main);
  const current = sectionEntry(lines, main);
  if (action === "status") return { text: null, change: main === undefined ? "absent" : "unchanged", entry: current };
  if (action === "uninstall") {
    if (sections.length === 0) return { text: null, change: "absent", entry: null };
    const gone = (index: number) => sections.some((section) => (index >= section.start && index < section.end) || (index === section.start - 1 && (lines[index] as string).trim() === ""));
    return { text: finished(lines.filter((_, index) => !gone(index)), newline), change: "removed", entry: null };
  }
  const block = tomlBlock(wanted);
  if (main === undefined) {
    const body = [...lines];
    while (body.length > 0 && (body[body.length - 1] as string).trim() === "") body.pop();
    return { text: finished(body.length === 0 ? block : [...body, "", ...block], newline), change: "added", entry: wanted };
  }
  if (current !== null && sameEntry(current, wanted)) return { text: null, change: "unchanged", entry: current };
  const body = lines.slice(main.start + 1, main.end).filter((line) => TOML_KEY_LINE.exec(line) === null);
  const next = [...lines.slice(0, main.start), lines[main.start] as string, ...block.slice(1), ...body, ...lines.slice(main.end)];
  return { text: finished(next, newline), change: "updated", entry: wanted };
}

export function present(paths: Record<Client, string>): Client[] {
  return CLIENTS.filter((client) => fs.existsSync(paths[client]) || (client !== "claude" && fs.existsSync(path.dirname(paths[client]))));
}

export function manage(args: ManageArgs, paths: Record<Client, string> = configPaths()): Outcome[] {
  const wanted = serverEntry(args.command);
  const clients = args.clients ?? (args.action === "status" ? [...CLIENTS] : present(paths));
  const outcomes: Outcome[] = [];
  for (const client of clients) {
    const file = paths[client];
    const text = readText(file);
    const edited = client === "codex" ? editToml(text, args.action, wanted) : editJson(file, text, args.action, wanted, client);
    const written = edited.text !== null && !args.dryRun && args.action !== "status";
    if (written) writeAtomic(file, edited.text as string);
    outcomes.push({ client, name: CLIENT_NAMES[client], path: file, change: edited.change, written, entry: edited.entry, matches: edited.entry !== null && sameEntry(edited.entry, wanted) });
  }
  return outcomes;
}

function shown(file: string): string {
  const home = os.homedir();
  return file === home || file.startsWith(`${home}${path.sep}`) ? `~${file.slice(home.length)}` : file;
}

export function outcomeLine(outcome: Outcome, action: Action, dryRun: boolean): string {
  const where = shown(outcome.path);
  if (action === "status") {
    if (outcome.entry === null) return `- ${outcome.name}: not set up (${where})`;
    return `✓ ${outcome.name}: ${outcome.entry.command} ${outcome.entry.args.join(" ")} (${where})`;
  }
  const verb: Record<Change, string> = {
    added: dryRun ? "would add ardia to" : "added ardia to",
    updated: dryRun ? "would update ardia in" : "updated ardia in",
    removed: dryRun ? "would remove ardia from" : "removed ardia from",
    unchanged: "already set up in",
    absent: "no ardia entry in",
  };
  const mark = outcome.change === "unchanged" || outcome.change === "absent" ? "=" : "✓";
  return `${mark} ${outcome.name}: ${verb[outcome.change]} ${where}`;
}

export function manageMain(args: ManageArgs, write: (text: string) => void, paths: Record<Client, string> = configPaths()): number {
  if (args.help) {
    write(MCP_MANAGE_HELP);
    return 0;
  }
  let outcomes: Outcome[];
  try {
    outcomes = manage(args, paths);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    write(args.json ? `${JSON.stringify({ success: false, error: message })}\n` : `✗ ${message}\n`);
    return 1;
  }
  if (args.json) {
    write(`${JSON.stringify({ success: true, action: args.action, dryRun: args.dryRun, clients: outcomes })}\n`);
    return 0;
  }
  if (outcomes.length === 0) {
    write("✗ No Claude Code, Codex or Cursor config found; pick one with --client claude|codex|cursor\n");
    return 1;
  }
  const lines = outcomes.map((outcome) => outcomeLine(outcome, args.action, args.dryRun));
  if (args.action === "install" && !args.dryRun && outcomes.some((outcome) => outcome.written)) lines.push("Restart the client (or reload its MCP servers) to pick up browser_repl and browser_act.");
  write(`${lines.join("\n")}\n`);
  return 0;
}
