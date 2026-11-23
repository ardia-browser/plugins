import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";
import { type FrozenFunctions, frozenFunctionReports, oracle } from "../oracle-fixtures.ts";

const ORACLE = path.join(path.dirname(fileURLToPath(import.meta.url)), "oracle.ts");

test("urlmatch, the idna codec and userscript parsing answer exactly as their Python originals did on the frozen cases", async () => {
  const frozen = oracle<FrozenFunctions>("m2-scripts-pure");
  const { reports, functions, cases } = await frozenFunctionReports(frozen, ORACLE);
  assert.equal(reports.join("\n\n"), "");
  assert.ok(functions >= 20, `only ${functions} functions frozen`);
  assert.ok(cases >= 20 * frozen.count, `only ${cases} cases frozen`);
}, 300_000);
