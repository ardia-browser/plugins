import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PYTHON = process.env.ARDIA_TEST_PYTHON ?? "python3";
const ESBUILD = process.env.ARDIA_TEST_ESBUILD_DIR;

test("scripts install, uninstall and list end to end write what Python writes, byte for byte", { skip: ESBUILD ? false : "set ARDIA_TEST_ESBUILD_DIR to esbuild's folder", timeout: 310_000 }, () => {
  const run = spawnSync(PYTHON, ["-m", "tests.m2_scripts.live", "--esbuild", ESBUILD as string], { cwd: CLI, encoding: "utf8", timeout: 300_000 });
  assert.equal(run.status, 0, `${run.stdout.slice(-6000)}\n${run.stderr.slice(-4000)}`);
});
