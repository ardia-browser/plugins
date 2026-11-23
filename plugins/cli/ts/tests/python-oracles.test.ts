import assert from "node:assert/strict";
import { test } from "bun:test";
import { getCloseMatches as closeMatches } from "../src/pylib/close.ts";
import { dumps } from "../src/json.ts";
import { formatG } from "../src/py.ts";
import { DecodeError, loads, Refused } from "../src/pyjson.ts";
import { oracle } from "./oracle-fixtures.ts";

type PyjsonRow = { text: string; strict: Record<string, string>; lenient: Record<string, string> };
type CloseRow = { name: string; pool: string[]; found: string[]; values: number[]; g: string[] };
const FROZEN = oracle<{ pyjson: Record<string, PyjsonRow[]>; close: Record<string, CloseRow[]> }>("python-oracles");

function decoded(text: string, strict: boolean): Record<string, string> {
  try {
    return { ok: dumps(loads(text, strict ? { what: "--params" } : undefined), "spaced", true) };
  } catch (error) {
    if (error instanceof Refused) return { refused: error.message };
    if (error instanceof DecodeError) return { error: error.message };
    throw error;
  }
}

test("the params decoder gives CPython's value or its exact error for thousands of edge texts", () => {
  let count = 0;
  for (const seed of ["1", "2"]) {
    for (const row of FROZEN.pyjson[seed] ?? []) {
      count += 1;
      assert.deepEqual(decoded(row.text, true), row.strict, `strict ${JSON.stringify(row.text)}`);
      assert.deepEqual(decoded(row.text, false), row.lenient, `lenient ${JSON.stringify(row.text)}`);
    }
  }
  assert.equal(count, 2 * 4054);
});

test("nearest names and %g match difflib and Python's formatting", () => {
  let count = 0;
  for (const seed of ["1", "2", "3"]) {
    for (const row of FROZEN.close[seed] ?? []) {
      count += 1;
      assert.deepEqual(closeMatches(row.name, row.pool), row.found, `${row.name} in ${row.pool.join(",")}`);
      assert.deepEqual(row.values.map(formatG), row.g);
    }
  }
  assert.equal(count, 3 * 400);
  assert.deepEqual([30, 2.5, 0.00001, 29.99873, 599.99999, 1.140625, 12.34375, 0.000099999996].map(formatG), ["30", "2.5", "1e-05", "29.9987", "600", "1.14062", "12.3438", "0.0001"]);
});
