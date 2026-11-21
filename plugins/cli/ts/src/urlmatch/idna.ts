import { tables, within } from "./tables.ts";

const S_BASE = 0xac00;
const L_BASE = 0x1100;
const V_BASE = 0x1161;
const T_BASE = 0x11a7;
const L_COUNT = 19;
const V_COUNT = 21;
const T_COUNT = 28;
const N_COUNT = V_COUNT * T_COUNT;
const S_COUNT = L_COUNT * N_COUNT;
const LABEL_DOTS = /[.。．｡]/;
const MAX_LABEL = 63;
const DIGITS = "abcdefghijklmnopqrstuvwxyz0123456789";
const MAX_POINT = 0x10ffff;
const ACE_PREFIX = "xn--";
const CHUNK = 4096;

export class IdnaFailure extends Error {}

export function pointsOf(text: string): number[] {
  const found: number[] = [];
  for (let at = 0; at < text.length; at += 1) {
    const unit = text.charCodeAt(at);
    const next = text.charCodeAt(at + 1);
    if (unit >= 0xd800 && unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      found.push(((unit - 0xd800) << 10) + (next - 0xdc00) + 0x10000);
      at += 1;
    } else found.push(unit);
  }
  return found;
}

function decompose(points: number[]): number[] {
  const { decomposed } = tables();
  const out: number[] = [];
  for (const point of points) {
    const syllable = point - S_BASE;
    if (syllable >= 0 && syllable < S_COUNT) {
      out.push(L_BASE + Math.floor(syllable / N_COUNT), V_BASE + Math.floor((syllable % N_COUNT) / T_COUNT));
      if (syllable % T_COUNT) out.push(T_BASE + (syllable % T_COUNT));
      continue;
    }
    const parts = decomposed.get(point);
    if (parts === undefined) out.push(point);
    else out.push(...parts);
  }
  return out;
}

function classOf(point: number): number {
  return tables().combining.get(point) ?? 0;
}

function reorder(points: number[]): void {
  for (let at = 1; at < points.length; at += 1) {
    const current = points[at] as number;
    const wanted = classOf(current);
    if (wanted === 0) continue;
    let back = at;
    while (back > 0) {
      const previous = classOf(points[back - 1] as number);
      if (previous === 0 || previous <= wanted) break;
      points[back] = points[back - 1] as number;
      back -= 1;
    }
    points[back] = current;
  }
}

function composePair(first: number, second: number): number | undefined {
  const lead = first - L_BASE;
  if (lead >= 0 && lead < L_COUNT) {
    const vowel = second - V_BASE;
    if (vowel >= 0 && vowel < V_COUNT) return S_BASE + (lead * V_COUNT + vowel) * T_COUNT;
  }
  const syllable = first - S_BASE;
  if (syllable >= 0 && syllable < S_COUNT && syllable % T_COUNT === 0) {
    const trail = second - T_BASE;
    if (trail > 0 && trail < T_COUNT) return first + trail;
  }
  return tables().composed.get(first)?.get(second);
}

function compose(points: number[]): number[] {
  if (points.length === 0) return points;
  const out = [points[0] as number];
  let starter = 0;
  let lastClass = classOf(out[0] as number) === 0 ? 0 : 256;
  for (let at = 1; at < points.length; at += 1) {
    const point = points[at] as number;
    const pointClass = classOf(point);
    const composite = composePair(out[starter] as number, point);
    if (composite !== undefined && (lastClass < pointClass || lastClass === 0)) {
      out[starter] = composite;
      continue;
    }
    if (pointClass === 0) starter = out.length;
    lastClass = pointClass;
    out.push(point);
  }
  return out;
}

export function nfkc(points: number[]): number[] {
  const decomposed = decompose(points);
  reorder(decomposed);
  return compose(decomposed);
}

export function nameprep(points: number[]): number[] {
  const { mapped, prohibited, randAl, leftToRight } = tables();
  const kept: number[] = [];
  for (const point of points) {
    const replacement = mapped.get(point);
    if (replacement === undefined) kept.push(point);
    else kept.push(...replacement);
  }
  const label = nfkc(kept);
  if (label.some((point) => within(prohibited, point))) throw new IdnaFailure("invalid character");
  const rightToLeft = label.map((point) => within(randAl, point));
  if (rightToLeft.some(Boolean)) {
    if (label.some((point) => within(leftToRight, point))) throw new IdnaFailure("bidi requirement 2");
    if (!rightToLeft[0] || !rightToLeft[rightToLeft.length - 1]) throw new IdnaFailure("bidi requirement 3");
  }
  return label;
}

function threshold(j: number, bias: number): number {
  return Math.min(26, Math.max(1, 36 * (j + 1) - bias));
}

function adapt(delta: number, first: boolean, count: number): number {
  let value = first ? Math.floor(delta / 700) : Math.floor(delta / 2);
  value += Math.floor(value / count);
  let divisions = 0;
  while (value > 455) {
    value = Math.floor(value / 35);
    divisions += 36;
  }
  return divisions + Math.floor((36 * value) / (value + 38));
}

export function punycodeEncode(points: number[]): string {
  const base = points.filter((point) => point < 128);
  const extended = [...new Set(points.filter((point) => point >= 128))].sort((a, b) => a - b);
  const deltas: number[] = [];
  let oldChar = 0x80;
  let oldIndex = -1;
  for (const char of extended) {
    let index = -1;
    const currentLength = points.filter((point) => point < char).length;
    let delta = (currentLength + 1) * (char - oldChar);
    for (const point of points) {
      if (point < char) index += 1;
      else if (point === char) {
        index += 1;
        delta += index - oldIndex;
        deltas.push(delta - 1);
        oldIndex = index;
        delta = 0;
      }
    }
    oldChar = char;
  }
  let encoded = "";
  let bias = 72;
  deltas.forEach((delta, count) => {
    let rest = delta;
    for (let j = 0; ; j += 1) {
      const t = threshold(j, bias);
      if (rest < t) {
        encoded += DIGITS[rest];
        break;
      }
      encoded += DIGITS[t + ((rest - t) % (36 - t))];
      rest = Math.floor((rest - t) / (36 - t));
    }
    bias = adapt(delta, count === 0, base.length + count + 1);
  });
  const head = String.fromCharCode(...base);
  return head ? `${head}-${encoded}` : encoded;
}

function adaptBig(delta: bigint, first: boolean, count: bigint): bigint {
  let value = first ? delta / 700n : delta / 2n;
  value += value / count;
  let divisions = 0n;
  while (value > 455n) {
    value /= 35n;
    divisions += 36n;
  }
  return divisions + (36n * value) / (value + 38n);
}

export function punycodeDecodes(text: string): boolean {
  const dash = text.lastIndexOf("-");
  const extended = (dash < 0 ? text : text.slice(dash + 1)).toUpperCase();
  let length = BigInt(dash < 0 ? 0 : dash);
  let char = 0x80n;
  let position = -1n;
  let bias = 72n;
  let at = 0;
  while (at < extended.length) {
    const first = at === 0;
    let result = 0n;
    let weight = 1n;
    for (let j = 0n; ; j += 1n) {
      if (at >= extended.length) return false;
      const code = extended.charCodeAt(at);
      at += 1;
      let digit: bigint;
      if (code >= 0x41 && code <= 0x5a) digit = BigInt(code - 0x41);
      else if (code >= 0x30 && code <= 0x39) digit = BigInt(code - 22);
      else return false;
      let t = 36n * (j + 1n) - bias;
      t = t < 1n ? 1n : t > 26n ? 26n : t;
      result += digit * weight;
      if (digit < t) break;
      weight *= 36n - t;
    }
    position += result + 1n;
    char += position / (length + 1n);
    if (char > BigInt(MAX_POINT)) return false;
    position %= length + 1n;
    length += 1n;
    bias = adaptBig(result, first, length);
  }
  return true;
}

function isAscii(points: number[]): boolean {
  return points.every((point) => point < 128);
}

export function textOf(points: number[]): string {
  let text = "";
  for (let at = 0; at < points.length; at += CHUNK) text += String.fromCodePoint(...points.slice(at, at + CHUNK));
  return text;
}

function asciiLabel(points: number[]): string {
  if (points.length > 0 && points.length <= MAX_LABEL) return String.fromCharCode(...points);
  throw new IdnaFailure("label empty or too long");
}

export function toAscii(label: number[]): string {
  if (isAscii(label)) return asciiLabel(label);
  const prepared = nameprep(label);
  if (isAscii(prepared)) return asciiLabel(prepared);
  if (textOf(prepared).toLowerCase().startsWith("xn--")) throw new IdnaFailure("label starts with ACE prefix");
  if (prepared.length > MAX_LABEL - ACE_PREFIX.length) throw new IdnaFailure("label too long");
  const encoded = `${ACE_PREFIX}${punycodeEncode(prepared)}`;
  if (encoded.length <= MAX_LABEL) return encoded;
  throw new IdnaFailure("label too long");
}

export function encodeIdna(text: string): string {
  if (text === "") return "";
  const points = pointsOf(text);
  if (isAscii(points)) {
    const labels = text.split(".");
    if (labels.slice(0, -1).some((label) => label.length === 0)) throw new IdnaFailure("label empty");
    if (labels.some((label) => label.length > MAX_LABEL)) throw new IdnaFailure("label too long");
    return text;
  }
  const labels = text.split(LABEL_DOTS);
  let trailing = "";
  if (labels.length > 0 && labels[labels.length - 1] === "") {
    trailing = ".";
    labels.pop();
  }
  return labels.map((label) => toAscii(pointsOf(label))).join(".") + trailing;
}
