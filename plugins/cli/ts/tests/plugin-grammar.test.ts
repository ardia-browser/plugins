import assert from "node:assert/strict";
import { test } from "bun:test";
import { splitGlobals, Usage } from "../src/browse/args.ts";
import { DAEMON_GRAMMAR, daemonParse, type Grammar, pluginVerdict } from "../src/browse/plugin-grammar.ts";
import { ALIASES } from "../src/browse/tables.ts";
import { oracle } from "./oracle-fixtures.ts";

type PythonParse = { command: string; known: boolean; usage?: string; options?: Record<string, unknown>; positionals?: string[] };
const FROZEN = oracle<{ split: [string[], unknown][]; parse: [string[], PythonParse][]; grammar: Record<string, unknown> }>("plugin-grammar");

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

test("the client's global split agrees with Python's on every case, rejections included", () => {
  assert.ok(FROZEN.split.length > 100);
  FROZEN.split.forEach(([browse, want]) => {
    const ours = tsSplit(browse) as { rest?: string[] };
    const command = ours.rest?.find((word) => !word.startsWith("-"));
    if (command === "wait" && (ours.rest ?? []).some((word) => word === "--state" || word.startsWith("--state="))) {
      assert.match((want as { usage?: string }).usage ?? "", /--state doesn't apply to Ardia/, JSON.stringify(browse));
      return;
    }
    assert.deepEqual(ours, want, JSON.stringify(browse));
  });
});

test("the guard's grammar table is the daemon's, read from its command functions", () => {
  const names = Object.keys(DAEMON_GRAMMAR);
  assert.deepEqual(FROZEN.grammar, Object.fromEntries(names.map((name) => [name, DAEMON_GRAMMAR[name]])));
});

test("the guard parses every daemon argv exactly as Python's parse() does", () => {
  assert.deepEqual(FROZEN.parse.slice(0, BYPASSES.length).map(([rest]) => rest), BYPASSES);
  assert.ok(FROZEN.parse.length > 100);
  FROZEN.parse.forEach(([rest, want]) => {
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

test("nothing that only works through page script is allowed: snapshot --cursor and get styles read computed styles", () => {
  for (const rest of [["snapshot", "--cursor"], ["snapshot", "-C"], ["snapshot", "-i", "-C"], ["get", "styles", "@e1"]]) {
    assert.equal(pluginVerdict(rest).allowed, false, JSON.stringify(rest));
  }
  for (const rest of [["snapshot", "-c", "-u"], ["get", "box", "@e1"], ["get", "count", "li"], ["wait", "--text", "Done"]]) {
    assert.equal(pluginVerdict(rest).allowed, true, JSON.stringify(rest));
  }
});

test("a token Python reads as a negative number never hides a flag, and anything the guard can't parse is refused", () => {
  assert.equal(pluginVerdict(["wait", "-\u0663", "--download", "x"]).allowed, false);
  assert.equal(pluginVerdict(["click", "-\u0661", "--new-tab", "@e1"]).allowed, false);
  assert.equal(pluginVerdict(["snapshot", "-\u{1d7d9}", "-i"]).allowed, true);
  for (const rest of [["snapshot", "-x"], ["snapshot", "--depth"], ["click", "--nope", "@e1"], ["get", "-\u00b2", "title"]]) {
    assert.equal(pluginVerdict(rest).allowed, false, JSON.stringify(rest));
  }
});
