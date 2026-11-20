import CODECS from "./codecs.gen.json" with { type: "json" };
import { pyError } from "../pyerror.ts";

type Registry = { names: Record<string, string>; text: Record<string, boolean>; tables: Record<string, string> };
const REGISTRY = CODECS as Registry;

export const WHATWG: Readonly<Record<string, string>> = {
  big5: "big5",
  big5hkscs: "big5",
  cp950: "big5",
  cp932: "shift_jis",
  shift_jis: "shift_jis",
  shift_jis_2004: "shift_jis",
  shift_jisx0213: "shift_jis",
  euc_jp: "euc-jp",
  euc_jis_2004: "euc-jp",
  euc_jisx0213: "euc-jp",
  iso2022_jp: "iso-2022-jp",
  iso2022_jp_1: "iso-2022-jp",
  iso2022_jp_2: "iso-2022-jp",
  iso2022_jp_2004: "iso-2022-jp",
  iso2022_jp_3: "iso-2022-jp",
  iso2022_jp_ext: "iso-2022-jp",
  euc_kr: "euc-kr",
  cp949: "euc-kr",
  johab: "euc-kr",
  iso2022_kr: "iso-2022-kr",
  gb2312: "gbk",
  gbk: "gbk",
  gb18030: "gb18030",
  "utf-7": "utf-8",
};

function isAsciiAlnum(char: string): boolean {
  return /^[A-Za-z0-9]$/u.test(char);
}

export function normalizeEncoding(name: string): string {
  let out = "";
  let punct = false;
  for (const char of name) {
    if (/^[\p{L}\p{N}]$/u.test(char) || char === ".") {
      if (punct && out) out += "_";
      if (isAsciiAlnum(char) || char === ".") out += char;
      punct = false;
    } else punct = true;
  }
  return out;
}

export function codecOf(name: string): string {
  const lowered = name.replace(/[A-Z]/gu, (char) => char.toLowerCase()).replaceAll(" ", "_").replaceAll("-", "_");
  const key = normalizeEncoding(lowered);
  const codec = REGISTRY.names[key] ?? REGISTRY.names[key.replaceAll(".", "_")];
  if (codec === undefined) throw pyError("LookupError", `unknown encoding: ${name}`);
  if (REGISTRY.text[codec] === false) throw pyError("LookupError", `'${name}' is not a text encoding; use codecs.decode() to handle arbitrary codecs`);
  return codec;
}

type Label = ConstructorParameters<typeof TextDecoder>[0];
type DecoderOptions = ConstructorParameters<typeof TextDecoder>[1];

function textDecoder(label: string, options: DecoderOptions = {}): { decode(bytes: Uint8Array): string } {
  return new TextDecoder(label as Label, options);
}

function decodeTable(bytes: Uint8Array, table: string): string {
  let out = "";
  const step = 4096;
  for (let start = 0; start < bytes.length; start += step) {
    const chars: string[] = [];
    for (const byte of bytes.subarray(start, start + step)) chars.push(table[byte] as string);
    out += chars.join("");
  }
  return out;
}

function decodeUtf32(bytes: Uint8Array, little: boolean): string {
  const points: string[] = [];
  const whole = bytes.length - (bytes.length % 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 0; at < whole; at += 4) {
    const code = view.getUint32(at, little);
    points.push(code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? "�" : String.fromCodePoint(code));
  }
  if (whole < bytes.length) points.push("�");
  return points.join("");
}

function bom(bytes: Uint8Array, ...marks: number[]): boolean {
  return marks.every((mark, index) => bytes[index] === mark);
}

export const APPROXIMATE = new Set([...Object.keys(WHATWG), "unicode-escape", "punycode"]);

export function decode(bytes: Uint8Array, charset: string): string {
  const codec = codecOf(charset);
  if (codec === "idna") throw pyError("UnicodeError", "Unsupported error handling: replace");
  if (codec === "undefined") throw pyError("UnicodeError", "undefined encoding");
  const table = REGISTRY.tables[codec];
  if (table !== undefined) return decodeTable(bytes, table);
  if (codec === "utf-8") return textDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  if (codec === "utf-8-sig") return textDecoder("utf-8").decode(bytes);
  if (codec === "utf-16-le") return textDecoder("utf-16le", { ignoreBOM: true }).decode(bytes);
  if (codec === "utf-16-be") return textDecoder("utf-16be", { ignoreBOM: true }).decode(bytes);
  if (codec === "utf-16") {
    if (bom(bytes, 0xfe, 0xff)) return textDecoder("utf-16be", { ignoreBOM: true }).decode(bytes.subarray(2));
    if (bom(bytes, 0xff, 0xfe)) return textDecoder("utf-16le", { ignoreBOM: true }).decode(bytes.subarray(2));
    return textDecoder("utf-16le", { ignoreBOM: true }).decode(bytes);
  }
  if (codec === "utf-32-le") return decodeUtf32(bytes, true);
  if (codec === "utf-32-be") return decodeUtf32(bytes, false);
  if (codec === "utf-32") {
    if (bom(bytes, 0x00, 0x00, 0xfe, 0xff)) return decodeUtf32(bytes.subarray(4), false);
    if (bom(bytes, 0xff, 0xfe, 0x00, 0x00)) return decodeUtf32(bytes.subarray(4), true);
    return decodeUtf32(bytes, true);
  }
  const label = WHATWG[codec];
  if (label !== undefined) {
    try {
      return textDecoder(label).decode(bytes);
    } catch {
      return textDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    }
  }
  return textDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}
