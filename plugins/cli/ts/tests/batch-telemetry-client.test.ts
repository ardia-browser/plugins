import { expect, test } from "bun:test";
import "./libc-loaded.ts";
import { type Value } from "../src/json.ts";
import { noteAnswerCodes } from "../src/browse/index.ts";
import { Call } from "../src/telemetry.ts";

test("the client copies the failed step into the event", () => {
  const call = new Call(["browse", "batch"]);
  noteAnswerCodes(new Map<string, Value>([["code", "not_found"], ["failed_step_command", "find"]]), call);
  expect([call.errorCode, call.metrics.get("failed_step_command")]).toEqual(["not_found", "find"]);
  const odd = new Call(["browse", "batch"]);
  noteAnswerCodes(new Map<string, Value>([["failed_step_command", "https://example.com/?q=secret"]]), odd);
  expect(odd.metrics.get("failed_step_command")).toBe("other");
});
