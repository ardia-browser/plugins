import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { Float, type Value } from "../../src/json.ts";
import { drawAnnotations, thresholdOf } from "../../src/browse/media/draw.ts";
import { comparePngs, crc32, decodePng, encodePng, Image, PngCorrupt } from "../../src/browse/media/png.ts";
import { bezierPoint, controlPoints, CubicBezier, fittsDuration, keyEvents, minimumJerk, moveDuration, pauseAfter, type Point, roundCoordinate, tremorSigma } from "../../src/browse/input/human.ts";
import { humanizeDefault, parseCombo, parseKey } from "../../src/browse/input/keys.ts";
import { Random } from "../../src/pylib/random.ts";

import { num, text, toValue } from "./values.ts";

const f = (value: number) => new Float(value);

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function imageFields(image: Image): Value {
  return new Map<string, Value>([["width", BigInt(image.width)], ["height", BigInt(image.height)], ["pixels", sha(image.pixels)], ["size", BigInt(image.pixels.length)]]);
}

function bytesOf(value: Value | undefined): Uint8Array {
  return Buffer.from(text(value), "base64");
}

function pngShape(data: Uint8Array): Value {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const chunks: Value[] = [];
  const idat: Uint8Array[] = [];
  let offset = 8;
  while (offset < data.length) {
    const length = view.getUint32(offset);
    const kind = String.fromCharCode(...data.subarray(offset + 4, offset + 8));
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (kind === "IDAT") {
      idat.push(body);
      chunks.push([kind, crc32(data.subarray(offset + 4, offset + 8 + length)) === view.getUint32(offset + 8 + length)]);
    } else chunks.push([kind, Buffer.from(data.subarray(offset, offset + 12 + length)).toString("hex")]);
    offset += 12 + length;
  }
  return new Map<string, Value>([["signature", Buffer.from(data.subarray(0, 8)).toString("hex")], ["chunks", chunks], ["raw", sha(inflateSync(Buffer.concat(idat)))]]);
}

function corruptOr(run: () => Value): Value {
  try {
    return run();
  } catch (error) {
    if (error instanceof PngCorrupt) return new Map<string, Value>([["corrupt", true]]);
    throw error;
  }
}

function point(value: Value | undefined): Point {
  const [x, y] = value as Value[];
  return [num(x), num(y)];
}

function pair(value: readonly [number, number] | Point): Value {
  return [f(value[0]), f(value[1])];
}

function randomOp(source: Random, op: Value[]): Value {
  const [name, ...args] = op;
  switch (name) {
    case "random":
      return f(source.random());
    case "uniform":
      return f(source.uniform(num(args[0]), num(args[1])));
    case "randint":
      return BigInt(source.randint(num(args[0]), num(args[1])));
    case "choice":
      return source.choice(args[0] as Value[]);
    case "gauss":
      return f(source.gauss(num(args[0]), num(args[1])));
    case "getrandbits":
      return source.getrandbits(num(args[0]));
    default:
      return BigInt(source.randbelow(num(args[0])));
  }
}

function keySpec(spec: readonly [string, string, number, string | null]): Value {
  return [spec[0], spec[1], BigInt(spec[2]), spec[3]];
}

export const P2_MORE: Record<string, (...args: Value[]) => Value> = {
  "media.decode": (data) => corruptOr(() => imageFields(decodePng(bytesOf(data)))),
  "media.compare": (a, b, threshold) =>
    corruptOr(() => {
      const { result, diff } = comparePngs(bytesOf(a), bytesOf(b), num(threshold));
      const out = new Map<string, Value>([["match", result.match]]);
      if (result.reason !== undefined) out.set("reason", result.reason);
      out.set("diffPixels", result.diffPixels === null ? null : BigInt(result.diffPixels));
      out.set("totalPixels", BigInt(result.totalPixels));
      if (result.diffPercent !== undefined) out.set("diffPercent", f(result.diffPercent));
      if (diff) out.set("diff", imageFields(decodePng(encodePng(diff))));
      return out;
    }),
  "media.encode": (width, height, pixels) => pngShape(encodePng(new Image(num(width), num(height), Uint8Array.from(bytesOf(pixels))))),
  "media.annotate": (png, rows, viewport, offset) => {
    const plainRows = (rows as Value[]).map((row) => {
      const map = row as Map<string, Value>;
      const box = map.get("box") as Map<string, Value>;
      return { number: num(map.get("number")), box: { x: num(box.get("x")), y: num(box.get("y")), width: num(box.get("width")), height: num(box.get("height")) } };
    });
    const width = (viewport as Map<string, Value>).get("clientWidth");
    const out = drawAnnotations(bytesOf(png), plainRows, { clientWidth: width === undefined || width === null ? null : num(width) }, offset === null ? null : point(offset));
    return new Map<string, Value>([["shape", pngShape(out)], ["image", imageFields(decodePng(out))]]);
  },
  "media.threshold": (value) => f(thresholdOf(typeof value === "bigint" ? Number(value) : value instanceof Float ? value.value : value)),
  "random.ops": (seed, ops) => {
    const source = new Random(seed as bigint);
    return (ops as Value[][]).map((op) => randomOp(source, op));
  },
  "human.control_points": (seed, start, end) => {
    const [near, far] = controlPoints(point(start), point(end), new Random(seed as bigint));
    return [pair(near), pair(far)];
  },
  "human.pause": (seed, chars) => {
    const source = new Random(seed as bigint);
    return (chars as Value[]).map((char) => f(pauseAfter(text(char), source)));
  },
  "human.solve": (points, xs) => {
    const [x1, y1, x2, y2] = (points as Value[]).map(num) as [number, number, number, number];
    const curve = new CubicBezier(x1, y1, x2, y2);
    return (xs as Value[]).map((x) => f(curve.solve(num(x))));
  },
  "human.bezier_point": (t, p0, p1, p2, p3) => pair(bezierPoint(num(t), point(p0), point(p1), point(p2), point(p3))),
  "human.minimum_jerk": (t) => f(minimumJerk(num(t))),
  "human.fitts": (distance, width, a, b) => f(fittsDuration(num(distance), num(width), num(a), num(b))),
  "human.duration": (distance) => f(moveDuration(num(distance))),
  "human.tremor": (x, y, now, previous) => f(tremorSigma(num(x), num(y), num(now), (previous as Value[]).map(num) as [number, number, number])),
  "human.key_events": (char) => toValue(keyEvents(text(char))),
  "human.round": (value) => BigInt(roundCoordinate(num(value))),
  "keys.parse_key": (name) => keySpec(parseKey(text(name))),
  "keys.parse_combo": (combo) => {
    const [modifiers, last] = parseCombo(text(combo));
    return [modifiers, last];
  },
  "keys.humanize_default": (env) => humanizeDefault(Object.fromEntries([...(env as Map<string, Value>)].map(([key, value]) => [key, value === null ? undefined : text(value)]))),
};

