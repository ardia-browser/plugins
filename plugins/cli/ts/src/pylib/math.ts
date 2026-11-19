const SPLITTER = 134217729;
const DBL_MIN = 2.2250738585072014e-308;

function twoProduct(a: number, b: number): [number, number] {
  const product = a * b;
  const ca = SPLITTER * a;
  const aHigh = ca - (ca - a);
  const aLow = a - aHigh;
  const cb = SPLITTER * b;
  const bHigh = cb - (cb - b);
  const bLow = b - bHigh;
  const error = aLow * bLow - (((product - aHigh * bHigh) - aLow * bHigh) - aHigh * bLow);
  return [product, error];
}

function fastSum(a: number, b: number): [number, number] {
  const x = a + b;
  const z = x - a;
  return [x, b - z];
}

function exponentOf(value: number): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = (view.getUint32(0) >>> 20) & 0x7ff;
  if (bits !== 0) return bits - 1022;
  const high = view.getUint32(0) & 0xfffff;
  const low = view.getUint32(4);
  const leading = high !== 0 ? Math.clz32(high) - 12 : 20 + Math.clz32(low);
  return -1021 - leading;
}

function vectorNorm(values: number[], max: number, foundNan: boolean): number {
  if (!Number.isFinite(max) && !Number.isNaN(max)) return max;
  if (foundNan) return Number.NaN;
  if (max === 0 || values.length <= 1) return max;
  const exponent = exponentOf(max);
  if (exponent < -1023) return DBL_MIN * vectorNorm(values.map((value) => value / DBL_MIN), max / DBL_MIN, foundNan);
  const scale = 2 ** -exponent;
  let csum = 1.0;
  let frac1 = 0.0;
  let frac2 = 0.0;
  for (const value of values) {
    const x = value * scale;
    const [high, low] = twoProduct(x, x);
    const [sum, rest] = fastSum(csum, high);
    csum = sum;
    frac1 += low;
    frac2 += rest;
  }
  let h = Math.sqrt(csum - 1.0 + (frac1 + frac2));
  const [high, low] = twoProduct(-h, h);
  const [sum, rest] = fastSum(csum, high);
  csum = sum;
  frac1 += low;
  frac2 += rest;
  const x = csum - 1.0 + (frac1 + frac2);
  h += x / (2.0 * h);
  return h / scale;
}

export function hypot(...coordinates: number[]): number {
  let max = 0.0;
  let foundNan = false;
  const values = coordinates.map((coordinate) => {
    const x = Math.abs(coordinate);
    if (Number.isNaN(x)) foundNan = true;
    if (x > max) max = x;
    return x;
  });
  return vectorNorm(values, max, foundNan);
}
