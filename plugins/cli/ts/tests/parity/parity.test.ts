import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "bun:test";
import { PARITY } from "./cases.ts";
import { runEngineDetached } from "./detached.ts";
import type { EngineResult } from "./engine.ts";
import { passed, programPath, report } from "./run.ts";

const PER_CASE_MS = 1000;
const program = programPath();

const capture = JSON.parse(readFileSync(join(PARITY, "capture.json"), "utf8")) as { base: string; platforms: Record<string, unknown> };

if (!(process.platform in capture.platforms)) {
  test(`the expected outcomes were captured on ${process.platform}`, () => {
    throw new Error(`capture.json has no ${process.platform} capture of base ${capture.base}: run the capture script there (--key expected_${process.platform}) before trusting this runner on ${process.platform}`);
  }, PER_CASE_MS);
} else if (!existsSync(program)) {
  test("the TypeScript ardia is built", () => {
    throw new Error(`no ardia-ts at ${program}: build it with sh plugins/cli/ts/scripts/build.sh, or point ARDIA_TS_CLI at one`);
  }, PER_CASE_MS);
} else {
  let result: EngineResult | undefined;
  let failure: unknown;
  try {
    result = await runEngineDetached();
  } catch (error) {
    failure = error;
  }
  test("the parity engine ran every case", () => {
    if (failure !== undefined) throw failure;
    if (!result?.outcomes.length) throw new Error("the parity engine ran no case");
    process.stderr.write(`parity: ${result.outcomes.filter(passed).length} of ${result.total} cases match in ${(result.ms / 1000).toFixed(1)} s\n`);
  }, PER_CASE_MS);
  test("no route marker is left unclaimed", () => {
    if (result?.strayRoutes.length) throw new Error(`route markers no case claimed: ${result.strayRoutes.join(", ")}`);
  }, PER_CASE_MS);
  for (const outcome of result?.outcomes ?? []) {
    test(`parity ${outcome.id}`, () => {
      if (!passed(outcome)) throw new Error(report(outcome));
    }, PER_CASE_MS);
  }
}
