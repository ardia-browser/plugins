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

const CLIENT_WORDS = ["help", "--help", "-h", "--version", "-V"];

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
  ["wait", "-\u0663", "--download", "x"],
  ["click", "-\u0661", "--new-tab", "@e1"],
  ["snapshot", "-\u{1d7d9}", "-i"],
  ["scroll", "-\u0966\u0967", "down"],
  ["fill", "-\uff11", "x"],
  ["get", "-\u00b2", "title"],
];

function browseArgv(argv: readonly string[]): string[] {
  const at = argv.indexOf("browse");
  return argv.slice(at + 1);
}

function caseArgvs(): string[][] {
  const out: string[][] = [];
  for (const file of ["ai-plugin-contract.json", "ai-plugin-review.json"]) {
    const rows = JSON.parse(readFileSync(path.join(CLI, "tests", "parity", "cases", file), "utf8")) as { argv: string[] }[];
    for (const row of rows) out.push(browseArgv(row.argv));
  }
  return out;
}

function tsSplit(browse: readonly string[]): unknown {
  try {
    const { found, rest } = splitGlobals(browse);
    const merged: Record<string, unknown> = { ...Object.fromEntries(found.values), ...Object.fromEntries(found.flags) };
    if (found.enable !== undefined) merged.enable = found.enable;
    if (found.initScript !== undefined) merged.init_script = found.initScript;
    return { found: merged, rest };
  } catch (error) {
    if (!(error instanceof Usage)) throw error;
    return { usage: error.message };
  }
}

function daemonArgvs(): string[][] {
  const out: string[][] = [];
  for (const browse of caseArgvs()) {
    const split = tsSplit(browse) as { rest?: string[] };
    const rest = split.rest;
    if (rest !== undefined && rest.length > 0 && !CLIENT_WORDS.includes(rest[0] as string) && !rest.includes("--help") && !rest.includes("-h")) out.push(rest);
  }
  return out;
}

const GLOBAL_CORPUS = [
  ["wait", "--state=visible", "#x"],
  ["wait", "--state", "visible", "#x"],
  ["--json", "get", "--", "title"],
  ["--session", "--json", "get", "title"],
  ["get", "--session"],
  ["--max-output", "--", "get", "title"],
  ["--data-dir", "x", "get", "title"],
];

test("the client's global split agrees with Python's on every case, rejections included", () => {
  const corpus = [...GLOBAL_CORPUS, ...caseArgvs()];
  const expected = python(["split"], corpus) as unknown[];
  corpus.forEach((browse, index) => assert.deepEqual(tsSplit(browse), expected[index], JSON.stringify(browse)));
});

type PythonParse = { command: string; known: boolean; usage?: string; options?: Record<string, unknown>; positionals?: string[] };

test("the guard's grammar table is the daemon's, read from its command functions", () => {
  const names = Object.keys(DAEMON_GRAMMAR);
  assert.deepEqual(python(["grammar", ...names]), Object.fromEntries(names.map((name) => [name, DAEMON_GRAMMAR[name]])));
});

test("the guard parses every daemon argv exactly as Python's parse() does", () => {
  const corpus = [...BYPASSES, ...daemonArgvs()];
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

test("a token Python reads as a negative number never hides a flag, and anything the guard can't parse is refused", () => {
  assert.equal(pluginVerdict(["wait", "-\u0663", "--download", "x"]).allowed, false);
  assert.equal(pluginVerdict(["click", "-\u0661", "--new-tab", "@e1"]).allowed, false);
  assert.equal(pluginVerdict(["snapshot", "-\u{1d7d9}", "-i"]).allowed, true);
  for (const rest of [["snapshot", "-x"], ["snapshot", "--depth"], ["click", "--nope", "@e1"], ["get", "-\u00b2", "title"]]) {
    assert.equal(pluginVerdict(rest).allowed, false, JSON.stringify(rest));
  }
});
