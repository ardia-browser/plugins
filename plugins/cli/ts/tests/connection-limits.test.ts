import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { Connection, EVENT_QUEUE_BYTES, Stop, UNREADABLE_LINE } from "../src/connection.ts";
import { recordedSocketCode } from "../src/error-codes.ts";
import { emptyListing, methodFailed } from "../src/listing.ts";

const EVENT_QUEUE_TEST_MS = 60_000;

type Pair = { connection: Connection; client: Socket; peer: Socket; server: Server; cleanup: () => void };

async function pair(): Promise<Pair> {
  const folder = mkdtempSync(path.join(tmpdir(), "acl"));
  const where = path.join(folder, "s.sock");
  let peer: Socket | undefined;
  const server = createServer((socket) => {
    peer = socket;
  });
  await new Promise<void>((resolve) => server.listen(where, resolve));
  const client = createConnection({ path: where, allowHalfOpen: true });
  await new Promise<void>((resolve) => client.once("connect", () => resolve()));
  while (peer === undefined) await new Promise((resolve) => setTimeout(resolve, 5));
  const fd = (client as unknown as { _handle: { fd: number } })._handle.fd;
  const connection = new Connection(client, fd, () => false, () => {});
  const accepted = peer;
  return {
    connection,
    client,
    peer: accepted,
    server,
    cleanup: () => {
      connection.close();
      accepted.destroy();
      server.close();
      rmSync(folder, { recursive: true, force: true });
    },
  };
}

async function stopOf(promise: Promise<unknown>): Promise<Stop> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Stop, String(error));
    return error;
  }
  assert.fail("expected the request to stop");
}

test("one deadline covers sending a large request and its reply, and closes the socket when it fires", async () => {
  const { connection, client, peer, cleanup } = await pair();
  try {
    peer.pause();
    const started = performance.now();
    const stop = await stopOf(connection.request("workspace", "p".repeat(900 * 1024), 0.5));
    const spent = performance.now() - started;
    assert.equal(stop.kind, "timeout");
    assert.equal(stop.reason, "Ardia didn't answer workspace in 0.5 s");
    assert.ok(spent >= 450 && spent < 3000, `took ${spent} ms`);
    assert.ok(client.destroyed);
  } finally {
    cleanup();
  }
});

test("a reply deadline also closes the socket", async () => {
  const { connection, client, cleanup } = await pair();
  try {
    const stop = await stopOf(connection.request("windows", undefined, 0.2));
    assert.equal(stop.kind, "timeout");
    assert.ok(client.destroyed);
  } finally {
    cleanup();
  }
});

test("an over-deep line wakes a waiting events reader instead of stranding it, after the events before it", async () => {
  const { connection, peer, cleanup } = await pair();
  try {
    const waiting = connection.nextEvent();
    peer.write(`{"event": "tab.opened", "data": {}}\n`);
    assert.equal((await waiting).raw, `{"event": "tab.opened", "data": {}}`);
    const next = connection.nextEvent();
    peer.write(`${"[".repeat(10_000)}${"]".repeat(10_000)}\n`);
    const stop = await stopOf(next);
    assert.equal(stop.reason, UNREADABLE_LINE);
    peer.end();
    assert.equal((await stopOf(connection.nextEvent())).reason, UNREADABLE_LINE);
  } finally {
    cleanup();
  }
});

test("the events queue is capped by bytes as well as entries, oldest dropped first", async () => {
  const { connection, peer, cleanup } = await pair();
  try {
    const filler = "x".repeat(900 * 1024);
    const count = Math.ceil(EVENT_QUEUE_BYTES / (900 * 1024)) + 4;
    for (let index = 0; index < count; index += 1) peer.write(`{"event": "tab.opened", "n": ${index}, "data": {"x": "${filler}"}}\n`);
    peer.write(`{"event": "tab.closed", "data": {}}\n`);
    let last = "";
    for (let waited = 0; !last.includes("tab.closed") && waited < 200; waited += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      last = (connection as unknown as { events: { raw: string }[] }).events.at(-1)?.raw ?? "";
    }
    const dropped = connection.takeDropped();
    assert.ok(dropped > 0, "nothing was dropped");
    const first = await connection.nextEvent();
    assert.match(first.raw, new RegExp(`"n": ${dropped}[,}]`));
  } finally {
    cleanup();
  }
}, EVENT_QUEUE_TEST_MS);

test("only the app's documented error codes reach telemetry; anything else is other", () => {
  for (const code of ["bad_request", "unknown_method", "unknown_command", "refused", "no_window", "failed", "unsupported_protocol", "password_manager_plugin"]) {
    assert.equal(recordedSocketCode(code), code);
  }
  for (const code of ["not_found", "secret_value", "Refused", ""]) assert.equal(recordedSocketCode(code), "other");
  assert.equal(methodFailed("tabs", emptyListing(), "user_typed_text", "x").errorCode, "other");
  assert.equal(methodFailed("groups", emptyListing(), "unknown_method", "x").errorCode, "unknown_method");
});

test("an over-deep line fails every pending call at once, and later calls too", async () => {
  const { connection, peer, cleanup } = await pair();
  try {
    const started = performance.now();
    const first = stopOf(connection.request("windows", undefined, 30));
    const second = stopOf(connection.request("workspace", undefined, 30));
    await new Promise((resolve) => setTimeout(resolve, 50));
    peer.write(`${"[".repeat(10_000)}${"]".repeat(10_000)}\n`);
    for (const stop of [await first, await second]) assert.deepEqual([stop.reason, stop.kind], [UNREADABLE_LINE, "lost"]);
    assert.ok(performance.now() - started < 3000);
    const later = await stopOf(connection.request("windows", undefined, 30));
    assert.deepEqual([later.reason, later.kind], [UNREADABLE_LINE, "lost"]);
  } finally {
    cleanup();
  }
});

test("an event with a very wide array is queued; its size is counted without spreading it into a call", async () => {
  const { connection, peer, cleanup } = await pair();
  try {
    const wide = `{"event": "tab.opened", "data": [${Array.from({ length: 300_000 }, () => "0").join(",")}]}`;
    const next = connection.nextEvent();
    peer.write(`${wide}\n`);
    assert.equal((await next).raw, wide);
  } finally {
    cleanup();
  }
});
