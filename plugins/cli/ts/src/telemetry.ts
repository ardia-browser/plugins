import { closeSync, fstatSync, openSync } from "node:fs";
import { iso, now, parseIso } from "./clock.ts";
import { dataRoot, installedDataDir } from "./control.ts";
import { Float, type JsonObject, object, parse, TELEMETRY_JSON_DEPTH, TooDeep, type Value } from "./json.ts";
import { abspath, envSet, join, realpath, uid } from "./paths.ts";
import { O_NOFOLLOW, O_NONBLOCK, O_RDONLY, readFd } from "./privatefs.ts";
import { isSpace, strip } from "./py.ts";
import { appendToSpool, discardSpool, keepLocalCopy, startFlush } from "./spool.ts";
import { recordUsage } from "./usage.ts";
import { exceptionProperties } from "./crash.ts";
import { cliVersion, isDevBuild } from "./version.ts";

export const SERVED_BY = "ts";
export const LOGS_URL = "https://ardia.dev/otel/v1/logs";
const CONSENT_FILE = "telemetry.json";
const MAX_CONSENT_BYTES = 64 * 1024;
const LOCAL_ONLY_ID = "local";
const INSTALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\n?$/;
const MAX_FLAGS = 20;
const MAX_MS = 3_600_000;
const TEST_ENDPOINT_FLAGS = ["--port", "--ws", "--cdp"];
const TEST_ENDPOINT_ENV = ["ARDIA_WS", "ARDIA_PORT", "ARDIA_CDP_URL", "AGENT_BROWSER_CDP"];
const OFF_VALUES = ["0", "false", "off", "no"];

export class Call {
  readonly startedMs = performance.now();
  readonly startedAt = now();
  command = "none";
  subcommand: string | undefined;
  allowedFlags: readonly string[] = [];
  errorCode: string | undefined;
  readonly metrics = new Map<string, Value>();
  task = false;

  constructor(readonly argv: string[]) {}

  noteErrorCode(code: string | undefined): void {
    if (code !== undefined && code !== "") this.errorCode = code;
  }
}

export type Target = { root: string; url: string; environment: string };

function lowered(name: string): string {
  return strip(process.env[name] ?? "", isSpace).toLowerCase();
}

export function optedOut(): boolean {
  if (!["", "0", "false"].includes(lowered("DO_NOT_TRACK"))) return true;
  return OFF_VALUES.includes(lowered("ARDIA_TELEMETRY"));
}

export function loopbackUrl(text: string): boolean {
  const line = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (!line.startsWith("http://")) return false;
  const rest = line.slice("http://".length);
  const host = ["127.0.0.1:", "localhost:", "[::1]:"].find((prefix) => rest.startsWith(prefix));
  if (host === undefined) return false;
  const port = rest.slice(host.length);
  const digits = /^[0-9]*/.exec(port)?.[0].length ?? 0;
  if (digits < 1 || digits > 5 || port[digits] !== "/") return false;
  const path = Buffer.from(port.slice(digits + 1), "utf8");
  return path.length <= 200 && path.every((byte) => byte >= 0x21 && byte <= 0x7e);
}

function logsUrl(): string | undefined {
  const url = envSet("ARDIA_TELEMETRY_URL");
  if (url !== undefined) return loopbackUrl(url) ? url : undefined;
  return isDevBuild() ? undefined : LOGS_URL;
}

export function environmentFor(root: string): string {
  if (isDevBuild()) return "dev";
  return realpath(installedDataDir()) === realpath(root) ? "production" : "test";
}

export function leadingTokens(argv: string[]): string[] {
  const end = argv.indexOf("--");
  return end < 0 ? argv : argv.slice(0, end);
}

export function dataDirArg(tokens: string[]): string | undefined {
  let found: string | undefined;
  tokens.forEach((token, index) => {
    if (token === "--data-dir" && index + 1 < tokens.length) found = tokens[index + 1];
    else if (token.startsWith("--data-dir=")) found = token.slice("--data-dir=".length);
  });
  return found === "" ? undefined : found;
}

function namesTestEndpoint(tokens: string[]): boolean {
  return tokens.some((token) => token.startsWith("--") && TEST_ENDPOINT_FLAGS.includes(token.split("=")[0] ?? ""));
}

export function cliTarget(argv: string[]): Target | undefined {
  const tokens = leadingTokens(argv);
  if (namesTestEndpoint(tokens) || optedOut() || TEST_ENDPOINT_ENV.some((name) => envSet(name) !== undefined)) return undefined;
  const url = logsUrl();
  if (url === undefined) return undefined;
  const root = abspath(dataRoot(dataDirArg(tokens)));
  return { root, url, environment: environmentFor(root) };
}

export function readConsent(root: string): JsonObject | undefined {
  let fd: number;
  try {
    fd = openSync(join(root, CONSENT_FILE), O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== uid() || info.size > MAX_CONSENT_BYTES) return undefined;
    const doc = parse(readFd(fd, MAX_CONSENT_BYTES + 1), TELEMETRY_JSON_DEPTH);
    return doc instanceof Map ? doc : undefined;
  } catch (error) {
    if (error instanceof TooDeep) throw error;
    return undefined;
  } finally {
    closeSync(fd);
  }
}

const MS_EPOCH_FLOOR = 100_000_000_000n;

function bigintSeconds(value: bigint): number {
  if (value <= MS_EPOCH_FLOOR) return Number(value);
  const scaled = Number(value) / 1000;
  return Number.isFinite(scaled) ? scaled : Number(value / 1000n);
}

function epochSeconds(value: Value | undefined): number | undefined {
  const scaled = (seconds: number) => (seconds > 1e11 ? seconds / 1000 : seconds);
  if (typeof value === "bigint") return bigintSeconds(value);
  if (value instanceof Float) return scaled(value.value);
  if (typeof value === "string") {
    const parsed = parseIso(value);
    return typeof parsed === "object" ? parsed.at : undefined;
  }
  return undefined;
}

function validId(value: Value | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.toLowerCase();
  return INSTALL_ID.test(text) ? text : undefined;
}

function unreadableExpiry(doc: JsonObject): boolean {
  const until = doc.get("sharingUntil");
  return doc.get("sharing") === true && typeof until === "string" && typeof parseIso(until) !== "object";
}

export function consentUnreadable(argv: string[]): boolean {
  const target = cliTarget(argv);
  try {
    const doc = target === undefined ? undefined : readConsent(target.root);
    return doc !== undefined && unreadableExpiry(doc);
  } catch (error) {
    if (error instanceof TooDeep) return false;
    throw error;
  }
}

export function sharingId(doc: JsonObject | undefined): string | undefined {
  if (doc === undefined || doc.get("sharing") !== true) return undefined;
  const until = doc.get("sharingUntil");
  if (until !== undefined && until !== null) {
    const seconds = epochSeconds(until);
    if (seconds === undefined || !Number.isFinite(seconds) || seconds <= now()) return undefined;
  }
  return validId(doc.get("installId"));
}

export function consentedInstall(root: string): string | undefined {
  if (optedOut()) return undefined;
  return sharingId(readConsent(root));
}

export function uuid7(): string {
  const ms = BigInt(Math.trunc(now() * 1000)) & ((1n << 48n) - 1n);
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const rand = bytes.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
  const value = (ms << 80n) | (0x7n << 76n) | (((rand >> 62n) & 0xfffn) << 64n) | (0b10n << 62n) | (rand & ((1n << 62n) - 1n));
  const text = value.toString(16).padStart(32, "0");
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

export function sessionId(doc: JsonObject | undefined): string {
  return (doc?.get("sessionOpen") === true ? validId(doc.get("sessionId")) : undefined) ?? uuid7();
}

function watchReport(doc: JsonObject): string | undefined {
  const report = doc.get("watchReport");
  if (typeof report !== "string" || !report.startsWith("FB-")) return undefined;
  return /^[A-Z0-9]{2,16}$/.test(report.slice(3)) ? report : undefined;
}

function flagNames(argv: string[], allowed: readonly string[]): string {
  const names = leadingTokens(argv)
    .filter((token) => token.startsWith("-"))
    .map((token) => token.split("=")[0] ?? "")
    .filter((name) => allowed.includes(name));
  return [...new Set(names)].sort().slice(0, MAX_FLAGS).join(",");
}

function roundTiesEven(value: number): number {
  const rounded = Math.round(value);
  return Math.abs(value % 1) === 0.5 ? 2 * Math.round(value / 2) : rounded;
}

function wholeMs(value: number): bigint {
  return BigInt(Math.min(MAX_MS, Math.max(0, roundTiesEven(value))));
}

function timings(call: Call, into: [string, Value][]): void {
  const elapsed = performance.now() - call.startedMs;
  const startup = (call.startedAt - performance.timeOrigin / 1000) * 1000;
  for (const [key, value] of call.metrics) if (key !== "startup_ms" && key !== "total_ms") into.push([key, value]);
  if (startup >= 0 && startup <= MAX_MS) {
    into.push(["startup_ms", wholeMs(startup)], ["total_ms", wholeMs(startup + elapsed)]);
  } else into.push(["total_ms", wholeMs(elapsed)]);
}

function errorCodeOk(code: string): boolean {
  return code.length <= 41 && /^[a-z][a-z0-9_]*$/.test(code);
}

function commonProperties(into: [string, Value][], doc: JsonObject | undefined, session: string): void {
  into.push(["$session_id", session]);
  const report = doc !== undefined && sharingId(doc) !== undefined ? watchReport(doc) : undefined;
  if (report !== undefined) into.push(["watch_report", report]);
}

function event(name: string, distinctId: string, properties: [string, Value][]): JsonObject {
  return object([
    ["uuid", uuid7()],
    ["event", name],
    ["distinct_id", distinctId],
    ["timestamp", iso(now())],
    ["properties", object(properties)],
  ]);
}

function commandRecord(call: Call, status: number, crashed: boolean, distinctId: string, environment: string): [string, Value][] {
  const given = crashed ? "unhandled_exception" : call.errorCode;
  const code = given !== undefined && errorCodeOk(given) ? given : null;
  const properties: [string, Value][] = [
    ["command", call.command],
    ["subcommand", call.subcommand ?? null],
    ["exit_code", BigInt(status)],
    ["error_code", code],
    ["flags", flagNames(call.argv, call.allowedFlags)],
  ];
  timings(call, properties);
  properties.push(["cli_version", cliVersion()], ["$environment", environment], ["served_by", SERVED_BY]);
  return properties;
}

export function finish(call: Call, status: number, python: string | null, crash?: number): void {
  recordUsage(call, status);
  try {
    record(call, status, python, crash);
  } catch (error) {
    if (!(error instanceof TooDeep)) throw error;
  }
}

function record(call: Call, status: number, python: string | null, crash: number | undefined): void {
  const target = cliTarget(call.argv);
  if (target === undefined) return;
  const doc = readConsent(target.root);
  const installId = optedOut() ? undefined : sharingId(doc);
  const distinctId = installId ?? LOCAL_ONLY_ID;
  const session = sessionId(doc);
  const shaped: [string, [string, Value][]][] = [];
  if (crash !== undefined) shaped.push(["$exception", exceptionProperties(crash, target.environment)]);
  shaped.push(["cli_command", commandRecord(call, status, crash !== undefined, distinctId, target.environment)]);
  const records = shaped.map(([name, properties]) => {
    commonProperties(properties, doc, session);
    return event(name, distinctId, properties);
  });
  keepLocalCopy(target.root, records, installId !== undefined);
  if (installId === undefined) {
    discardSpool(target.root);
    return;
  }
  const spooled = appendToSpool(target.root, records);
  if (spooled !== undefined) startFlush(spooled, target);
}
