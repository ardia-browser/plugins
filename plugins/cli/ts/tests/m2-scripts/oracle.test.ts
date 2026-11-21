import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PYTHON = process.env.ARDIA_TEST_PYTHON ?? "python3";
const COUNT = process.env.ARDIA_ORACLE_COUNT ?? "400";

test("urlmatch, the idna codec and userscript parsing answer exactly as their Python originals", { timeout: 610_000 }, () => {
  const run = spawnSync(PYTHON, ["-m", "tests.m2_scripts.pure", "all", "--generated", COUNT, "--show", "3"], {
    cwd: CLI,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 600_000,
  });
  assert.equal(run.status, 0, `${run.stdout.slice(-6000)}\n${run.stderr.slice(-4000)}`);
});
