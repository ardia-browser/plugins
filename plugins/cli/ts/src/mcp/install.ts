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
      const next = argv[at + 1];
      if (equals < 0 && next !== undefined && next.startsWith("-")) return { error: "--command needs the path of the ardia command" };
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

export function resolveTarget(file: string): string {
  let info: fs.Stats;
  try {
    info = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return file;
    throw new ConfigError(`Can't read ${file}: ${(error as Error).message}`);
  }
  if (!info.isSymbolicLink()) return file;
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(path.dirname(file), fs.readlinkSync(file));
  }
}

export function writeAtomic(file: string, text: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let mode = 0o600;
  try {
    const info = fs.lstatSync(file);
    if (info.isSymbolicLink()) throw new ConfigError(`${file} is a symlink; resolve it before writing`);
    mode = info.mode & 0o777;
  } catch (error) {
    if (error instanceof ConfigError || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temp = path.join(dir, `.${path.basename(file)}.ardia-${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
  const bytes = Buffer.from(text, "utf8");
  const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), mode);
  try {
    fs.fchmodSync(fd, mode);
    for (let at = 0; at < bytes.length; ) at += fs.writeSync(fd, bytes, at, bytes.length - at);
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
  const given = found !== null && typeof found === "object" && !Array.isArray(found) ? (found as Record<string, unknown>) : {};
  const otherTransport = given["url"] !== undefined || given["serverUrl"] !== undefined || (given["type"] !== undefined && given["type"] !== "stdio");
  const kept: Record<string, unknown> = otherTransport ? (given["env"] !== undefined ? { env: given["env"] } : {}) : given;
  const next: Record<string, unknown> = client === "claude" ? { type: "stdio", ...kept, command: wanted.command, args: wanted.args } : { ...kept, command: wanted.command, args: wanted.args };
  if (client !== "claude" && otherTransport) delete next["type"];
  if (client === "claude" && next["env"] === undefined) next["env"] = {};
  const merged = { ...config, mcpServers: { ...servers, [SERVER_NAME]: next } };
  return { text: `${JSON.stringify(merged, null, 2)}\n`, change: found === undefined ? "added" : "updated", entry: wanted };
}

type TomlStatement = { kind: "header" | "key"; path: string[]; local: string[]; array: boolean; start: number; end: number };
type ValueMode = null | "basic" | "literal" | "mlbasic" | "mlliteral";

const BARE_KEY = /[A-Za-z0-9_-]/u;
const OURS = ["mcp_servers", SERVER_NAME];

function readKey(text: string, from: number): { path: string[]; at: number } | null {
  const path: string[] = [];
  let at = from;
  for (;;) {
    while (text[at] === " " || text[at] === "\t") at += 1;
    const first = text[at];
    if (first === '"') {
      let end = at + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      if (end >= text.length) return null;
      try {
        path.push(JSON.parse(text.slice(at, end + 1)) as string);
      } catch {
        return null;
      }
      at = end + 1;
    } else if (first === "'") {
      const end = text.indexOf("'", at + 1);
      if (end < 0) return null;
      path.push(text.slice(at + 1, end));
      at = end + 1;
    } else {
      let end = at;
      while (end < text.length && BARE_KEY.test(text[end] as string)) end += 1;
      if (end === at) return null;
      path.push(text.slice(at, end));
      at = end;
    }
    while (text[at] === " " || text[at] === "\t") at += 1;
    if (text[at] !== ".") return { path, at };
    at += 1;
  }
}

function valueEnd(lines: readonly string[], line: number, column: number): number {
  let depth = 0;
  let mode: ValueMode = null;
  for (let index = line; index < lines.length; index += 1) {
    const text = lines[index] as string;
    let at = index === line ? column : 0;
    while (at < text.length) {
      const char = text[at];
      if (mode === "mlbasic" || mode === "mlliteral") {
        const quote = mode === "mlbasic" ? '"' : "'";
        if (mode === "mlbasic" && char === "\\") {
          at += 2;
          continue;
        }
        if (text.startsWith(quote.repeat(3), at)) {
          let next = at + 3;
          while (text[next] === quote && next < at + 5) next += 1;
          mode = null;
          at = next;
          continue;
        }
        at += 1;
        continue;
      }
      if (mode === "basic") {
        if (char === "\\") at += 2;
        else {
          if (char === '"') mode = null;
          at += 1;
        }
        continue;
      }
      if (mode === "literal") {
        if (char === "'") mode = null;
        at += 1;
        continue;
      }
      if (char === "#") break;
      if (text.startsWith('"""', at)) {
        mode = "mlbasic";
        at += 3;
      } else if (text.startsWith("'''", at)) {
        mode = "mlliteral";
        at += 3;
      } else if (char === '"') {
        mode = "basic";
        at += 1;
      } else if (char === "'") {
        mode = "literal";
        at += 1;
      } else {
        if (char === "[" || char === "{") depth += 1;
        else if (char === "]" || char === "}") depth -= 1;
        at += 1;
      }
    }
    if (mode === "basic" || mode === "literal") throw new ConfigError("the Codex config has an unterminated string, so it was left alone");
    if (mode === null && depth <= 0) return index;
  }
  throw new ConfigError("the Codex config has an unterminated value, so it was left alone");
}

export function scanToml(lines: readonly string[]): TomlStatement[] {
  const out: TomlStatement[] = [];
  let table: string[] = [];
  for (let index = 0; index < lines.length; ) {
    const text = lines[index] as string;
    const trimmed = text.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      index += 1;
      continue;
    }
    if (trimmed.startsWith("[")) {
      const array = trimmed.startsWith("[[");
      const key = readKey(trimmed, array ? 2 : 1);
      if (key === null || !trimmed.startsWith(array ? "]]" : "]", key.at)) throw new ConfigError(`the Codex config has a table header it can't read on line ${index + 1}, so it was left alone`);
      table = key.path;
      out.push({ kind: "header", path: key.path, local: key.path, array, start: index, end: index });
      index += 1;
      continue;
    }
    const key = readKey(text, 0);
    if (key === null || text[key.at] !== "=") throw new ConfigError(`the Codex config has a line it can't read (line ${index + 1}), so it was left alone`);
    const end = valueEnd(lines, index, key.at + 1);
    out.push({ kind: "key", path: [...table, ...key.path], local: key.path, array: false, start: index, end });
    index = end + 1;
  }
  return out;
}

function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((part, index) => path[index] === part);
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && startsWith(a, b);
}

function refuseInline(statements: readonly TomlStatement[]): void {
  for (const statement of statements) {
    if (statement.kind === "header" && statement.array && startsWith(statement.path, ["mcp_servers"])) {
      throw new ConfigError("the Codex config declares mcp_servers as an array of tables, so it was left alone; edit it by hand");
    }
    if (statement.kind !== "key") continue;
    const table = statement.path.slice(0, statement.path.length - statement.local.length);
    const definesServers = table.length === 0 && statement.local[0] === "mcp_servers";
    const definesOurs = samePath(table, ["mcp_servers"]) && statement.local[0] === SERVER_NAME;
    if (definesServers || definesOurs) {
      throw new ConfigError("the Codex config defines mcp_servers with an inline table or dotted keys, so it was left alone; add [mcp_servers.ardia] by hand, or switch it to [mcp_servers.<name>] tables");
    }
  }
}

type TomlSection = { start: number; end: number; main: boolean };

function ourSections(lines: readonly string[], statements: readonly TomlStatement[]): TomlSection[] {
  const headers = statements.filter((statement) => statement.kind === "header");
  const out: TomlSection[] = [];
  headers.forEach((header, index) => {
    if (!startsWith(header.path, OURS)) return;
    let end = index + 1 < headers.length ? (headers[index + 1] as TomlStatement).start : lines.length;
    while (end > header.start + 1 && (lines[end - 1] as string).trim() === "") end -= 1;
    out.push({ start: header.start, end, main: samePath(header.path, OURS) });
  });
  return out;
}

function parseToml(text: string | null, what: string): Record<string, unknown> {
  if (text === null || text.trim() === "") return {};
  try {
    return Bun.TOML.parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new ConfigError(`${what} (${(error as Error).message}), so it was left alone`);
  }
}

function withoutOurs(document: Record<string, unknown>): string {
  const copy = JSON.parse(JSON.stringify(document)) as Record<string, unknown>;
  const servers = copy["mcp_servers"];
  if (servers !== null && typeof servers === "object" && !Array.isArray(servers)) {
    delete (servers as Record<string, unknown>)[SERVER_NAME];
    if (Object.keys(servers).length === 0) delete copy["mcp_servers"];
  }
  return stableJson(copy);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function verifiedToml(before: string | null, after: string, wanted: ServerEntry | null): string {
  const old = parseToml(before, "the Codex config isn't valid TOML");
  const next = parseToml(after, "the edit would have left the Codex config invalid");
  const { lines } = splitLines(after);
  const headers = scanToml(lines).filter((statement) => statement.kind === "header" && !statement.array).map((statement) => JSON.stringify(statement.path));
  const ours = headers.filter((header) => header === JSON.stringify(OURS)).length;
  const servers = next["mcp_servers"] as Record<string, unknown> | undefined;
  const entry = servers !== undefined ? servers[SERVER_NAME] : undefined;
  const fine =
    withoutOurs(old) === withoutOurs(next) &&
    new Set(headers).size === headers.length &&
    (wanted === null ? ours === 0 && entry === undefined : ours === 1 && sameEntry(entry, wanted));
  if (!fine) throw new ConfigError("the edit couldn't be made cleanly, so the Codex config was left alone; edit [mcp_servers.ardia] by hand");
  return after;
}

function splitLines(text: string | null): { lines: string[]; newline: string } {
  const source = text ?? "";
  return { lines: source === "" ? [] : source.split(/\r?\n/u), newline: source.includes("\r\n") ? "\r\n" : "\n" };
}

export function tomlEntry(text: string | null): ServerEntry | null {
  const servers = parseToml(text, "the Codex config isn't valid TOML")["mcp_servers"];
  return servers !== null && typeof servers === "object" ? entryOf((servers as Record<string, unknown>)[SERVER_NAME]) : null;
}

export function tomlBlock(entry: ServerEntry): string[] {
  return [`[mcp_servers.${SERVER_NAME}]`, `command = ${JSON.stringify(entry.command)}`, `args = ${JSON.stringify(entry.args).replaceAll(",", ", ")}`];
}

function finished(lines: readonly string[], newline: string): string {
  const joined = lines.join(newline).replace(/(?:\r?\n)+$/u, "");
  return joined === "" ? "" : `${joined}${newline}`;
}

export function editToml(text: string | null, action: Action, wanted: ServerEntry): { text: string | null; change: Change; entry: ServerEntry | null } {
  const current = tomlEntry(text);
  const { lines, newline } = splitLines(text);
  const statements = scanToml(lines);
  const sections = ourSections(lines, statements);
  const main = sections.find((section) => section.main);
  if (action === "status") return { text: null, change: main === undefined && current === null ? "absent" : "unchanged", entry: current };
  refuseInline(statements);
  if (action === "uninstall") {
    if (sections.length === 0) return { text: null, change: "absent", entry: null };
    const gone = (index: number) => sections.some((section) => (index >= section.start && index < section.end) || (index === section.start - 1 && (lines[index] as string).trim() === ""));
    const kept = lines.filter((_, index) => !gone(index));
    while (kept.length > 0 && (kept[0] as string).trim() === "" && (lines[0] as string).trim() !== "") kept.shift();
    return { text: verifiedToml(text, finished(kept, newline), null), change: "removed", entry: null };
  }
  const block = tomlBlock(wanted);
  if (main === undefined) {
    const body = [...lines];
    while (body.length > 0 && (body[body.length - 1] as string).trim() === "") body.pop();
    return { text: verifiedToml(text, finished(body.length === 0 ? block : [...body, "", ...block], newline), wanted), change: "added", entry: wanted };
  }
  if (current !== null && sameEntry(current, wanted)) return { text: null, change: "unchanged", entry: current };
  const replaced = statements.filter((statement) => statement.kind === "key" && statement.start > main.start && statement.start < main.end && statement.local.length === 1 && (statement.local[0] === "command" || statement.local[0] === "args"));
  const dropped = (index: number) => replaced.some((statement) => index >= statement.start && index <= statement.end);
  const body = lines.slice(main.start + 1, main.end).filter((_, offset) => !dropped(main.start + 1 + offset));
  const next = [...lines.slice(0, main.start), lines[main.start] as string, ...block.slice(1), ...body, ...lines.slice(main.end)];
  return { text: verifiedToml(text, finished(next, newline), wanted), change: "updated", entry: wanted };
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
    const target = resolveTarget(file);
    const text = readText(target);
    const edited = client === "codex" ? editToml(text, args.action, wanted) : editJson(file, text, args.action, wanted, client);
    const written = edited.text !== null && !args.dryRun && args.action !== "status";
    if (written) writeAtomic(target, edited.text as string);
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
  if (outcomes.length === 0) {
    const message = "No Claude Code, Codex or Cursor config found; pick one with --client claude|codex|cursor";
    write(args.json ? `${JSON.stringify({ success: false, error: message })}\n` : `✗ ${message}\n`);
    return 1;
  }
  if (args.json) {
    write(`${JSON.stringify({ success: true, action: args.action, dryRun: args.dryRun, clients: outcomes })}\n`);
    return 0;
  }
  const lines = outcomes.map((outcome) => outcomeLine(outcome, args.action, args.dryRun));
  if (args.action === "install" && !args.dryRun && outcomes.some((outcome) => outcome.written)) lines.push("Restart the client (or reload its MCP servers) to pick up browser_repl and browser_act.");
  write(`${lines.join("\n")}\n`);
  return 0;
}
