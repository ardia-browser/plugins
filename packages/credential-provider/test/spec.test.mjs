import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./load.mjs";
import { raw } from "./fixtures.mjs";

const { validateCliSpec, defineCliSpec } = await load("index");

const withVerb = (id, verb) => ({ ...raw, verbs: { ...raw.verbs, [id]: verb } });
const problemsOf = (spec) => validateCliSpec(spec).problems.join("\n");

test("a well-formed spec has no problems and keeps its verbs", () => {
  const checked = validateCliSpec(raw);
  assert.deepEqual(checked.problems, []);
  assert.equal(checked.spec.name, "fakecli");
  assert.equal(checked.spec.sessionLastsSeconds, 600);
  assert.equal(checked.spec.verbs["item.get"].slots.id.pattern, "item");
  assert.equal(checked.spec.verbs.unlock.timeoutMs, 30000);
});

test("a command that runs other programs or writes files is never allowed", () => {
  const op = { ...raw, name: "op", verbs: { run: { argv: ["run", "--", "sh"], output: { mode: "lines" } }, read: { argv: ["read", "--out-file", "x"], output: { mode: "lines" } } } };
  const problems = problemsOf(op);
  assert.match(problems, /op run is never allowed, since it runs other programs/);
  assert.match(problems, /op read with --out-file is never allowed, since it writes files/);
  assert.match(problemsOf({ ...raw, name: "bw", verbs: { serve: { argv: ["serve"], output: { mode: "lines" } } } }), /bw serve is never allowed/);
});

test("secrets stay out of argv unless argvSecrets says so", () => {
  const leaky = withVerb("leak", { argv: ["unlock", { slot: "password" }], slots: { password: { type: "secret" } }, output: { mode: "lines" } });
  assert.match(problemsOf(leaky), /a secret slot can't go in argv/);
  const prefixed = withVerb("leak", { argv: ["unlock", { slot: "password", prefix: "password=" }], slots: { password: { type: "secret" } }, output: { mode: "lines" } });
  assert.match(problemsOf(prefixed), /argvSecrets: true/);
});

test("env never takes PATH, loader or proxy variables", () => {
  assert.match(problemsOf({ ...raw, env: [{ name: "PATH", literal: "/tmp" }] }), /PATH is set by Ardia/);
  assert.match(problemsOf({ ...raw, env: [{ name: "DYLD_INSERT_LIBRARIES", literal: "x" }] }), /matches DYLD_\*/);
  assert.match(problemsOf({ ...raw, env: [{ name: "FOO", testFolder: "" }] }), /exactly one of literal or secretSlot/);
});

test("slots, patterns and output modes are checked", () => {
  assert.match(problemsOf(withVerb("unused", { argv: ["x"], slots: { id: { type: "id", pattern: "item" } }, output: { mode: "lines" } })), /isn't used in argv, env or stdin/);
  assert.match(problemsOf(withVerb("nopattern", { argv: ["x", { slot: "id" }], slots: { id: { type: "id", pattern: "missing" } }, output: { mode: "lines" } })), /must name one of cli.patterns/);
  assert.match(problemsOf({ ...raw, patterns: { bad: "(a+)+" } }), /starts with \^ and ends with \$/);
  assert.match(problemsOf(withVerb("secret", { argv: ["x"], output: { mode: "lastLineSecret" } })), /must unlock/);
  assert.match(problemsOf(withVerb("extra", { argv: ["x"], output: { mode: "lines" }, shell: true })), /shell isn't a key of a verb/);
  assert.match(problemsOf(withVerb("dash", { argv: ["x", "--"], output: { mode: "lines" } })), /lone --/);
});

test("defineCliSpec throws with every problem", () => {
  assert.throws(() => defineCliSpec({ ...raw, name: "Bad Name" }), /cli.name must be a program name/);
});
