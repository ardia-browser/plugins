export function topLevelString(raw: Uint8Array, key: string): string | undefined {
  if (Buffer.from(raw.subarray(0, 8)).toString("latin1") === "bplist00") return binaryString(raw, key);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    return undefined;
  }
  return xmlString(text, key);
}

function range(raw: Uint8Array, from: number, to: number): Uint8Array | undefined {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || from > to || to > raw.length) return undefined;
  return raw.subarray(from, to);
}

function be(bytes: Uint8Array | undefined): number | undefined {
  if (bytes === undefined || bytes.length > 8) return undefined;
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
}

class Binary {
  constructor(
    readonly raw: Uint8Array,
    readonly offsets: number[],
    readonly refSize: number,
  ) {}

  object(index: number): [number, number, number] | undefined {
    const start = this.offsets[index];
    if (start === undefined) return undefined;
    const marker = this.raw[start];
    if (marker === undefined) return undefined;
    const kind = marker >> 4;
    let count = marker & 0x0f;
    let body = start + 1;
    if (count === 0x0f && [0x5, 0x6, 0xa, 0xd].includes(kind)) {
      const sizeMarker = this.raw[body];
      if (sizeMarker === undefined || sizeMarker >> 4 !== 0x1) return undefined;
      const width = 2 ** (sizeMarker & 0x0f);
      const sized = be(range(this.raw, body + 1, body + 1 + width));
      if (sized === undefined) return undefined;
      count = sized;
      body += 1 + width;
    }
    return [kind, count, body];
  }

  reference(at: number): number | undefined {
    return be(range(this.raw, at, at + this.refSize));
  }

  string(index: number | undefined): string | undefined {
    if (index === undefined) return undefined;
    const found = this.object(index);
    if (found === undefined) return undefined;
    const [kind, count, body] = found;
    if (kind === 0x5) {
      const bytes = range(this.raw, body, body + count);
      return bytes === undefined ? undefined : Buffer.from(bytes).toString("latin1");
    }
    if (kind === 0x6) {
      const bytes = range(this.raw, body, body + count * 2);
      if (bytes === undefined) return undefined;
      let text = "";
      for (let at = 0; at + 1 < bytes.length; at += 2) text += String.fromCharCode(((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0));
      return text.toWellFormed();
    }
    return undefined;
  }
}

function binaryString(raw: Uint8Array, key: string): string | undefined {
  if (raw.length < 40) return undefined;
  const trailer = raw.subarray(raw.length - 32);
  const offsetSize = trailer[6] ?? 0;
  const refSize = trailer[7] ?? 0;
  const count = be(trailer.subarray(8, 16));
  const top = be(trailer.subarray(16, 24));
  const table = be(trailer.subarray(24, 32));
  if (count === undefined || top === undefined || table === undefined) return undefined;
  if (offsetSize === 0 || refSize === 0 || count > raw.length) return undefined;
  const offsets: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const at = table + index * offsetSize;
    const offset = be(range(raw, at, at + offsetSize));
    if (offset === undefined) return undefined;
    offsets.push(offset);
  }
  const plist = new Binary(raw, offsets, refSize);
  const found = plist.object(top);
  if (found === undefined || found[0] !== 0xd) return undefined;
  const [, entries, body] = found;
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

function decodeEntity(entity: string): string | undefined {
  const named = NAMED[entity];
  if (named !== undefined) return named;
  let code: number | undefined;
  if (/^#[xX]\+?[0-9a-fA-F]+$/.test(entity)) code = Number.parseInt(entity.slice(2), 16);
  else if (/^#\+?[0-9]+$/.test(entity)) code = Number.parseInt(entity.slice(1), 10);
  if (code === undefined || code > 0x10ffff || (code >= 0xd800 && code < 0xe000)) return undefined;
  return String.fromCodePoint(code);
}

function unescape(text: string): string {
  let out = "";
  let rest = text;
  for (let amp = rest.indexOf("&"); amp >= 0; amp = rest.indexOf("&")) {
    out += rest.slice(0, amp);
    rest = rest.slice(amp);
    const semi = rest.indexOf(";");
    if (semi < 0) break;
    const decoded = decodeEntity(rest.slice(1, semi));
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
    const name = tag.replace(/\/+$/, "").split(/[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/).filter((word) => word !== "")[0] ?? "";
    const empty = tag.endsWith("/");
    if ((name === "dict" || name === "array") && !empty) {
      depth += 1;
      if (depth > 1) pendingKey = undefined;
    } else if (name === "/dict" || name === "/array") depth -= 1;
    else if (name === "key" && depth === 1 && !empty) {
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
      const matched = pendingKey === key;
      pendingKey = undefined;
      if (matched) return value;
    } else if (name === "plist" || name === "/plist") {
    } else if (depth === 1 && !name.startsWith("/")) pendingKey = undefined;
  }
  return undefined;
}
