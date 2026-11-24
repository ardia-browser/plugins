import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, realpathSync, writeSync } from "node:fs";
import { isatty } from "node:tty";
import { dumps, type Value } from "../json.ts";
import { MAX_NOTE, refuseApproval, runRequest } from "../notes-files.ts";
import { untrustedText } from "./untrusted.ts";
import { parseArgs as parseNotes } from "../notes.ts";
import { loads } from "../pyjson.ts";
import { pyStr } from "../pylib/plain.ts";
import { add as addPlugin, find as findPlugin, pluginRunResult, registry, remove as removePlugin, runPlugin } from "./auth/providers.ts";
import { listing, loadMeta, publicMeta, remove as removeProfile, save as saveProfile, totpCode } from "./auth/vault.ts";
import { parse } from "./commands/parse.ts";
import { Usage } from "./daemon-errors.ts";
import { Result } from "./daemon/render.ts";
import { runLocal as runFlowLocal, runsLocally as flowRunsLocally } from "./flows/flows.ts";
import { browseDir, checkName, closeFd, listNames, lockHeld, readPrivateJson } from "./paths.ts";
import { ALIASES as READ_ALIASES, flags as readFlags, MAX_STDIN, readLocal, readsStdin, runsLocally as readRunsLocally, singleFetch } from "./read/pages.ts";
import { run as fetchRun } from "./read/fetch.ts";

export const LOCAL_AUTH = ["save", "list", "show", "delete", "totp"];
const MAX_SCRIPT_SOURCE = 256 * 1024;

export type LiveSession = Record<string, Value> & { key: string; session: string };

export function readStdin(limit: number): string {
  const chunks: Buffer[] = [];
  let total = 0;
  const buffer = Buffer.alloc(64 * 1024);
  for (;;) {
    let read: number;
    try {
      read = readSync(0, buffer, 0, buffer.length, null);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EAGAIN") continue;
      if ((error as NodeJS.ErrnoException).code === "EOF") break;
      throw error;
    }
    if (read === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, read)));
    total += read;
    if (total > limit * 4 + 4) break;
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return [...text].slice(0, limit).join("");
}

function codePointLength(text: string): number {
  return [...text].length;
}

function promptPassword(): Promise<string> {
  const tty = openSync("/dev/tty", "r+");
  try {
    writeSync(tty, "Password: ");
    spawnSync("/bin/stty", ["-echo"], { stdio: [tty, "ignore", "ignore"] });
    const bytes: number[] = [];
    const one = Buffer.alloc(1);
    try {
      while (readSync(tty, one, 0, 1, null) === 1 && one[0] !== 0x0a) bytes.push(one[0] as number);
    } finally {
      spawnSync("/bin/stty", ["echo"], { stdio: [tty, "ignore", "ignore"] });
      writeSync(tty, "\n");
    }
    return Promise.resolve(Buffer.from(bytes).toString("utf8").replace(/\r$/u, ""));
  } finally {
    closeSync(tty);
  }
}

const TERMINAL_SEQUENCES = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[P^_X][^\u001b]*(?:\u001b\\)?|[@-Z\\-_])|\u009b[0-?]*[ -/]*[@-~]|[\u0090\u009d\u009e\u009f][^\u009c]*\u009c?/gu;
const TERMINAL_CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

export function terminalSafe(text: string): string {
  return text.replace(/\r\n?/gu, "\n").replace(TERMINAL_SEQUENCES, "").replace(TERMINAL_CONTROLS, "");
}

export function approveOnTerminal(site: string, text: string): boolean {
  if (!isatty(0)) refuseApproval();
  let tty: number;
  try {
    tty = openSync("/dev/tty", "r+");
  } catch {
    refuseApproval();
  }
  try {
    const shown = terminalSafe(untrustedText(text)).split("\n").map((line) => `  ${line}`).join("\n");
    writeSync(tty, `Notes for ${site}:\n${shown}\nApprove them as trusted site notes? [y/N] `);
    const bytes: number[] = [];
    const one = Buffer.alloc(1);
    while (readSync(tty, one, 0, 1, null) === 1 && one[0] !== 0x0a) bytes.push(one[0] as number);
    return /^y(es)?$/iu.test(Buffer.from(bytes).toString("utf8").trim());
  } finally {
    closeSync(tty);
  }
}

export function notesNeedPage(args: string[]): boolean {
  if (args.some((arg) => arg === "--tab" || arg.startsWith("--tab="))) return true;
  try {
    const request = parseNotes(args);
    return request.site === null && request.action !== "list";
  } catch {
    return false;
  }
}

function readArgs(args: string[]): [Record<string, unknown>, string[]] | null {
  try {
    return parse(args, readFlags(), READ_ALIASES) as [Record<string, unknown>, string[]];
  } catch (error) {
    if (error instanceof Usage) return null;
    throw error;
  }
}

export function readRunsHere(args: string[]): boolean {
  const parsed = readArgs(args);
  return parsed !== null && readRunsLocally(parsed[0] as never, parsed[1]);
}

export function readStdinUrls(args: string[]): string | null {
  const parsed = readArgs(args);
  if (parsed === null || !readsStdin(parsed[0] as never, parsed[1])) return null;
  return readStdin(MAX_STDIN);
}

export function readStdinNote(): string {
  const text = readStdin(MAX_NOTE * 4 + 1);
  if (codePointLength(text) > MAX_NOTE * 4) throw new Usage(`stdin is over ${MAX_NOTE * 4} characters; notes hold at most ${MAX_NOTE / 1024} KB per site`);
  return text;
}

const GIT = process.platform === "darwin" ? "/usr/bin/git" : "git";

export function sessionId(args: string[], cwd: string): string {
  const [options] = parse(args, { "--scope": "value", "--prefix": "value" });
  const scope = (options["scope"] as string | undefined) || "cwd";
  let base = cwd;
  if (scope === "worktree") {
    const done = spawnSync(GIT, ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", timeout: 10_000 });
    base = (done.error === undefined && typeof done.stdout === "string" ? done.stdout.trim() : "") || cwd;
  } else if (scope !== "cwd") throw new Usage("--scope takes cwd or worktree");
  let real = base;
  try {
    real = realpathSync(base);
  } catch {}
  const digest = createHash("sha256").update(real, "utf8").digest("hex").slice(0, 8);
  return checkName("A session id", `${(options["prefix"] as string | undefined) || "s"}-${digest}`);
}

export function liveSessions(root: string): LiveSession[] {
  const dir = browseDir(root);
  try {
    const rows: LiveSession[] = [];
    for (const entry of listNames(dir).sort()) {
      if (!entry.endsWith(".json") || entry.startsWith(".")) continue;
      const key = entry.slice(0, -5);
      if (!lockHeld(`${key}.lock`, dir)) continue;
      const meta = readPrivateJson(entry, dir);
      if (meta instanceof Map && meta.size > 0) rows.push({ ...Object.fromEntries(meta), key } as LiveSession);
    }
    return rows;
  } finally {
    closeFd(dir);
  }
}

function inlineCode(text: string): boolean {
  return ![".js", ".mjs", ".ts"].some((suffix) => text.endsWith(suffix)) && [" ", ";", "(", "=", "\n"].some((mark) => text.includes(mark));
}

export function scriptSource(args: string[], cwd: string, expand: (path: string) => string): string {
  const [options, positional] = parse(args, { "--timeout": "value", "--stdin": "bool", "--repl": "bool", "--persist": "bool", "--reset": "bool" });
  if (positional.length > 1) throw new Usage("Usage: ardia browse script [file.js] [--timeout 90s] [--repl] [--reset]; quote the script in a heredoc on stdin, or put it in a file");
  let source: string;
  const first = positional[0];
  if (first !== undefined && first !== "-") {
    try {
      const fd = openSync(expand(first), "r");
      try {
        const buffer = Buffer.alloc(MAX_SCRIPT_SOURCE * 4 + 4);
        let length = 0;
        for (let read = 1; read > 0 && length < buffer.length; length += read) read = readSync(fd, buffer, length, buffer.length - length, null);
        source = [...buffer.subarray(0, length).toString("utf8")].slice(0, MAX_SCRIPT_SOURCE + 1).join("");
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if (!inlineCode(first)) throw new Usage(`Can't read ${first}: ${strerror(error)}`);
      source = first;
    }
  } else if (first !== undefined || options["stdin"] || !isatty(0)) source = readStdin(MAX_SCRIPT_SOURCE + 1);
  else if (options["reset"]) source = "";
  else throw new Usage("ardia browse script reads the script from a file or stdin: ardia browse script <<'EOF' … EOF");
  if (codePointLength(source) > MAX_SCRIPT_SOURCE) throw new Usage(`The script is over ${MAX_SCRIPT_SOURCE / 1024} KB`);
  void cwd;
  return source;
}

function strerror(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  const reasons: Record<string, string> = { ENOENT: "No such file or directory", EACCES: "Permission denied", EISDIR: "Is a directory", ENOTDIR: "Not a directory" };
  return (code && reasons[code]) || String((error as Error).message ?? error);
}

function profileLine(row: Record<string, unknown>): string {
  return `${row["name"]}  ${row["username"] || "-"}  ${row["url"]}`;
}

async function auth(root: string, args: string[]): Promise<Result> {
  const action = args[0] ?? "list";
  if (action === "save") {
    const [parsed, positional] = parse(args.slice(1), {
      "--url": "value",
      "--origin": "multi",
      "--username": "value",
      "--password": "value",
      "--password-stdin": "bool",
      "--totp-stdin": "bool",
      "--no-totp": "bool",
      "--username-selector": "value",
      "--password-selector": "value",
      "--submit-selector": "value",
    });
    if (positional.length === 0) throw new Usage("Usage: ardia browse auth save <name> --url <https url> --username <u> [--password-stdin]");
    const name = positional[0] as string;
    const meta = await saveProfile(root, name, parsed, { stdin: () => readStdin(Number.MAX_SAFE_INTEGER), isTTY: () => isatty(0), prompt: promptPassword });
    const kept = meta["totp"] ? "password and TOTP secret" : "password";
    return new Result(publicMeta(meta), `✓ Saved ${name} for ${(meta["origins"] as string[]).join(", ")} (${kept} in the login Keychain)`);
  }
  if (action === "totp") {
    if (args.length < 2) throw new Usage("Usage: ardia browse auth totp <name>");
    const name = args[1] as string;
    const { code, remaining, waited } = await totpCode(root, name);
    return new Result({ name, code, remaining, waited: waited > 0 }, `${code}  (valid for ${remaining} s)`);
  }
  if (action === "list") {
    const rows = listing(root);
    return new Result({ profiles: rows }, rows.map(profileLine).join("\n") || "No saved auth profiles");
  }
  if (action === "show") {
    if (args.length < 2) throw new Usage("Usage: ardia browse auth show <name>");
    const meta = publicMeta(loadMeta(root, args[1] as string));
    return new Result({ profile: meta }, Object.entries(meta).filter(([, value]) => value !== null && value !== undefined).map(([key, value]) => `${key}: ${pyStr(value)}`).join("\n"));
  }
  if (action === "delete") {
    if (args.length < 2) throw new Usage("Usage: ardia browse auth delete <name>");
    await removeProfile(root, args[1] as string);
    return new Result({ deleted: args[1] }, `✓ Deleted ${args[1]}`);
  }
  throw new Usage(`Unknown auth subcommand: ${action}`);
}

async function plugin(root: string, args: string[]): Promise<Result> {
  const action = args[0] ?? "list";
  if (action === "add") {
    const [parsed, positional] = parse(args.slice(1), { "--name": "value", "--capability": "multi" });
    if (positional.length === 0) throw new Usage("Usage: ardia browse plugin add <npm-name[@version] | owner/repo[#ref]> [--name n]");
    const added = await addPlugin(root, positional[0] as string, (parsed["name"] as string | undefined) ?? null, (parsed["capability"] as string[] | undefined) ?? null);
    return new Result({ plugin: added }, `✓ Added ${added["name"]} (${added["spec"]})`);
  }
  if (action === "list") {
    const rows = registry(root);
    return new Result({ plugins: rows }, rows.map((row) => `${row["name"]}  ${(row["capabilities"] as string[]).join(", ")}`).join("\n") || "No plugins");
  }
  if (action === "show") {
    if (args.length < 2) throw new Usage("Usage: ardia browse plugin show <name>");
    const found = findPlugin(root, args[1] as string);
    return new Result({ plugin: found }, dumps(toValue(found), "indented", true));
  }
  if (action === "remove") {
    if (args.length < 2) throw new Usage("Usage: ardia browse plugin remove <name>");
    removePlugin(root, args[1] as string);
    return new Result({ removed: args[1] }, `✓ Removed ${args[1]}`);
  }
  if (action === "run") {
    const [parsed, positional] = parse(args.slice(1), { "--payload": "value" });
    if (positional.length < 2) throw new Usage("Usage: ardia browse plugin run <name> <type> [--payload json]");
    const payload = parsed["payload"] ? loads(parsed["payload"] as string) : new Map();
    const shown = pluginRunResult(await runPlugin(root, positional[0] as string, positional[1] as string, payload));
    return new Result(shown.data, shown.text);
  }
  throw new Usage(`Unknown plugin subcommand: ${action}`);
}

function toValue(value: unknown): Value {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(toValue);
  if (typeof value === "object" && !(value instanceof Map)) return new Map(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, toValue(item)]));
  if (typeof value === "number") return Number.isInteger(value) ? BigInt(value) : (value as unknown as Value);
  return value as Value;
}

export function servesHere(command: string, args: string[]): boolean {
  if (command === "auth") return LOCAL_AUTH.includes(args[0] ?? "list");
  if (command === "notes") return !notesNeedPage(args);
  if (command === "flow") return flowRunsLocally(args);
  if (command === "plugin") return true;
  if (command === "read") return readRunsHere(args);
  if (command === "session") return args[0] === "id" || args[0] === "list";
  return false;
}

export async function runLocal(command: string, args: string[], root: string, options: Record<string, unknown>, cwd: string): Promise<Result | null> {
  if (command === "auth") return auth(root, args);
  if (command === "plugin") return plugin(root, args);
  if (command === "flow") return runFlowLocal(root, args);
  if (command === "notes") {
    const request = parseNotes(args);
    if (request.text === "-") request.text = readStdinNote();
    return runRequest(root, request, null, approveOnTerminal);
  }
  if (command === "read") {
    const [parsed, positional] = parse(args, readFlags(), READ_ALIASES);
    if (singleFetch(parsed as never, positional)) return fetchRun(positional[0] as string, parsed as never, options as never);
    return readLocal(parsed as never, positional, readStdinUrls(args), options as never);
  }
  if (command === "session") {
    if (args[0] === "id") {
      const value = sessionId(args.slice(1), cwd);
      return new Result({ session: value }, value);
    }
    if (args[0] === "list") {
      const rows = liveSessions(root);
      const current = options["_session"];
      const lines = ["Active sessions:", ...rows.map((row) => `${row.session === current ? "→" : " "} ${row.session}`)];
      return new Result({ sessions: rows }, rows.length > 0 ? lines.join("\n") : "No active sessions");
    }
  }
  return null;
}
