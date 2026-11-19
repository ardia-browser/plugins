import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import "./libc-loaded.ts";
import { openPrivate } from "../src/privatefs.ts";
import { sleepMs } from "../src/printable.ts";
import { startFlush } from "../src/spool.ts";

const CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const PYTHON = process.env.ARDIA_TEST_PYTHON ?? "python3";
const NOW_SLACK_S = 5;
const SPAWN_WAIT_MS = 3000;
const PYTHON_SIDE = `
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[2])
from ardia_cli import telemetry
root = Path(sys.argv[1])
telemetry.spawn_flusher = lambda where: (root / "spawned").write_text("")
`;

const STATES = [
  '{"failures": NaN, "next_at": 0}',
  '{"failures": Infinity, "next_at": 0}',
  '{"failures": -Infinity, "next_at": 0}',
  '{"failures": 2.7, "next_at": 0}',
  '{"failures": -2.7, "next_at": 0}',
  '{"failures": 1e300, "next_at": 0}',
  '{"failures": 123456789012345678901234567890123456789012345, "next_at": 0}',
  '{"failures": -123456789012345678901234567890123456789012345, "next_at": 0}',
  '{"failures": "3", "next_at": 0}',
  '{"failures": true, "next_at": 0}',
  '{"failures": null, "next_at": 0}',
  '{"failures": 0, "next_at": NaN}',
  '{"failures": 0, "next_at": Infinity}',
  '{"failures": 0, "next_at": -Infinity}',
  '{"failures": 0, "next_at": 1e300}',
  '{"failures": 0, "next_at": 99999999999999999999999999999999999999999999}',
  '{"failures": 0, "next_at": -99999999999999999999999999999999999999999999}',
  '{"failures": 0, "next_at": "9e12"}',
  '{"failures": 0, "next_at": true}',
  '{"failures": 0, "next_at": null}',
  '{"failures": 0, "next_at": 1.5}',
  '{"failures": NaN, "next_at": 9e12}',
  '{"failures": Infinity, "next_at": 99999999999999999999999999999999999999999999}',
];

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

function viaPython(state: string): Outcome {
  const root = box(state);
  const started = Date.now() / 1000;
  const run = spawnSync(
    PYTHON,
    [
      "-I",
      "-c",
      `${PYTHON_SIDE}
import os
dir_fd = os.open(root / "Telemetry", os.O_RDONLY | os.O_DIRECTORY)
try:
    telemetry.start_flush(dir_fd, telemetry.Target(root, "http://127.0.0.1:9/v1/logs", "test"))
except Exception as error:
    print(type(error).__name__, file=sys.stderr)
`,
      root,
      CLI,
    ],
    { cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  return outcome(root, started, Date.now() / 1000);
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

for (const state of STATES) {
  test(`a flush state of ${state} is read the way Python reads it`, () => {
    assert.deepEqual(viaTypeScript(state), viaPython(state));
  });
}
