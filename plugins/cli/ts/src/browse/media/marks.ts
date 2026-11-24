import { Usage } from "../daemon-errors.ts";
import { roundHalfEven } from "../../pylib/format.ts";
import type { Box } from "./draw.ts";

export const MIN_SCALE = 0.25;
export const MAX_SCALE = 1;

export type Region = { x: number; y: number; width: number; height: number };
export type Size = { width: number; height: number };
export type Mark = {
  number: number;
  ref: string;
  role: string;
  name?: string;
  box: Box;
  center: { x: number; y: number };
  image: Box;
};
export type CoordinateFrame = {
  viewport: Size;
  image: Size;
  scale: number;
  region: Region;
  dpr: number;
};

export function parseScale(text: unknown): number | null {
  if (text === undefined || text === null || text === false) return null;
  const raw = String(text).trim();
  const value = raw.endsWith("%") ? Number(raw.slice(0, -1)) / 100 : Number(raw);
  if (raw === "" || !Number.isFinite(value) || value < MIN_SCALE || value > MAX_SCALE) {
    throw new Usage(`--scale takes a number from ${MIN_SCALE} to ${MAX_SCALE} (0.5 halves each side, about a quarter of the image tokens), not ${raw || "nothing"}`);
  }
  return value;
}

export function parseRegion(text: unknown): Region | null {
  if (text === undefined || text === null || text === false) return null;
  const raw = String(text).trim();
  const parts = raw.split(/[,\s]+/u).filter(Boolean).map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    throw new Usage(`--region takes x,y,w,h in the viewport's CSS pixels, like --region 0,0,800,600, not ${raw || "nothing"}`);
  }
  const [x, y, width, height] = parts as [number, number, number, number];
  if (x < 0 || y < 0 || width <= 0 || height <= 0) throw new Usage(`--region needs x and y of 0 or more and a width and height above 0, not ${raw}`);
  return { x, y, width, height };
}

function u16be(bytes: Uint8Array, at: number): number {
  return ((bytes[at] as number) << 8) | (bytes[at + 1] as number);
}

function u32be(bytes: Uint8Array, at: number): number {
  return (((bytes[at] as number) << 24) >>> 0) + ((bytes[at + 1] as number) << 16) + ((bytes[at + 2] as number) << 8) + (bytes[at + 3] as number);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_FRAME_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

export function imageSize(bytes: Uint8Array): Size | null {
  if (bytes.length >= 24 && PNG_SIGNATURE.every((value, index) => bytes[index] === value)) {
    return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) {
      at += 1;
      continue;
    }
    const marker = bytes[at + 1] as number;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const length = u16be(bytes, at + 2);
    if (JPEG_FRAME_MARKERS.has(marker)) return { width: u16be(bytes, at + 7), height: u16be(bytes, at + 5) };
    at += 2 + length;
  }
  return null;
}

export function shortNumber(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

export function clipScale(scale: number, dpr: number): number {
  return scale / (dpr > 0 ? dpr : 1);
}

export function frameOf(viewport: Size, region: Region, image: Size | null, dpr: number): CoordinateFrame {
  const shown = image ?? { width: Math.round(region.width), height: Math.round(region.height) };
  const scale = region.width > 0 ? Math.round((shown.width / region.width) * 1000) / 1000 : 1;
  return { viewport, image: shown, scale, region, dpr };
}

export function regionText(region: Region): string {
  return [region.x, region.y, region.width, region.height].map(shortNumber).join(",");
}

export function frameLines(frame: CoordinateFrame, wholeViewport: boolean): string[] {
  const head = `   viewport: ${shortNumber(frame.viewport.width)}×${shortNumber(frame.viewport.height)}, image: ${frame.image.width}×${frame.image.height}, scale: ${shortNumber(frame.scale)} (use viewport CSS coordinates for click --xy)`;
  if (wholeViewport) return [head];
  const { x, y } = frame.region;
  const map = `viewport x = ${shortNumber(x)} + image x / ${shortNumber(frame.scale)}, y = ${shortNumber(y)} + image y / ${shortNumber(frame.scale)}`;
  return [head, `   region: ${regionText(frame.region)} (${map})`];
}

export function markOf(row: { number: number; ref: string; role: string; name?: string; box: Box }, frame: CoordinateFrame): Mark {
  const { box } = row;
  const s = frame.scale;
  const mark: Mark = {
    number: row.number,
    ref: row.ref,
    role: row.role,
    box,
    center: { x: roundHalfEven(box.x + box.width / 2), y: roundHalfEven(box.y + box.height / 2) },
    image: {
      x: Math.round((box.x - frame.region.x) * s),
      y: Math.round((box.y - frame.region.y) * s),
      width: Math.round(box.width * s),
      height: Math.round(box.height * s),
    },
  };
  if (row.name) mark.name = row.name;
  return mark;
}

export function markLine(mark: Mark): string {
  const name = mark.name ? ` "${mark.name}"` : "";
  return `   [${mark.number}] @${mark.ref} ${mark.role}${name} at ${mark.center.x},${mark.center.y} (box ${mark.box.x},${mark.box.y} ${mark.box.width}×${mark.box.height})`;
}

export function marksText(marks: readonly Mark[]): string[] {
  if (marks.length === 0) return ["   marks: none (no interactive element with a ref shows in this image; run `snapshot -i` to see what's on the page)"];
  return [`   marks: ${marks.length} (the badge number is the ref's number; "at" is the center in viewport CSS pixels)`, ...marks.map(markLine)];
}
