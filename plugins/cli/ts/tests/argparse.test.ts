import assert from "node:assert/strict";
import { test } from "bun:test";
import { frontEnd, namespaceJson } from "../src/argparse-cli.ts";
import { parseArgs } from "../src/argparse-env.ts";
import { oracle } from "./oracle-fixtures.ts";

const CLEARED = ["ARDIA_CONFIG_HOME", "XDG_CONFIG_HOME", "ARDIA_DATA_DIR", "ARDIA_WS", "ARDIA_PORT"];

type Case = { spec?: string; cli?: boolean; argv: string[]; columns: string | null; linux: boolean; version: string };
type Result = { status: number | null; stdout: string; stderr: string; values?: Record<string, unknown> };

function tsResult(one: Case): Result {
  if (one.columns === null) delete process.env.COLUMNS;
  else process.env.COLUMNS = one.columns;
  const overrides = { linux: one.linux, version: one.version };
  if (one.cli) return frontEnd(one.argv, overrides).result;
  const parsed = parseArgs(one.spec as string, one.argv, overrides);
  if (parsed.ok) return { status: null, stdout: "", stderr: parsed.stderr, values: namespaceJson(parsed.values) };
  return { status: parsed.status, stdout: parsed.stdout, stderr: parsed.stderr };
}

for (const platform of ["darwin", "linux"]) {
  test(`argparse output and values match CPython's on ${platform}`, () => {
    const saved = { ...process.env };
    try {
      const { home, cases, results } = oracle<{ home: string; cases: Case[]; results: Result[] }>(`argparse-${platform}`);
      process.env.HOME = home;
      for (const name of CLEARED) delete process.env[name];
      const failures: string[] = [];
      cases.forEach((one, index) => {
        const ours = tsResult(one);
        const theirs = results[index] as Result;
        if (JSON.stringify(ours) !== JSON.stringify(theirs) && failures.length < 20) {
          failures.push(`${JSON.stringify(one)}\n  python: ${JSON.stringify(theirs)}\n  ts:     ${JSON.stringify(ours)}`);
        }
      });
      assert.equal(failures.join("\n\n"), "");
      assert.ok(cases.length > 1000);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  }, 300_000);
}
