import { PyException, pyFloatOrUndefined } from "../../pylib/str.ts";
import { pyStr } from "../../pylib/plain.ts";
import { BrowseError } from "../daemon-errors.ts";
import { decodePng, encodePng, type Image } from "./png.ts";

export const UNCHANGED_PERCENT = 0.5;
const FONT: Readonly<Record<string, readonly string[]>> = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
};
export const LABEL: readonly [number, number, number] = [230, 30, 60];
export const WHITE: readonly [number, number, number] = [255, 255, 255];

export function fill(image: Image, left: number, top: number, right: number, bottom: number, color: readonly number[]): void {
  const x0 = Math.max(0, left);
  const x1 = Math.min(image.width, right);
  const value = ((color[0] as number) | ((color[1] as number) << 8) | ((color[2] as number) << 16) | 0xff000000) >>> 0;
  const pixels = new Uint32Array(image.pixels.buffer, image.pixels.byteOffset, image.width * image.height);
  for (let y = Math.max(0, top), y1 = Math.min(image.height, bottom); y < y1; y += 1) {
    if (x1 > x0) pixels.fill(value, y * image.width + x0, y * image.width + x1);
  }
}

export function outline(image: Image, left: number, top: number, right: number, bottom: number, color: readonly number[], thickness = 2): void {
  fill(image, left, top, right, top + thickness, color);
  fill(image, left, bottom - thickness, right, bottom, color);
  fill(image, left, top, left + thickness, bottom, color);
  fill(image, right - thickness, top, right, bottom, color);
}

export function text(image: Image, x: number, y: number, value: string, color: readonly number[], scale = 2): void {
  let at = x;
  for (const char of value) {
    const glyph = Object.hasOwn(FONT, char) ? FONT[char] : undefined;
    if (glyph) {
      glyph.forEach((bits, row) => {
        for (let column = 0; column < bits.length; column += 1) {
          if (bits[column] === "1") fill(image, at + column * scale, y + row * scale, at + (column + 1) * scale, y + (row + 1) * scale, color);
        }
      });
    }
    at += 6 * scale;
  }
}

export type Box = { x: number; y: number; width: number; height: number };
export type AnnotationRow = { number: number; box: Box };

export function drawAnnotations(png: Uint8Array, rows: readonly AnnotationRow[], viewport: { clientWidth?: number | null }, fullOffset: readonly [number, number] | null): Uint8Array {
  const image = decodePng(png);
  const cssWidth = viewport.clientWidth || image.width;
  if (!fullOffset && cssWidth === 0) throw new PyException("ZeroDivisionError", "division by zero");
  const scale = !fullOffset ? image.width / cssWidth : image.width / Math.max(cssWidth, 1);
  const [dx, dy] = fullOffset ?? [0, 0];
  for (const row of rows) {
    const box = row.box;
    const left = Math.trunc((box.x + dx) * scale);
    const top = Math.trunc((box.y + dy) * scale);
    const right = Math.trunc((box.x + dx + box.width) * scale);
    const bottom = Math.trunc((box.y + dy + box.height) * scale);
    if (right <= 0 || bottom <= 0 || left >= image.width || top >= image.height) continue;
    outline(image, left, top, right, bottom, LABEL, Math.max(2, Math.trunc(scale)));
    const label = String(row.number);
    const glyph = Math.max(2, Math.trunc(scale * 1.5));
    const width = label.length * 6 * glyph + 2 * glyph;
    const height = 7 * glyph + 2 * glyph;
    const labelTop = top - height >= 0 ? top - height : top;
    fill(image, left, labelTop, left + width, labelTop + height, LABEL);
    text(image, left + glyph, labelTop + glyph, label, WHITE, glyph);
  }
  return encodePng(image);
}

export function thresholdOf(value: unknown): number {
  if (value === null || value === undefined) return UNCHANGED_PERCENT;
  const shown = pyStr(value);
  let end = shown.length;
  while (end > 0 && shown[end - 1] === "%") end -= 1;
  const percent = pyFloatOrUndefined(shown.slice(0, end));
  if (percent === undefined) throw new BrowseError(`--threshold takes a percent of changed pixels, like 0.5, not ${shown}`);
  if (!(percent >= 0 && percent <= 100)) throw new BrowseError(`--threshold is a percent from 0 to 100, not ${shown}`);
  return percent;
}
