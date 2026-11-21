import { crc32 as zlibCrc32, deflateSync, inflateSync } from "node:zlib";
import { roundTo } from "../../pylib/format.ts";
import { BrowseError } from "../daemon-errors.ts";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export class PngCorrupt extends Error {}

export class Image {
  constructor(
    readonly width: number,
    readonly height: number,
    readonly pixels: Uint8Array,
  ) {}
}

function chunkType(data: Uint8Array, at: number): string {
  return String.fromCharCode(data[at] as number, data[at + 1] as number, data[at + 2] as number, data[at + 3] as number);
}

function readHeader(data: Uint8Array): { width: number; height: number; depth: number; colorType: number; interlace: number; idat: Uint8Array[] } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 8;
  let header: [number, number, number, number, number] | undefined;
  const idat: Uint8Array[] = [];
  while (offset < data.length) {
    if (offset + 8 > data.length) throw new PngCorrupt("unpack requires a buffer of 8 bytes");
    const length = view.getUint32(offset);
    const kind = chunkType(data, offset + 4);
    const body = data.subarray(offset + 8, Math.min(data.length, offset + 8 + length));
    offset += 12 + length;
    if (kind === "IHDR") {
      if (body.length !== 13) throw new PngCorrupt("unpack requires a buffer of 13 bytes");
      const head = new DataView(body.buffer, body.byteOffset, 13);
      header = [head.getUint32(0), head.getUint32(4), body[8] as number, body[9] as number, body[12] as number];
    } else if (kind === "IDAT") idat.push(body);
    else if (kind === "IEND") break;
  }
  if (header === undefined || header[2] !== 8 || (header[3] !== 2 && header[3] !== 6) || header[4]) {
    throw new BrowseError("Only 8-bit RGB or RGBA non-interlaced PNGs are supported");
  }
  return { width: header[0], height: header[1], depth: header[2], colorType: header[3], interlace: header[4], idat };
}

function addUp(line: Uint32Array, previous: Uint32Array, words: number): void {
  for (let i = 0; i < words; i += 1) {
    const a = line[i] as number;
    const b = previous[i] as number;
    line[i] = (((a & 0x7f7f7f7f) + (b & 0x7f7f7f7f)) ^ ((a ^ b) & 0x80808080)) >>> 0;
  }
}

function unfilter(kind: number, line: Uint8Array, previous: Uint8Array, line32: Uint32Array, previous32: Uint32Array, stride: number, channels: number): void {
  if (kind === 1) {
    for (let i = channels; i < stride; i += 1) line[i] = ((line[i] as number) + (line[i - channels] as number)) & 255;
  } else if (kind === 2) {
    addUp(line32, previous32, stride >> 2);
    for (let i = stride & ~3; i < stride; i += 1) line[i] = ((line[i] as number) + (previous[i] as number)) & 255;
  } else if (kind === 3) {
    for (let i = 0; i < channels; i += 1) line[i] = ((line[i] as number) + ((previous[i] as number) >> 1)) & 255;
    for (let i = channels; i < stride; i += 1) line[i] = ((line[i] as number) + (((line[i - channels] as number) + (previous[i] as number)) >> 1)) & 255;
  } else if (kind === 4) {
    for (let i = 0; i < channels; i += 1) line[i] = ((line[i] as number) + (previous[i] as number)) & 255;
    for (let i = channels; i < stride; i += 1) {
      const a = line[i - channels] as number;
      const b = previous[i] as number;
      const c = previous[i - channels] as number;
      let pa = b - c;
      let pb = a - c;
      let pc = pa + pb;
      if (pa < 0) pa = -pa;
      if (pb < 0) pb = -pb;
      if (pc < 0) pc = -pc;
      line[i] = ((line[i] as number) + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
    }
  }
}

export function decodePng(data: Uint8Array): Image {
  for (let index = 0; index < 8; index += 1) if (data[index] !== SIGNATURE[index]) throw new BrowseError("Not a PNG image");
  const { width, height, colorType, idat } = readHeader(data);
  const channels = colorType === 6 ? 4 : 3;
  let raw: Uint8Array;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch (error) {
    throw new PngCorrupt(`Error while decompressing data: ${(error as Error).message}`);
  }
  const stride = width * channels;
  const padded = (stride + 3) & ~3;
  let lineBuffer = new ArrayBuffer(padded);
  let previousBuffer = new ArrayBuffer(padded);
  const out = new Uint8Array(width * height * 4);
  const out32 = new Uint32Array(out.buffer);
  let position = 0;
  for (let y = 0; y < height; y += 1) {
    if (position >= raw.length) throw new PngCorrupt("index out of range");
    const kind = raw[position] as number;
    if (position + 1 + stride > raw.length) throw new PngCorrupt("truncated row");
    const line = new Uint8Array(lineBuffer, 0, stride);
    line.set(raw.subarray(position + 1, position + 1 + stride));
    position += 1 + stride;
    unfilter(kind, line, new Uint8Array(previousBuffer, 0, stride), new Uint32Array(lineBuffer), new Uint32Array(previousBuffer), stride, channels);
    if (channels === 4) out.set(line, y * width * 4);
    else {
      let source = 0;
      for (let x = y * width, end = x + width; x < end; x += 1, source += 3) {
        out32[x] = ((line[source] as number) | ((line[source + 1] as number) << 8) | ((line[source + 2] as number) << 16) | 0xff000000) >>> 0;
      }
    }
    const swap = previousBuffer;
    previousBuffer = lineBuffer;
    lineBuffer = swap;
  }
  return new Image(width, height, out);
}

export function crc32(bytes: Uint8Array): number {
  return zlibCrc32(bytes);
}

function chunk(kind: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let index = 0; index < 4; index += 1) out[4 + index] = kind.charCodeAt(index);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

export function encodePng(image: Image): Uint8Array {
  const stride = image.width * 4;
  const rows = new Uint8Array((stride + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) rows.set(image.pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, image.width);
  view.setUint32(4, image.height);
  header[8] = 8;
  header[9] = 6;
  const parts = [Uint8Array.from(SIGNATURE), chunk("IHDR", header), chunk("IDAT", deflateSync(rows, { level: 6 })), chunk("IEND", new Uint8Array(0))];
  return Buffer.concat(parts);
}

export type Comparison = { match: boolean; reason?: string; diffPixels: number | null; totalPixels: number; diffPercent?: number; diffPath?: string };

export function comparePixels(a: Image, b: Image, threshold: number): { result: Comparison; diff: Image | null } {
  if (a.width !== b.width || a.height !== b.height) {
    return { result: { match: false, reason: `size differs: ${a.width}x${a.height} vs ${b.width}x${b.height}`, diffPixels: null, totalPixels: b.width * b.height }, diff: null };
  }
  const limit = (threshold * 441.67) ** 2;
  const diff = new Image(a.width, a.height, new Uint8Array(a.width * a.height * 4));
  const out32 = new Uint32Array(diff.pixels.buffer);
  const pa = a.pixels;
  const pb = b.pixels;
  const count = a.width * a.height;
  let changed = 0;
  for (let p = 0, i = 0; p < count; p += 1, i += 4) {
    const r = pb[i] as number;
    const g = pb[i + 1] as number;
    const bl = pb[i + 2] as number;
    const dr = (pa[i] as number) - r;
    const dg = (pa[i + 1] as number) - g;
    const db = (pa[i + 2] as number) - bl;
    if (dr * dr + dg * dg + db * db > limit) {
      changed += 1;
      out32[p] = 0xff0000ff;
    } else {
      const light = 255 - ((255 - Math.floor((r + g + bl) / 3)) >> 2);
      out32[p] = (light | (light << 8) | (light << 16) | 0xff000000) >>> 0;
    }
  }
  const total = count;
  return { result: { match: changed === 0, diffPixels: changed, totalPixels: total, diffPercent: roundTo((changed * 100) / total, 3) }, diff };
}

export function comparePngs(before: Uint8Array, after: Uint8Array, threshold: number): { result: Comparison; diff: Image | null } {
  return comparePixels(decodePng(before), decodePng(after), threshold);
}
