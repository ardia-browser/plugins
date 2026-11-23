import { isHigh, SPLIT, splitsAfterHigh } from "./pystr.ts";

type Encoding = "utf-8" | "utf-8-sig" | "utf-16" | "utf-16-be" | "utf-16-le" | "utf-32" | "utf-32-be" | "utf-32-le";

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);
}

const BOM_UTF32_BE = [0x00, 0x00, 0xfe, 0xff];
const BOM_UTF32_LE = [0xff, 0xfe, 0x00, 0x00];
const BOM_UTF16_BE = [0xfe, 0xff];
const BOM_UTF16_LE = [0xff, 0xfe];
const BOM_UTF8 = [0xef, 0xbb, 0xbf];

function detectEncoding(bytes: Uint8Array): Encoding {
  if (startsWith(bytes, BOM_UTF32_BE) || startsWith(bytes, BOM_UTF32_LE)) return "utf-32";
  if (startsWith(bytes, BOM_UTF16_BE) || startsWith(bytes, BOM_UTF16_LE)) return "utf-16";
  if (startsWith(bytes, BOM_UTF8)) return "utf-8-sig";
  if (bytes.length >= 4) {
    if (!bytes[0]) return bytes[1] ? "utf-16-be" : "utf-32-be";
    if (!bytes[1]) return bytes[2] || bytes[3] ? "utf-16-le" : "utf-32-le";
  } else if (bytes.length === 2) {
    if (!bytes[0]) return "utf-16-be";
    if (!bytes[1]) return "utf-16-le";
  }
  return "utf-8";
}

function pushCodePoint(units: number[], code: number, afterLoneHigh: boolean): boolean {
  if (code >= 0x10000) {
    units.push(0xd800 + ((code - 0x10000) >> 10), 0xdc00 + ((code - 0x10000) & 0x3ff));
    return false;
  }
  if (afterLoneHigh && splitsAfterHigh(code)) units.push(SPLIT);
  units.push(code);
  return isHigh(code);
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function continuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

function utf8SurrogatePass(bytes: Uint8Array): string | undefined {
  try {
    return strictUtf8.decode(bytes);
  } catch {}
  const units: number[] = [];
  let out = "";
  let loneHigh = false;
  const flush = () => {
    out += String.fromCharCode(...units);
    units.length = 0;
  };
  for (let at = 0; at < bytes.length; ) {
    const lead = bytes[at] as number;
    let code: number;
    let size: number;
    if (lead < 0x80) [code, size] = [lead, 1];
    else if (lead >= 0xc2 && lead <= 0xdf && continuation(bytes[at + 1])) [code, size] = [((lead & 0x1f) << 6) | ((bytes[at + 1] as number) & 0x3f), 2];
    else if (lead >= 0xe0 && lead <= 0xef && continuation(bytes[at + 1]) && continuation(bytes[at + 2])) {
      code = ((lead & 0x0f) << 12) | (((bytes[at + 1] as number) & 0x3f) << 6) | ((bytes[at + 2] as number) & 0x3f);
      size = 3;
      if (code < 0x800) return undefined;
    } else if (lead >= 0xf0 && lead <= 0xf4 && continuation(bytes[at + 1]) && continuation(bytes[at + 2]) && continuation(bytes[at + 3])) {
      code =
        ((lead & 0x07) << 18) | (((bytes[at + 1] as number) & 0x3f) << 12) | (((bytes[at + 2] as number) & 0x3f) << 6) | ((bytes[at + 3] as number) & 0x3f);
      size = 4;
      if (code < 0x10000 || code > 0x10ffff) return undefined;
    } else return undefined;
    loneHigh = pushCodePoint(units, code, loneHigh);
    if (units.length >= 4096) flush();
    at += size;
  }
  flush();
  return out;
}

function utf16(bytes: Uint8Array, bigEndian: boolean): string | undefined {
  if (bytes.length % 2 !== 0) return undefined;
  const units: number[] = [];
  let out = "";
  for (let at = 0; at < bytes.length; at += 2) {
    const [high, low] = [bytes[at] as number, bytes[at + 1] as number];
    const unit = bigEndian ? (high << 8) | low : (low << 8) | high;
    if (unit === SPLIT && units.length > 0 && isHigh(units[units.length - 1] as number)) units.push(SPLIT);
    units.push(unit);
    if (units.length >= 4096 && !isHigh(unit)) {
      out += String.fromCharCode(...units);
      units.length = 0;
    }
  }
  return out + String.fromCharCode(...units);
}

function utf32(bytes: Uint8Array, bigEndian: boolean): string | undefined {
  if (bytes.length % 4 !== 0) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const units: number[] = [];
  let out = "";
  let loneHigh = false;
  for (let at = 0; at < bytes.length; at += 4) {
    const code = view.getUint32(at, !bigEndian);
    if (code > 0x10ffff) return undefined;
    loneHigh = pushCodePoint(units, code, loneHigh);
    if (units.length >= 4096) {
      out += String.fromCharCode(...units);
      units.length = 0;
    }
  }
  return out + String.fromCharCode(...units);
}

export function decodeJsonBytes(bytes: Uint8Array): string | undefined {
  const encoding = detectEncoding(bytes);
  if (encoding === "utf-8") return utf8SurrogatePass(bytes);
  if (encoding === "utf-8-sig") return utf8SurrogatePass(bytes.subarray(3));
  if (encoding === "utf-16") return utf16(bytes.subarray(2), bytes[0] === 0xfe);
  if (encoding === "utf-32") return utf32(bytes.subarray(4), bytes[0] === 0x00);
  if (encoding === "utf-16-be" || encoding === "utf-16-le") return utf16(bytes, encoding === "utf-16-be");
  return utf32(bytes, encoding === "utf-32-be");
}

const wellFormedUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function wellFormedUtf16(bytes: Uint8Array, bigEndian: boolean): boolean {
  if (bytes.length % 2 !== 0) return false;
  let wantLow = false;
  for (let at = 0; at < bytes.length; at += 2) {
    const unit = bigEndian ? ((bytes[at] as number) << 8) | (bytes[at + 1] as number) : ((bytes[at + 1] as number) << 8) | (bytes[at] as number);
    const high = unit >= 0xd800 && unit < 0xdc00;
    const low = unit >= 0xdc00 && unit < 0xe000;
    if (wantLow !== low) return false;
    wantLow = high;
  }
  return !wantLow;
}

function wellFormedUtf32(bytes: Uint8Array, bigEndian: boolean): boolean {
  if (bytes.length % 4 !== 0) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 0; at < bytes.length; at += 4) {
    const code = view.getUint32(at, !bigEndian);
    if (code > 0x10ffff || (code >= 0xd800 && code < 0xe000)) return false;
  }
  return true;
}

export function strictJsonText(bytes: Uint8Array): string | undefined {
  const encoding = detectEncoding(bytes);
  if (encoding === "utf-8") {
    try {
      return wellFormedUtf8.decode(bytes);
    } catch {
      return undefined;
    }
  }
  if (encoding === "utf-16-be" || encoding === "utf-16-le") return wellFormedUtf16(bytes, encoding === "utf-16-be") ? decodeJsonBytes(bytes) : undefined;
  if (encoding === "utf-32-be" || encoding === "utf-32-le") return wellFormedUtf32(bytes, encoding === "utf-32-be") ? decodeJsonBytes(bytes) : undefined;
  return undefined;
}
