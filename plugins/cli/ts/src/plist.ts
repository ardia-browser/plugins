const BINARY_MAGIC = Buffer.from("bplist00", "latin1");
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const WHITE_SPACE = new RegExp("[\\u0009-\\u000d\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]+", "u");

export function topLevelString(raw: Uint8Array, key: string): string | undefined {
  const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  if (bytes.subarray(0, 8).equals(BINARY_MAGIC)) return binaryString(bytes, key);
  let text: string;
  try {
    text = UTF8_STRICT.decode(bytes);
  } catch {
    return undefined;
  }
  return xmlString(text, key);
}

function bigEndian(bytes: Uint8Array | undefined): number | undefined {
  if (bytes === undefined || bytes.length > 8) return undefined;
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value > MAX_SAFE ? undefined : Number(value);
}

function slice(raw: Buffer, start: number, end: number): Buffer | undefined {
  return start <= end && end <= raw.length ? raw.subarray(start, end) : undefined;
}

class Binary {
  constructor(
    readonly raw: Buffer,
    readonly offsets: number[],
    readonly refSize: number,
  ) {}

  object(index: number): [number, number, number] | undefined {
    const start = this.offsets[index];
    if (start === undefined || start >= this.raw.length) return undefined;
    const marker = this.raw[start] as number;
    const kind = marker >> 4;
    let count = marker & 0x0f;
    let body = start + 1;
    if (count === 0x0f && (kind === 0x5 || kind === 0x6 || kind === 0xa || kind === 0xd)) {
      const sizeMarker = this.raw[body];
      if (sizeMarker === undefined || sizeMarker >> 4 !== 0x1) return undefined;
      const width = 1 << (sizeMarker & 0x0f);
      const read = bigEndian(slice(this.raw, body + 1, body + 1 + width));
      if (read === undefined) return undefined;
      count = read;
      body += 1 + width;
    }
    return [kind, count, body];
  }

  reference(at: number): number | undefined {
    return bigEndian(slice(this.raw, at, at + this.refSize));
  }

  string(index: number): string | undefined {
    const found = this.object(index);
    if (found === undefined) return undefined;
    const [kind, count, body] = found;
    if (kind === 0x5) return slice(this.raw, body, body + count)?.toString("latin1");
    if (kind === 0x6) {
      const units = slice(this.raw, body, body + count * 2);
      if (units === undefined) return undefined;
      let text = "";
      for (let at = 0; at < units.length; at += 2) text += String.fromCharCode(units.readUInt16BE(at));
      return text.toWellFormed();
    }
    return undefined;
  }
}

function binaryString(raw: Buffer, key: string): string | undefined {
  if (raw.length < 40) return undefined;
  const trailer = raw.subarray(raw.length - 32);
  const offsetSize = trailer[6] as number;
  const refSize = trailer[7] as number;
  const count = bigEndian(trailer.subarray(8, 16));
  const top = bigEndian(trailer.subarray(16, 24));
  const table = bigEndian(trailer.subarray(24, 32));
  if (count === undefined || top === undefined || table === undefined) return undefined;
  if (offsetSize === 0 || refSize === 0 || count > raw.length) return undefined;
  const offsets: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const at = table + index * offsetSize;
    const offset = bigEndian(slice(raw, at, at + offsetSize));
    if (offset === undefined) return undefined;
    offsets.push(offset);
  }
  const plist = new Binary(raw, offsets, refSize);
  const dict = plist.object(top);
  if (dict === undefined || dict[0] !== 0xd) return undefined;
  const [, entries, body] = dict;
  for (let entry = 0; entry < entries; entry += 1) {
    const keyRef = plist.reference(body + entry * refSize);
    if (keyRef === undefined) return undefined;
    if (plist.string(keyRef) === key) {
      const valueRef = plist.reference(body + (entries + entry) * refSize);
      return valueRef === undefined ? undefined : plist.string(valueRef);
    }
  }
  return undefined;
}

const NAMED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function parsedUnsigned(text: string, radix: 16 | 10): number | undefined {
  const pattern = radix === 16 ? /^\+?[0-9a-fA-F]+$/ : /^\+?[0-9]+$/;
  if (!pattern.test(text)) return undefined;
  const value = BigInt(radix === 16 ? `0x${text.replace(/^\+/, "")}` : text.replace(/^\+/, ""));
  return value > 0xffffffffn ? undefined : Number(value);
}

function scalar(code: number | undefined): string | undefined {
  if (code === undefined || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return undefined;
  return String.fromCodePoint(code);
}

function entityChar(entity: string): string | undefined {
  const named = Object.hasOwn(NAMED, entity) ? NAMED[entity] : undefined;
  if (named !== undefined) return named;
  const hex = entity.startsWith("#x") || entity.startsWith("#X") ? scalar(parsedUnsigned(entity.slice(2), 16)) : undefined;
  if (hex !== undefined) return hex;
  return entity.startsWith("#") ? scalar(parsedUnsigned(entity.slice(1), 10)) : undefined;
}

function unescape(text: string): string {
  let out = "";
  let rest = text;
  for (let amp = rest.indexOf("&"); amp >= 0; amp = rest.indexOf("&")) {
    out += rest.slice(0, amp);
    rest = rest.slice(amp);
    const semi = rest.indexOf(";");
    if (semi < 0) break;
    const decoded = entityChar(rest.slice(1, semi));
    if (decoded !== undefined) {
      out += decoded;
      rest = rest.slice(semi + 1);
    } else {
      out += "&";
      rest = rest.slice(1);
    }
  }
  return out + rest;
}

function xmlString(text: string, key: string): string | undefined {
  let depth = 0;
  let at = 0;
  let pendingKey: string | undefined;
  for (let open = text.indexOf("<", at); open >= 0; open = text.indexOf("<", at)) {
    if (text.startsWith("<!--", open)) {
      const end = text.indexOf("-->", open);
      if (end < 0) return undefined;
      at = end + 3;
      continue;
    }
    const close = text.indexOf(">", open);
    if (close < 0) return undefined;
    const tag = text.slice(open + 1, close);
    at = close + 1;
    if (tag.startsWith("?") || tag.startsWith("!")) continue;
    const name = tag.replace(/\/+$/, "").split(WHITE_SPACE).find((word) => word !== "") ?? "";
    const empty = tag.endsWith("/");
    if ((name === "dict" || name === "array") && !empty) {
      depth += 1;
      if (depth > 1) pendingKey = undefined;
    } else if (name === "/dict" || name === "/array") {
      depth -= 1;
    } else if (name === "key" && depth === 1 && !empty) {
      const end = text.indexOf("</key>", at);
      if (end < 0) return undefined;
      pendingKey = unescape(text.slice(at, end));
      at = end + 6;
    } else if (name === "string" && depth === 1) {
      let value = "";
      if (!empty) {
        const end = text.indexOf("</string>", at);
        if (end < 0) return undefined;
        value = unescape(text.slice(at, end));
        at = end + 9;
      }
      const wanted = pendingKey === key;
      pendingKey = undefined;
      if (wanted) return value;
    } else if (name === "plist" || name === "/plist") {
    } else if (depth === 1 && !name.startsWith("/")) {
      pendingKey = undefined;
    }
  }
  return undefined;
}
