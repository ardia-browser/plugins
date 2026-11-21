import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { frontEnd, namespaceJson } from "../src/argparse-cli.ts";
import { parseArgs } from "../src/argparse-env.ts";

const PYTHON = process.env.ARDIA_TEST_PYTHON;
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKIP = PYTHON === undefined ? "needs ARDIA_TEST_PYTHON, a CPython 3.13" : false;
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

function pythonCases(platform: string, out: string): { home: string; cases: Case[]; results: Result[] } {
  const done = spawnSync(PYTHON as string, ["-I", join(CLI, "tests", "argparse_diff.py"), platform, CLI, out], { encoding: "utf8", maxBuffer: 1 << 26 });
  if (done.status !== 0) throw new Error(`argparse_diff.py on ${platform} failed:\n${done.stderr}`);
  return JSON.parse(readFileSync(out, "utf8"));
}

test("the checked-in argparse specs match the Python parsers", { skip: SKIP }, () => {
  const done = spawnSync(PYTHON as string, ["-I", join(CLI, "tests", "argparse_specs.py"), "--check"], { cwd: CLI, encoding: "utf8" });
  assert.equal(done.stderr, "");
  assert.equal(done.status, 0);
});

for (const platform of ["darwin", "linux"]) {
  test(`argparse output and values match CPython's on ${platform}`, { skip: SKIP, timeout: 300_000 }, () => {
    const scratch = mkdtempSync(join(tmpdir(), "argparse-diff-"));
    const saved = { ...process.env };
    try {
      const { home, cases, results } = pythonCases(platform, join(scratch, "cases.json"));
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
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}
