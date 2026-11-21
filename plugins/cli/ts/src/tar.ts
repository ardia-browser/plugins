export type TarEntry = { name: string; type: "file" | "dir" | "other"; data: Buffer; mode: number };

export class TarError extends Error {}

const BLOCK = 512;

function text(block: Buffer, start: number, length: number): string {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return (end < 0 ? slice : slice.subarray(0, end)).toString("utf8");
}

function octal(block: Buffer, start: number, length: number): number {
  const field = block.subarray(start, start + length);
  if ((field[0] ?? 0) & 0x80) {
    let value = 0n;
    for (let index = 1; index < field.length; index += 1) value = (value << 8n) | BigInt(field[index] ?? 0);
    return Number(value);
  }
  const digits = text(block, start, length).replace(/[\s\0]+$/u, "").trim();
  if (digits === "") return 0;
  if (!/^[0-7]+$/.test(digits)) throw new TarError("invalid header");
  return Number.parseInt(digits, 8);
}

function checksumOk(block: Buffer): boolean {
  const stored = octal(block, 148, 8);
  let unsigned = 0;
  let signed = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    const byte = index >= 148 && index < 156 ? 0x20 : (block[index] ?? 0);
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
    const length = Number.parseInt(data.subarray(at, space).toString("ascii"), 10);
    if (!Number.isFinite(length) || length <= 0) throw new TarError("invalid pax header");
    const record = data.subarray(space + 1, at + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0) records.set(record.slice(0, equals), record.slice(equals + 1));
    at += length;
  }
  return records;
}

export function readTar(archive: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let at = 0;
  let longName: string | undefined;
  let pax = new Map<string, string>();
  const global = new Map<string, string>();
  while (at + BLOCK <= archive.length) {
    const block = archive.subarray(at, at + BLOCK);
    if (block.every((byte) => byte === 0)) break;
    if (!checksumOk(block)) throw new TarError("bad checksum");
    const size = octal(block, 124, 12);
    const flag = String.fromCharCode(block[156] ?? 0);
    const dataStart = at + BLOCK;
    const data = archive.subarray(dataStart, dataStart + size);
    if (data.length < size) throw new TarError("unexpected end of data");
    at = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    if (flag === "x") {
      pax = paxRecords(data);
      continue;
    }
    if (flag === "g") {
      for (const [key, value] of paxRecords(data)) global.set(key, value);
      continue;
    }
    if (flag === "L") {
      longName = text(data, 0, data.length);
      continue;
    }
    const magic = block.subarray(257, 263).toString("latin1");
    const prefix = magic.startsWith("ustar") ? text(block, 345, 155) : "";
    let name = text(block, 0, 100);
    if (prefix !== "") name = `${prefix}/${name}`;
    name = pax.get("path") ?? longName ?? global.get("path") ?? name;
    pax = new Map();
    longName = undefined;
    const type = flag === "0" || flag === "\0" || flag === "7" ? (name.endsWith("/") ? "dir" : "file") : flag === "5" ? "dir" : "other";
    entries.push({ name, type, data, mode: octal(block, 100, 8) });
  }
  return entries;
}
