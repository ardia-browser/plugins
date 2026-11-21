const HEXTETS = 8;
const MAX_IPV6_TEXT = 45;
const HEX = /^[0-9A-Fa-f]*$/;
const ASCII_DIGITS = /^[0-9]+$/;
const ASCII_ALNUM = /^[0-9A-Za-z]+$/;

export class NotAnAddress extends Error {}

function partOf(text: string): bigint | null {
  let digits: string;
  let prefix: string;
  if (text.startsWith("0x") || text.startsWith("0X")) [digits, prefix] = [text.slice(2), "0x"];
  else if (text.length > 1 && text.startsWith("0")) [digits, prefix] = [text.slice(1), "0o"];
  else [digits, prefix] = [text, ""];
  if (digits === "") return prefix === "" ? null : 0n;
  if (!ASCII_ALNUM.test(digits)) return null;
  if (prefix === "0x" && !HEX.test(digits)) return null;
  if (prefix === "0o" && !/^[0-7]+$/.test(digits)) return null;
  if (prefix === "" && !ASCII_DIGITS.test(digits)) return null;
  return BigInt(prefix + digits);
}

export function dotted(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 0xffn)).join(".");
}

export function ipv4(host: string): string | null {
  let parts = host.split(".");
  if (parts.length > 1 && parts[parts.length - 1] === "") parts = parts.slice(0, -1);
  const last = parts[parts.length - 1] as string;
  const hexLast = (last.startsWith("0x") || last.startsWith("0X")) && HEX.test(last.slice(2));
  if (!(ASCII_DIGITS.test(last) || hexLast)) return null;
  if (parts.length > 4) throw new NotAnAddress();
  const numbers = parts.map(partOf);
  if (numbers.some((number) => number === null)) throw new NotAnAddress();
  const values = numbers as bigint[];
  if (values.slice(0, -1).some((number) => number > 255n)) throw new NotAnAddress();
  const final = values[values.length - 1] as bigint;
  if (final >= 256n ** BigInt(5 - values.length)) throw new NotAnAddress();
  let value = final;
  values.slice(0, -1).forEach((number, index) => {
    value += number * 256n ** BigInt(3 - index);
  });
  return dotted(value);
}

function octet(text: string): bigint {
  if (!text || !ASCII_DIGITS.test(text) || text.length > 3 || (text !== "0" && text.startsWith("0"))) throw new NotAnAddress();
  const value = BigInt(text);
  if (value > 255n) throw new NotAnAddress();
  return value;
}

function strictIpv4(text: string): bigint {
  const octets = text.split(".");
  if (!text || octets.length !== 4) throw new NotAnAddress();
  return octets.reduce((value, part) => (value << 8n) | octet(part), 0n);
}

function hextet(text: string): bigint {
  if (!text || !HEX.test(text) || text.length > 4) throw new NotAnAddress();
  return BigInt(`0x${text}`);
}

function splitColons(text: string): string[] {
  const parts: string[] = [];
  let rest = text;
  while (parts.length < HEXTETS + 1) {
    const at = rest.indexOf(":");
    if (at < 0) break;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at + 1);
  }
  parts.push(rest);
  return parts;
}

export function ipv6Value(text: string): bigint {
  if (text.includes("/")) throw new NotAnAddress();
  const [address, percent, scope] = partition(text, "%");
  if (percent && (!scope || scope.includes("%"))) throw new NotAnAddress();
  if (!address || [...address].length > MAX_IPV6_TEXT) throw new NotAnAddress();
  const parts = splitColons(address);
  if (parts.length < 3) throw new NotAnAddress();
  if ((parts[parts.length - 1] as string).includes(".")) {
    const value = strictIpv4(parts.pop() as string);
    parts.push(((value >> 16n) & 0xffffn).toString(16), (value & 0xffffn).toString(16));
  }
  if (parts.length > HEXTETS + 1) throw new NotAnAddress();
  let skip: number | null = null;
  for (let index = 1; index < parts.length - 1; index += 1) {
    if (parts[index]) continue;
    if (skip !== null) throw new NotAnAddress();
    skip = index;
  }
  let high: number;
  let low: number;
  let skipped: number;
  if (skip !== null) {
    high = skip;
    low = parts.length - skip - 1;
    if (!parts[0] && --high) throw new NotAnAddress();
    if (!parts[parts.length - 1] && --low) throw new NotAnAddress();
    skipped = HEXTETS - (high + low);
    if (skipped < 1) throw new NotAnAddress();
  } else {
    if (parts.length !== HEXTETS || !parts[0] || !parts[parts.length - 1]) throw new NotAnAddress();
    [high, low, skipped] = [parts.length, 0, 0];
  }
  let value = 0n;
  for (let index = 0; index < high; index += 1) value = (value << 16n) | hextet(parts[index] as string);
  value <<= 16n * BigInt(skipped);
  for (let index = parts.length - low; index < parts.length; index += 1) value = (value << 16n) | hextet(parts[index] as string);
  return value;
}

function partition(text: string, separator: string): [string, string, string] {
  const at = text.indexOf(separator);
  return at < 0 ? [text, "", ""] : [text.slice(0, at), separator, text.slice(at + 1)];
}

function compressed(value: bigint): string {
  const hextets = Array.from({ length: HEXTETS }, (_, index) => ((value >> BigInt(16 * (HEXTETS - 1 - index))) & 0xffffn).toString(16));
  let bestStart = -1;
  let bestLength = 0;
  let start = -1;
  let length = 0;
  hextets.forEach((part, index) => {
    if (part !== "0") {
      [start, length] = [-1, 0];
      return;
    }
    length += 1;
    if (start === -1) start = index;
    if (length > bestLength) [bestStart, bestLength] = [start, length];
  });
  if (bestLength <= 1) return hextets.join(":");
  const end = bestStart + bestLength;
  const parts = [...hextets.slice(0, bestStart), "", ...hextets.slice(end)];
  if (end === HEXTETS) parts.push("");
  if (bestStart === 0) parts.unshift("");
  return parts.join(":");
}

export function ipv6Compressed(text: string): string {
  const [, percent, scope] = partition(text, "%");
  const value = ipv6Value(text);
  const shown = value >> 32n === 0xffffn ? `${compressed(0xffffn)}:${dotted(value & 0xffffffffn)}` : compressed(value);
  return percent && scope ? `${shown}%${scope}` : shown;
}
