import { now } from "./clock.ts";
import { dumps, Float, type JsonObject, object, parse, TELEMETRY_JSON_DEPTH, type Value } from "./json.ts";
import { logsRequest } from "./otlp.ts";
import { cleanEvent } from "./telemetry-schema.ts";
import { close, closeDir, type Dir, readPrivate, takeLock, takeLockRetrying, unlinkQuietly, writePrivate } from "./privatefs.ts";
import { truthy } from "./py.ts";
import { utf8 } from "./pystr.ts";
import { FLUSH_INTERVAL_S, FLUSH_STATE, MAX_EVENTS, newest, openFolder, readLines, SPOOL, SPOOL_LOCK, writeLines } from "./spool.ts";
import { consentedInstall, LOGS_URL, loopbackUrl } from "./telemetry.ts";

const INGEST_KEY_HEADER = "X-Ardia-Key";
const CLI_INGEST_KEY = "ak_cli_67adb8ebc49841125eda860e";
const FLUSH_LOCK = "cli-flush.lock";
const ACKED = "cli-flush-acked.json";
const MAX_ACKED_BYTES = 64 * 1024;
const BATCH_SIZE = 100;
const MAX_BODY_BYTES = 500_000;
const FIRST_BACKOFF_S = 30;
const MAX_BACKOFF_S = 30 * 60;
const SEND_TIMEOUT_MS = 5_000;
const SEND_BUDGET_S = 12;
export const FLUSH_DEADLINE_MS = 30_000;
const MAX_CONFIG_BYTES = 64 * 1024;
const CONFIG_TIMEOUT_MS = 5_000;
const MAX_STATE_BYTES = 64 * 1024;

export type FlushResult = "busy" | "off" | "done" | "failed" | "revoked";
export type Post = (url: string, body: Buffer) => Promise<number>;

export async function post(url: string, body: Buffer): Promise<number> {
  try {
    const response = await fetch(url, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/json", [INGEST_KEY_HEADER]: CLI_INGEST_KEY },
      redirect: "manual",
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => {});
    return response.status;
  } catch {
    return 0;
  }
}

function consent(root: string): string | undefined {
  return consentedInstall(root);
}

function validRecord(record: Value | undefined, installId: string): record is JsonObject {
  return (
    record instanceof Map &&
    record.get("distinct_id") === installId &&
    typeof record.get("uuid") === "string" &&
    typeof record.get("event") === "string" &&
    typeof record.get("timestamp") === "string" &&
    record.get("properties") instanceof Map
  );
}

function parseLines(lines: Buffer[], installId: string, dropped: Set<string>): JsonObject[] {
  const records: JsonObject[] = [];
  for (const line of lines) {
    const record = parse(line, TELEMETRY_JSON_DEPTH);
    if (!validRecord(record, installId) || dropped.has(record.get("uuid") as string)) continue;
    const clean = cleanEvent(record);
    if (clean === undefined) dropped.add(record.get("uuid") as string);
    else records.push(clean);
  }
  return records.slice(Math.max(0, records.length - MAX_EVENTS));
}

function keepLine(line: Buffer, installId: string, sent: Set<string>): boolean {
  const record = parse(line, TELEMETRY_JSON_DEPTH);
  return validRecord(record, installId) && !sent.has(record.get("uuid") as string);
}

function outcome(status: number, count: number): "sent" | "drop" | "split" | "retry" {
  if (status >= 200 && status < 300) return "sent";
  if (status === 400) return "drop";
  if (status === 413) return count > 1 ? "split" : "drop";
  return "retry";
}

export async function sendAll(
  pending: JsonObject[],
  url: string,
  environment: string,
  sent: Set<string>,
  stillConsented: () => boolean,
  send: Post = post,
): Promise<"done" | "failed" | "revoked"> {
  const started = performance.now();
  let size = BATCH_SIZE;
  let index = 0;
  while (index < pending.length) {
    const batch = pending.slice(index, index + size);
    const body = logsRequest(environment, batch);
    if (body.length > MAX_BODY_BYTES && batch.length > 1) {
      size = Math.floor((batch.length + 1) / 2);
      continue;
    }
    if ((performance.now() - started) / 1000 > SEND_BUDGET_S) return "failed";
    if (!stillConsented()) return "revoked";
    const result = outcome(await send(url, body), batch.length);
    if (result === "retry") return "failed";
    if (result === "split") {
      size = Math.floor((batch.length + 1) / 2);
      continue;
    }
    for (const record of batch) sent.add(record.get("uuid") as string);
    index += batch.length;
  }
  return "done";
}

function stateFailures(dir: Dir): bigint {
  let raw: Buffer | undefined;
  try {
    raw = readPrivate(FLUSH_STATE, dir, MAX_STATE_BYTES);
  } catch {
    return 0n;
  }
  const state = raw === undefined ? undefined : parse(raw, TELEMETRY_JSON_DEPTH);
  const failures = state instanceof Map ? state.get("failures") : undefined;
  if (typeof failures === "bigint") return failures;
  if (failures instanceof Float) {
    if (!Number.isFinite(failures.value)) throw new RangeError("cannot convert the failure count to an integer");
    return BigInt(Math.trunc(failures.value));
  }
  return 0n;
}

function backoff(failures: bigint): number {
  if (failures === 0n) return FLUSH_INTERVAL_S;
  if (failures - 1n > 6n) return MAX_BACKOFF_S;
  return Math.min(MAX_BACKOFF_S, FIRST_BACKOFF_S * 2 ** Number(failures - 1n));
}

function writeState(dir: Dir, failures: bigint, nextAt: number): void {
  writePrivate(FLUSH_STATE, dir, utf8(dumps(object([["failures", failures], ["next_at", new Float(nextAt)]]), "spaced")));
}

function forget(dir: Dir): void {
  unlinkQuietly(SPOOL, dir);
  unlinkQuietly(FLUSH_STATE, dir);
  unlinkQuietly(ACKED, dir);
}

function readAcked(dir: Dir): Set<string> {
  let raw: Buffer | undefined;
  try {
    raw = readPrivate(ACKED, dir, MAX_ACKED_BYTES);
  } catch {
    return new Set();
  }
  const parsed = raw === undefined ? undefined : parse(raw, 4);
  const uuids = parsed instanceof Map ? parsed.get("uuids") : undefined;
  return new Set(Array.isArray(uuids) ? uuids.filter((uuid): uuid is string => typeof uuid === "string") : []);
}

function writeAcked(dir: Dir, sent: Set<string>): void {
  try {
    writePrivate(ACKED, dir, utf8(dumps(object([["uuids", [...sent]]]), "compact")));
  } catch {}
}

export async function flush(root: string, url: string, environment: string, send: Post = post): Promise<FlushResult> {
  const dir = openFolder(root, false);
  try {
    const flusher = takeLock(FLUSH_LOCK, dir);
    if (flusher === undefined) return "busy";
    try {
      const installId = consent(root);
      let lock = takeLockRetrying(SPOOL_LOCK, dir);
      if (lock === undefined) return "busy";
      let pending: JsonObject[];
      const sent = readAcked(dir);
      try {
        if (installId === undefined) {
          forget(dir);
          return "off";
        }
        pending = parseLines(readLines(dir), installId, sent);
      } finally {
        close(lock);
      }
      const result = await sendAll(pending, url, environment, sent, () => consent(root) === installId, send);
      if (sent.size > 0) writeAcked(dir, sent);
      const current = consent(root);
      lock = takeLockRetrying(SPOOL_LOCK, dir);
      if (lock === undefined) return result;
      try {
        if (current === undefined) {
          forget(dir);
          return "off";
        }
        writeLines(dir, newest(readLines(dir).filter((line) => keepLine(line, current, sent))));
        unlinkQuietly(ACKED, dir);
      } finally {
        close(lock);
      }
      const failures = result === "failed" ? stateFailures(dir) + 1n : 0n;
      writeState(dir, failures, now() + backoff(failures));
      return result;
    } finally {
      close(flusher);
    }
  } finally {
    closeDir(dir);
  }
}

function readConfig(): Promise<Value | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const done = () => {
      process.stdin.removeAllListeners();
      process.stdin.destroy();
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks).subarray(0, MAX_CONFIG_BYTES));
        resolve(text === "" ? new Map() : parse(utf8(text), TELEMETRY_JSON_DEPTH));
      } catch (error) {
        reject(error);
      }
    };
    const timer = setTimeout(() => reject(new Error("the flusher's config never arrived")), CONFIG_TIMEOUT_MS);
    process.stdin.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= MAX_CONFIG_BYTES) {
        clearTimeout(timer);
        done();
      }
    });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      done();
    });
    process.stdin.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export function flushTarget(config: Value | undefined): { root: string; url: string; environment: string } | undefined {
  if (!(config instanceof Map)) throw new TypeError("the flusher's config isn't an object");
  const url = config.get("url");
  if (url !== LOGS_URL && !(typeof url === "string" && loopbackUrl(url))) return undefined;
  const root = config.get("data_root");
  if (typeof root !== "string") throw new TypeError("the flusher's config has no data_root");
  const environment = config.get("environment");
  const chosen = !truthy(environment) ? "production" : environment === "production" ? "production" : typeof environment === "string" ? environment : "other";
  return { root, url: url as string, environment: chosen };
}

export async function flushMain(): Promise<void> {
  try {
    const target = flushTarget(await readConfig());
    if (target !== undefined) await flush(target.root, target.url, target.environment);
  } catch {}
}
