import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { BUILT_LIBC } from "./libc-loaded.ts";
import { flush } from "../src/flush.ts";

const TS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.resolve(TS, "..");
const PYTHON = process.env.ARDIA_TEST_PYTHON ?? "python3";
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
after(() => server.close());

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

async function viaPython(root: string): Promise<string> {
  const script = `import sys; sys.path.insert(0, sys.argv[2])
from pathlib import Path
from ardia_cli import telemetry
print(telemetry.flush(Path(sys.argv[1]), sys.argv[3], "dev"))`;
  const child = spawn(PYTHON, ["-I", "-c", script, root, CLI, URL], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TZ: process.env.TZ ?? "Etc/UTC" } });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  assert.equal(code, 0, err);
  return out.trim();
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

async function both(lines: string[], consent?: Record<string, unknown>): Promise<void> {
  const pythonRoot = box(lines, consent);
  const tsRoot = box(lines, consent);
  seen.length = 0;
  const pythonResult = await viaPython(pythonRoot);
  const pythonBodies = withoutPythonVersion(seen.splice(0));
  const tsResult = await flush(tsRoot, URL, "dev");
  const tsBodies = withoutPythonVersion(seen.splice(0));
  assert.equal(tsResult, pythonResult);
  assert.deepEqual(tsBodies, pythonBodies);
  assert.deepEqual(leftovers(tsRoot), leftovers(pythonRoot));
  fs.rmSync(pythonRoot, { recursive: true, force: true });
  fs.rmSync(tsRoot, { recursive: true, force: true });
}

const MIXED = [
  record("u1", { command: "browse", subcommand: "goto", exit_code: 0, flags: "--json", total_ms: 12 }),
  record("u2", { command: "browse", subcommand: "zzzunknown", exit_code: 1, error_code: null }),
  record("u3", { command: "browse", exit_code: 0 }),
  record("u4", { command: "tabs", big: 12345678901234567890, small: -9007199254740991, f: 1.5, whole: 2.0, neg0: -0.0, t: true }),
  record("u5", { command: "x", list: [1, "two", { three: 3 }], nested: { a: [] }, text: "héllo ☃ 😀" }),
  record("u6", { command: "x" }, { distinct_id: OTHER_ID }),
  "not json",
  record("u7", { command: "x" }, { timestamp: "2026-11-20T10:11:12" }),
  record("u8", { command: "x", event: "override", uuid: "override" }),
  record("u9", { command: "x" }, { properties: "not a dict" }),
];

test("a mixed spool is sent exactly as Python sends it", async () => {
  status = 200;
  await both(MIXED);
});

test("a failed send keeps the events and backs off like Python", async () => {
  status = 503;
  await both(MIXED);
  status = 200;
});

test("a rejected batch is dropped, an oversized one split, like Python", async () => {
  status = 400;
  await both(MIXED);
  status = 413;
  await both(MIXED);
  status = 200;
});

test("a large backlog goes in batches like Python", { timeout: 30_000 }, async () => {
  const lines = Array.from({ length: 130 }, (_, index) => record(`b${index}`, { command: "x", pad: "p".repeat(5000) }));
  await both(lines);
});

test("sharing off removes the spool like Python", async () => {
  await both(MIXED, { sharing: false });
});

test("the program flushes in the background when spawned with the flush argument", async () => {
  const root = box([record("bg1", { command: "config" })]);
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
  const root = box([record("bg2", { command: "config" })]);
  seen.length = 0;
  const child = spawn(PROGRAM, ["--ardia-telemetry-flush"], { stdio: ["pipe", "ignore", "ignore"], env: { PATH: "/usr/bin:/bin" } });
  child.stdin.end(JSON.stringify({ data_root: root, url: "http://example.com/v1/logs", environment: "dev" }));
  assert.equal(await new Promise<number | null>((resolve) => child.on("exit", resolve)), 0);
  assert.equal(seen.length, 0);
  assert.equal(fs.existsSync(path.join(root, "Telemetry", "cli-queue.jsonl")), true);
  fs.rmSync(root, { recursive: true, force: true });
});
