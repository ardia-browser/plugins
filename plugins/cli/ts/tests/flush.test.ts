import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, test } from "bun:test";
import { BUILT_LIBC } from "./libc-loaded.ts";
import { flush } from "../src/flush.ts";
import { systemInfo } from "../src/system-info.ts";
import { cliVersion } from "../src/version.ts";
import { oracle } from "./oracle-fixtures.ts";

const TS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROGRAM = process.env.ARDIA_TS_CLI ?? path.join(TS, "dist", "ardia-ts");
const INSTALL_ID = "0b6f4c1e-8d2a-4f3b-9c5d-1e2f3a4b5c6d";
const OTHER_ID = "11111111-2222-4333-8444-555555555555";

type Seen = { body: unknown; headers: Record<string, string> };
const seen: Seen[] = [];
let status = 200;
const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    seen.push({ body: JSON.parse(Buffer.concat(chunks).toString("utf8")), headers: request.headers as Record<string, string> });
    response.writeHead(status, { "Content-Length": "0" });
    response.end();
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/logs`;
afterAll(() => server.close());

type FrozenRun = { name: string; status: number; consent: Record<string, unknown>; lines: string[]; tz: string; result: string; bodies: string[]; leftovers: { spool: string | null; failures: unknown } };
const FROZEN = new Map(oracle<{ runs: FrozenRun[] }>("flush").runs.map((run) => [run.name, run]));
const savedTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "UTC";
});
afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

function record(uuid: string, properties: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ uuid, event: "cli_command", distinct_id: INSTALL_ID, timestamp: "2026-11-20T10:11:12.345Z", properties, ...extra });
}

function box(lines: string[], consent: Record<string, unknown> = { sharing: true, installId: INSTALL_ID }): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ardia-flush-")));
  fs.writeFileSync(path.join(root, "telemetry.json"), JSON.stringify(consent), { mode: 0o600 });
  fs.mkdirSync(path.join(root, "Telemetry"), { mode: 0o700 });
  fs.writeFileSync(path.join(root, "Telemetry", "cli-queue.jsonl"), lines.map((line) => `${line}\n`).join(""), { mode: 0o600 });
  return root;
}

type Attribute = { key: string; value: unknown };

function withoutPythonVersion(bodies: Seen[]): unknown[] {
  return bodies.map(({ body }) => {
    const copy = structuredClone(body) as { resourceLogs: { scopeLogs: { logRecords: { attributes: Attribute[] }[] }[] }[] };
    for (const logRecord of copy.resourceLogs[0]?.scopeLogs[0]?.logRecords ?? []) {
      logRecord.attributes = logRecord.attributes.filter((item) => item.key !== "python_version");
    }
    return copy;
  });
}

const HOST_ATTRIBUTES: Record<string, () => string> = {
  "os.type": () => systemInfo().osType,
  "os.version": () => systemInfo().osVersion,
  "host.arch": () => systemInfo().arch,
  $os: () => systemInfo().os,
  $os_version: () => systemInfo().osVersion,
  arch: () => systemInfo().arch,
};

function onThisHost(attributes: Attribute[]): void {
  for (const item of attributes) {
    const host = HOST_ATTRIBUTES[item.key];
    if (host !== undefined) item.value = { stringValue: host() };
  }
}

function withRunningVersion(bodies: unknown[]): unknown[] {
  return bodies.map((body) => {
    const copy = structuredClone(body) as { resourceLogs: { resource: { attributes: Attribute[] }; scopeLogs: { logRecords: { attributes: Attribute[] }[] }[] }[] };
    onThisHost(copy.resourceLogs[0]?.resource.attributes ?? []);
    for (const logRecord of copy.resourceLogs[0]?.scopeLogs[0]?.logRecords ?? []) {
      for (const item of logRecord.attributes) if (item.key === "cli_version") item.value = { stringValue: cliVersion() };
      onThisHost(logRecord.attributes);
    }
    return copy;
  });
}

function leftovers(root: string): { spool: string | null; failures: unknown } {
  const read = (name: string) => {
    try {
      return fs.readFileSync(path.join(root, "Telemetry", name), "utf8");
    } catch {
      return null;
    }
  };
  const state = read("cli-flush.json");
  return { spool: read("cli-queue.jsonl"), failures: state === null ? null : JSON.parse(state).failures };
}

function withoutFrames(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutFrames);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (key === "stringValue" && typeof inner === "string" && inner.includes('"frames":')) {
      const entries = JSON.parse(inner) as { stacktrace: { frames: unknown[] } }[];
      for (const entry of entries) entry.stacktrace.frames = [];
      out[key] = JSON.stringify(entries);
    } else out[key] = withoutFrames(inner);
  }
  return out;
}

async function againstPython(name: string, lines: string[], consent?: Record<string, unknown>): Promise<void> {
  const frozen = FROZEN.get(name);
  assert.ok(frozen, `no frozen run named ${name}`);
  assert.deepEqual(frozen.lines, lines);
  assert.deepEqual(frozen.consent, consent ?? { sharing: true, installId: INSTALL_ID });
  assert.equal(frozen.status, status);
  assert.equal(frozen.tz, process.env.TZ);
  const pythonBodies = withRunningVersion(withoutFrames(withoutPythonVersion(frozen.bodies.map((text) => ({ body: JSON.parse(text), headers: {} })))) as unknown[]);
  const tsRoot = box(lines, consent);
  seen.length = 0;
  const tsResult = await flush(tsRoot, URL, "dev");
  const tsBodies = withoutPythonVersion(seen.splice(0));
  assert.equal(tsResult, frozen.result);
  assert.deepEqual(tsBodies, pythonBodies);
  assert.deepEqual(leftovers(tsRoot), frozen.leftovers);
  fs.rmSync(tsRoot, { recursive: true, force: true });
}

function uid(index: number): string {
  return `00000000-0000-7000-8000-${String(index).padStart(12, "0")}`;
}

const FRAME = { platform: "custom", lang: "python", function: "main", module: "ardia_cli.cli", filename: "ardia_cli.cli", lineno: 12, colno: null, resolved: true, in_app: true };
const EXCEPTION = {
  $exception_level: "fatal", source: "cli_unhandled", $exception_types: ["KeyError"], $exception_values: ["KeyError"],
  $exception_list: [{ type: "KeyError", value: "KeyError", mechanism: { type: "cli_unhandled", handled: false, synthetic: false }, stacktrace: { type: "raw", frames: [FRAME] } }],
  error_code: null, cli_version: "0.4.0", $environment: "production",
};

const MIXED = [
  record(uid(1), { command: "browse", subcommand: "goto", exit_code: 0, flags: "--json", total_ms: 12, cdp_calls: 3, humanize: false, served_by: "ts" }),
  record(uid(2), { command: "browse", subcommand: "zzzunknown", exit_code: 1, error_code: "stale_ref", $session_id: uid(99), watch_report: "FB-AB12" }),
  record(uid(3), { command: "browse", exit_code: 0, cli_version: "0.4.0", $environment: "test" }),
  record(uid(4), EXCEPTION, { event: "$exception" }),
  record(uid(6), { command: "x" }, { distinct_id: OTHER_ID }),
  "not json",
  record(uid(7), { command: "config", subcommand: "path" }, { timestamp: "2026-11-20T10:11:12" }),
  record(uid(9), { command: "x" }, { properties: "not a dict" }),
];

test("every frozen Python run is replayed", () => {
  assert.deepEqual([...FROZEN.keys()], ["mixed", "failed send", "rejected", "oversized", "backlog", "sharing off"]);
});

test("a mixed spool is sent exactly as Python sends it", async () => {
  status = 200;
  await againstPython("mixed", MIXED);
});

test("a failed send keeps the events and backs off like Python", async () => {
  status = 503;
  await againstPython("failed send", MIXED);
  status = 200;
});

test("a rejected batch is dropped, an oversized one split, like Python", async () => {
  status = 400;
  await againstPython("rejected", MIXED);
  status = 413;
  await againstPython("oversized", MIXED);
  status = 200;
});

test("a large backlog goes in batches like Python", async () => {
  const lines = Array.from({ length: 130 }, (_, index) => record(uid(1000 + index), { command: "tabs", exit_code: index }));
  await againstPython("backlog", lines);
}, 30_000);

test("sharing off removes the spool like Python", async () => {
  await againstPython("sharing off", MIXED, { sharing: false });
});

test("the program flushes in the background when spawned with the flush argument", async () => {
  const root = box([record(uid(2001), { command: "config" })]);
  seen.length = 0;
  const child = spawn(PROGRAM, ["--ardia-telemetry-flush"], { stdio: ["pipe", "ignore", "pipe"], env: { PATH: "/usr/bin:/bin", ARDIA_TEST_LIBC: BUILT_LIBC } });
  child.stdin.end(JSON.stringify({ data_root: root, url: URL, environment: "dev" }));
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  assert.equal(code, 0);
  assert.equal(seen.length, 1);
  assert.equal(fs.existsSync(path.join(root, "Telemetry", "cli-queue.jsonl")), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("the flusher refuses a URL that isn't loopback or ardia.dev", async () => {
  const root = box([record(uid(2002), { command: "config" })]);
  seen.length = 0;
  const child = spawn(PROGRAM, ["--ardia-telemetry-flush"], { stdio: ["pipe", "ignore", "ignore"], env: { PATH: "/usr/bin:/bin" } });
  child.stdin.end(JSON.stringify({ data_root: root, url: "http://example.com/v1/logs", environment: "dev" }));
  assert.equal(await new Promise<number | null>((resolve) => child.on("exit", resolve)), 0);
  assert.equal(seen.length, 0);
  assert.equal(fs.existsSync(path.join(root, "Telemetry", "cli-queue.jsonl")), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("only the CLI's events and fields are uploaded; free text is dropped or replaced by other", async () => {
  const root = box([
    record(uid(3001), { command: "tabs", exit_code: 0, title: "Bank statement", flags: "--json", extra: { nested: 1 }, total_ms: 5 }),
    record(uid(3002), { command: "Free text here", exit_code: 0 }),
    record(uid(3003), { command: "x", error_code: "Has Spaces" }),
    record(uid(3004), { command: "x" }, { event: "page_text" }),
    record("not-a-uuid", { command: "x" }),
    record(uid(3005), { ...EXCEPTION, $exception_values: ["Welcome back Jane"] }, { event: "$exception" }),
  ]);
  seen.length = 0;
  assert.equal(await flush(root, URL, "dev"), "done");
  const records = (seen[0]?.body as { resourceLogs: { scopeLogs: { logRecords: { attributes: Attribute[] }[] }[] }[] }).resourceLogs[0]?.scopeLogs[0]?.logRecords ?? [];
  const keys = records.map((logRecord) => logRecord.attributes.map((item) => item.key).filter((key) => !key.startsWith("$lib") && !["$os", "$os_version", "arch", "$process_person_profile", "$geoip_disable"].includes(key)));
  assert.deepEqual(keys, [
    ["event", "uuid", "distinct_id", "command", "exit_code", "flags", "total_ms"],
    ["event", "uuid", "distinct_id", "command", "exit_code"],
    ["event", "uuid", "distinct_id", "command"],
    ["event", "uuid", "distinct_id", "$exception_level", "source", "$exception_types", "$exception_values", "$exception_list", "cli_version", "$environment"],
  ]);
  const valueOf = (index: number, key: string) => JSON.stringify(records[index]?.attributes.find((item) => item.key === key)?.value);
  assert.equal(valueOf(1, "command"), JSON.stringify({ stringValue: "other" }));
  assert.equal(valueOf(2, "command"), JSON.stringify({ stringValue: "other" }));
  assert.equal(valueOf(3, "$exception_values"), JSON.stringify({ stringValue: '["other"]' }));
  assert.equal(fs.existsSync(path.join(root, "Telemetry", "cli-queue.jsonl")), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("events acknowledged before a crash aren't sent again", async () => {
  const root = box([record(uid(4001), { command: "x" }), record(uid(4002), { command: "y" })]);
  fs.writeFileSync(path.join(root, "Telemetry", "cli-flush-acked.json"), JSON.stringify({ uuids: [uid(4001)] }), { mode: 0o600 });
  seen.length = 0;
  assert.equal(await flush(root, URL, "dev"), "done");
  assert.equal(seen.length, 1);
  const body = JSON.stringify(seen[0]?.body);
  assert.equal(body.includes(uid(4001)), false);
  assert.equal(body.includes(uid(4002)), true);
  assert.equal(fs.existsSync(path.join(root, "Telemetry", "cli-flush-acked.json")), false);
  assert.equal(fs.existsSync(path.join(root, "Telemetry", "cli-queue.jsonl")), false);
  fs.rmSync(root, { recursive: true, force: true });
});

for (const [name, consent] of [
  ["an unreadable expiry", { sharing: true, installId: INSTALL_ID, sharingUntil: "next week" }],
  ["an expiry that isn't a time", { sharing: true, installId: INSTALL_ID, sharingUntil: true }],
  ["an expiry that is a list", { sharing: true, installId: INSTALL_ID, sharingUntil: [1] }],
  ["a past expiry", { sharing: true, installId: INSTALL_ID, sharingUntil: "2020-01-01T00:00:00Z" }],
  ["sharing that isn't true", { sharing: "yes", installId: INSTALL_ID }],
] as const) {
  test(`the flusher sends nothing and clears the spool for ${name}`, async () => {
    const root = box([record(uid(5001), { command: "x" })], consent as Record<string, unknown>);
    seen.length = 0;
    assert.equal(await flush(root, URL, "dev"), "off");
    assert.equal(seen.length, 0);
    assert.equal(fs.existsSync(path.join(root, "Telemetry", "cli-queue.jsonl")), false);
    fs.rmSync(root, { recursive: true, force: true });
  });
}

test("the flusher honours DO_NOT_TRACK and ARDIA_TELEMETRY itself", async () => {
  for (const [key, value] of [["DO_NOT_TRACK", "1"], ["ARDIA_TELEMETRY", "off"]] as const) {
    const root = box([record(uid(6001), { command: "x" })]);
    seen.length = 0;
    const child = spawn(PROGRAM, ["--ardia-telemetry-flush"], { stdio: ["pipe", "ignore", "ignore"], env: { PATH: "/usr/bin:/bin", [key]: value } });
    child.stdin.end(JSON.stringify({ data_root: root, url: URL, environment: "dev" }));
    assert.equal(await new Promise<number | null>((resolve) => child.on("exit", resolve)), 0);
    assert.equal(seen.length, 0, key);
    assert.equal(fs.existsSync(path.join(root, "Telemetry", "cli-queue.jsonl")), false, key);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a flusher whose config never arrives gives up", async () => {
  const child = spawn(PROGRAM, ["--ardia-telemetry-flush"], { stdio: ["pipe", "ignore", "ignore"], env: { PATH: "/usr/bin:/bin" } });
  const started = Date.now();
  assert.equal(await new Promise<number | null>((resolve) => child.on("exit", resolve)), 0);
  assert.ok(Date.now() - started < 10_000);
  child.stdin.end();
}, 15_000);
