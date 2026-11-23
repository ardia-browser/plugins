import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "bun:test";
import { type Case, loadCases, PARITY, SERVED_TABLE } from "./cases.ts";
import type { EngineResult } from "./engine.ts";

const PER_CASE_MS = 1000;
const SWITCH_ROWS = new Set(["browse-daemon"]);
const GROUP_ROWS = new Set(["browse"]);
const ARGPARSE_ROW = "argparse";

async function routesThroughArgparse(argv: string[]): Promise<boolean> {
  const [{ route, withArgparse }, { parseCommand }] = await Promise.all([import("../../src/route.ts"), import("../../src/commands.ts")]);
  return (await withArgparse(route(argv, undefined, parseCommand), argv)).kind === "argparse";
}

function servedRows(): string[] {
  return readFileSync(SERVED_TABLE, "utf8")
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((words) => words.length >= 2)
    .map((words) => words.slice(0, -1).join(" "));
}

function servedRow(command: string, served: Set<string>): string | null {
  if (served.has(command)) return command;
  const group = command.split(" ", 1)[0] as string;
  if (command.includes(" ") && GROUP_ROWS.has(group) && served.has(group)) return group;
  const family = `${group} *`;
  return command.includes(" ") && served.has(family) ? family : null;
}

const capture = JSON.parse(readFileSync(join(PARITY, "capture.json"), "utf8")) as { base: string; platforms: Record<string, unknown> };

const supported = process.platform in capture.platforms;
const { runEngineDetached } = supported ? await import("./detached.ts") : { runEngineDetached: null };
const { passed, programPath, report } = supported ? await import("./run.ts") : { passed: null, programPath: null, report: null };
const program = programPath?.() ?? "";

if (!supported || runEngineDetached === null || passed === null || report === null) {
  test(`the expected outcomes were captured on ${process.platform}`, () => {
    throw new Error(`capture.json has expectations for ${Object.keys(capture.platforms).join(" and ")} only (captured from ${capture.base}); this runner can't judge ${process.platform}`);
  }, PER_CASE_MS);
} else if (!existsSync(program)) {
  test("the TypeScript ardia is built", () => {
    throw new Error(`no ardia-ts at ${program}: build it with sh plugins/cli/ts/scripts/build.sh, or point ARDIA_TS_CLI at one`);
  }, PER_CASE_MS);
} else {
  let result: EngineResult | undefined;
  let failure: unknown;
  const cases: Case[] = loadCases();
  try {
    const ids = cases.map((kase) => kase.id);
    const deep = ids.filter((id) => id.startsWith("ts-r3--") && id.endsWith("-deep"));
    const rest = await runEngineDetached({ only: ids.filter((id) => !deep.includes(id)) });
    const alone = await runEngineDetached({ only: deep, jobs: 1 });
    result = { total: rest.total + alone.total, ms: rest.ms + alone.ms, strayRoutes: [...rest.strayRoutes, ...alone.strayRoutes], outcomes: [...rest.outcomes, ...alone.outcomes] };
  } catch (error) {
    failure = error;
  }
  test("the parity engine ran every case", () => {
    if (failure !== undefined) throw failure;
    if (!result?.outcomes.length) throw new Error("the parity engine ran no case");
    process.stderr.write(`parity: ${result.outcomes.filter(passed).length} of ${result.total} cases match in ${(result.ms / 1000).toFixed(1)} s\n`);
  }, PER_CASE_MS);
  test("every loaded case produced exactly one result", () => {
    const seen = (result?.outcomes ?? []).map((outcome) => outcome.id).sort();
    const missing = cases.map((kase) => kase.id).filter((id) => !seen.includes(id));
    const repeated = seen.filter((id, index) => seen[index - 1] === id);
    if (missing.length || repeated.length) throw new Error(`cases without a result: ${missing.join(", ") || "none"}; cases run twice: ${repeated.join(", ") || "none"}`);
  }, PER_CASE_MS);
  test("every command served.txt lists has at least one passing case", async () => {
    const served = new Set(servedRows().filter((name) => !SWITCH_ROWS.has(name)));
    const commandOf = new Map(cases.map((kase) => [kase.id, kase.command]));
    const proven = new Set<string>();
    for (const outcome of result?.outcomes ?? []) {
      const command = commandOf.get(outcome.id);
      const row = command === undefined ? null : servedRow(command, served);
      if (!passed(outcome)) continue;
      if (row !== null) proven.add(row);
      if (served.has(ARGPARSE_ROW) && !proven.has(ARGPARSE_ROW) && (await routesThroughArgparse(outcome.argv))) proven.add(ARGPARSE_ROW);
    }
    const unproven = [...served].filter((name) => !proven.has(name));
    if (unproven.length) throw new Error(`served.txt lists commands with no passing parity case: ${unproven.join(", ")}`);
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
