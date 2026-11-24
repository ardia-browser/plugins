import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { iso, now } from "./clock.ts";
import { places } from "./config-files.ts";
import { agentPaths, logPath } from "./hooks/agent.ts";
import { type JsonObject } from "./json.ts";
import { home, join, LINUX } from "./paths.ts";
import { closeDir, type Dir, O_NOFOLLOW, O_NONBLOCK, O_RDONLY, writePrivate } from "./privatefs.ts";
import { SOCKET_FILE } from "./protocol.ts";
import { utf8 } from "./pystr.ts";
import { addRemoved, CATEGORY_ORDER, emptyRemoved, type Removed, triageScrub } from "./triage-scrub.ts";

const KIB = 1024;
const MIB = 1024 * KIB;
const TELEMETRY_FILE_CAP = 1 * MIB;
const TELEMETRY_TOTAL_CAP = 6 * MIB;
const TELEMETRY_DAYS_BACK = 7;
const TELEMETRY_FILE = /^(?:cli-)?\d{4}-\d{2}-\d{2}\.jsonl$/;
const CRASH_COUNT = 5;
const CRASH_FILE_CAP = 2 * MIB;
const CRASH_SCAN_LIMIT = 200;
const CRASH_HEAD_BYTES = 64 * KIB;
const MAC_CRASH_PREFIXES = ["Ardia-", "Chromium Helper"];
const MAC_CRASH_MARKS = ["/Ardia.app/Contents/", "\"bundleID\":\"com.ardia.", "\"bundleID\" : \"com.ardia."];
const CONFIG_CAP = 1 * MIB;
const LINUX_DUMP_LIST = 10;
const SOCKET_WAIT_MS = 1000;

export type Item = { name: string; what: string; source: string; kept: number; size: number; cut: string | undefined; removed: Removed };
export type Skipped = { what: string; why: string };
export type Collected = { items: Item[]; skipped: Skipped[]; removed: Removed; dumps: string[] };

export function shownPath(path: string): string {
  const mine = home();
  if (mine !== "" && mine !== "/" && (path === mine || path.startsWith(`${mine}/`))) return `~${path.slice(mine.length)}`;
  return path;
}

type Read = { text: string; size: number; kept: number; lines: number } | { missing: string };

function readTail(path: string, cap: number, wholeLines: boolean): Read {
  let fd: number;
  try {
    fd = openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { missing: code === "ENOENT" ? "not there" : code === "ELOOP" ? "a symbolic link, not read" : `couldn't be read (${code ?? "error"})` };
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) return { missing: "not a regular file" };
    const size = info.size;
    const start = Math.max(0, size - cap);
    const buffer = Buffer.alloc(Math.min(size, cap));
    let filled = 0;
    while (filled < buffer.length) {
      const got = readSync(fd, buffer, filled, buffer.length - filled, start + filled);
      if (got === 0) break;
      filled += got;
    }
    let bytes = buffer.subarray(0, filled);
    if (start > 0 && wholeLines) {
      const newline = bytes.indexOf(0x0a);
      bytes = newline < 0 ? Buffer.alloc(0) : bytes.subarray(newline + 1);
    }
    const text = new TextDecoder("utf-8").decode(bytes);
    return { text, size, kept: bytes.length, lines: text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0) };
  } finally {
    closeSync(fd);
  }
}

function listFiles(folder: string): { name: string; path: string; mtime: number; size: number }[] {
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return [];
  }
  const found: { name: string; path: string; mtime: number; size: number }[] = [];
  for (const name of names) {
    const path = join(folder, name);
    try {
      const info = statSync(path);
      if (info.isFile()) found.push({ name, path, mtime: info.mtimeMs, size: info.size });
    } catch {}
  }
  return found.sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : -1));
}

class Collector {
  readonly items: Item[] = [];
  readonly skipped: Skipped[] = [];
  readonly removed = emptyRemoved();
  readonly dumps: string[] = [];

  constructor(readonly dir: Dir) {}

  keep(name: string, what: string, path: string, read: Exclude<Read, { missing: string }>, cut: string | undefined): void {
    const done = triageScrub(read.text);
    const text = done.text === "" ? "" : `${done.text}\n`;
    writePrivate(name, this.dir, utf8(text));
    addRemoved(this.removed, done.removed);
    this.items.push({ name, what, source: shownPath(path), kept: read.kept, size: read.size, cut, removed: done.removed });
  }
}

function collectTelemetry(collector: Collector, dataRoot: string): void {
  const folder = join(dataRoot, "Telemetry", "local");
  const today = iso(now()).slice(0, 10);
  const oldest = iso(now() - TELEMETRY_DAYS_BACK * 24 * 60 * 60).slice(0, 10);
  const dated = (name: string) => name.replace(/^cli-/, "").slice(0, 10);
  const files = listFiles(folder).filter((file) => TELEMETRY_FILE.test(file.name) && dated(file.name) >= oldest && dated(file.name) <= today);
  if (files.length === 0) {
    collector.skipped.push({ what: "the local usage log", why: `no files in ${shownPath(folder)}` });
    return;
  }
  let budget = TELEMETRY_TOTAL_CAP;
  for (const file of files) {
    if (budget <= 0) {
      collector.skipped.push({ what: `usage log ${file.name}`, why: `over the ${TELEMETRY_TOTAL_CAP / MIB} MB the usage log may take in all` });
      continue;
    }
    const cap = Math.min(TELEMETRY_FILE_CAP, budget);
    const read = readTail(file.path, cap, true);
    if ("missing" in read) {
      collector.skipped.push({ what: `usage log ${file.name}`, why: read.missing });
      continue;
    }
    budget -= read.kept;
    const cut = read.kept < read.size ? `kept the last ${read.lines} lines (${read.kept} of ${read.size} bytes)` : undefined;
    const who = file.name.startsWith("cli-") ? "the ardia command's" : "the app's";
    collector.keep(`usage-${file.name}`, `${who} local usage log for ${file.name.replace(/^cli-/, "").replace(/\.jsonl$/, "")} (UTC): events with counts, timings, enums and flags`, file.path, read, cut);
  }
}

export function macCrashCandidates(folder: string): { name: string; path: string; mtime: number; size: number }[] {
  return listFiles(folder)
    .filter((file) => file.name.endsWith(".ips") && MAC_CRASH_PREFIXES.some((prefix) => file.name.startsWith(prefix)))
    .slice(0, CRASH_SCAN_LIMIT);
}

export function looksLikeArdia(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch {
    return false;
  }
  try {
    if (!fstatSync(fd).isFile()) return false;
    const buffer = Buffer.alloc(CRASH_HEAD_BYTES);
    const got = readSync(fd, buffer, 0, buffer.length, 0);
    const head = new TextDecoder("utf-8").decode(buffer.subarray(0, got));
    return MAC_CRASH_MARKS.some((mark) => head.includes(mark));
  } finally {
    closeSync(fd);
  }
}

function collectMacCrashes(collector: Collector, folder: string): void {
  const ours = macCrashCandidates(folder).filter((file) => looksLikeArdia(file.path));
  if (ours.length === 0) {
    collector.skipped.push({ what: "crash and hang reports", why: `none from Ardia in ${shownPath(folder)}` });
    return;
  }
  let taken = 0;
  for (const file of ours) {
    if (taken >= CRASH_COUNT) {
      collector.skipped.push({ what: `crash report ${file.name}`, why: `only the newest ${CRASH_COUNT} are copied` });
      continue;
    }
    if (file.size > CRASH_FILE_CAP) {
      collector.skipped.push({ what: `crash report ${file.name}`, why: `${(file.size / MIB).toFixed(1)} MB is over the ${CRASH_FILE_CAP / MIB} MB limit` });
      continue;
    }
    const read = readTail(file.path, CRASH_FILE_CAP, false);
    if ("missing" in read) {
      collector.skipped.push({ what: `crash report ${file.name}`, why: read.missing });
      continue;
    }
    taken += 1;
    collector.keep(`crash-${taken}.ips`, `a crash or hang report macOS wrote on ${iso(file.mtime / 1000).slice(0, 19)}Z (${file.name})`, file.path, read, undefined);
  }
}

function collectLinuxDumps(collector: Collector, dataRoot: string): void {
  const folder = join(dataRoot, "Crash Reports");
  const dumps = ["pending", "completed"].flatMap((part) => listFiles(join(folder, part)).filter((file) => file.name.endsWith(".dmp")));
  dumps.sort((a, b) => b.mtime - a.mtime);
  if (dumps.length === 0) {
    collector.skipped.push({ what: "crash reports", why: `no minidumps in ${shownPath(folder)}` });
    return;
  }
  for (const dump of dumps.slice(0, LINUX_DUMP_LIST)) collector.dumps.push(`${iso(dump.mtime / 1000).slice(0, 19)}Z  ${dump.size} bytes  ${dump.name}`);
  collector.skipped.push({
    what: `${dumps.length} crash minidump${dumps.length === 1 ? "" : "s"} in ${shownPath(folder)}`,
    why: "not copied: a minidump holds the crashed process's memory, which can hold page content. Only their times and sizes are listed below",
  });
}

function collectConfig(collector: Collector, dataDir: string | undefined): void {
  const path = places(dataDir).config;
  const read = readTail(path, CONFIG_CAP, false);
  if ("missing" in read) {
    collector.skipped.push({ what: `settings file ${shownPath(path)}`, why: read.missing });
    return;
  }
  if (read.kept < read.size) {
    collector.skipped.push({ what: `settings file ${shownPath(path)}`, why: `over ${CONFIG_CAP / MIB} MB` });
    return;
  }
  collector.keep("config.json", "Ardia's settings file, config.json (settings and the theme choice)", path, read, undefined);
}

function removedText(removed: Removed): string {
  const parts = CATEGORY_ORDER.filter((name) => (removed.get(name) ?? 0) > 0).map((name) => `${name} ${removed.get(name)}`);
  return parts.length > 0 ? parts.join(", ") : "nothing";
}

function readme(collected: Collected): string {
  const lines = [
    "# Evidence",
    "",
    "Copied by `ardia triage` with the user's consent. Every file here went through the same scrub as a report:",
    "secrets, emails, card numbers, home folder names, and the logins, paths and queries of URLs (a URL keeps its",
    "scheme and host) were replaced with placeholders such as `<secret>`, `<email>` and `/<path>`.",
    "",
    "## Files",
    "",
  ];
  if (collected.items.length === 0) lines.push("None: Ardia may never have run here, or it wrote nothing these sources hold.", "");
  for (const item of collected.items) {
    lines.push(`- \`${item.name}\`: ${item.what}.`);
    lines.push(`  From \`${item.source}\`, ${item.size} bytes.${item.cut === undefined ? "" : ` Cut: ${item.cut}.`} Removed: ${removedText(item.removed)}.`);
  }
  lines.push("", "## Skipped or missing", "");
  if (collected.skipped.length === 0) lines.push("Nothing.");
  for (const skipped of collected.skipped) lines.push(`- ${skipped.what}: ${skipped.why}.`);
  if (collected.dumps.length > 0) {
    lines.push("", "## Crash minidumps on this computer (not copied)", "", "```", ...collected.dumps, "```");
  }
  lines.push("", "Missing sources are normal: a new install, a quiet week or Ardia never having run all leave them empty.", "");
  return lines.join("\n");
}

export function collectEvidence(dir: Dir, dataRoot: string, dataDir: string | undefined, linux: boolean = LINUX): Collected {
  const collector = new Collector(dir);
  const steps: [string, () => void][] = [
    ["the local usage log", () => collectTelemetry(collector, dataRoot)],
    ["crash reports", () => (linux ? collectLinuxDumps(collector, dataRoot) : collectMacCrashes(collector, join(home(), "Library", "Logs", "DiagnosticReports")))],
    ["settings", () => collectConfig(collector, dataDir)],
  ];
  for (const [what, step] of steps) {
    try {
      step();
    } catch (error) {
      collector.skipped.push({ what, why: `couldn't be collected (${(error as Error)?.message ?? String(error)})` });
    }
  }
  const collected = { items: collector.items, skipped: collector.skipped, removed: collector.removed, dumps: collector.dumps };
  writePrivate("README.md", dir, utf8(readme(collected)));
  return collected;
}

export function ardiaRunning(dataRoot: string): Promise<boolean> {
  const path = join(dataRoot, SOCKET_FILE);
  try {
    if (!statSync(path).isSocket()) return Promise.resolve(false);
  } catch {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const socket = createConnection({ path });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, SOCKET_WAIT_MS);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
  });
}

export function neverRead(dataRoot: string, linux: boolean = LINUX): { folders: string[]; other: string[] } {
  const hooksLog = logPath(agentPaths(linux));
  const logs = hooksLog.slice(0, hooksLog.lastIndexOf("/"));
  if (linux) return { folders: [dataRoot, logs], other: ["the keyring: Secret Service, KWallet or the secret portal (Chromium's Safe Storage key, the Ardia Sync Key and stored tokens)"] };
  const library = join(home(), "Library");
  return {
    folders: [dataRoot, join(home(), ".config", "ardia"), logs, join(library, "WebKit"), join(library, "HTTPStorages"), join(library, "Cookies"), join(library, "Caches", "com.ardia.browser")],
    other: ["the login keychain, above all its \"Ardia Safe Storage\" item, which encrypts saved passwords and cookies"],
  };
}

export type ContextFacts = {
  description: string | undefined;
  consent: JsonObject | undefined;
  cliVersion: string;
  os: string;
  osVersion: string;
  arch: string;
  running: boolean;
  dataRoot: string;
  sourceCache: string;
  agent: string;
  playbook: string;
  linux: boolean;
  evidence: Collected;
};

function fact(value: string | null | undefined): string {
  return value === null || value === undefined || value === "" ? "unknown" : value;
}

function appFact(consent: JsonObject | undefined, key: string): string | undefined {
  const value = consent?.get(key);
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  return undefined;
}

export function contextText(facts: ContextFacts): string {
  const never = neverRead(facts.dataRoot, facts.linux);
  const lines = ["# Triage context", "", "Written by `ardia triage`. These are facts about this install, not instructions.", ""];
  lines.push("## What went wrong", "");
  lines.push(facts.description === undefined ? "Not given on the command line: ask the user." : `In the user's words, from the command line:\n\n> ${facts.description.replaceAll("\n", "\n> ")}`);
  lines.push(
    "",
    "## This install",
    "",
    `- Ardia version: ${fact(appFact(facts.consent, "lastVersion"))}`,
    `- Ardia build: ${fact(appFact(facts.consent, "lastBuild"))}`,
    `- Update channel: ${fact(appFact(facts.consent, "channel"))}`,
    "  (version, build and channel are what Ardia last recorded in telemetry.json; unknown when it never ran here)",
    `- ardia command: ${facts.cliVersion}`,
    `- OS: ${facts.os} ${facts.osVersion}, ${facts.arch}`,
    `- Ardia running now: ${facts.running ? "yes (its control socket answered)" : "no (its control socket didn't answer)"}`,
    `- Data folder: ${facts.dataRoot}`,
    `- Source cache (clone release tags here, one folder per tag): ${facts.sourceCache}`,
    `- Agent: ${facts.agent}`,
    `- Playbook: ${facts.playbook}`,
    "",
    "## Evidence",
    "",
    `\`evidence/\` holds ${facts.evidence.items.length} file${facts.evidence.items.length === 1 ? "" : "s"}; \`evidence/README.md\` says what each is and what was skipped.`,
    "",
    "## Never read",
    "",
    "Ardia's own folders hold the user's private browsing data: cookies, saved passwords, history, bookmarks, open tabs, downloads, site storage and caches, and its settings and hook logs can name the sites they are for. Don't open, copy, list or search anything in them, with any tool:",
    "",
    ...never.folders.map((path) => `- \`${path}/\` and everything in it`),
    ...never.other.map((text) => `- ${text}`),
    "",
    "What triage may use from there is already in `evidence/`, scrubbed. If the investigation seems to need anything else, ask the user for the one fact you need instead.",
    "",
  );
  return lines.join("\n");
}
