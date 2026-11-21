import { chmodSync, closeSync, mkdirSync, openSync, utimesSync, writeSync } from "node:fs";
import { gunzipSync } from "node:zlib";

export class TarError extends Error {}

export type Member = { name: string; type: string; mode: number; mtime: number; size: number; data: Buffer; linkname: string };

const BLOCK = 512;

function text(block: Buffer, at: number, length: number): string {
  const field = block.subarray(at, at + length);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? length : end).toString("utf8");
}

function octal(block: Buffer, at: number, length: number): number {
  const field = block.subarray(at, at + length);
  if (((field[0] as number) & 0x80) !== 0) {
    let value = 0;
    for (let index = 1; index < length; index += 1) value = value * 256 + (field[index] as number);
    return value;
  }
  const digits = field.toString("latin1").replace(/\0.*$/s, "").trim();
  if (digits === "") return 0;
  if (!/^[0-7]+$/.test(digits)) throw new TarError("invalid header");
  return Number.parseInt(digits, 8);
}

function checksumOk(block: Buffer): boolean {
  const stored = octal(block, 148, 8);
  let unsigned = 0;
  let signed = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    const byte = index >= 148 && index < 156 ? 0x20 : (block[index] as number);
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  return stored === unsigned || stored === signed;
}

function paxRecords(data: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0) break;
    const length = Number(data.subarray(at, space).toString("latin1"));
    if (!Number.isFinite(length) || length <= 0) throw new TarError("invalid header");
    const record = data.subarray(space + 1, at + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0) records.set(record.slice(0, equals), record.slice(equals + 1));
    at += length;
  }
  return records;
}

export function readTarGz(archive: Buffer): Member[] {
  let data: Buffer;
  try {
    data = gunzipSync(archive);
  } catch {
    throw new TarError("not a gzip file");
  }
  const members: Member[] = [];
  let at = 0;
  let longName: string | undefined;
  let longLink: string | undefined;
  let pax = new Map<string, string>();
  let globalPax = new Map<string, string>();
  while (at + BLOCK <= data.length) {
    const block = data.subarray(at, at + BLOCK);
    if (block.every((byte) => byte === 0)) break;
    if (!checksumOk(block)) throw new TarError(members.length === 0 ? "empty file" : "invalid header");
    const type = String.fromCharCode(block[156] as number || 0x30);
    const size = octal(block, 124, 12);
    const body = data.subarray(at + BLOCK, at + BLOCK + size);
    if (body.length < size) throw new TarError("unexpected end of data");
    at += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === "L") {
      longName = body.toString("utf8").replace(/\0+$/, "");
      continue;
    }
    if (type === "K") {
      longLink = body.toString("utf8").replace(/\0+$/, "");
      continue;
    }
    if (type === "x") {
      pax = paxRecords(body);
      continue;
    }
    if (type === "g") {
      globalPax = paxRecords(body);
      continue;
    }
    const magic = block.subarray(257, 263).toString("latin1");
    let name = text(block, 0, 100);
    if (magic.startsWith("ustar")) {
      const prefix = text(block, 345, 155);
      if (prefix !== "") name = `${prefix}/${name}`;
    }
    const merged = new Map([...globalPax, ...pax]);
    name = merged.get("path") ?? longName ?? name;
    const linkname = merged.get("linkpath") ?? longLink ?? text(block, 157, 100);
    const mtimeText = merged.get("mtime");
    members.push({ name, type, mode: octal(block, 100, 8), mtime: mtimeText === undefined ? octal(block, 136, 12) : Math.floor(Number(mtimeText)), size, data: Buffer.from(body), linkname });
    longName = undefined;
    longLink = undefined;
    pax = new Map();
  }
  return members;
}

export function isFile(member: Member): boolean {
  return member.type === "0" || member.type === "\0" || member.type === "7";
}

export function isDir(member: Member): boolean {
  return member.type === "5";
}

function dataMode(member: Member): number | undefined {
  if (!isFile(member)) return undefined;
  let mode = member.mode & 0o777;
  mode &= ~0o022;
  mode |= 0o600;
  if (!(mode & 0o100)) mode &= ~0o011;
  return mode;
}

export function extractMembers(dest: string, members: Member[]): void {
  const dirs: Member[] = [];
  for (const member of members) {
    const target = `${dest}/${member.name}`;
    const parent = target.slice(0, target.lastIndexOf("/"));
    mkdirSync(parent, { recursive: true });
    if (isDir(member)) {
      try {
        mkdirSync(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      dirs.push(member);
      continue;
    }
    const fd = openSync(target, "w");
    try {
      let written = 0;
      while (written < member.data.length) written += writeSync(fd, member.data, written);
    } finally {
      closeSync(fd);
    }
    const mode = dataMode(member);
    if (mode !== undefined) chmodSync(target, mode);
    utimesSync(target, member.mtime, member.mtime);
  }
  dirs.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  for (const member of dirs) utimesSync(`${dest}/${member.name}`, member.mtime, member.mtime);
}
