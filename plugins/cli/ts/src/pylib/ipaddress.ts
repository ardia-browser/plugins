import { pyLen } from "./str.ts";

const HEXTET_COUNT = 8;

function isAsciiDigits(text: string): boolean {
  if (text === "") return false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x30 || code > 0x39) return false;
  }
  return true;
}

function octetOk(octet: string): boolean {
  if (!isAsciiDigits(octet) || octet.length > 3) return false;
  if (octet !== "0" && octet[0] === "0") return false;
  return Number(octet) <= 255;
}

function ipv4Ok(text: string): boolean {
  if (text === "") return false;
  const octets = text.split(".");
  return octets.length === 4 && octets.every(octetOk);
}

export function isIPv4Address(text: string): boolean {
  return !text.includes("/") && ipv4Ok(text);
}

function hextetOk(hextet: string): boolean {
  if (hextet === "" || hextet.length > 4) return false;
  for (let index = 0; index < hextet.length; index += 1) {
    const code = hextet.charCodeAt(index);
    const hex = (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
    if (!hex) return false;
  }
  return true;
}

function splitMax(text: string, separator: string, maxsplit: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (parts.length < maxsplit) {
    const at = rest.indexOf(separator);
    if (at < 0) break;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at + separator.length);
  }
  parts.push(rest);
  return parts;
}

function ipv6Ok(text: string): boolean {
  if (text === "" || pyLen(text) > 45) return false;
  const maxParts = HEXTET_COUNT + 1;
  const parts = splitMax(text, ":", maxParts);
  if (parts.length < 3) return false;
  if ((parts.at(-1) as string).includes(".")) {
    const last = parts.pop() as string;
    if (!ipv4Ok(last)) return false;
    parts.push("0", "0");
  }
  if (parts.length > maxParts) return false;
  let skip: number | undefined;
  for (let index = 1; index < parts.length - 1; index += 1) {
    if (!parts[index]) {
      if (skip !== undefined) return false;
      skip = index;
    }
  }
  let high: number;
  let low: number;
  if (skip !== undefined) {
    high = skip;
    low = parts.length - skip - 1;
    if (!parts[0]) {
      high -= 1;
      if (high) return false;
    }
    if (!parts.at(-1)) {
      low -= 1;
      if (low) return false;
    }
    if (HEXTET_COUNT - (high + low) < 1) return false;
  } else {
    if (parts.length !== HEXTET_COUNT || !parts[0] || !parts.at(-1)) return false;
    high = parts.length;
    low = 0;
  }
  for (let index = 0; index < high; index += 1) if (!hextetOk(parts[index] as string)) return false;
  for (let index = parts.length - low; index < parts.length; index += 1) if (!hextetOk(parts[index] as string)) return false;
  return true;
}

export function isIPv6Address(text: string): boolean {
  if (text.includes("/")) return false;
  const percent = text.indexOf("%");
  if (percent < 0) return ipv6Ok(text);
  const scope = text.slice(percent + 1);
  if (scope === "" || scope.includes("%")) return false;
  return ipv6Ok(text.slice(0, percent));
}
