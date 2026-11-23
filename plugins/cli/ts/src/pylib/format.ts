import { fixed } from "../py.ts";

function exactDigits(value: number): { digits: string; point: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  const mantissa = exponentBits === 0 ? fraction : fraction | (1n << 52n);
  const exponent = (exponentBits === 0 ? 1 : exponentBits) - 1075;
  if (exponent >= 0) {
    const digits = (mantissa << BigInt(exponent)).toString();
    return { digits, point: digits.length };
  }
  const scaled = (mantissa * 5n ** BigInt(-exponent)).toString();
  return { digits: scaled, point: scaled.length + exponent };
}

function roundedDigits(value: number, precision: number): { digits: string; exponent: number } {
  const { digits, point } = exactDigits(value);
  const start = digits.search(/[1-9]/);
  const significant = digits.slice(start);
  let exponent = point - start - 1;
  let kept = significant.slice(0, precision).padEnd(precision, "0");
  const rest = significant.slice(precision);
  const first = rest.charCodeAt(0) - 48;
  const beyond = /[1-9]/.test(rest.slice(1));
  const odd = (kept.charCodeAt(precision - 1) - 48) % 2 === 1;
  if (rest !== "" && (first > 5 || (first === 5 && (beyond || odd)))) {
    const bumped = (BigInt(kept) + 1n).toString();
    if (bumped.length > precision) {
      exponent += 1;
      kept = bumped.slice(0, precision);
    } else kept = bumped;
  }
  return { digits: kept, exponent };
}

function trimZeros(text: string): string {
  if (!text.includes(".")) return text;
  let end = text.length;
  while (text[end - 1] === "0") end -= 1;
  if (text[end - 1] === ".") end -= 1;
  return text.slice(0, end);
}

export function formatG(value: number, precision = 6): string {
  if (Number.isNaN(value)) return "nan";
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
  const sign = value < 0 || Object.is(value, -0) ? "-" : "";
  if (value === 0) return `${sign}0`;
  const wanted = precision === 0 ? 1 : precision;
  const { digits, exponent } = roundedDigits(Math.abs(value), wanted);
  if (exponent < -4 || exponent >= wanted) {
    const mantissa = trimZeros(digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits);
    return `${sign}${mantissa}e${exponent < 0 ? "-" : "+"}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  if (exponent < 0) return `${sign}${trimZeros(`0.${"0".repeat(-exponent - 1)}${digits}`)}`;
  const whole = digits.slice(0, exponent + 1);
  const rest = digits.slice(exponent + 1);
  return `${sign}${trimZeros(rest === "" ? whole : `${whole}.${rest}`)}`;
}

export function roundHalfEven(value: number): number {
  if (!Number.isFinite(value)) return value;
  const floor = Math.floor(value);
  const difference = value - floor;
  if (difference < 0.5) return floor;
  if (difference > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

export function roundTo(value: number, digits: number): number {
  if (!Number.isFinite(value) || value === 0) return value;
  const rounded = Number(fixed(value, digits));
  return rounded === 0 && (value < 0 || Object.is(value, -0)) ? -0 : rounded;
}

export function groupThousands(digits: string): string {
  const negative = digits.startsWith("-");
  const body = negative ? digits.slice(1) : digits;
  const point = body.indexOf(".");
  const whole = point < 0 ? body : body.slice(0, point);
  const tail = point < 0 ? "" : body.slice(point);
  let grouped = "";
  for (let index = 0; index < whole.length; index += 1) {
    if (index > 0 && (whole.length - index) % 3 === 0) grouped += ",";
    grouped += whole[index];
  }
  return (negative ? "-" : "") + grouped + tail;
}

export function zeroPad(value: bigint | number, width: number): string {
  const text = typeof value === "bigint" ? value.toString() : String(value);
  const negative = text.startsWith("-");
  const body = negative ? text.slice(1) : text;
  return (negative ? "-" : "") + body.padStart(width - (negative ? 1 : 0), "0");
}
