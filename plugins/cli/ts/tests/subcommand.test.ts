import assert from "node:assert/strict";
import { test } from "bun:test";
import { telemetrySubcommand } from "../src/telemetry.ts";

test("cli_command's subcommand is a known name, other or unknown, never free text", () => {
  assert.equal(telemetrySubcommand("browse", "get"), "get");
  assert.equal(telemetrySubcommand("browse", "goto"), "goto");
  assert.equal(telemetrySubcommand("browse", "screenshot"), "screenshot");
  assert.equal(telemetrySubcommand("browse", "help"), "help");
  assert.equal(telemetrySubcommand("browse", "other"), "other");
  assert.equal(telemetrySubcommand("browse", "my-secret-page"), "unknown");
  assert.equal(telemetrySubcommand("browse", "tabs"), "unknown");
  assert.equal(telemetrySubcommand("browse", undefined), null);
  assert.equal(telemetrySubcommand("tabs", "list"), "list");
});
