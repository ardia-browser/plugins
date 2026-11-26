import { CREDENTIAL_LIMITS } from "./constants";
import { isRecord, utf8Length } from "./data";
import type { CredentialVerb, LaunchOutcome } from "./types";

export type VerbOutcome = {
  status: number;
  launched: boolean;
  timedOut: boolean;
  cancelled: boolean;
  overflowed: boolean;
  succeeded: boolean;
  stderr: string;
  hints: string[];
  json: unknown;
  lines: string[];
  items: number;
  droppedLines: number;
  lastLine: string | null;
};

const ESCAPE_CODES = /\x1B\[[0-9;?]*[A-Za-z]/g;
const LOG_PREFIX = /^\[[A-Za-z]+\]\s+\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}\s+/;
const MOST_JSON_STARTS = 64;
const NOISE_SCAN_BYTES = 64 << 10;
const HIDDEN = "[hidden]";

export function cleanStderr(text: string): string {
  const cleaned = text
    .replace(ESCAPE_CODES, "")
    .split("\n")
    .map((line) => line.replace(LOG_PREFIX, ""))
    .join("\n");
  return cleaned.length > CREDENTIAL_LIMITS.stderrBytes ? cleaned.slice(0, CREDENTIAL_LIMITS.stderrBytes) : cleaned;
}

export function tolerantJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {}
  const closing = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (closing < 0) return undefined;
  let tried = 0;
  for (let start = 0; start < Math.min(closing, NOISE_SCAN_BYTES); start++) {
    if (text[start] !== "{" && text[start] !== "[") continue;
    try {
      return JSON.parse(text.slice(start, closing + 1));
    } catch {}
    if (++tried >= MOST_JSON_STARTS) break;
  }
  return undefined;
}

export function redactText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join(HIDDEN);
  return out;
}

export function redactJson(value: unknown, secrets: readonly string[]): unknown {
  if (!secrets.length) return value;
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => redactJson(entry, secrets));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactJson(entry, secrets)]));
  return value;
}

export const redactable = (values: readonly string[], least: number) => [...new Set(values.filter((value) => value.length >= least))].sort((a, b) => b.length - a.length);

export function matchedHints(verb: CredentialVerb, stderr: string): string[] {
  const lowered = stderr.toLowerCase();
  return Object.entries(verb.hints)
    .filter(([, needles]) => needles.some((needle) => lowered.includes(needle.toLowerCase())))
    .map(([hint]) => hint);
}

export function itemsOf(verb: CredentialVerb, parsed: unknown): unknown[] | null {
  const key = verb.output.items;
  if (key === undefined) return null;
  if (key === "$") return Array.isArray(parsed) ? parsed : null;
  return isRecord(parsed) && Array.isArray(parsed[key]) ? (parsed[key] as unknown[]) : null;
}

function jsonOutput(verb: CredentialVerb, stdout: string, secrets: readonly string[]) {
  const parsed = stdout.trim() ? tolerantJson(stdout) : undefined;
  const json = parsed === undefined ? null : redactJson(parsed, secrets);
  const items = itemsOf(verb, json);
  const overflowed = items?.some((element) => utf8Length(JSON.stringify(element) ?? "") > CREDENTIAL_LIMITS.outputItemBytes) ?? false;
  return overflowed ? { overflowed, json: null, items: 0 } : { overflowed, json, items: items?.length ?? 0 };
}

export function verbOutcome(verb: CredentialVerb, outcome: LaunchOutcome, consumed: readonly string[], jsonStrings: readonly string[]): VerbOutcome {
  const { launched, cancelled } = outcome;
  const timedOut = !cancelled && outcome.timedOut;
  const status = !launched || cancelled || timedOut ? -1 : outcome.status;
  const rawStderr = cancelled ? "" : outcome.stderr;
  const stdout = cancelled || timedOut ? "" : outcome.stdout;
  const secrets = redactable(consumed, 3);
  let overflowed = outcome.overflowed || utf8Length(stdout) > verb.outputLimitBytes;
  let json: unknown = null;
  let lines: string[] = [];
  let droppedLines = 0;
  let items = 0;
  let lastLine: string | null = null;
  if (!overflowed && launched && !cancelled) {
    const mode = verb.output.mode;
    if (mode === "json") ({ overflowed, json, items } = jsonOutput(verb, stdout, secrets));
    else if (mode === "lines" || mode === "stream") {
      const rawLines = stdout === "" ? [] : (stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout).split("\n");
      lines = rawLines.map((line) => redactText(line.replace(/\r$/, ""), secrets));
      if (lines.length > CREDENTIAL_LIMITS.retainedLines) {
        droppedLines = lines.length - CREDENTIAL_LIMITS.retainedLines;
        lines = lines.slice(droppedLines);
      }
    } else {
      const last = stdout.split("\n").map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
      lastLine = /^\S{16,4096}$/.test(last) ? last : null;
    }
  }
  const succeeded = launched && !cancelled && !timedOut && !overflowed && status === 0;
  const stderr = redactText(cleanStderr(rawStderr), redactable([...consumed, ...jsonStrings.filter((text) => text.length >= 6)], 3));
  const hints = matchedHints(verb, rawStderr);
  return { status, launched, timedOut, cancelled, overflowed, succeeded, stderr, hints, json, lines, items, droppedLines, lastLine };
}
