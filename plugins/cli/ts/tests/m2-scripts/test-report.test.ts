import { readFileSync } from "node:fs";
import { describe as group, expect, test } from "bun:test";
import "../libc-loaded.ts";
import { expandUser } from "../../src/paths.ts";
import { clip, describe, formatReport, Report, reportJson } from "../../src/scripts/test-run.ts";
import { oracle } from "../oracle-fixtures.ts";

type Fixture = { script: string; url: string; run_at: string; set: Record<string, unknown> };
const FROZEN = oracle<{ describe: [Record<string, unknown>, string][]; clip: [string, string][]; reports: [Fixture, [string, string]][] }>("test-report");

function rootHome(): string {
  const entry = readFileSync("/etc/passwd", "utf8").split("\n").find((line) => line.startsWith("root:"));
  if (entry === undefined) throw new Error("no root entry in /etc/passwd");
  return entry.split(":")[5] as string;
}

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
  test("describe, clip, the text report and the JSON report match scripts_test.py", () => {
    expect([FROZEN.describe.length, FROZEN.clip.length, FROZEN.reports.length]).toEqual([13, 4, 6]);
    expect(FROZEN.describe.map(([arg]) => describe(arg))).toEqual(FROZEN.describe.map(([, want]) => want));
    expect(FROZEN.clip.map(([text]) => clip(text))).toEqual(FROZEN.clip.map(([, want]) => want));
    expect(FROZEN.reports.map(([fixture]) => [formatReport(tsReport(fixture)), reportJson(tsReport(fixture))])).toEqual(FROZEN.reports.map(([, want]) => want));
  });

  test("a ~user path expands to that account's home and ~ to $HOME, as os.path.expanduser does", () => {
    const home = process.env.HOME as string;
    expect(["~root/x", "~root", "~no_such_account_zz/x", "~/y", "~"].map(expandUser)).toEqual([`${rootHome()}/x`, rootHome(), "~no_such_account_zz/x", `${home}/y`, home]);
  });
});
