import { inflateSync } from "node:zlib";

export type Image = { width: number; height: number; channels: number; pixels: Uint8Array };

export function decodePng(bytes: Uint8Array): Image {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0, height = 0, colorType = 0, bitDepth = 0, interlace = 0;
  const chunks: Uint8Array[] = [];
  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") chunks.push(data);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (bitDepth !== 8 || interlace !== 0 || ![2, 6].includes(colorType)) throw new Error(`unsupported png: depth ${bitDepth} color ${colorType} interlace ${interlace}`);
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const pixels = new Uint8Array(height * stride);
  for (let row = 0; row < height; row++) {
    const filter = raw[row * (stride + 1)];
    const line = raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1));
    const out = pixels.subarray(row * stride, (row + 1) * stride);
    const previous = row ? pixels.subarray((row - 1) * stride, row * stride) : new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? out[i - channels] : 0;
      const up = previous[i];
      const upLeft = i >= channels ? previous[i - channels] : 0;
      let value = line[i];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const estimate = left + up - upLeft;
        const distanceLeft = Math.abs(estimate - left), distanceUp = Math.abs(estimate - up), distanceUpLeft = Math.abs(estimate - upLeft);
        value += distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft ? left : distanceUp <= distanceUpLeft ? up : upLeft;
      }
      out[i] = value & 255;
    }
  }
  return { width, height, channels, pixels };
}

export function centroid(image: Image, match: (r: number, g: number, b: number) => boolean) {
  let sumX = 0, sumY = 0, count = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const index = (y * image.width + x) * image.channels;
      if (match(image.pixels[index], image.pixels[index + 1], image.pixels[index + 2])) {
        sumX += x;
        sumY += y;
        count++;
      }
    }
  }
  return count ? { x: sumX / count, y: sumY / count, count } : null;
}
