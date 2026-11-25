import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { load } from "./load.mjs";
import { fakeCliScript, raw } from "./fixtures.mjs";

const { defineCliSpec } = await load("index");
const { runCredentialSidecar, findProgram } = await load("sidecar");

let folder;
let sidecar;

function start(env) {
  const input = new PassThrough();
  const output = new PassThrough();
  const waiting = new Map();
  let pending = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => {
    pending += chunk;
    let end;
    while ((end = pending.indexOf("\n")) >= 0) {
      const reply = JSON.parse(pending.slice(0, end));
      pending = pending.slice(end + 1);
      waiting.get(reply.id)?.(reply);
      waiting.delete(reply.id);
    }
  });
  runCredentialSidecar(defineCliSpec(raw), { input, output, env, folders: [] });
  let next = 0;
  return {
    request(method, params) {
      const id = ++next;
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        input.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    },
    stop: () => input.end(),
  };
}

before(() => {
  folder = mkdtempSync(join(tmpdir(), "credential-sidecar-"));
  writeFileSync(join(folder, "fakecli"), fakeCliScript);
  chmodSync(join(folder, "fakecli"), 0o755);
  sidecar = start({ PATH: `${folder}:${process.env.PATH}`, HOME: process.env.HOME });
});

after(() => {
  sidecar.stop();
  rmSync(folder, { recursive: true, force: true });
});

test("finds the CLI on PATH and reports it", async () => {
  assert.equal(findProgram("fakecli", { env: { PATH: folder }, folders: [] }), join(folder, "fakecli"));
  assert.equal(findProgram("../fakecli", { env: { PATH: folder }, folders: [] }), null);
  const { result } = await sidecar.request("session.status");
  assert.deepEqual(result.cli, { name: "fakecli", found: true });
  assert.equal(result.unlocked, false);
});

test("runs a json verb with the spec's env and parses its items", async () => {
  const { result } = await sidecar.request("cli.run", { verb: "item.list", params: {} });
  assert.equal(result.succeeded, true);
  assert.equal(result.items, 2);
  assert.deepEqual(result.json.map((item) => item.id), ["a1", "b2"]);
});

test("a wrong password fails with its hint and the password redacted", async () => {
  const { result } = await sidecar.request("cli.run", { verb: "unlock", params: { password: "wrong one" } });
  assert.equal(result.succeeded, false);
  assert.deepEqual(result.hints, ["wrongPassword"]);
  assert.doesNotMatch(result.stderr, /wrong one/);
  assert.match(result.stderr, /\[hidden\]/);
  assert.equal(result.unlocked, false);
});

test("an unlock keeps the session, which later verbs take by handle", async () => {
  const { result } = await sidecar.request("cli.run", { verb: "unlock", params: { password: "correct horse" } });
  assert.equal(result.unlocked, true);
  assert.equal(result.persist, "sessionkey0123456789abcdef");
  assert.equal((await sidecar.request("session.status")).result.unlocked, true);
  const status = await sidecar.request("cli.run", { verb: "status", params: { session: { $secret: "session" } } });
  assert.deepEqual(status.result.json, { session: "[hidden]" });
  assert.equal((await sidecar.request("session.drop")).result.unlocked, false);
  const after = await sidecar.request("cli.run", { verb: "status", params: { session: { $secret: "session" } } });
  assert.equal(after.error.code, "expired");
});

test("json reaches the CLI on stdin", async () => {
  const { result } = await sidecar.request("cli.run", { verb: "create", params: { item: { title: "New", urls: ["https://example.com"] } } });
  assert.deepEqual(result.json, { title: "New", urls: ["https://example.com"] });
});

test("refused verbs answer with an error and launch nothing", async () => {
  assert.equal((await sidecar.request("cli.run", { verb: "item.get", params: { id: "--help" } })).error.code, "bad_request");
  assert.equal((await sidecar.request("cli.run", { verb: "rm", params: {} })).error.code, "refused");
  assert.equal((await sidecar.request("format.disk", {})).error.code, "refused");
});

test("a verb that runs past its timeout is stopped", async () => {
  const { result } = await sidecar.request("cli.run", { verb: "slow", params: {} });
  assert.equal(result.timedOut, true);
  assert.equal(result.succeeded, false);
});

test("a stream verb answers at its first line and keeps running until it ends", async () => {
  const first = (await sidecar.request("cli.run", { verb: "login", params: {} })).result;
  assert.ok(first.running);
  assert.match(first.lines[0], /https:\/\/example\.com\/approve/);
  assert.equal(first.signInRun.state, "running");
  let reply = first;
  while (reply.running) reply = (await sidecar.request("cli.wait", { run: first.running, waitMs: 2000 })).result;
  assert.equal(reply.succeeded, true);
  assert.equal(reply.unlocked, true);
  assert.equal(reply.signInRun.state, "succeeded");
  assert.equal((await sidecar.request("cli.wait", { run: first.running })).error.code, "expired");
});

test("a missing CLI isn't launched", async () => {
  const bare = start({ PATH: "/nonexistent" });
  try {
    assert.equal((await bare.request("session.status")).result.cli.found, false);
    const { result } = await bare.request("cli.run", { verb: "item.list", params: {} });
    assert.equal(result.launched, false);
  } finally {
    bare.stop();
  }
});
