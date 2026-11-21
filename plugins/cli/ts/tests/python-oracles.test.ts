import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { closeMatches } from "../src/closest.ts";
import { dumps } from "../src/json.ts";
import { formatG } from "../src/py.ts";
import { DecodeError, loads, Refused } from "../src/pyjson.ts";

const PYTHON = process.env.ARDIA_TEST_PYTHON ?? "python3";
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const BUNDLED_PYTHON = "3.13";
const version = spawnSync(PYTHON, ["-I", "-c", "import sys; print('%d.%d' % sys.version_info[:2])"], { encoding: "utf8" }).stdout?.trim();
const skip = process.env.ARDIA_TEST_PYTHON === undefined && version !== BUNDLED_PYTHON ? `needs CPython ${BUNDLED_PYTHON}, the bundled one (set ARDIA_TEST_PYTHON)` : false;

test("the oracle is the bundled CPython's version", { skip }, () => {
  assert.equal(version, BUNDLED_PYTHON);
});

function oracle(script: string, seed: number): string {
  const ran = spawnSync(PYTHON, ["-I", path.join(FIXTURES, script), String(seed)], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(ran.status, 0, ran.stderr);
  return ran.stdout;
}

function decoded(text: string, strict: boolean): Record<string, string> {
  try {
    return { ok: dumps(loads(text, strict ? { what: "--params" } : undefined), "spaced", true) };
  } catch (error) {
    if (error instanceof Refused) return { refused: error.message };
    if (error instanceof DecodeError) return { error: error.message };
    throw error;
  }
}

test("the params decoder gives CPython's value or its exact error for thousands of edge texts", { skip }, () => {
  for (const seed of [1, 2]) {
    for (const line of oracle("pyjson_oracle.py", seed).split("\n").filter(Boolean)) {
      const row = JSON.parse(line);
      assert.deepEqual(decoded(row.text, true), row.strict, `strict ${JSON.stringify(row.text)}`);
      assert.deepEqual(decoded(row.text, false), row.lenient, `lenient ${JSON.stringify(row.text)}`);
    }
  }
});

test("nearest names and %g match difflib and Python's formatting", { skip }, () => {
  for (const seed of [1, 2, 3]) {
    const rows = JSON.parse(oracle("close_matches_oracle.py", seed)) as { name: string; pool: string[]; found: string[]; values: number[]; g: string[] }[];
    for (const row of rows) {
      assert.deepEqual(closeMatches(row.name, row.pool), row.found, `${row.name} in ${row.pool.join(",")}`);
      assert.deepEqual(row.values.map(formatG), row.g);
    }
  }
  assert.deepEqual([30, 2.5, 0.00001, 29.99873, 599.99999, 1.140625, 12.34375, 0.000099999996].map(formatG), ["30", "2.5", "1e-05", "29.9987", "600", "1.14062", "12.3438", "0.0001"]);
});
