import assert from "node:assert/strict";
import { test } from "bun:test";
import { freeText, onlyPlaceholders, scrub } from "../src/scrub.ts";
import { oracle } from "./oracle-fixtures.ts";

type Row = [string, string, boolean, [string, boolean][]];

test("scrub, free_text and only_placeholders match Python on a mixed corpus", () => {
  const { limits, rows } = oracle<{ limits: number[]; rows: Row[] }>("scrub");
  assert.equal(rows.length, 432);
  for (const [text, scrubbed, placeholders, free] of rows) {
    assert.equal(scrub(text), scrubbed, `scrub ${JSON.stringify(text)}`);
    assert.equal(onlyPlaceholders(text), placeholders, `only_placeholders ${JSON.stringify(text)}`);
    limits.forEach((limit, at) => assert.deepEqual(freeText(text, limit), free[at], `free_text ${limit} ${JSON.stringify(text)}`));
  }
});
