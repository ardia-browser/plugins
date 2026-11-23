import { expect, test } from "bun:test";
import "./libc-loaded.ts";
import { type JsonObject, object, type Value } from "../src/json.ts";
import { strerror } from "../src/libc.ts";
import { cleanEvent } from "../src/telemetry-schema.ts";

const UUID = "0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0";

function record(event: string, properties: [string, Value][]): JsonObject {
  return object([
    ["event", event],
    ["uuid", UUID],
    ["timestamp", "2026-11-20T12:00:00Z"],
    ["distinct_id", UUID],
    ["properties", object(properties)],
  ]);
}

function cleaned(event: string, properties: [string, Value][]): JsonObject {
  return (cleanEvent(record(event, properties)) as JsonObject).get("properties") as JsonObject;
}

test("a command, subcommand or flag outside the CLI's own tables is replaced or dropped at upload", () => {
  const kept = cleaned("cli_command", [
    ["command", "tabs"],
    ["subcommand", "close"],
    ["flags", "--json,--data-dir"],
  ]);
  expect([kept.get("command"), kept.get("subcommand"), kept.get("flags")]).toEqual(["tabs", "close", "--json,--data-dir"]);
  const browse = cleaned("cli_command", [["command", "browse"], ["subcommand", "snapshot"], ["flags", "-i,--json"]]);
  expect([browse.get("command"), browse.get("subcommand"), browse.get("flags")]).toEqual(["browse", "snapshot", "-i,--json"]);
  const odd = cleaned("cli_command", [
    ["command", "mysecretproject"],
    ["subcommand", "hunter2"],
    ["flags", "--json,--my-private-flag"],
  ]);
  expect([odd.get("command"), odd.get("subcommand"), odd.get("flags")]).toEqual(["other", "other", "--json"]);
  expect(cleaned("cli_command", [["subcommand", null]]).get("subcommand")).toBe(null);
});

test("exception types, values and sources come from fixed sets; frames are dropped", () => {
  const frame = object([
    ["platform", "custom"],
    ["lang", "python"],
    ["function", "user_supplied_name"],
    ["module", "ardia_cli.cli"],
    ["filename", "ardia_cli.cli"],
    ["lineno", 12n],
    ["colno", null],
    ["resolved", true],
    ["in_app", true],
  ]);
  const entry = (type: string, value: string, source: string) =>
    object([
      ["type", type],
      ["value", value],
      ["mechanism", object([["type", source], ["handled", false], ["synthetic", false]])],
      ["stacktrace", object([["type", "raw"], ["frames", [frame]]])],
    ]);
  const errno = `[Errno 2] ${strerror(2)}`;
  const props = cleaned("$exception", [
    ["$exception_level", "fatal"],
    ["source", "made_up_source"],
    ["$exception_types", ["ValueError", "MyCustomLeak"]],
    ["$exception_values", ["list index out of range", "secret_identifier", errno, "[Errno 2] my words here"]],
    ["$exception_list", [entry("KeyError", "secret_identifier", "cli_unhandled"), entry("SecretType", "ValueError", "browse_daemon")]],
  ]);
  expect(props.get("source")).toBe("other");
  expect(props.get("$exception_types")).toEqual(["ValueError", "other"]);
  expect(props.get("$exception_values")).toEqual(["list index out of range", "other", errno, "other"]);
  const list = props.get("$exception_list") as JsonObject[];
  expect(list.map((item) => [item.get("type"), item.get("value"), (item.get("mechanism") as JsonObject).get("type")])).toEqual([
    ["KeyError", "other", "cli_unhandled"],
    ["other", "ValueError", "browse_daemon"],
  ]);
  expect(list.map((item) => (item.get("stacktrace") as JsonObject).get("frames"))).toEqual([[], []]);
});
