import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generate } from "../../scripts/plugin-key-table.ts";
import { NAMED_KEYS } from "../../src/browse/input/keys.ts";
import { charEvents, clickAt, comboEvents, uncheckedComboEvents, wheelAt } from "../../src/browse/plugin/input.ts";
import { KEY_ROWS } from "../../src/browse/plugin/key-table.ts";
import { keyRefusal } from "../../src/browse/plugin/keys.ts";
import { PluginRefused } from "../../src/browse/plugin/session.ts";
import { TS_DIR } from "./daemon-helpers.ts";

setDefaultTimeout(120_000);
const ENGINE = path.join(TS_DIR, "tests", "m3", "plugin-engine");
const POLICY = path.join(ENGINE, "chrome", "browser", "ardia");
const ABSENT = "\u0001";
const MODIFIERS = ["Alt", "Control", "Meta", "Shift"];
const EXTRA_CHARS = ["é", "ß", "中", "😀", "€"];
const work = fs.mkdtempSync(path.join(os.tmpdir(), "f1e-keys-"));
const clang = spawnSync("clang++", ["--version"]).status === 0;

afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

type Event = Record<string, unknown>;

function line(event: Event): string {
  const field = (name: string) => (name in event ? String(event[name]) : ABSENT);
  const commands = Array.isArray(event["commands"]) ? (event["commands"] as string[]).join(",") : "";
  return [field("type"), field("key"), field("code"), field("windowsVirtualKeyCode"), String(event["modifiers"] ?? 0), commands, "nativeVirtualKeyCode" in event ? "1" : "0", "isSystemKey" in event ? "1" : "0"].join("\t");
}

function validator(): (events: Event[]) => string[] {
  const binary = path.join(work, "check");
  const built = spawnSync("clang++", ["-std=c++20", "-O1", `-I${ENGINE}`, path.join(ENGINE, "check.cc"), path.join(POLICY, "ac_cli_plugin_input.cc"), "-o", binary], { encoding: "utf8" });
  if (built.status !== 0) throw new Error(`the engine's key validator didn't build:\n${built.stderr}`);
  let batch = 0;
  return (events) => {
    batch += 1;
    const input = path.join(work, `events-${batch}.tsv`);
    fs.writeFileSync(input, events.map(line).join("\n") + "\n");
    const fd = fs.openSync(input, "r");
    let ran;
    try {
      ran = spawnSync(binary, [], { stdio: [fd, "pipe", "pipe"], encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
    } finally {
      fs.closeSync(fd);
    }
    const answers = ran.stdout.trimEnd().split("\n");
    if (ran.status !== 0 || answers.length !== events.length) throw new Error(`the validator answered ${answers.length} of ${events.length} events (status ${String(ran.status)}, signal ${String(ran.signal)})`);
    return answers;
  };
}

function subsets(items: readonly string[]): string[][] {
  return Array.from({ length: 1 << items.length }, (_, mask) => items.filter((_, bit) => mask & (1 << bit)));
}

function keyNames(): string[] {
  const chars = new Set<string>();
  for (const row of KEY_ROWS) for (const text of [row[2], row[3]]) if ([...text].length === 1 && text !== "\t" && text !== "\n" && text !== "+") chars.add(text);
  return [...NAMED_KEYS.keys(), ...MODIFIERS, ...chars, ...EXTRA_CHARS];
}

describe("plugin key events follow ardia#2808's key policy", () => {
  test("the daemon's key table is generated from the engine's header, unchanged", () => {
    expect(fs.readFileSync(path.join(TS_DIR, "src", "browse", "plugin", "key-table.ts"), "utf8")).toBe(generate(POLICY));
  });

  test.skipIf(!process.env["ARDIA_ENGINE_POLICY_DIR"])("the vendored engine sources match the engine checkout named by ARDIA_ENGINE_POLICY_DIR", () => {
    const engine = process.env["ARDIA_ENGINE_POLICY_DIR"] as string;
    for (const name of fs.readdirSync(POLICY)) expect(fs.readFileSync(path.join(POLICY, name), "utf8")).toBe(fs.readFileSync(path.join(engine, name), "utf8"));
  });

  test.skipIf(!clang)("every key event the daemon can send passes the engine's compiled validator, and every combo it refuses the engine would refuse", () => {
    const check = validator();
    const sent: Event[] = [];
    const refusedRaw: [string, Event[]][] = [];
    let combos = 0;
    for (const key of keyNames()) {
      for (const held of subsets(MODIFIERS)) {
        if (held.includes(key)) continue;
        const combo = [...held, key].join("+");
        let raw: Event[];
        try {
          raw = uncheckedComboEvents(combo);
        } catch {
          continue;
        }
        combos += 1;
        try {
          sent.push(...comboEvents(combo));
        } catch (error) {
          if (!(error instanceof PluginRefused)) throw error;
          refusedRaw.push([combo, raw]);
        }
      }
      const typed = charEvents(key);
      if (typed !== null) sent.push(...typed);
    }
    const answers = check(sent);
    const rejected = sent.map((event, index) => [JSON.stringify(event), answers[index]]).filter(([, answer]) => answer !== "ok");
    expect(rejected).toEqual([]);
    const flat = refusedRaw.flatMap(([combo, raw]) => raw.map((event) => [combo, event] as const));
    const verdicts = check(flat.map(([, event]) => event));
    const engineRefused = new Set(flat.filter((_, index) => verdicts[index] !== "ok").map(([combo]) => combo));
    const overRefused = refusedRaw.map(([combo]) => combo).filter((combo) => !engineRefused.has(combo));
    expect(overRefused).toEqual([]);
    expect(sent.every((event) => keyRefusal(event) === null)).toBe(true);
    expect(combos).toBeGreaterThan(1000);
    expect(sent.length).toBeGreaterThan(1500);
  });

  test("text no key event can type goes through Input.insertText", () => {
    for (const char of EXTRA_CHARS) expect(charEvents(char)).toBeNull();
    expect(charEvents("a")).not.toBeNull();
  });
});

describe("plugin wheels and clicks follow ardia#2808's pointer policy", () => {
  test.skipIf(!clang)("every wheel and Ardia.dispatchClick the daemon sends passes the engine's compiled validator", async () => {
    const binary = path.join(work, "check_pointer");
    const built = spawnSync("clang++", ["-std=c++20", "-O1", `-I${ENGINE}`, path.join(ENGINE, "check_pointer.cc"), path.join(POLICY, "ac_cli_plugin_input.cc"), "-o", binary], { encoding: "utf8" });
    expect(built.stderr).toBe("");
    const sent: [string, Record<string, unknown>][] = [];
    const page = { send: async (method: string, params: Record<string, unknown>) => (sent.push([method, params]), {}) } as never;
    for (const [x, y, dx, dy] of [[500, 400, 0, 2600], [500, 400, 0, -900], [1, 1, 300, 0], [999.5, 0.5, -10.25, 0]] as const) await wheelAt(page, x, y, dx, dy);
    for (const button of ["left", "right"]) for (const count of [1, 2]) await clickAt(page, 35.5, 315, button, count);
    const kind = (value: unknown) => (typeof value === "string" ? `s:${value}` : Number.isInteger(value) ? `i:${String(value)}` : `d:${String(value)}`);
    const lines = sent.map(([method, params]) => [method === "Ardia.dispatchClick" ? "click" : "mouse", ...Object.entries(params).map(([name, value]) => `${name}=${kind(value)}`)].join("\t"));
    const input = path.join(work, "pointer.tsv");
    fs.writeFileSync(input, `${lines.join("\n")}\n`);
    const fd = fs.openSync(input, "r");
    const ran = spawnSync(binary, [], { stdio: [fd, "pipe", "pipe"], encoding: "utf8" });
    fs.closeSync(fd);
    const answers = ran.stdout.trimEnd().split("\n");
    expect(answers).toHaveLength(sent.length);
    expect(sent.map(([method], index) => [method, answers[index]]).filter(([, answer]) => answer !== "ok")).toEqual([]);
    expect(sent.filter(([method]) => method === "Input.dispatchMouseEvent")).toHaveLength(4);
    const control = path.join(work, "pointer-control.tsv");
    fs.writeFileSync(control, "mouse\ttype=s:mousePressed\tx=i:1\ty=i:1\tbutton=s:left\tbuttons=i:1\nclick\tx=i:1\ty=i:1\tbutton=s:middle\tclickCount=i:1\tmodifiers=i:0\n");
    const controlFd = fs.openSync(control, "r");
    const refused = spawnSync(binary, [], { stdio: [controlFd, "pipe", "pipe"], encoding: "utf8" }).stdout.trimEnd().split("\n");
    fs.closeSync(controlFd);
    expect(refused.every((answer) => answer !== "ok")).toBe(true);
  });
});
