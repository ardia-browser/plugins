import { NeedsPython } from "./paths.ts";

export type PlistValue = string | boolean | number | bigint | PlistValue[] | Map<string, PlistValue> | Buffer | Date | null;

const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;

function escape(text: string): string {
  if (CONTROL.test(text)) throw new NeedsPython("strings can't contain control characters; use bytes instead");
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function dumpsXml(value: Map<string, PlistValue>): string {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">', '<plist version="1.0">'];
  const write = (item: PlistValue, level: number) => {
    const indent = "\t".repeat(level);
    if (typeof item === "string") lines.push(`${indent}<string>${escape(item)}</string>`);
    else if (item === true) lines.push(`${indent}<true/>`);
    else if (item === false) lines.push(`${indent}<false/>`);
    else if (typeof item === "bigint") lines.push(`${indent}<integer>${item}</integer>`);
    else if (Array.isArray(item)) {
      if (item.length === 0) lines.push(`${indent}<array/>`);
      else {
        lines.push(`${indent}<array>`);
        for (const child of item) write(child, level + 1);
        lines.push(`${indent}</array>`);
      }
    } else if (item instanceof Map) {
      if (item.size === 0) lines.push(`${indent}<dict/>`);
      else {
        lines.push(`${indent}<dict>`);
        for (const [key, child] of item) {
          lines.push(`${indent}\t<key>${escape(key)}</key>`);
          write(child, level + 1);
        }
        lines.push(`${indent}</dict>`);
      }
    } else throw new NeedsPython("a plist value only Python writes");
  };
  write(value, 0);
  lines.push("</plist>");
  return `${lines.join("\n")}\n`;
}

class Malformed extends Error {}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, name: string) => {
    if (name === "amp") return "&";
    if (name === "lt") return "<";
    if (name === "gt") return ">";
    if (name === "quot") return '"';
    if (name === "apos") return "'";
    return String.fromCodePoint(name.startsWith("#x") ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10));
  });
}

type Token = { kind: "open" | "close" | "empty"; name: string } | { kind: "text"; text: string };

function tokens(xml: string): Token[] {
  const out: Token[] = [];
  let at = 0;
  while (at < xml.length) {
    const open = xml.indexOf("<", at);
    if (open < 0) {
      out.push({ kind: "text", text: xml.slice(at) });
      break;
    }
    if (open > at) out.push({ kind: "text", text: xml.slice(at, open) });
    if (xml.startsWith("<!--", open)) {
      const end = xml.indexOf("-->", open);
      if (end < 0) throw new Malformed();
      at = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", open)) {
      const end = xml.indexOf("]]>", open);
      if (end < 0) throw new Malformed();
      out.push({ kind: "text", text: `\u0000${xml.slice(open + 9, end)}` });
      at = end + 3;
      continue;
    }
    const close = xml.indexOf(">", open);
    if (close < 0) throw new Malformed();
    const inner = xml.slice(open + 1, close);
    at = close + 1;
    if (inner.startsWith("?") || inner.startsWith("!")) continue;
    if (inner.startsWith("/")) out.push({ kind: "close", name: inner.slice(1).trim() });
    else if (inner.endsWith("/")) out.push({ kind: "empty", name: inner.slice(0, -1).trim().split(/\s/)[0] ?? "" });
    else out.push({ kind: "open", name: inner.trim().split(/\s/)[0] ?? "" });
  }
  return out;
}

function textOf(token: Token | undefined): string {
  if (token === undefined || token.kind !== "text") return "";
  return token.text.startsWith("\u0000") ? token.text.slice(1) : decodeEntities(token.text);
}

function parseXml(xml: string): PlistValue {
  const list = tokens(xml).filter((token) => token.kind !== "text" || token.text.trim() !== "" || true);
  let at = 0;
  const skipSpace = () => {
    while (at < list.length) {
      const token = list[at] as Token;
      if (token.kind === "text" && token.text.trim() === "") at += 1;
      else break;
    }
  };
  const simple = (name: string): string => {
    const token = list[at];
    let text = "";
    while (list[at]?.kind === "text") {
      text += textOf(list[at]);
      at += 1;
    }
    const end = list[at];
    if (end === undefined || end.kind !== "close" || end.name !== name) throw new Malformed(token === undefined ? "" : name);
    at += 1;
    return text;
  };
  const value = (): PlistValue => {
    skipSpace();
    const token = list[at];
    if (token === undefined) throw new Malformed();
    at += 1;
    if (token.kind === "empty") {
      if (token.name === "true") return true;
      if (token.name === "false") return false;
      if (token.name === "dict") return new Map();
      if (token.name === "array") return [];
      if (token.name === "string") return "";
      throw new Malformed();
    }
    if (token.kind !== "open") throw new Malformed();
    switch (token.name) {
      case "string":
        return simple("string");
      case "integer": {
        const text = simple("integer").trim();
        return text.startsWith("0x") || text.startsWith("0X") ? BigInt(text) : BigInt(text);
      }
      case "real":
        return Number(simple("real"));
      case "true":
        simple("true");
        return true;
      case "false":
        simple("false");
        return false;
      case "date":
        return new Date(simple("date"));
      case "data":
        return Buffer.from(simple("data").replace(/\s/g, ""), "base64");
      case "array": {
        const items: PlistValue[] = [];
        for (;;) {
          skipSpace();
          const next = list[at];
          if (next?.kind === "close" && next.name === "array") {
            at += 1;
            return items;
          }
          items.push(value());
        }
      }
      case "dict": {
        const map = new Map<string, PlistValue>();
        for (;;) {
          skipSpace();
          const next = list[at];
          if (next?.kind === "close" && next.name === "dict") {
            at += 1;
            return map;
          }
          if (next?.kind !== "open" || next.name !== "key") throw new Malformed();
          at += 1;
          const key = simple("key");
          map.set(key, value());
        }
      }
      default:
        throw new Malformed();
    }
  };
  skipSpace();
  const root = list[at];
  if (root === undefined || root.kind !== "open" || root.name !== "plist") throw new Malformed();
  at += 1;
  const result = value();
  return result;
}

function parseBinary(data: Buffer): PlistValue {
  if (data.length < 40) throw new Malformed();
  const trailer = data.subarray(data.length - 32);
  const offsetSize = trailer[6] as number;
  const refSize = trailer[7] as number;
  const count = Number(trailer.readBigUInt64BE(8));
  const top = Number(trailer.readBigUInt64BE(16));
  const tableAt = Number(trailer.readBigUInt64BE(24));
  const readInt = (at: number, size: number): number => {
    let value = 0;
    for (let index = 0; index < size; index += 1) value = value * 256 + (data[at + index] as number);
    return value;
  };
  const offsets: number[] = [];
  for (let index = 0; index < count; index += 1) offsets.push(readInt(tableAt + index * offsetSize, offsetSize));
  const seen = new Set<number>();
  const object = (ref: number): PlistValue => {
    if (seen.has(ref) || ref >= count) throw new Malformed();
    seen.add(ref);
    try {
      return decodeObject(offsets[ref] as number);
    } finally {
      seen.delete(ref);
    }
  };
  const lengthAt = (at: number, info: number): [number, number] => {
    if (info !== 0x0f) return [info, at + 1];
    const marker = data[at + 1] as number;
    const size = 1 << (marker & 0x0f);
    return [readInt(at + 2, size), at + 2 + size];
  };
  const decodeObject = (at: number): PlistValue => {
    const marker = data[at];
    if (marker === undefined) throw new Malformed();
    const kind = marker >> 4;
    const info = marker & 0x0f;
    if (marker === 0x00) return null;
    if (marker === 0x08) return false;
    if (marker === 0x09) return true;
    if (kind === 0x1) {
      const size = 1 << info;
      if (size === 8) return data.readBigInt64BE(at + 1);
      return BigInt(readInt(at + 1, size));
    }
    if (kind === 0x2) return info === 2 ? data.readFloatBE(at + 1) : data.readDoubleBE(at + 1);
    if (kind === 0x3) return new Date((Date.UTC(2001, 0, 1) / 1000 + data.readDoubleBE(at + 1)) * 1000);
    if (kind === 0x4) {
      const [length, start] = lengthAt(at, info);
      return Buffer.from(data.subarray(start, start + length));
    }
    if (kind === 0x5) {
      const [length, start] = lengthAt(at, info);
      return data.subarray(start, start + length).toString("latin1");
    }
    if (kind === 0x6) {
      const [length, start] = lengthAt(at, info);
      const units = data.subarray(start, start + length * 2);
      const swapped = Buffer.from(units);
      swapped.swap16();
      return swapped.toString("utf16le");
    }
    if (kind === 0xa) {
      const [length, start] = lengthAt(at, info);
      const items: PlistValue[] = [];
      for (let index = 0; index < length; index += 1) items.push(object(readInt(start + index * refSize, refSize)));
      return items;
    }
    if (kind === 0xd) {
      const [length, start] = lengthAt(at, info);
      const map = new Map<string, PlistValue>();
      for (let index = 0; index < length; index += 1) {
        const key = object(readInt(start + index * refSize, refSize));
        if (typeof key !== "string") throw new Malformed();
        map.set(key, object(readInt(start + (length + index) * refSize, refSize)));
      }
      return map;
    }
    throw new Malformed();
  };
  return object(top);
}

export function loadPlist(data: Buffer): PlistValue {
  if (data.subarray(0, 8).toString("latin1") === "bplist00") return parseBinary(data);
  return parseXml(data.toString("utf8"));
}

export function topLevelString(raw: Uint8Array, key: string): string | undefined {
  let parsed: PlistValue;
  try {
    parsed = loadPlist(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength));
  } catch {
    return undefined;
  }
  const value = parsed instanceof Map ? parsed.get(key) : undefined;
  return typeof value === "string" ? value : undefined;
}
