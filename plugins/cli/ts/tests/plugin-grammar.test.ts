import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { splitGlobals, Usage } from "../src/browse/args.ts";
import { DAEMON_GRAMMAR, daemonParse, type Grammar, pluginVerdict } from "../src/browse/plugin-grammar.ts";
import { ALIASES } from "../src/browse/tables.ts";

const CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const PYTHON = process.env.ARDIA_TEST_PYTHON ?? "python3";
const HELPER = path.join(CLI, "tests", "plugin_grammar.py");

function python(args: string[], input?: unknown): unknown {
  const run = spawnSync(PYTHON, ["-I", HELPER, ...args], { input: input === undefined ? "" : JSON.stringify(input), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

const BYPASSES = [
  ["open", "--label", "--", "--read", "https://example.com/"],
  ["goto", "--headers", "--", "--read", "https://example.com/"],
  ["navigate", "--enable=--", "--read", "https://example.com/"],
  ["open", "--", "--read"],
  ["click", "--button", "--", "--new-tab", "@e1"],
  ["click", "--button=--new-tab", "@e1"],
  ["wait", "--text", "--", "--download", "x"],
  ["wait", "-t", "--fn", "1"],
  ["wait", "-f", "1"],
  ["wait", "--download=0"],
  ["snapshot", "-s", "--", "-i"],
  ["snapshot", "-d", "-3"],
  ["snapshot", "-x"],
  ["snapshot", "--depth"],
  ["scroll", "-s=main"],
  ["scroll", "--selector=main", "down", "-5"],
  ["tab", "--label", "--", "new"],
  ["tab", "close"],
  ["tab", "ABC", "extra"],
  ["get", "cdp-url"],
  ["get", "--", "title"],
  ["type", "--delay", "--no-humanize", "@e1", "x"],
  ["find", "--name", "--exact", "role", "button"],
  ["key", "Enter"],
  ["fill", "@e2", "-", "--"],
  ["is", "visible", "--", "-x"],
];

function caseArgvs(): string[][] {
  const out: string[][] = [];
  for (const file of ["ai-plugin-contract.json", "ai-plugin-review.json"]) {
    const rows = JSON.parse(readFileSync(path.join(CLI, "tests", "parity", "cases", file), "utf8")) as { argv: string[] }[];
    for (const row of rows) {
      try {
        const { rest } = splitGlobals(row.argv.slice(1));
        if (rest.length > 0) out.push(rest);
      } catch (error) {
        if (!(error instanceof Usage)) throw error;
      }
    }
  }
  return out;
}

type PythonParse = { command: string; known: boolean; usage?: string; options?: Record<string, unknown>; positionals?: string[] };

test("the guard's grammar table is the daemon's, read from its command functions", () => {
  const names = Object.keys(DAEMON_GRAMMAR);
  assert.deepEqual(python(["grammar", ...names]), Object.fromEntries(names.map((name) => [name, DAEMON_GRAMMAR[name]])));
});

test("the guard parses every daemon argv exactly as Python's parse() does", () => {
  const corpus = [...BYPASSES, ...caseArgvs()];
  const expected = python(["parse"], corpus) as PythonParse[];
  corpus.forEach((rest, index) => {
    const want = expected[index] as PythonParse;
    const name = ALIASES[rest[0] as string] ?? (rest[0] as string);
    assert.equal(want.command, name, JSON.stringify(rest));
    const grammar = DAEMON_GRAMMAR[name] as Grammar | undefined;
    if (grammar === undefined) {
      assert.equal(pluginVerdict(rest).allowed, false, `${JSON.stringify(rest)} isn't in the grammar, so the guard must refuse it`);
      return;
    }
    const got = daemonParse(rest.slice(1), grammar);
    if ("usage" in got) assert.equal(got.usage, want.usage, JSON.stringify(rest));
    else assert.deepEqual({ options: Object.fromEntries(got.options), positionals: got.positionals }, { options: want.options, positionals: want.positionals }, JSON.stringify(rest));
  });
});

test("flags hidden behind a value that is -- are still refused", () => {
  for (const rest of BYPASSES.slice(0, 3)) assert.deepEqual(pluginVerdict(rest), { allowed: false, why: `\`${rest[0]} --read\``, nested: true });
  assert.equal(pluginVerdict(["open", "--", "--read"]).allowed, false);
  assert.equal(pluginVerdict(["click", "--button", "--", "--new-tab", "@e1"]).allowed, false);
  assert.equal(pluginVerdict(["click", "--button=--new-tab", "@e1"]).allowed, true);
  assert.equal(pluginVerdict(["wait", "--text", "--", "--download", "x"]).allowed, false);
  assert.equal(pluginVerdict(["wait", "-t", "--fn", "1"]).allowed, true);
  assert.equal(pluginVerdict(["wait", "-f", "1"]).allowed, false);
  assert.equal(pluginVerdict(["tab", "--label", "--", "new"]).allowed, false);
  assert.equal(pluginVerdict(["tab", "close"]).allowed, false);
  assert.equal(pluginVerdict(["get", "cdp-url"]).allowed, false);
  assert.equal(pluginVerdict(["snapshot", "-c"]).allowed, true);
  assert.equal(pluginVerdict(["diff", "snapshot", "--baseline", "/etc/hosts"]).allowed, false);
  assert.equal(pluginVerdict(["upload", "@e1", "/etc/hosts"]).allowed, false);
});
