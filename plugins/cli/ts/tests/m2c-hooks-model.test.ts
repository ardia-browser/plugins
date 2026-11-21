import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import "./libc-loaded.ts";
import { Float, type JsonObject, type Value } from "../src/json.ts";
import { JsonDecodeError, JsonValueError, loads, parseConfigJson } from "../src/pylib/jsonloads.ts";
import { didYouMean } from "../src/pylib/close.ts";
import { agentPlistText, serviceUnit } from "../src/hooks/agent.ts";
import { minimizedUrl, parseAnswer } from "../src/hooks/decide.ts";
import { formatDuration, hookFrom, makeHook, parseDuration, parseHooks, HooksError, HookValueError } from "../src/hooks/model.ts";
import { hookEnv, envValue } from "../src/hooks/runner.ts";
import { nextAt, occurrence } from "../src/hooks/schedule.ts";
import { knownZone } from "../src/hooks/zones.ts";
import { formatG } from "../src/stream.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const python = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "hooks-python.json"), "utf8"));

function plain(value: Value): unknown {
  if (value instanceof Map) return Object.fromEntries([...value].map(([key, item]) => [key, plain(item)]));
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Float) return value.value;
  return value;
}

function object(entries: Record<string, unknown>): JsonObject {
  const convert = (item: unknown): Value => {
    if (Array.isArray(item)) return item.map(convert);
    if (item !== null && typeof item === "object") return new Map(Object.entries(item).map(([key, inner]) => [key, convert(inner)]));
    if (typeof item === "number") return Number.isInteger(item) ? BigInt(item) : new Float(item);
    return item as Value;
  };
  return convert(entries) as JsonObject;
}

test("json errors read like CPython 3.13's", () => {
  const cases: [string, string, number, number, number][] = [
    ['{"a":"\\u12"}', "Invalid \\uXXXX escape", 7, 1, 8],
    ['"\\uZZZZ"', "Invalid \\uXXXX escape", 2, 1, 3],
    ['"\\ud800\\uZZ00"', "Invalid \\uXXXX escape", 8, 1, 9],
    ['"ab\\q"', "Invalid \\escape", 3, 1, 4],
    ["[1,]", "Illegal trailing comma before end of array", 2, 1, 3],
    ['{"a":1,}', "Illegal trailing comma before end of object", 6, 1, 7],
    ['{"a" 1}', "Expecting ':' delimiter", 5, 1, 6],
    ["{1:2}", "Expecting property name enclosed in double quotes", 1, 1, 2],
    ["[1 2]", "Expecting ',' delimiter", 3, 1, 4],
    ['"abc', "Unterminated string starting at", 0, 1, 1],
    ['"a\u0001"', "Invalid control character at", 2, 1, 3],
    ["-", "Expecting value", 0, 1, 1],
    ["[-x]", "Expecting value", 1, 1, 2],
    ["1.", "Extra data", 1, 1, 2],
    ["01", "Extra data", 1, 1, 2],
    ["", "Expecting value", 0, 1, 1],
    ["  ", "Expecting value", 2, 1, 3],
    ["﻿{}", "Unexpected UTF-8 BOM (decode using utf-8-sig)", 0, 1, 1],
    ['{"a":1}x', "Extra data", 7, 1, 8],
    ["[1,\n 2,]", "Illegal trailing comma before end of array", 6, 2, 3],
    ['"\\u1234', "Unterminated string starting at", 0, 1, 1],
  ];
  for (const [text, msg, pos, line, column] of cases) {
    assert.throws(
      () => loads(text),
      (error: unknown) => error instanceof JsonDecodeError && error.msg === msg && error.pos === pos && error.lineno === line && error.colno === column,
      text,
    );
  }
  assert.throws(() => parseConfigJson("[NaN]"), (error: unknown) => error instanceof JsonValueError && error.message === "NaN isn't valid JSON");
  assert.throws(() => parseConfigJson("[1e999]"), (error: unknown) => error instanceof JsonValueError && error.message === "1e999 is too large a number");
  assert.deepEqual(plain(loads('{"a": [1, 2.5, "\\ud83d\\ude00"], "a": true}')), { a: true });
  assert.equal(loads('"\\ud83d\\ude00"'), "\u{1f600}");
});

test("did-you-mean ranks like difflib.get_close_matches", () => {
  assert.equal(didYouMean("matc", ["name", "on", "match", "run"]), " (did you mean match?)");
  assert.equal(didYouMean("tab.opned", ["tab.opened", "tab.closed", "tab.moved"]), " (did you mean tab.opened, tab.moved or tab.closed?)");
  assert.equal(didYouMean("RUN", ["run"]), " (did you mean run?)");
  assert.equal(didYouMean("zzz", ["name"]), "");
});

test("durations and %g match Python", () => {
  for (const [text, seconds] of Object.entries(python.durations as Record<string, number | null>)) assert.equal(parseDuration(text), seconds, text);
  for (const [seconds, text] of Object.entries(python.formats as Record<string, string>)) assert.equal(formatDuration(Number(seconds)), text);
  assert.equal(formatG(60), "60");
  assert.equal(formatG(2.5), "2.5");
  assert.equal(formatG(0.1), "0.1");
  assert.equal(formatG(1234567), "1.23457e+06");
  assert.equal(formatG(0.00001), "1e-05");
});

test("the LaunchAgent plist and the systemd unit are byte for byte Python's", () => {
  const mac = { home: "/Users/x", cliHome: "/Users/x/cli", linux: false, configHome: null, stateHome: null, ardiaConfigHome: null };
  assert.equal(agentPlistText(mac, "/Users/x/cli/current/bin/ardia", "/usr/bin:/a & <b>"), python.plist);
  const linux = { home: "/home/x", cliHome: "/home/x/.local/share/ardia/cli", linux: true, configHome: "/home/x/.config", stateHome: "/home/x/.local/state", ardiaConfigHome: "/home/x/.config" };
  assert.equal(serviceUnit(linux, "/home/x/.local/share/ardia/cli/current/bin/ardia", "/p%a$b\"c"), python.unit);
  assert.throws(() => serviceUnit({ ...linux, home: "/home/a\nb" }, "/x", undefined), HooksError);
});

test("hook programs get the event's environment, trimmed and private where Python trims it", () => {
  const event = object({ event: "tab.navigated", data: { windowId: "w1", tabId: 7, url: "https://a/?q#f", title: `T\u0000x${"é".repeat(3000)}`, profile: null, x: { a: 1 } } });
  assert.deepEqual(hookEnv(event, { ARDIA_URL: "old", KEEP: "1" }), python.env);
  assert.deepEqual(hookEnv(object({ event: "notification.shown", data: { url: "u", title: "t", tabId: "t1" } }), {}), python.note_env);
  assert.equal(Buffer.byteLength(envValue("é".repeat(3000))), 4096);
});

test("decide answers parse strictly and URLs lose their query and fragment", () => {
  for (const [text, expected] of Object.entries(python.answers as Record<string, unknown>)) {
    const answer = parseAnswer(Buffer.from(text));
    if (expected === null && !["null"].includes(text.trim())) assert.equal(answer, undefined, text);
    else if (text.includes("NaN")) assert.ok(answer instanceof Map && Number.isNaN((answer.get("a") as Float).value));
    else assert.deepEqual(answer === undefined ? undefined : plain(answer), expected, text);
  }
  assert.deepEqual(["https://a/b?c#d", "https://a/b#d?c", "https://a/b"].map(minimizedUrl), python.minimized);
});

test("schedules land where Python's do, across zones and DST", () => {
  const saved = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    for (const row of python.next_at as { zone: string | null; at: string; days: string[]; after: number; next: number; occurrence: string }[]) {
      const hook = hookFrom(object({ name: "h", at: row.at, run: ["/bin/true"], ...(row.days.length > 0 ? { days: row.days } : {}), ...(row.zone ? { timezone: row.zone } : {}) }));
      const stamp = nextAt(hook, row.after);
      assert.equal(stamp, row.next, `${row.zone} ${row.at} ${row.days} ${row.after}`);
      assert.equal(occurrence(hook, stamp), row.occurrence);
    }
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});

test("zone names are checked against the zoneinfo files, as ZoneInfo does", () => {
  assert.ok(knownZone("Europe/Paris"));
  assert.ok(knownZone("UTC"));
  assert.ok(!knownZone("Mars/Base"));
  assert.ok(!knownZone("/etc/localtime"));
  assert.ok(!knownZone("../zoneinfo/UTC"));
  assert.ok(!knownZone(""));
});

test("hooks.json problems are joined in file order", () => {
  assert.throws(
    () => parseHooks(JSON.stringify({ hooks: [{ name: "a", on: "tab.opened" }, 3, { name: "a", on: "tab.opened", run: ["/x"] }, { name: "a", on: "tab.opened", run: ["/x"] }] })),
    (error: unknown) => error instanceof HooksError && error.message === "hook a: give exactly one of run, command or a decide answer (rewrite, cancel, route, drop, folder, permission); hook 2 must be an object; hook a: the name is used twice; hook a: the name is used twice",
  );
  assert.throws(() => makeHook("on", ["tab.idle"], [], ["/bin/true"]), (error: unknown) => error instanceof HookValueError && error.message === "tab.idle needs an idle threshold, like --idle 30m");
  const hook = hookFrom(object({ name: "r", on: "tab.opening", cancel: true }));
  assert.equal(hook.action(), "answers in Ardia (cancel)");
  assert.equal(hook.revision.length, 32);
  assert.equal(hook.raw, '{"cancel":true,"name":"r","on":"tab.opening"}');
});
