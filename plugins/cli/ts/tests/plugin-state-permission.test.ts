import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkManifest } from "../src/app-manifest/pluginManifest.ts";
import { parseText, type Value } from "../src/json.ts";
import { manifestProblems } from "../src/plugin-rules.ts";

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "ardia-plugin-state-"));
const SHIPPED = fs.readFileSync(path.join(import.meta.dir, "..", "assets", "plugin.schema.json"), "utf8");

function manifest(permissions: Record<string, unknown>): Record<string, unknown> {
  return { manifest: 2, name: "stateful", title: "Stateful", icon: "bolt", main: "dist/index.js", permissions };
}

function installProblems(doc: Record<string, unknown>): string[] {
  return manifestProblems({ data_dir: DATA }, parseText(JSON.stringify(doc)) as Map<string, Value>);
}

const VALID: Record<string, unknown>[] = [
  { state: { events: ["downloads"] } },
  { state: false },
  { tabs: "write", state: { intents: ["tabs.group", "tabs.move", "groups.update"] } },
  { tabs: "read", state: { events: ["tabs", "navigation", "downloads"] } },
  { tabs: "write", state: { events: ["workspace"], intents: ["tabs.pin", "tabs.activate"] } },
];

const INVALID: [Record<string, unknown>, string][] = [
  [{ state: { events: ["downloads"], watch: true } }, "watch"],
  [{ state: { events: ["clipboard"] } }, "events"],
  [{ tabs: "write", state: { intents: ["tabs.close"] } }, "intents"],
  [{ tabs: "read", state: { intents: ["tabs.group"] } }, "tabs: write"],
  [{ state: { events: ["tabs"] } }, "needs tabs"],
  [{ state: true }, "state"],
];

test("the shipped schema describes permissions.state as ardia main does", () => {
  const state = SHIPPED.slice(SHIPPED.indexOf('"state": {'));
  expect(SHIPPED).toContain('"state": {');
  expect(state).toContain('"downloads"');
  expect(state).toContain('"tabs.group"');
});

test("plugins install and the app's own checker accept every valid permissions.state", () => {
  for (const permissions of VALID) {
    const doc = manifest(permissions);
    expect(installProblems(doc), JSON.stringify(permissions)).toEqual([]);
    const read = checkManifest(JSON.parse(JSON.stringify(doc)), 2);
    expect(read.problems, JSON.stringify(permissions)).toEqual([]);
    const state = read.manifest?.permissions.state;
    if (permissions["state"] === false) expect(state).toBe(false);
    else expect(state as unknown).toEqual({ events: (permissions["state"] as { events?: string[] }).events ?? [], intents: (permissions["state"] as { intents?: string[] }).intents ?? [] });
  }
});

test("plugins install and the app's own checker refuse unknown state keys, events and intents, and intents or tab events without the tabs they need", () => {
  for (const [permissions, said] of INVALID) {
    const problems = installProblems(manifest(permissions));
    expect(problems.length, JSON.stringify(permissions)).toBeGreaterThan(0);
    expect(problems.join("\n"), JSON.stringify(permissions)).toContain("permissions");
    const read = checkManifest(JSON.parse(JSON.stringify(manifest(permissions))), 2);
    expect(read.problems.join("\n"), JSON.stringify(permissions)).toContain(said);
  }
});
