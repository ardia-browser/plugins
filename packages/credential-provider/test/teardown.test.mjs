import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { load } from "./load.mjs";
import { raw } from "./fixtures.mjs";

const { defineCliSpec, createSidecarCore, CREDENTIAL_LIMITS } = await load("index");
const { nodeLauncher, runCredentialSidecar } = await load("sidecar");
const { splitLines } = await load("lines");

const script = `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const note = (pid) => fs.appendFileSync(process.env.TEARDOWN_PIDS, pid + "\\n");
const grandchild = () => note(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] }).pid);
note(process.pid);
switch (process.argv[2]) {
  case "hang":
    setInterval(() => {}, 1000);
    break;
  case "orphan":
    grandchild();
    setTimeout(() => process.exit(0), 50);
    break;
  case "stubborn":
    process.on("SIGTERM", () => {});
    grandchild();
    setInterval(() => {}, 1000);
    break;
  case "noisy":
    process.stderr.write("x".repeat(4 * 1024 * 1024), () => process.exit(0));
    break;
}
`;

let folder;
let pids;
let spec;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(check, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const notedPids = () => (existsSync(pids) ? readFileSync(pids, "utf8").split("\n").filter(Boolean).map(Number) : []);

before(() => {
  folder = mkdtempSync(join(tmpdir(), "credential-teardown-"));
  pids = join(folder, "pids");
  writeFileSync(join(folder, "tcli"), script);
  chmodSync(join(folder, "tcli"), 0o755);
  spec = defineCliSpec({
    name: "tcli",
    install: raw.install,
    sessionLastsSeconds: 600,
    patterns: {},
    env: [{ name: "TEARDOWN_PIDS", literal: pids }],
    verbs: {
      hang: { argv: ["hang"], timeoutMs: 30000, output: { mode: "lines" } },
      orphan: { argv: ["orphan"], timeoutMs: 30000, output: { mode: "lines" } },
      stubborn: { argv: ["stubborn"], timeoutMs: 1000, output: { mode: "lines" } },
      noisy: { argv: ["noisy"], output: { mode: "lines" } },
    },
  });
});

after(() => {
  for (const pid of notedPids()) if (alive(pid)) process.kill(pid, "SIGKILL");
  rmSync(folder, { recursive: true, force: true });
});

const launcher = () => nodeLauncher({ env: { PATH: `${folder}:${dirname(process.execPath)}`, HOME: process.env.HOME }, folders: [], killGraceMs: 200, drainGraceMs: 300 });

test("dispose stops a running non-streaming command at once", async () => {
  rmSync(pids, { force: true });
  const core = createSidecarCore(spec, launcher());
  const started = Date.now();
  const reply = core.handle("cli.run", { verb: "hang", params: {} });
  await until(() => notedPids().length === 1, 5000, "the command to start");
  core.dispose();
  const result = await reply;
  assert.equal(result.cancelled, true);
  assert.equal(result.succeeded, false);
  assert.ok(Date.now() - started < 5000);
  await until(() => !alive(notedPids()[0]), 2000, "the command to die");
  await assert.rejects(core.handle("cli.run", { verb: "hang", params: {} }), /stopping/);
});

test("a grandchild that holds the pipes after the command exits can't hold the reply, and is killed with its group", async () => {
  rmSync(pids, { force: true });
  const core = createSidecarCore(spec, launcher());
  const started = Date.now();
  const result = await core.handle("cli.run", { verb: "orphan", params: {} });
  assert.equal(result.launched, true);
  assert.equal(result.status, 0);
  assert.ok(Date.now() - started < 3000, `answered after ${Date.now() - started} ms`);
  const [, grandchild] = notedPids();
  assert.ok(grandchild);
  await until(() => !alive(grandchild), 2000, "the grandchild to die");
});

test("a command that ignores SIGTERM and a grandchild holding its pipes end within the timeout and the kill grace", async () => {
  rmSync(pids, { force: true });
  const core = createSidecarCore(spec, launcher());
  const started = Date.now();
  const result = await core.handle("cli.run", { verb: "stubborn", params: {} });
  const took = Date.now() - started;
  assert.equal(result.timedOut, true);
  assert.ok(took < 1000 + 200 + 1500, `answered after ${took} ms`);
  const [leader, grandchild] = notedPids();
  await until(() => !alive(leader) && !alive(grandchild), 2000, "the command and its grandchild to die");
});

test("megabytes of stderr with no newline stay within the stderr cap and make no lines", async () => {
  rmSync(pids, { force: true });
  const lines = [];
  const outcome = await launcher()(
    { verb: "noisy", program: "tcli", argv: ["noisy"], env: { TEARDOWN_PIDS: pids }, stdin: "", timeoutMs: 10000, outputLimitBytes: 1024, signIn: false },
    { onLine: (line) => lines.push(line), cancelled: new Promise(() => {}) },
  );
  assert.equal(outcome.status, 0);
  assert.equal(Buffer.byteLength(outcome.stderr), CREDENTIAL_LIMITS.stderrBytes);
  assert.deepEqual(lines, []);
});

test("the line splitter never holds more than its limit of an unterminated line", () => {
  const seen = [];
  let oversized = 0;
  const lines = splitLines(16, (line) => seen.push(line.toString("utf8")), () => oversized++);
  lines.push(Buffer.from("short\r\nx"));
  for (let i = 0; i < 1000; i++) lines.push(Buffer.alloc(1024, 120));
  lines.push(Buffer.from("tail\nnext"));
  lines.end();
  assert.deepEqual(seen, ["short", "next"]);
  assert.equal(oversized, 1);
  assert.equal(lines.dropped, 1);
});

test("a stream verb keeps at most retainedLines lines and counts the rest as dropped", async () => {
  const fake = (launch, io) => {
    for (let i = 0; i < CREDENTIAL_LIMITS.retainedLines + 500; i++) io.onLine({ stream: "stdout", text: `line ${i}` });
    return new Promise((resolve) => io.cancelled.then(() => resolve({ launched: true, status: -1, stdout: "", stderr: "", timedOut: false, overflowed: false, cancelled: true })));
  };
  const core = createSidecarCore(defineCliSpec(raw), fake);
  const first = await core.handle("cli.run", { verb: "login", params: {} });
  assert.ok(first.running);
  assert.equal(first.lines.length, CREDENTIAL_LIMITS.retainedLines);
  assert.equal(first.droppedLines, 500);
  assert.equal(first.lines.at(-1), `line ${CREDENTIAL_LIMITS.retainedLines + 499}`);
  core.dispose();
});

function collect(output) {
  const replies = [];
  let pending = "";
  output.on("data", (chunk) => {
    pending += chunk;
    let end;
    while ((end = pending.indexOf("\n")) >= 0) {
      replies.push(JSON.parse(pending.slice(0, end)));
      pending = pending.slice(end + 1);
    }
  });
  return replies;
}

test("a request frame over the limit closes the sidecar cleanly instead of buffering it", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  const replies = collect(output);
  let ended = false;
  output.on("end", () => (ended = true));
  runCredentialSidecar(defineCliSpec(raw), { input, output, env: { PATH: "/nonexistent" }, folders: [], frameBytes: 1024 });
  input.write("x".repeat(4096));
  await until(() => ended, 2000, "the output to end");
  assert.equal(replies.length, 1);
  assert.deepEqual([replies[0].id, replies[0].error.code], [null, "too_large"]);
  assert.equal(input.destroyed, true);
});

test("replies wait for a slow reader in order, and the sidecar stops reading while they wait", async () => {
  const input = new PassThrough();
  const written = [];
  const output = new Writable({
    highWaterMark: 8,
    write(chunk, _encoding, done) {
      written.push(chunk.toString("utf8"));
      setTimeout(done, 2);
    },
  });
  let paused = 0;
  const pause = input.pause.bind(input);
  input.pause = () => {
    paused++;
    return pause();
  };
  runCredentialSidecar(defineCliSpec(raw), { input, output, env: { PATH: "/nonexistent" }, folders: [] });
  input.write(Array.from({ length: 30 }, (_, i) => `${JSON.stringify({ id: i + 1, method: "session.status" })}\n`).join(""));
  await until(() => written.join("").split("\n").filter(Boolean).length === 30, 5000, "every reply");
  assert.deepEqual(written.join("").split("\n").filter(Boolean).map((line) => JSON.parse(line).id), Array.from({ length: 30 }, (_, i) => i + 1));
  assert.ok(paused > 0);
  input.end();
});

test("a reader that never drains overflows the bounded reply queue and closes the sidecar", async () => {
  const input = new PassThrough();
  const output = new Writable({ highWaterMark: 8, write() {} });
  runCredentialSidecar(defineCliSpec(raw), { input, output, env: { PATH: "/nonexistent" }, folders: [], replyQueue: 5 });
  input.write(Array.from({ length: 30 }, (_, i) => `${JSON.stringify({ id: i + 1, method: "session.status" })}\n`).join(""));
  await until(() => input.destroyed, 2000, "the sidecar to close");
});
