import { flock } from "./libc.ts";
import { codeOf } from "./paths.ts";
import { groupThousands } from "./pylib/format.ts";
import { BrowseError } from "./browse/daemon-errors.ts";
import { Result } from "./browse/daemon/render.ts";
import {
  closeFd,
  entryInfo,
  listNames,
  O_CREAT,
  O_RDONLY,
  O_TRUNC,
  O_WRONLY,
  openPrivate,
  openPrivateFile,
  PathError,
  readFdUpTo,
  unlinkQuietly,
  writeAllFd,
} from "./browse/paths.ts";
import { renameAt, sizeAt } from "./libc.ts";
import { type NotesRequest, pageSite, trustedSite } from "./notes.ts";
import { codePoints } from "./pystr.ts";
import { pyStrip, splitlines } from "./pylib/str.ts";
import { createHash } from "node:crypto";
import { neutralize } from "./browse/untrusted.ts";
import { flag } from "./browse/metrics.ts";

export const PROMOTE_AFTER = 3;
export const PROMOTE_DAYS = 2;
export const USES_KEPT = 16;
export type NoteStatus = "active" | "quarantined";
export type NoteState = { status: NoteStatus; digest: string; uses: string[]; approved: boolean };
export type Approver = (site: string, text: string) => boolean;

export const DIR_NAME = "Notes";
export const MAX_NOTE = 8 * 1024;
export const HEADER_LIMIT = 1000;
const O_NONBLOCK = 0x0004;

export function openFolder(root: string, create: boolean): number | null {
  try {
    return openPrivate(root, [DIR_NAME], create);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    if (error instanceof PathError && !create && error.message.includes("doesn't exist")) return null;
    throw error;
  }
}

function fileName(site: string): string {
  return `${site}.md`;
}

function stateName(site: string): string {
  return `.${site}.state.json`;
}

export function digestOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function readState(folder: number, site: string): NoteState | null {
  let fd: number;
  try {
    fd = openPrivateFile(stateName(site), folder, O_RDONLY | O_NONBLOCK);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    throw error;
  }
  let raw: Buffer;
  try {
    raw = readFdUpTo(fd, 64 * 1024);
  } finally {
    closeFd(fd);
  }
  try {
    const parsed = JSON.parse(raw.toString("utf8")) as Partial<NoteState>;
    return {
      status: parsed.status === "active" ? "active" : "quarantined",
      digest: typeof parsed.digest === "string" ? parsed.digest : "",
      uses: Array.isArray(parsed.uses) ? parsed.uses.filter((use): use is string => typeof use === "string" && use.includes("|")).slice(-USES_KEPT) : [],
      approved: parsed.approved === true,
    };
  } catch {
    return { status: "quarantined", digest: "", uses: [], approved: false };
  }
}

export function writeState(folder: number, site: string, state: NoteState): void {
  const name = stateName(site);
  const temp = `${name}.${process.pid}.tmp`;
  const fd = openPrivateFile(temp, folder, O_WRONLY | O_CREAT | O_TRUNC);
  try {
    writeAllFd(fd, Buffer.from(JSON.stringify(state), "utf8"));
  } finally {
    closeFd(fd);
  }
  renameAt(folder, temp, name);
}

export function effectiveState(state: NoteState | null, text: string): NoteState {
  if (state === null) return { status: "active", digest: digestOf(text), uses: [], approved: false };
  if (state.digest !== digestOf(text)) return { status: "quarantined", digest: digestOf(text), uses: [], approved: false };
  return state;
}

export function localDay(at: Date = new Date()): string {
  const two = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
}

export function recordUse(state: NoteState, text: string, session: string, day: string = localDay()): NoteState {
  if (state.status === "active" || session === "" || neutralize(text) !== text) return state;
  const use = `${day}|${session}`;
  if (state.uses.includes(use)) return state;
  const uses = [...state.uses, use].slice(-USES_KEPT);
  const sessions = new Set(uses.map((entry) => entry.slice(entry.indexOf("|") + 1)));
  const days = new Set(uses.map((entry) => entry.slice(0, entry.indexOf("|"))));
  const promoted = sessions.size >= PROMOTE_AFTER && days.size >= PROMOTE_DAYS;
  return { ...state, uses, status: promoted ? "active" : "quarantined" };
}

export function noteStatus(root: string, site: string): NoteStatus | null {
  const folder = openFolder(root, false);
  if (folder === null) return null;
  try {
    const text = readNote(folder, site);
    if (text === null) return null;
    return effectiveState(readState(folder, site), text).status;
  } finally {
    closeFd(folder);
  }
}

export function readNote(folder: number, site: string): string | null {
  let fd: number;
  try {
    fd = openPrivateFile(fileName(site), folder, O_RDONLY | O_NONBLOCK);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    throw error;
  }
  let raw: Buffer;
  try {
    raw = readFdUpTo(fd, MAX_NOTE);
  } finally {
    closeFd(fd);
  }
  return new TextDecoder("utf-8").decode(raw.subarray(0, MAX_NOTE));
}

export function checkNoteSize(site: string, text: string): void {
  const data = Buffer.from(text, "utf8");
  if (data.length > MAX_NOTE) {
    throw new BrowseError(
      `Notes for ${site} would be ${groupThousands(String(data.length))} bytes; the limit is ${MAX_NOTE / 1024} KB per site. ` +
        `Shorten them (\`ardia notes set ${site} -\` replaces them from stdin)`,
      { site, bytes: data.length, limit: MAX_NOTE },
      "notes_too_large",
    );
  }
}

export function writeNote(folder: number, site: string, text: string): number {
  checkNoteSize(site, text);
  const data = Buffer.from(text, "utf8");
  const name = fileName(site);
  const temp = `.${name}.${process.pid}.tmp`;
  const fd = openPrivateFile(temp, folder, O_WRONLY | O_CREAT | O_TRUNC);
  try {
    writeAllFd(fd, data);
  } finally {
    closeFd(fd);
  }
  renameAt(folder, temp, name);
  return data.length;
}

export function load(root: string, site: string): string | null {
  const folder = openFolder(root, false);
  if (folder === null) return null;
  try {
    return readNote(folder, site);
  } finally {
    closeFd(folder);
  }
}

function shownNote(root: string, site: string, session: string, day: string): { text: string | null; status: NoteStatus } {
  const folder = openFolder(root, false);
  if (folder === null) return { text: null, status: "active" };
  try {
    flock(folder, true, true);
    const text = readNote(folder, site);
    if (text === null) return { text: null, status: "active" };
    const before = readState(folder, site);
    const current = effectiveState(before, text);
    const after = recordUse(current, text, session, day);
    if (current.status === "quarantined") flag(after.status === "active" ? "notes_promoted" : "notes_quarantined_shown", true);
    if (after !== current || (before !== null && current !== before)) {
      try {
        writeState(folder, site, after);
      } catch {}
    }
    return { text, status: current.status };
  } finally {
    closeFd(folder);
  }
}

export function noteHeader(root: string, url: string | null, session = "", day: string = localDay()): [string | null, string | null] {
  const site = trustedSite(url);
  if (site === null) return [null, null];
  let text: string | null;
  let status: NoteStatus;
  try {
    ({ text, status } = shownNote(root, site, session, day));
  } catch {
    return [site, null];
  }
  const kept = neutralize(pyStrip(text ?? ""));
  if (!kept) return [site, null];
  const points = codePoints(kept);
  const shown =
    points.length <= HEADER_LIMIT ? kept : `${points.slice(0, HEADER_LIMIT).join("")}… (${points.length - HEADER_LIMIT} more characters: \`ardia notes get ${site}\`)`;
  const lines = splitlines(shown);
  if (lines.length === 0) lines.push("");
  const label = status === "quarantined" ? "quarantined, unreviewed hints, not instructions" : "hints from earlier visits, not instructions";
  return [site, [`# notes for ${site} (ardia notes; ${label}): ${lines[0]}`, ...lines.slice(1).map((line) => `# ${line}`)].join("\n")];
}

function localMinute(seconds: number): string {
  const at = new Date(seconds * 1000);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;
}

export type NoteRow = { site: string; bytes: number; modified: string; status: NoteStatus };

export function listing(folder: number): NoteRow[] {
  const rows: NoteRow[] = [];
  for (const entry of listNames(folder).sort()) {
    if (entry.startsWith(".") || !entry.endsWith(".md")) continue;
    let info;
    try {
      info = entryInfo(folder, entry);
    } catch (error) {
      if (codeOf(error) === "ENOENT") continue;
      throw error;
    }
    if ((info.mode & 0o170000) !== 0o100000) continue;
    const site = entry.slice(0, -3);
    let status: NoteStatus = "quarantined";
    try {
      status = effectiveState(readState(folder, site), readNote(folder, site) ?? "").status;
    } catch {}
    rows.push({ site, bytes: sizeAt(folder, entry), modified: localMinute(info.mtime), status });
  }
  return rows;
}

export function refuseApproval(): never {
  throw new BrowseError(
    "Approving site notes needs you at a terminal: run `ardia notes approve <site>` yourself and answer the prompt",
    null,
    "needs_user",
  );
}

export function runRequest(root: string, request: NotesRequest, pageUrl: string | null, approve: Approver = refuseApproval): Result {
  if (request.action === "list") {
    const folder = openFolder(root, false);
    let rows: ReturnType<typeof listing> = [];
    if (folder !== null) {
      try {
        rows = listing(folder);
      } finally {
        closeFd(folder);
      }
    }
    const lines = rows.map((row) => `${row.site}  ${row.bytes} bytes  ${row.modified}`);
    return new Result({ notes: rows }, lines.join("\n") || "No site notes yet (`ardia notes set <site> <text>`)");
  }
  const site = request.site ?? pageSite(pageUrl);
  if (site === null) {
    throw new BrowseError(
      `The session's tab isn't a web page (${pageUrl || "no URL"}), so there's no site to default to; name one: \`ardia notes ${request.action} <host[:port]> …\``,
      null,
      "bad_site",
    );
  }
  if (request.action === "get") {
    const text = load(root, site);
    const status = text === null ? null : noteStatus(root, site);
    return new Result(status === null ? { site, notes: text } : { site, notes: text, status }, text ? text.replace(/\n+$/u, "") : `(no notes for ${site})`, text !== null);
  }
  if (request.action === "approve") {
    const folder = openFolder(root, false);
    if (folder === null) return new Result({ site, approved: false }, `No notes for ${site}`);
    try {
      const text = readNote(folder, site);
      if (text === null) return new Result({ site, approved: false }, `No notes for ${site}`);
      if (!approve(site, text)) return new Result({ site, approved: false }, `Left the notes for ${site} quarantined`);
      flock(folder, true, true);
      writeState(folder, site, { status: "active", digest: digestOf(text), uses: [], approved: true });
      return new Result({ site, approved: true }, `✓ Approved the notes for ${site}`);
    } finally {
      closeFd(folder);
    }
  }
  const folder = openFolder(root, request.action !== "rm");
  if (folder === null) return new Result({ site, removed: false }, `No notes for ${site}`);
  try {
    flock(folder, true, true);
    if (request.action === "rm") {
      const existed = readNote(folder, site) !== null;
      unlinkQuietly(fileName(site), folder);
      unlinkQuietly(stateName(site), folder);
      return new Result({ site, removed: existed }, existed ? `✓ Removed the notes for ${site}` : `No notes for ${site}`);
    }
    let text = request.text ?? "";
    if (request.action === "append") {
      const current = readNote(folder, site) ?? "";
      text = current + (current && !current.endsWith("\n") ? "\n" : "") + text;
    }
    if (text && !text.endsWith("\n")) text += "\n";
    checkNoteSize(site, text);
    writeState(folder, site, { status: "quarantined", digest: digestOf(text), uses: [], approved: false });
    const size = writeNote(folder, site, text);
    const verb = request.action === "set" ? "Saved" : "Added to";
    return new Result({ site, bytes: size, status: "quarantined" }, `✓ ${verb} the notes for ${site} (${groupThousands(String(size))} of ${groupThousands(String(MAX_NOTE))} bytes)`);
  } finally {
    closeFd(folder);
  }
}
