import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import "./libc-loaded.ts";
import { openPrivate } from "../src/privatefs.ts";
import { sleepMs } from "../src/printable.ts";
import { startFlush } from "../src/spool.ts";
import { oracle } from "./oracle-fixtures.ts";

const NOW_SLACK_S = 5;
const SPAWN_WAIT_MS = 3000;
const FROZEN = oracle<{ rows: [string, Outcome][] }>("flush-state").rows;

type Outcome = { state: string; spawned: boolean };

function box(state: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ardia-flush-")));
  fs.mkdirSync(path.join(root, "Telemetry"), { mode: 0o700 });
  fs.writeFileSync(path.join(root, "Telemetry", "cli-flush.json"), state, { mode: 0o600 });
  return root;
}

function outcome(root: string, started: number, ended: number): Outcome {
  const text = fs.readFileSync(path.join(root, "Telemetry", "cli-flush.json"), "utf8");
  const scrubbed = text.replace(/("next_at": )([0-9.e+]+)/, (whole, head: string, value: string) => {
    const at = Number(value);
    return at >= started + 60 - NOW_SLACK_S && at <= ended + 60 + NOW_SLACK_S ? `${head}<now+60>` : whole;
  });
  const spawned = fs.existsSync(path.join(root, "spawned"));
  fs.rmSync(root, { recursive: true, force: true });
  return { state: scrubbed, spawned };
}

function viaTypeScript(state: string): Outcome {
  const root = box(state);
  const started = Date.now() / 1000;
  const marker = path.join(root, "spawned");
  const fakePython = path.join(root, "python");
  fs.writeFileSync(fakePython, `#!/bin/sh\n: > '${marker}'\n`, { mode: 0o700 });
  startFlush(openPrivate(root, ["Telemetry"], false), { root, url: "http://127.0.0.1:9/v1/logs", environment: "test" }, fakePython);
  const rewritten = fs.readFileSync(path.join(root, "Telemetry", "cli-flush.json"), "utf8") !== state;
  const deadline = Date.now() + SPAWN_WAIT_MS;
  while (rewritten && !fs.existsSync(marker) && Date.now() < deadline) sleepMs(10);
  return outcome(root, started, Date.now() / 1000);
}

test("every frozen flush state is here", () => {
  assert.equal(FROZEN.length, 23);
});

for (const [state, python] of FROZEN) {
  test(`a flush state of ${state} is read the way Python reads it`, () => {
    assert.deepEqual(viaTypeScript(state), python);
  });
}
