import { existsSync } from "node:fs";
import { test } from "bun:test";
import { loadCases } from "./cases.ts";
import { runEngineDetached } from "./detached.ts";
import { TIMEOUT_MS } from "./observe.ts";
import { programPath } from "./run.ts";

const DEEP_FIXTURE_CPU_S = 5;
const DEEP_FIXTURE_WALL_MS = TIMEOUT_MS / 2;
const program = programPath();
const deep = loadCases().filter((kase) => kase.id.startsWith("ts-r3--") && kase.id.endsWith("-deep")).map((kase) => kase.id);

if (existsSync(program)) {
  const result = await runEngineDetached({ only: deep, timed: true, jobs: 1 });
  for (const outcome of result.outcomes) process.stderr.write(`deep: ${outcome.id} ${(outcome.ms / 1000).toFixed(1)} s, ${outcome.cpuSeconds?.toFixed(2) ?? "?"} s CPU\n`);
  test("the deep fixtures are all there", () => {
    if (deep.length !== 11 || result.outcomes.length !== deep.length) throw new Error(`expected 11 deep fixtures, found ${deep.length}, ran ${result.outcomes.length}`);
  }, 1000);
  for (const outcome of result.outcomes) {
    test(`deep fixture ${outcome.id} finishes well inside the runner's timeout`, () => {
      if (outcome.timedOut) throw new Error(`${outcome.id} timed out`);
      if (outcome.cpuSeconds === undefined) throw new Error(`${outcome.id}: no CPU time measured`);
      if (outcome.cpuSeconds >= DEEP_FIXTURE_CPU_S) throw new Error(`${outcome.id} used ${outcome.cpuSeconds.toFixed(1)} s of CPU`);
      if (outcome.ms >= DEEP_FIXTURE_WALL_MS) throw new Error(`${outcome.id} took ${(outcome.ms / 1000).toFixed(1)} s`);
    }, 1000);
  }
}
