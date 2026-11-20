import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ENGINE_PREFIX, ENGINE_REFUSALS, ENGINE_UNCODED, engineRefusal } from "../../src/browse/plugin/engine-codes.ts";
import { TS_DIR } from "./daemon-helpers.ts";

const HEADER = path.join(TS_DIR, "tests", "m3", "plugin-engine", "ardia", "core", "ac_plugin_refusals.h");

function constants(file: string): Map<string, string> {
  const text = fs.readFileSync(file, "utf8");
  const found = new Map<string, string>();
  for (const match of text.matchAll(/inline constexpr char (k\w+)\[\] =((?:\s*"(?:[^"\\]|\\.)*")+);/gu)) {
    const parts = [...(match[2] as string).matchAll(/"((?:[^"\\]|\\.)*)"/gu)].map((part) => (part[1] as string).replace(/\\(.)/gu, "$1"));
    found.set(match[1] as string, parts.join(""));
  }
  return found;
}

describe("the engine's plugin refusals (ardia#2808 ac_plugin_refusals.h)", () => {
  const header = constants(HEADER);

  test("the vendored header has the constants this table reads", () => {
    expect(header.get("kPrefix")).toBe(ENGINE_PREFIX);
    expect(header.size).toBeGreaterThan(25);
  });

  test("every row of the table is one of the header's strings, exactly", () => {
    const strings = new Set(header.values());
    expect(ENGINE_REFUSALS.filter((entry) => !strings.has(entry.message)).map((entry) => entry.message)).toEqual([]);
  });

  test("the act lease's strings are in the header (573cd7ed8) with exactly the table's text", () => {
    expect(header.get("kActLeaseMissing")).toBe("ardia: no act lease for this page's current document");
    expect(header.get("kActLeaseEnded")).toBe("ardia: act lease ended before this input was delivered");
    expect(header.get("kActDocumentReplaced")).toBe("ardia: document_changed: the tab loaded a new document since the act was approved");
    expect(engineRefusal(header.get("kActDocumentReplaced") as string)?.code).toBe("document_changed");
  });

  test("the act-lease rows: both mean nothing ran and answer 77, never as outcome_unknown", () => {
    for (const message of ["ardia: no act lease for this page's current document", "ardia: act lease ended before this input was delivered"]) {
      expect(engineRefusal(message)).toMatchObject({ exit: 77, note: "nothing ran" });
    }
    expect(engineRefusal("ardia: no act lease for this page's current document")?.code).toBe("act_lease_missing");
    expect(engineRefusal("ardia: act lease ended before this input was delivered")?.code).toBe("act_lease_ended");
    expect(engineRefusal("ardia: outcome unknown")).toMatchObject({ code: "outcome_unknown", exit: 1 });
    expect(engineRefusal("ardia: no act lease for this page")).toBeNull();
  });

  test("every string in the header is either mapped or listed as deliberately uncoded, so a new refusal fails here", () => {
    const known = new Set([...ENGINE_REFUSALS.map((entry) => entry.message), ...ENGINE_UNCODED]);
    expect([...header.entries()].filter(([, value]) => !known.has(value)).map(([name]) => name)).toEqual([]);
  });

  test.skipIf(!process.env["ARDIA_ENGINE_REFUSALS_H"])("the vendored header matches the engine checkout's (ARDIA_ENGINE_REFUSALS_H)", () => {
    expect(fs.readFileSync(HEADER, "utf8")).toBe(fs.readFileSync(process.env["ARDIA_ENGINE_REFUSALS_H"] as string, "utf8"));
  });

  test("exact rows match only the whole message; pattern rows need the prefix, a method and the suffix; page text never matches", () => {
    expect(engineRefusal("ardia: busy")?.code).toBe("busy");
    expect(engineRefusal("ardia: busy wheel")).toBeNull();
    expect(engineRefusal("ardia: page hidden")?.code).toBe("page_hidden");
    expect(engineRefusal("ardia: not delivered")?.code).toBe("not_applied");
    expect(engineRefusal("ardia: outcome unknown")?.code).toBe("outcome_unknown");
    expect(engineRefusal("ardia: the page changed after the input was sent")?.code).toBe("document_changed");
    expect(engineRefusal("ardia: the page isn't taking input right now")?.code).toBe("page_busy");
    expect(engineRefusal("ardia: tab_out_of_scope: the tab left the plugin's window")?.code).toBe("tab_out_of_scope");
    expect(engineRefusal("ardia: tab_out_of_scope: the tab moved to another window")).toBeNull();
    expect(engineRefusal("ardia: that backendNodeId isn't in this page")?.code).toBe("stale_ref");
    const allowlist = engineRefusal("ardia: Runtime.evaluate with expression isn't allowed for a plugin");
    expect(allowlist).toMatchObject({ code: "plugin_refused", exit: 77 });
    expect(engineRefusal("ardia: Ardia.dispatchClick with that button can't be sent")).toMatchObject({ code: "plugin_refused", exit: 77 });
    expect(engineRefusal("ardia:  isn't allowed for a plugin")).toBeNull();
    expect(engineRefusal("page said ardia: busy")).toBeNull();
    expect(engineRefusal("ardia: input isn't allowed for this session")).toMatchObject({ code: "plugin_refused", exit: 77 });
  });
});
