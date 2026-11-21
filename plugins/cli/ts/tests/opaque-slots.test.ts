import assert from "node:assert/strict";
import { test } from "node:test";
import { splitGlobals, Usage } from "../src/browse/args.ts";
import { optionsFrom } from "../src/browse/request.ts";

test("a password shaped like a shared option stays the command's argument", () => {
  const cases: [string[], string][] = [
    [["set", "credentials", "alice", "--port=9222"], "--port=9222"],
    [["set", "auth", "--session", "--json"], "--json"],
    [["fill", "@e1", "--port=9222", "--json"], "--port=9222"],
    [["type", "#pw", "--data-dir=x"], "--data-dir=x"],
    [["keyboard", "type", "--ws=ws://x"], "--ws=ws://x"],
    [["cookies", "set", "sid", "--max-output=1"], "--max-output=1"],
    [["storage", "local", "set", "token", "--namespace=n"], "--namespace=n"],
  ];
  for (const [argv, value] of cases) {
    const { found, rest } = splitGlobals(argv);
    assert.deepEqual([...found.values.keys()], [], argv.join(" "));
    assert.ok(rest.includes(value), argv.join(" "));
  }
  assert.equal(splitGlobals(["fill", "@e1", "--port=9222", "--json"]).found.flag("json"), true);
  assert.deepEqual(splitGlobals(["set", "auth", "--session", "--json"]).rest, ["set", "auth", "--session", "--json"]);
});

test("shared options outside those slots still work anywhere", () => {
  const { found, rest } = splitGlobals(["snapshot", "-i", "--json", "--port", "9222"]);
  assert.equal(found.flag("json"), true);
  assert.equal(found.value("port"), "9222");
  assert.deepEqual(rest, ["snapshot", "-i"]);
  assert.equal(splitGlobals(["set", "viewport", "--json", "800", "600"]).found.flag("json"), true);
  assert.equal(splitGlobals(["--port=9", "fill", "@e1", "x"]).found.value("port"), "9");
});

test("a usage error about an option's value never repeats the value", () => {
  const secret = "hunter2-not-a-number";
  delete process.env.AGENT_BROWSER_MAX_OUTPUT;
  const { found } = splitGlobals(["--max-output", secret, "get", "title"]);
  assert.throws(() => optionsFrom(found), (error: unknown) => error instanceof Usage && !error.message.includes(secret));
});

test("the daemon's parser keeps the same slots opaque and never repeats an inline value", async () => {
  const { parse } = await import("../src/browse/commands/parse.ts");
  const { opaqueSlot } = await import("../src/browse/opaque.ts");
  const [, args] = parse(["#pw", "--port=9222", "--no-humanize"], { "--no-humanize": "bool" }, {}, (positionals) => opaqueSlot("fill", positionals));
  assert.deepEqual(args, ["#pw", "--port=9222"]);
  assert.throws(
    () => parse(["#pw", "x", "--secret=hunter2"], { "--no-humanize": "bool" }, {}, (positionals) => opaqueSlot("fill", positionals)),
    (error: unknown) => error instanceof Error && error.message === "Unknown flag: --secret",
  );
});
