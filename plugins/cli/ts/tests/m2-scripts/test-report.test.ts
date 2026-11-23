import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe as group, expect, test } from "bun:test";
import "../libc-loaded.ts";
import { expandUser } from "../../src/paths.ts";
import { clip, describe, formatReport, Report, reportJson } from "../../src/scripts/test-run.ts";

const PYTHON = process.env.ARDIA_TEST_PYTHON;
const SKIP = PYTHON === undefined ? "needs ARDIA_TEST_PYTHON, a CPython 3.13" : false;
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const ORACLE = `
import json, os, sys
from ardia_cli import scripts_test
data = json.load(sys.stdin)
out = {"describe": [scripts_test.describe(arg) for arg in data["args"]], "clip": [scripts_test.clip(t) for t in data["clips"]], "reports": [], "homes": [os.path.expanduser(p) for p in data["homes"]]}
for fields in data["reports"]:
    report = scripts_test.Report(script=fields["script"], url=fields["url"], run_at=fields["run_at"])
    for key, value in fields["set"].items():
        setattr(report, key, value)
    out["reports"].append([scripts_test.format_report(report), json.dumps(report.to_dict(), indent=2, ensure_ascii=False)])
print(json.dumps(out))
`;

const ARGS: Record<string, unknown>[] = [
  { type: "string", value: "plain" },
  { type: "number", value: 3 },
  { type: "number", value: 2.5 },
  { type: "boolean", value: true },
  { type: "object", subtype: "null", value: null },
  { type: "undefined" },
  { type: "number", unserializableValue: "-Infinity", description: "-Infinity" },
  { type: "object", className: "Object", description: "Object", preview: { type: "object", description: "Object", overflow: false, properties: [{ name: "a", type: "number", value: "1" }, { name: "b", type: "string", value: "é\"x" }] } },
  { type: "object", subtype: "array", className: "Array", description: "Array(3)", preview: { type: "object", subtype: "array", description: "Array(3)", overflow: true, properties: [{ name: "0", type: "number", value: "1" }, { name: "1", type: "string", value: "two" }] } },
  { type: "object", className: "Map", description: "Map(1)", preview: { type: "object", subtype: "map", description: "Map(1)", overflow: false, properties: [] } },
  { type: "function", className: "Function", description: "function f() {}" },
  { type: "object", className: "HTMLDivElement", description: "" },
  { type: "symbol" },
];

const CLIPS = ["short", "x".repeat(2000), "é".repeat(2001), "😀".repeat(2003)];

type Fixture = { script: string; url: string; run_at: string; set: Record<string, unknown> };

const REPORTS: Fixture[] = [
  { script: "a.user.ts", url: "https://example.com/", run_at: "document-end", set: {} },
  {
    script: "a.user.ts",
    url: "https://example.com/",
    run_at: "document-idle",
    set: {
      final_url: "https://example.com/next",
      frames: [
        { url: "https://example.com/", top: true, state: "start", detail: null },
        { url: "https://example.com/", top: true, state: "done", detail: null },
        { url: "https://frame.test/", top: false, state: "skip", detail: "no rule matches" },
        { url: "https://frame2.test/", top: false, state: "done", detail: null },
      ],
      console: [{ level: "warn", text: "careful ☃", at: "a.user.ts:3:9", frame: null }, { level: "log", text: "in frame", at: "a.user.ts:4:1", frame: "iframe" }],
      exceptions: [{ text: "Uncaught Error: x\n    at a.user.ts:9:1", frame: null, at: "a.user.ts:9:1" }, { text: "Uncaught boom", frame: "iframe", at: "a.user.ts:2:2" }],
      page_errors: [{ text: "Uncaught TypeError: nope\n    at page.js:1:1", frame: null }, { text: "", frame: null }],
      page_console: 4,
      expect: { truthy: true, value: { a: [1, "é", null, true] }, expression: "window.x" },
      screenshot: "/tmp/shot.png",
      warnings: ["first", "second"],
      kept: "TARGET1",
    },
  },
  { script: "b.js", url: "https://example.com/", run_at: "document-start", set: { frames: [{ url: "u", top: true, state: "skip", detail: "@noframes" }], expect: { error: "ReferenceError: q is not defined", expression: "q" } } },
  { script: "b.js", url: "https://example.com/", run_at: "document-start", set: { frames: [{ url: "u", top: true, state: "start", detail: null }], expect: { truthy: false, value: 0, undefined: true, expression: "void 0" } } },
  { script: "b.js", url: "https://example.com/", run_at: "document-end", set: { error: "couldn't open https://example.com/: net::ERR_NAME_NOT_RESOLVED" } },
  { script: "b.js", url: "https://example.com/", run_at: "document-end", set: { frames: [{ url: "u", top: true, state: "done", detail: null }], expect: { truthy: false, value: "", expression: "''" } } },
];

function tsReport(fixture: Fixture): Report {
  const report = new Report(fixture.script, fixture.url, fixture.run_at);
  const set = fixture.set;
  const fields: Record<string, keyof Report> = {
    final_url: "finalUrl",
    frames: "frames",
    console: "console",
    exceptions: "exceptions",
    page_errors: "pageErrors",
    page_console: "pageConsole",
    expect: "expect",
    screenshot: "screenshot",
    warnings: "warnings",
    error: "error",
    kept: "kept",
  };
  for (const [key, value] of Object.entries(set)) (report as unknown as Record<string, unknown>)[fields[key] as string] = value;
  return report;
}

group("scripts test reports", () => {
  test.skipIf(SKIP !== false)("describe, clip, the text report and the JSON report match scripts_test.py", () => {
    const homes = ["~root/x", "~root", "~no_such_account_zz/x", "~/y", "~"];
    const ran = spawnSync(PYTHON as string, ["-c", ORACLE], {
      input: JSON.stringify({ args: ARGS, clips: CLIPS, reports: REPORTS, homes }),
      encoding: "utf8",
      env: { ...process.env, PYTHONPATH: CLI },
    });
    expect(ran.stderr).toBe("");
    const oracle = JSON.parse(ran.stdout) as { describe: string[]; clip: string[]; reports: [string, string][]; homes: string[] };
    expect(ARGS.map(describe)).toEqual(oracle.describe);
    expect(CLIPS.map(clip)).toEqual(oracle.clip);
    expect(REPORTS.map((fixture) => [formatReport(tsReport(fixture)), reportJson(tsReport(fixture))])).toEqual(oracle.reports);
    expect(homes.map(expandUser)).toEqual(oracle.homes);
  });
});
