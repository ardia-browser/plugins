import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCommand } from "../src/commands.ts";
import { route } from "../src/route.ts";
import { servedTable } from "../src/served.ts";
import { lstrip, rstrip, strip, isSpace } from "../src/py.ts";

function label(argv: string[]): string | undefined {
  return parseCommand(argv)?.label;
}

test("each ported command is parsed and labelled for the served table", () => {
  assert.equal(label(["call", "history.search", "-p", "q=x", "--json"]), "call *");
  assert.equal(label(["--json", "--timeout", "5", "call", "windows"]), "call *");
  assert.equal(label(["methods", "run"]), "methods");
  assert.equal(label(["run", "selectTab", "2", "--window", "1"]), "run");
  assert.equal(label(["events", "--json", "tab.opened", "tab.closed"]), "events");
  assert.equal(label(["apply", "-"]), "apply");
  assert.equal(label(["tabs", "--json", "open", "a.example"]), "tabs open");
  assert.equal(label(["groups", "move", "g-1", "--parent", "P", "--unpin"]), "groups move");
});

test("anything argparse might read differently goes to Python", () => {
  for (const argv of [
    ["call"],
    ["call", "x", "--jso"],
    ["call", "x", "-h"],
    ["call", "x", "--timeout", "0"],
    ["call", "x", "--timeout", "1e2"],
    ["call", "x", "--timeout", "601"],
    ["call", "x", "-pq=1"],
    ["call", "x", "-p", "-1"],
    ["call", "x", "--", "y"],
    ["--port", "9222", "call", "x"],
    ["run", "a", "--json", "b"],
    ["run", "a", "b", "c"],
    ["events", "a", "--json", "b"],
    ["tabs", "open"],
    ["tabs", "--window", "1", "open", "x"],
    ["tabs", "move", "t", "--top", "--group", "g"],
    ["tabs", "move", "t", "--before", "a", "--after", "b"],
    ["tabs", "open", "x", "--pin", "tiles"],
    ["tabs", "close", "t", "--json=1"],
    ["groups", "update", "g", "--color", "teal"],
    ["groups", "move", "g", "--pin", "--unpin"],
    ["groups", "rename", "g"],
    ["--data-dir", "--json", "call", "x"],
  ]) {
    assert.equal(parseCommand(argv), undefined, argv.join(" "));
  }
});

test("values, lists, last-wins and hoisted flags land where argparse puts them", () => {
  const found = parseCommand(["--data-dir", "/d", "call", "m", "--params", "-", "-p", "a=1", "--param", "b:=2", "--data-dir=/e"]);
  assert.ok(found);
  assert.equal(found.dataDir, "/e");
  assert.equal(found.command.subcommand, "other");
  const groups = parseCommand(["groups", "create", "--url", "a", "--url", "b", "--name", "N"]);
  assert.equal(groups?.label, "groups create");
  assert.equal(parseCommand(["tabs", "move", "--group", "Work", "tab-1", "tab-2"])?.label, "tabs move");
});

test("the route serves a command only when served.txt lists it", () => {
  const table = servedTable("--version rust\ntabs rust\ncall * ts\ntabs open ts\n");
  assert.equal(route(["call", "windows"], table, parseCommand).kind, "command");
  assert.equal(route(["tabs", "open", "x"], table, parseCommand).kind, "command");
  assert.equal(route(["tabs", "close", "x"], table, parseCommand).kind, "python");
  assert.equal(route(["methods"], table, parseCommand).kind, "python");
  assert.equal(route(["tabs"], table, parseCommand).kind, "listing");
});

test("strip helpers keep Python's whitespace and slice without rebuilding long text", () => {
  assert.equal(strip("　\x1c a b \t", isSpace), "a b");
  assert.equal(lstrip("\x1f x "), "x ");
  assert.equal(rstrip(" x "), " x");
  const long = `${"a".repeat(2_000_000)} `;
  const started = performance.now();
  assert.equal(rstrip(long).length, 2_000_000);
  assert.ok(performance.now() - started < 2000);
});
