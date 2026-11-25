#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { constants, gzipSync } from "node:zlib";

const BLOCK = 512;
const MAX_ENTRIES = 20000;

function octal(value, width) {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function writeString(block, text, offset, width) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > width) throw new Error(`${text} doesn't fit a ${width}-byte tar field`);
  bytes.copy(block, offset);
}

function splitUstar(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  for (let i = path.length - 1; i > 0; i--) {
    if (path[i] !== "/") continue;
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (name && Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  return null;
}

function truncateUtf8(text, maxBytes) {
  let out = "";
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes) break;
    out += char;
    bytes += size;
  }
  return out;
}

function header(path, typeflag, mode, size) {
  const block = Buffer.alloc(BLOCK, 0);
  const split = splitUstar(path) ?? { name: truncateUtf8(path, 100), prefix: "" };
  writeString(block, split.name, 0, 100);
  writeString(block, octal(mode & 0o7777, 8), 100, 8);
  writeString(block, octal(0, 8), 108, 8);
  writeString(block, octal(0, 8), 116, 8);
  writeString(block, octal(size, 12), 124, 12);
  writeString(block, octal(0, 12), 136, 12);
  block.fill(32, 148, 156);
  writeString(block, typeflag, 156, 1);
  writeString(block, "ustar\0", 257, 6);
  writeString(block, "00", 263, 2);
  writeString(block, split.prefix, 345, 155);
  let sum = 0;
  for (const byte of block) sum += byte;
  writeString(block, `${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return block;
}

const pad = (size) => Buffer.alloc(size % BLOCK ? BLOCK - (size % BLOCK) : 0, 0);

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (Buffer.byteLength(`${length}${body}`) !== length) length = Buffer.byteLength(`${length}${body}`);
  return `${length}${body}`;
}

export function tarBytes(entries) {
  if (entries.length > MAX_ENTRIES) throw new Error(`the pack would hold more than ${MAX_ENTRIES} entries`);
  const chunks = [];
  for (const entry of entries) {
    const path = entry.type === "directory" ? `${entry.path.replace(/\/$/, "")}/` : entry.path;
    if (!splitUstar(path)) {
      const pax = Buffer.from(paxRecord("path", path), "utf8");
      chunks.push(header(`PaxHeaders/${truncateUtf8(path.split("/").pop() ?? "entry", 80)}`, "x", 0o644, pax.length), pax, pad(pax.length));
    }
    const data = entry.type === "file" ? Buffer.from(entry.data) : Buffer.alloc(0);
    const mode = entry.type === "directory" || entry.executable ? 0o755 : 0o644;
    chunks.push(header(path, entry.type === "file" ? "0" : "5", mode, data.length));
    if (data.length) chunks.push(data, pad(data.length));
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(chunks);
}

export function gzipDeterministic(data) {
  const out = gzipSync(data, { level: constants.Z_BEST_COMPRESSION, memLevel: 9 });
  out.writeUInt32LE(0, 4);
  out[9] = 255;
  return out;
}

export function folderEntries(folder, root) {
  const dir = resolve(folder);
  const items = [];
  const problems = [];
  const visit = (current) => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const rel = relative(dir, full).split(sep).join("/");
      const stats = lstatSync(full);
      if (stats.isSymbolicLink()) problems.push(`${rel} is a symlink`);
      else if (stats.isDirectory()) {
        items.push({ path: rel, type: "directory" });
        visit(full);
      } else if (!stats.isFile()) problems.push(`${rel} isn't a regular file`);
      else if (stats.nlink > 1) problems.push(`${rel} is a hard link`);
      else items.push({ path: rel, type: "file", full, executable: (stats.mode & 0o100) !== 0 });
    }
  };
  visit(dir);
  if (problems.length) throw new Error(`${folder} can't be packed:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  items.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return [
    { path: root, type: "directory" },
    ...items.map((item) => (item.type === "directory" ? { path: `${root}/${item.path}`, type: "directory" } : { path: `${root}/${item.path}`, type: "file", executable: item.executable, data: readFileSync(item.full) })),
  ];
}

export function packFolder(folder, outFile, options = {}) {
  const root = options.root ?? basename(resolve(folder));
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(root)) throw new Error(`${root} isn't a plugin folder name`);
  const entries = folderEntries(folder, root);
  const archive = gzipDeterministic(tarBytes(entries));
  const file = resolve(outFile);
  const sha256 = createHash("sha256").update(archive).digest("hex");
  mkdirSync(dirname(file), { recursive: true });
  const partial = `${file}.partial-${process.pid}`;
  writeFileSync(partial, archive);
  renameSync(partial, file);
  writeFileSync(`${file}.sha256`, `${sha256}  ${basename(file)}\n`);
  return { file, sha256, bytes: archive.length, entries: entries.length, root };
}

const HELP = `usage: node scripts/pack-folder.mjs <folder> <out .tar.gz> [--root <name>]

Packs <folder> as <root>/ (default: the folder's name) into a deterministic .tar.gz, the way ardia-plugin pack does:
sorted entries, mtime 0, owner 0, modes 755 or 644, gzip with no time or name. Writes <out>.sha256 beside it.
It refuses symlinks, hard links and anything that isn't a file or folder.
`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const at = args.indexOf("--root");
  const root = at >= 0 ? args[at + 1] : undefined;
  if (at >= 0) args.splice(at, 2);
  if (args.length !== 2) {
    process.stderr.write(HELP);
    process.exit(64);
  }
  try {
    const report = packFolder(args[0], args[1], { root });
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    process.stderr.write(`pack-folder: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
