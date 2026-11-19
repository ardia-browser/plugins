import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generate } from "../../scripts/plugin-key-table.ts";
import { NAMED_KEYS } from "../../src/browse/input/keys.ts";
import { charEvents, comboEvents, uncheckedComboEvents } from "../../src/browse/plugin/input.ts";
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
  return (events) => {
    const ran = spawnSync(binary, [], { input: events.map(line).join("\n") + "\n", encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return ran.stdout.trimEnd().split("\n");
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
    const overRefused = refusedRaw.filter(([, raw]) => check(raw).every((answer) => answer === "ok")).map(([combo]) => combo);
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
