import assert from "node:assert/strict";
import { test } from "bun:test";
import { jsonIntent, jsonIntentOfArgv } from "../src/browse/args.ts";

test("--json counts only where the global parser reads it as the switch", () => {
  delete process.env.AGENT_BROWSER_JSON;
  assert.equal(jsonIntent(["--session", "--json", "get", "title"]), false);
  assert.equal(jsonIntent(["--max-output", "--", "--json", "get", "title"]), true);
  assert.equal(jsonIntent(["get", "--", "--json"]), false);
  assert.equal(jsonIntent(["--json", "get", "title", "--session"]), true);
  assert.equal(jsonIntent(["--json=0", "get"]), false);
  assert.equal(jsonIntentOfArgv(["--data-dir", "--json", "browse", "get"]), false);
  assert.equal(jsonIntentOfArgv(["--json", "browse", "get", "title"]), true);
  assert.equal(jsonIntentOfArgv(["--port", "9", "browse", "--session", "--json", "get"]), false);
  assert.equal(jsonIntentOfArgv(["--port"]), false);
  assert.equal(jsonIntentOfArgv(["--json", "browse", "--json=false", "get"]), false);
  assert.equal(jsonIntentOfArgv(["--json", "browse", "get", "--json=0"]), false);
  assert.equal(jsonIntentOfArgv(["--json", "browse", "get", "--", "--json=0"]), true);
  process.env.AGENT_BROWSER_JSON = "1";
  assert.equal(jsonIntent(["--session", "--json", "get"]), true);
  delete process.env.AGENT_BROWSER_JSON;
});

test("--state after wait is wait's own option, not a launch option (plugins#18)", async () => {
  const { splitGlobals } = await import("../src/browse/args.ts");
  assert.deepEqual(splitGlobals(["--json", "wait", "--state=visible", "#x"]).rest, ["wait", "--state=visible", "#x"]);
  assert.deepEqual(splitGlobals(["wait", "--state", "hidden", "#x"]).rest, ["wait", "--state", "hidden", "#x"]);
  assert.throws(() => splitGlobals(["--state", "x", "wait", "#x"]), /launch options have no effect/);
  assert.throws(() => splitGlobals(["get", "--state=x", "title"]), /launch options have no effect/);
  assert.equal(jsonIntent(["wait", "--state", "visible", "--json", "#x"]), true);
});

