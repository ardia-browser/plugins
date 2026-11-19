import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

const CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");
const PYTHON = process.env.ARDIA_TEST_PYTHON ?? "python3";
const COUNT = process.env.ARDIA_ORACLE_COUNT ?? "150";

test("every ported pure function answers exactly as its Python original", { timeout: 310_000 }, () => {
  const run = spawnSync(PYTHON, [path.join(CLI, "tests", "m3", "pure.py"), "--count", COUNT, "--bun", process.execPath], {
    cwd: CLI,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 300_000,
  });
  assert.equal(run.status, 0, `${run.stdout.slice(-6000)}\n${run.stderr.slice(-4000)}`);
});
