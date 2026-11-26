import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./load.mjs";
import { raw } from "./fixtures.mjs";

const { defineCliSpec, createSidecarCore, verbOutcome, CREDENTIAL_LIMITS } = await load("index");

const spec = defineCliSpec(raw);
const LIMIT = CREDENTIAL_LIMITS.retainedLines;
const many = Array.from({ length: LIMIT + 1 }, (_, i) => `line ${i}`);
const done = { launched: true, status: 0, stdout: `${many.join("\n")}\n`, stderr: "", timedOut: false, overflowed: false, cancelled: false };

test(`retainedLines is ${LIMIT}`, () => {
  assert.equal(LIMIT, 1000);
});

for (const verb of ["item.get", "login"]) {
  const mode = spec.verbs[verb].output.mode;

  test(`a finished ${mode} verb with ${LIMIT + 1} stdout lines keeps the last ${LIMIT} and counts one dropped`, () => {
    const outcome = verbOutcome(spec.verbs[verb], done, [], []);
    assert.equal(outcome.lines.length, LIMIT);
    assert.equal(outcome.droppedLines, 1);
    assert.deepEqual([outcome.lines[0], outcome.lines.at(-1)], ["line 1", `line ${LIMIT}`]);
  });

  test(`the sidecar's completed ${mode} reply holds at most ${LIMIT} lines with droppedLines 1`, async () => {
    const launcher = (launch, io) => {
      for (const text of many) io.onLine({ stream: "stdout", text });
      return Promise.resolve(done);
    };
    const core = createSidecarCore(spec, launcher);
    const reply = await core.handle("cli.run", { verb, params: verb === "item.get" ? { id: "a1" } : {} });
    assert.equal(reply.running, undefined);
    assert.equal(reply.succeeded, true);
    assert.equal(reply.lines.length, LIMIT);
    assert.equal(reply.droppedLines, 1);
    assert.equal(reply.lines.at(-1), `line ${LIMIT}`);
    core.dispose();
  });
}

test(`exactly ${LIMIT} lines drop none`, () => {
  const outcome = verbOutcome(spec.verbs["item.get"], { ...done, stdout: many.slice(1).join("\n") }, [], []);
  assert.deepEqual([outcome.lines.length, outcome.droppedLines], [LIMIT, 0]);
});
