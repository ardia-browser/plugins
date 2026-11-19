import { hypot } from "../../pylib/math.ts";
import { type Random, rng } from "../../pylib/random.ts";

export const BUTTON_MASK: Readonly<Record<string, number>> = { left: 1, right: 2, middle: 4, back: 8, forward: 16 };
export const PRESSED_FORCE = 0.5;
export const PAUSE_CHARS = new Set([" ", ".", ",", "!", "?", ";", ":", "\n"]);
const SHIFTED_DIGITS = ")!@#$%^&*(";
const PUNCTUATION: Readonly<Record<string, readonly [string, number]>> = {
  " ": ["Space", 32], "-": ["Minus", 189], "=": ["Equal", 187], "[": ["BracketLeft", 219], "]": ["BracketRight", 221], "\\": ["Backslash", 220],
  ";": ["Semicolon", 186], "'": ["Quote", 222], "`": ["Backquote", 192], ",": ["Comma", 188], ".": ["Period", 190], "/": ["Slash", 191],
  _: ["Minus", 189], "+": ["Equal", 187], "{": ["BracketLeft", 219], "}": ["BracketRight", 221], "|": ["Backslash", 220], ":": ["Semicolon", 186],
  '"': ["Quote", 222], "~": ["Backquote", 192], "<": ["Comma", 188], ">": ["Period", 190], "?": ["Slash", 191],
};

export type KeyInfo = readonly [string, string, number];

export const CHAR_TO_KEY_INFO: ReadonlyMap<string, KeyInfo> = (() => {
  const table = new Map<string, KeyInfo>();
  for (const letter of "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ") table.set(letter, [letter, `Key${letter.toUpperCase()}`, letter.toUpperCase().charCodeAt(0)]);
  for (let digit = 0; digit < 10; digit += 1) table.set(String(digit), [String(digit), `Digit${digit}`, 48 + digit]);
  for (let digit = 0; digit < SHIFTED_DIGITS.length; digit += 1) {
    const symbol = SHIFTED_DIGITS[digit] as string;
    table.set(symbol, [symbol, `Digit${digit}`, 48 + digit]);
  }
  for (const [symbol, [code, keycode]] of Object.entries(PUNCTUATION)) table.set(symbol, [symbol, code, keycode]);
  table.set("\n", ["Enter", "Enter", 13]);
  table.set("\t", ["Tab", "Tab", 9]);
  return table;
})();

export const TYPING = {
  keyHoldMin: 0.06, keyHoldMax: 0.14, keystrokeMin: 0.03, keystrokeMax: 0.12, punctuationMin: 0.08, punctuationMax: 0.18, thinkingProbability: 0.02,
  thinkingMin: 0.3, thinkingMax: 0.7, distractionProbability: 0.005, distractionMin: 0.5, distractionMax: 1.2,
} as const;

export const MOUSE = {
  fittsA: 0.07, fittsB: 0.15, frameInterval: 0.012, frameIntervalVariance: 0.004, curvatureMin: 0.1, curvatureMax: 0.3, curvatureAsymmetry: 0.6,
  shortDistanceThreshold: 50.0, tremorAmplitude: 1.0, overshootProbability: 0.7, overshootDistanceMin: 0.03, overshootDistanceMax: 0.12,
  overshootSpeedThreshold: 200.0, preClickPauseMin: 0.05, preClickPauseMax: 0.2, clickHoldMin: 0.05, clickHoldMax: 0.15, doubleClickIntervalMin: 0.05,
  doubleClickIntervalMax: 0.1, dragStartPauseMin: 0.08, dragStartPauseMax: 0.2, dragEndPauseMin: 0.05, dragEndPauseMax: 0.15, microPauseProbability: 0.03,
  microPauseMin: 0.015, microPauseMax: 0.04, minDuration: 0.08, maxDuration: 2.5,
} as const;

export const SCROLL = {
  minDuration: 0.5, maxDuration: 1.5, bezierPoints: [0.645, 0.045, 0.355, 1.0] as const, frameInterval: 0.012, deltaJitter: 3, microPauseProbability: 0.05,
  microPauseMin: 0.02, microPauseMax: 0.05, overshootProbability: 0.15, overshootFactorMin: 1.02, overshootFactorMax: 1.08,
} as const;

export class CubicBezier {
  readonly cx: number;
  readonly bx: number;
  readonly ax: number;
  readonly cy: number;
  readonly by: number;
  readonly ay: number;

  constructor(x1: number, y1: number, x2: number, y2: number) {
    this.cx = 3.0 * x1;
    this.bx = 3.0 * (x2 - x1) - this.cx;
    this.ax = 1.0 - this.cx - this.bx;
    this.cy = 3.0 * y1;
    this.by = 3.0 * (y2 - y1) - this.cy;
    this.ay = 1.0 - this.cy - this.by;
  }

  xAt(t: number): number {
    return ((this.ax * t + this.bx) * t + this.cx) * t;
  }

  yAt(t: number): number {
    return ((this.ay * t + this.by) * t + this.cy) * t;
  }

  slopeX(t: number): number {
    return (3.0 * this.ax * t + 2.0 * this.bx) * t + this.cx;
  }

  tFor(x: number, epsilon = 1e-6): number {
    let t = x;
    for (let round = 0; round < 8; round += 1) {
      const error = this.xAt(t) - x;
      if (Math.abs(error) < epsilon) return t;
      const slope = this.slopeX(t);
      if (Math.abs(slope) < epsilon) break;
      t -= error / slope;
    }
    let low = 0.0;
    let high = 1.0;
    t = x;
    if (t < low) return low;
    if (t > high) return high;
    while (low < high) {
      const current = this.xAt(t);
      if (Math.abs(current - x) < epsilon) return t;
      if (x > current) low = t;
      else high = t;
      t = (high - low) * 0.5 + low;
    }
    return t;
  }

  solve(x: number): number {
    return this.yAt(this.tFor(x));
  }
}

export type Point = readonly [number, number];

export function minimumJerk(t: number): number {
  const t3 = t * t * t;
  return 10.0 * t3 - 15.0 * t3 * t + 6.0 * t3 * t * t;
}

export function bezierPoint(t: number, p0: Point, p1: Point, p2: Point, p3: Point): [number, number] {
  const u = 1.0 - t;
  const a = u * u * u;
  const b = 3.0 * u * u * t;
  const c = 3.0 * u * t * t;
  const d = t * t * t;
  return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
}

export function fittsDuration(distance: number, width: number, a: number, b: number): number {
  return distance <= 0 ? a : a + b * Math.log2(distance / width + 1.0);
}

export function controlPoints(start: Point, end: Point, random: Random = rng()): [Point, Point] {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const distance = hypot(dx, dy);
  if (distance < 1.0) return [start, end];
  const perpendicular = [-dy / distance, dx / distance] as const;
  const scale = Math.min(1.0, distance / MOUSE.shortDistanceThreshold);
  const first = random.uniform(MOUSE.curvatureMin, MOUSE.curvatureMax) * distance * scale;
  const second = random.uniform(MOUSE.curvatureMin, MOUSE.curvatureMax) * distance * scale;
  const sign = random.choice([-1.0, 1.0]);
  const t1 = random.uniform(0.2, MOUSE.curvatureAsymmetry);
  const t2 = random.uniform(MOUSE.curvatureAsymmetry, 0.8);
  const near: Point = [start[0] + dx * t1 + perpendicular[0] * first * sign, start[1] + dy * t1 + perpendicular[1] * first * sign];
  const counter = random.uniform(0.3, 1.0);
  const far: Point = [start[0] + dx * t2 + perpendicular[0] * second * sign * counter, start[1] + dy * t2 + perpendicular[1] * second * sign * counter];
  return [near, far];
}

export function moveDuration(distance: number): number {
  return Math.max(MOUSE.minDuration, Math.min(fittsDuration(distance, 20.0, MOUSE.fittsA, MOUSE.fittsB), MOUSE.maxDuration));
}

export function tremorSigma(x: number, y: number, now: number, previous: readonly [number, number, number]): number {
  const elapsed = now - previous[2];
  const speed = elapsed > 0 ? Math.max(0.2, 1.0 - hypot(x - previous[0], y - previous[1]) / elapsed / 500.0) : 1.0;
  return MOUSE.tremorAmplitude * speed;
}

export function pauseAfter(char: string, random: Random = rng()): number {
  let delay = random.uniform(TYPING.keystrokeMin, TYPING.keystrokeMax);
  if (PAUSE_CHARS.has(char)) delay += random.uniform(TYPING.punctuationMin, TYPING.punctuationMax);
  if (random.random() < TYPING.thinkingProbability) delay += random.uniform(TYPING.thinkingMin, TYPING.thinkingMax);
  if (random.random() < TYPING.distractionProbability) delay += random.uniform(TYPING.distractionMin, TYPING.distractionMax);
  return delay;
}

export type KeyCommand = { method: "Input.dispatchKeyEvent"; params: Record<string, string | number> };

export function keyEvents(char: string): [KeyCommand, KeyCommand] {
  const [key, code, keycode] = CHAR_TO_KEY_INFO.get(char) ?? [char, "", 0];
  const down = { type: "keyDown", text: char, unmodifiedText: char, code, key, windowsVirtualKeyCode: keycode, nativeVirtualKeyCode: keycode };
  const up = { type: "keyUp", code, key, windowsVirtualKeyCode: keycode, nativeVirtualKeyCode: keycode };
  return [{ method: "Input.dispatchKeyEvent", params: down }, { method: "Input.dispatchKeyEvent", params: up }];
}

export function roundCoordinate(value: number): number {
  const floor = Math.floor(value);
  const difference = value - floor;
  if (difference < 0.5) return floor;
  if (difference > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}
