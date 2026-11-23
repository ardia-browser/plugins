import { expect, test } from "bun:test";
import "./libc-loaded.ts";
import { type JsonObject, object, type Value } from "../src/json.ts";
import { answerFields, begin, failedStep, recordAnswer, stepCommand } from "../src/browse/metrics.ts";
import { stepName } from "../src/browse/commands/batch.ts";
import "../src/browse/commands/read.ts";
import { dispatch } from "../src/browse/commands/index.ts";
import { Ctx } from "../src/browse/commands/ctx.ts";
import { encodeAnswer } from "../src/browse/daemon/render.ts";
import type { State } from "../src/browse/state/state.ts";
import { allowedFlags } from "../src/browse/args.ts";
import { cleanEvent } from "../src/telemetry-schema.ts";
import { knownFlags } from "../src/telemetry-names.ts";

const UUID = "0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0";

async function batchFields(lines: string[][], flags: string[] = []) {
  return begin({ argv: ["batch"], }, async (metrics) => {
    const ctx = new Ctx({} as unknown as State, {}, "/", {}, null, "batch");
    const result = await dispatch(ctx, "batch", [...flags, ...lines.map((line) => JSON.stringify(line))]);
    recordAnswer(metrics, "batch", result as never, null, "");
    return answerFields(metrics);
  });
}

function cleaned(properties: [string, Value][]): JsonObject {
  const record = object([["event", "cli_command"], ["uuid", UUID], ["timestamp", "2026-11-20T12:00:00Z"], ["distinct_id", UUID], ["properties", object(properties)]]);
  return (cleanEvent(record) as JsonObject).get("properties") as JsonObject;
}

test("a failed batch records the first failing step's index, command and code", async () => {
  const fields = await batchFields([["batch", "x"], ["install"]]);
  expect(fields.metrics?.get("failed_step_index")).toBe(0);
  expect(fields.failed_step_command).toBe("batch");
  expect(fields.code).toBe("command_failed");
  const second = await batchFields([["frobnicate"], ["install"]], ["--bail"]);
  expect([second.metrics?.get("failed_step_index"), second.failed_step_command]).toEqual([0, "other"]);
});

test("a leading line option doesn't hide the command that ran, and the step's own code is kept", async () => {
  const fields = await batchFields([["--full", "install"], ["frobnicate", "secret-text"]]);
  expect([fields.metrics?.get("failed_step_index"), fields.failed_step_command, fields.code]).toEqual([0, "install", "unsupported"]);
  expect(stepName(["--max-output", "100", "snapshot", "-i"])).toBe("snapshot");
  expect(stepName(["--headed", "open", "x"])).toBe("");
  expect(stepName(["wait", "0", "--max-output", "lots"])).toBe("wait");
  expect(stepName(["goto", "x"])).toBe("goto");
  expect(stepName(["--max-output", "eval", "click", "X"])).toBe("click");
  expect(stepName(["--session", "open", "click", "X"])).toBe("click");
  expect(stepName(["--max-output"])).toBe("");
  expect(stepName(["--headers", "eval", "click", "X"])).toBe("");
  expect(stepName(["--proxy=x", "open"])).toBe("");
  expect(stepCommand("goto")).toBe("open");
  expect(stepCommand("https://example.com/?token=x")).toBe("other");
});

test("a line that can't be parsed is recorded as the failed step, as other", async () => {
  for (const bad of ["[bad", "install 'unclosed"]) {
    const fields = await begin({ argv: ["batch"] }, async (metrics) => {
      const ctx = new Ctx({} as unknown as State, {}, "/", {}, null, "batch");
      await dispatch(ctx, "batch", [JSON.stringify(["install"]), bad]).catch(() => undefined);
      return answerFields(metrics);
    });
    expect([fields.metrics?.get("failed_step_index"), fields.failed_step_command]).toEqual([1, "other"]);
  }
});

test("an oversized answer drops metrics before going over its limit", () => {
  const metrics = new Map<string, Value>([["failed_step_index", 1n], ["action_ms", 12n], ["cdp_calls", 3n], ["cdp_ms_total", 4n], ["humanize", false], ["output_truncated", false], ["batch_steps", 2n]]);
  const answer = encodeAnswer(1, "x".repeat(900), "", [["metrics", metrics], ["code", "not_found"], ["failed_step_command", "click"]], 300);
  const parsed = JSON.parse(answer.toString("utf8"));
  expect(answer.length).toBeLessThanOrEqual(300);
  expect([parsed.code, parsed.failed_step_command, parsed.metrics]).toEqual(["not_found", "click", { failed_step_index: 1 }]);
  const fields: [string, Value][] = [["metrics", metrics], ["code", "not_found"], ["failed_step_command", "click"]];
  const lean = encodeAnswer(1, "x".repeat(900), "", fields, 1).length;
  const tight = encodeAnswer(1, "x".repeat(900), "", fields, lean + 10);
  expect(tight.length).toBeLessThanOrEqual(lean + 10);
  expect(JSON.parse(tight.toString("utf8")).metrics).toBe(undefined);
});

test("a failure is attributed as it happens, so a later step that ends the batch doesn't erase it", async () => {
  const fields = await begin({ argv: ["batch"] }, async (metrics) => {
    const ctx = new Ctx({} as unknown as State, {}, "/", {}, null, "batch");
    await dispatch(ctx, "batch", [JSON.stringify(["install"]), JSON.stringify(["get", "title"])]).catch(() => undefined);
    return answerFields(metrics);
  });
  expect([fields.metrics?.get("failed_step_index"), fields.failed_step_command, fields.code]).toEqual([0, "install", "unsupported"]);
});

async function failedThenRendered(lines: string[][], finalCode: string) {
  return begin({ argv: ["batch"] }, async (metrics) => {
    const ctx = new Ctx({} as unknown as State, {}, "/", {}, null, "batch");
    await dispatch(ctx, "batch", lines.map((line) => JSON.stringify(line))).catch(() => undefined);
    recordAnswer(metrics, "batch", null, { code: finalCode, exit: 1 }, "");
    return answerFields(metrics);
  });
}

test("the first failed line keeps its code when the batch then ends in a timeout or a crash", async () => {
  const timedOut = await failedThenRendered([["install"], ["get", "title"]], "command_timeout");
  expect([timedOut.metrics?.get("failed_step_index"), timedOut.failed_step_command, timedOut.code]).toEqual([0, "install", "unsupported"]);
});

test("a line that ends the batch before any line failed is the failed step, with the batch's own code", async () => {
  const first = await failedThenRendered([["get", "title"]], "command_timeout");
  expect([first.metrics?.get("failed_step_index"), first.failed_step_command, first.code]).toEqual([0, "get", "command_timeout"]);
});

test("a nested batch hidden behind a line option is refused like a plain one and keeps the outer attribution", async () => {
  const outer = await failedThenRendered([["install"], ["--full", "batch", '["batch"]']], "command_failed");
  expect([outer.metrics?.get("failed_step_index"), outer.failed_step_command, outer.code]).toEqual([0, "install", "unsupported"]);
  const alone = await failedThenRendered([["--full", "batch", "x"]], "command_failed");
  expect([alone.metrics?.get("failed_step_index"), alone.failed_step_command, alone.code]).toEqual([0, "batch", "command_failed"]);
});

test("a batch that passed records no failed step", async () => {
  const fields = begin({ argv: ["batch"], }, (metrics) => {
    recordAnswer(metrics, "batch", { data: { results: [] }, batch: [{ command: ["eval", "1"], success: true }] }, null, "");
    return answerFields(metrics);
  });
  expect([fields.code, fields.failed_step_command, fields.metrics?.has("failed_step_index")]).toEqual([undefined, undefined, false]);
});

test("a failed trailing close is the step after the last line", () => {
  const fields = begin({ argv: ["batch"], }, (metrics) => {
    metrics.values.set("batch_steps", 2);
    metrics.errorCode = "session_busy";
    failedStep(2, "close", metrics.errorCode);
    return answerFields(metrics);
  });
  expect([fields.metrics?.get("failed_step_index"), fields.failed_step_command, fields.code]).toEqual([2, "close", "session_busy"]);
});

test("an oversized answer for an uncoded failure still carries a code", () => {
  const parsed = JSON.parse(encodeAnswer(0, "x".repeat(500), "", [["daemon", "ts/1"]], 200).toString("utf8"));
  expect([parsed.exit, parsed.code]).toEqual([1, "command_failed"]);
});

test("an oversized failed batch keeps its step's code and attribution", () => {
  const fields: [string, Value][] = [["metrics", new Map<string, Value>([["failed_step_index", 1n]])], ["code", "not_found"], ["failed_step_command", "click"], ["daemon", "ts/1"]];
  const parsed = JSON.parse(encodeAnswer(1, "x".repeat(500), "", fields, 300).toString("utf8"));
  expect([parsed.exit, parsed.code, parsed.failed_step_command, parsed.metrics.failed_step_index]).toEqual([1, "not_found", "click", 1]);
});

test("a step's code outside the daemon's own set is recorded as failed", () => {
  const fields = begin({ argv: ["batch"] }, (metrics) => {
    failedStep(0, "click", "page said: secret");
    return answerFields(metrics);
  });
  expect(fields.code).toBe("failed");
});

test("every daemon exit 1 carries a code: a reported failure or an uncoded error is command_failed", () => {
  const reported = begin({ argv: ["wait"], }, (metrics) => {
    recordAnswer(metrics, "wait", { data: {}, failed: true }, null, "");
    return answerFields(metrics);
  });
  expect(reported.code).toBe("command_failed");
  const uncoded = begin({ argv: ["click"], }, (metrics) => {
    recordAnswer(metrics, "click", null, { code: null, exit: 1 }, "");
    return answerFields(metrics);
  });
  expect(uncoded.code).toBe("command_failed");
  const unreachable = begin({ argv: ["open"] }, (metrics) => {
    recordAnswer(metrics, "open", null, { code: null, exit: 2 }, "");
    return answerFields(metrics);
  });
  expect(unreachable.code).toBe(undefined);
  const coded = begin({ argv: ["click"], }, (metrics) => {
    recordAnswer(metrics, "click", null, { code: "stale_ref", exit: 1 }, "");
    return answerFields(metrics);
  });
  expect(coded.code).toBe("stale_ref");
});

test("the upload keeps the failed step's command from a closed set and the new codes as themselves", () => {
  const kept = cleaned([["failed_step_command", "find"], ["failed_step_index", 1n], ["error_code", "command_failed"]]);
  expect([kept.get("failed_step_command"), kept.get("failed_step_index"), kept.get("error_code")]).toEqual(["find", 1n, "command_failed"]);
  expect(cleaned([["failed_step_command", "hunter2"]]).get("failed_step_command")).toBe("other");
  expect(cleaned([["failed_step_command", 3n]]).has("failed_step_command")).toBe(false);
  for (const code of ["usage_error", "invalid_name", "command_failed"]) expect(cleaned([["error_code", code]]).get("error_code")).toBe(code);
});

test("the flag table knows --touch, --isolated and --main-world", () => {
  expect(allowedFlags("click")).toContain("--touch");
  expect(allowedFlags("eval")).toEqual(expect.arrayContaining(["--isolated", "--main-world"]));
  expect(allowedFlags("wait")).toEqual(expect.arrayContaining(["--isolated", "--main-world"]));
  expect(knownFlags("--isolated,--main-world,--touch")).toBe("--isolated,--main-world,--touch");
});
