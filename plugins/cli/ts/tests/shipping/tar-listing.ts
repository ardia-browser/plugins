import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

export type ListedMember = { name: string; type: string; mode: string; uname: string; gname: string; sha256: string };

const BLOCK = 512;

function field(header: Buffer, start: number, length: number): string {
  const raw = header.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end < 0 ? length : end).toString("utf8");
}

function octal(header: Buffer, start: number, length: number): number {
  const text = field(header, start, length).trim();
  return text === "" ? 0 : parseInt(text, 8);
}

function paxPath(body: Buffer): string | undefined {
  let at = 0;
  let found: string | undefined;
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    if (space < 0) break;
    const length = Number(body.subarray(at, space).toString());
    if (!Number.isFinite(length) || length <= 0) break;
    const record = body.subarray(space + 1, at + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (record.slice(0, equals) === "path") found = record.slice(equals + 1);
    at += length;
  }
  return found;
}

export function listTarGz(archive: Buffer): ListedMember[] {
  const data = gunzipSync(archive);
  const members: ListedMember[] = [];
  let at = 0;
  let longName: string | undefined;
  while (at + BLOCK <= data.length) {
    const header = data.subarray(at, at + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const size = octal(header, 124, 12);
    const type = field(header, 156, 1) || "0";
    const body = data.subarray(at + BLOCK, at + BLOCK + size);
    at += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === "x") {
      longName = paxPath(body) ?? longName;
      continue;
    }
    if (type === "L") {
      longName = field(body, 0, body.length);
      continue;
    }
    if (type === "g") continue;
    const prefix = field(header, 345, 155);
    const shortName = field(header, 0, 100);
    const name = longName ?? (prefix === "" ? shortName : `${prefix}/${shortName}`);
    longName = undefined;
    const isFile = type === "0" || type === "\0";
    members.push({
      name: name.replace(/\/$/, ""),
      type,
      mode: (octal(header, 100, 8) & 0o7777).toString(8),
      uname: field(header, 265, 32),
      gname: field(header, 297, 32),
      sha256: isFile ? createHash("sha256").update(body).digest("hex") : "",
    });
  }
  return members;
}
