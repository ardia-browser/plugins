import { isSpace, strip } from "../../py.ts";
import { formatG } from "../../pylib/format.ts";
import { DigitPattern } from "../../pylib/re.ts";
import { Usage } from "../daemon-errors.ts";

export const DEFAULT_TIMEOUT = 90.0;
export const MAX_TIMEOUT = 600.0;
const TIMEOUT = new DigitPattern("([0-9]+(?:\\.[0-9]+)?)(ms|s|m)?");
const UNITS: Readonly<Record<string, number>> = { ms: 0.001, s: 1, m: 60 };

export function parseTimeout(value: string | null | undefined): number {
  if (value === null || value === undefined) return DEFAULT_TIMEOUT;
  const match = TIMEOUT.fullmatch(strip(String(value), isSpace));
  if (match === undefined) throw new Usage(`--timeout takes 30s, 2m or milliseconds, not ${value}`);
  const seconds = Number(match.digits[0]) * (UNITS[match.groups[1] ?? "ms"] as number);
  if (seconds <= 0 || seconds > MAX_TIMEOUT) throw new Usage(`--timeout takes a time above 0 and up to ${formatG(MAX_TIMEOUT / 60)}m, not ${value}`);
  return seconds;
}
