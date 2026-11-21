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
import { type NotesRequest, pageSite } from "./notes.ts";

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

export function writeNote(folder: number, site: string, text: string): number {
  const data = Buffer.from(text, "utf8");
  if (data.length > MAX_NOTE) {
    throw new BrowseError(
      `Notes for ${site} would be ${groupThousands(String(data.length))} bytes; the limit is ${MAX_NOTE / 1024} KB per site. ` +
        `Shorten them (\`ardia notes set ${site} -\` replaces them from stdin)`,
      { site, bytes: data.length, limit: MAX_NOTE },
      "notes_too_large",
    );
  }
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

function localMinute(seconds: number): string {
  const at = new Date(seconds * 1000);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;
}

export function listing(folder: number): { site: string; bytes: number; modified: string }[] {
  const rows: { site: string; bytes: number; modified: string }[] = [];
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
    rows.push({ site: entry.slice(0, -3), bytes: sizeAt(folder, entry), modified: localMinute(info.mtime) });
  }
  return rows;
}

export function runRequest(root: string, request: NotesRequest, pageUrl: string | null): Result {
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
    return new Result({ site, notes: text }, text ? text.replace(/\n+$/u, "") : `(no notes for ${site})`);
  }
  const folder = openFolder(root, request.action !== "rm");
  if (folder === null) return new Result({ site, removed: false }, `No notes for ${site}`);
  try {
    flock(folder, true, true);
    if (request.action === "rm") {
      const existed = readNote(folder, site) !== null;
      unlinkQuietly(fileName(site), folder);
      return new Result({ site, removed: existed }, existed ? `✓ Removed the notes for ${site}` : `No notes for ${site}`);
    }
    let text = request.text ?? "";
    if (request.action === "append") {
      const current = readNote(folder, site) ?? "";
      text = current + (current && !current.endsWith("\n") ? "\n" : "") + text;
    }
    if (text && !text.endsWith("\n")) text += "\n";
    const size = writeNote(folder, site, text);
    const verb = request.action === "set" ? "Saved" : "Added to";
    return new Result({ site, bytes: size }, `✓ ${verb} the notes for ${site} (${groupThousands(String(size))} of ${groupThousands(String(MAX_NOTE))} bytes)`);
  } finally {
    closeFd(folder);
  }
}
