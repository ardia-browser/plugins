import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { Entry } from "../canon.ts";
import { compared, LIVE } from "./compare.ts";
import { capturesConsole, checks, DIVERGENCES, namesFor, rewriter } from "./divergences.ts";
import { checkBlock, portBase, portRange, PortsBusy, RECORDED_FIXTURE } from "./infra.ts";
import { answer, fileValue, Ids, RULES, run, Subs, transcript, typescriptMovedTab, withoutClientErrorCode, withoutTempNonce } from "./normalize.ts";
import { recordedFixture } from "./side.ts";

type Item = [string, unknown];

function message(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

function entries(...items: Item[]): Entry[] {
  return items.map(([kind, text], index) => (kind === "in" || kind === "out" ? { k: kind, c: 0, t: index, m: text as string } : { k: kind, step: text as number }));
}

function shaped(items: Item[], subs: Record<string, string | number> = {}, names: string[] | null = null) {
  return transcript(entries(...items), new Subs(subs), names === null ? null : rewriter(names)).shaped as unknown as Record<string, unknown>;
}

function requestsOf(found: Record<string, unknown>): Record<string, Record<string, string[][]>> {
  return found["requests"] as Record<string, Record<string, string[][]>>;
}

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), "ardia-m3-harness-"));
}

describe("normalize", () => {
  test("live sets leave out the probes the TS daemon caches, and replay still sees them", () => {
    const visibility = "() => document.visibilityState === 'hidden'";
    const found = shaped([["mark", 0], ["out", message({ id: 1, method: "Page.getFrameTree", params: {} })], ["in", message({ id: 1, result: {} })],
      ["out", message({ id: 2, method: "Runtime.callFunctionOn", params: { functionDeclaration: visibility } })], ["in", message({ id: 2, result: {} })],
      ["out", message({ id: 3, method: "Page.navigate", params: { url: "about:blank" } })], ["in", message({ id: 3, result: {} })]]);
    const sets = (found["request_sets"] as Record<string, Record<string, string[]>>)["0"] ?? {};
    expect(Object.values(sets).flat().some((form) => form.includes("Page.getFrameTree") || form.includes("visibilityState"))).toBe(false);
    expect(Object.values(sets).flat().some((form) => form.includes("Page.navigate"))).toBe(true);
    expect(Object.values(requestsOf(found)["0"] ?? {}).flat(2).filter((form) => form.includes("Page.getFrameTree") || form.includes("Runtime.callFunctionOn")).length).toBe(2);
    expect((found["sources"] as Record<string, string[]>)["0"] ?? []).toEqual([]);
    expect(RULES["cached-probes"]).toBeDefined();
  });

  test("browser ids become placeholders by first appearance", () => {
    const a = shaped([["mark", 0], ["out", message({ id: 1, method: "Target.createTarget", params: { url: "about:blank" } })], ["in", message({ id: 1, result: { targetId: "AAAA1111" } })],
      ["out", message({ id: 2, method: "Target.attachToTarget", params: { targetId: "AAAA1111" } })]]);
    const b = shaped([["mark", 0], ["out", message({ id: 7, method: "Target.createTarget", params: { url: "about:blank" } })], ["in", message({ id: 7, result: { targetId: "BBBB2222" } })],
      ["out", message({ id: 8, method: "Target.attachToTarget", params: { targetId: "BBBB2222" } })]]);
    expect(a).toEqual(b);
    expect(requestsOf(a)["0"]?.["0:browser"]?.[1]?.[0]).toContain('"targetId":"<id#1>"');
  });

  test("only id fields are masked", () => {
    const a = shaped([["mark", 0], ["out", message({ id: 1, method: "Runtime.evaluate", params: { expression: "1", contextId: 5 } })]]);
    const b = shaped([["mark", 0], ["out", message({ id: 1, method: "Runtime.evaluate", params: { expression: "2", contextId: 9 } })]]);
    expect(compared(a, b, ["requests", "sources"]).length).toBeGreaterThan(0);
    expect(requestsOf(a)["0"]?.["0:browser"]?.[0]?.[0]).toContain('"contextId":"<context#1>"');
  });

  test("concurrent requests compare as a multiset and groups in order", () => {
    const first = message({ id: 1, method: "A.one", params: {} });
    const second = message({ id: 2, method: "A.two", params: {} });
    const later = message({ id: 3, method: "A.three", params: {} });
    const together = shaped([["mark", 0], ["out", first], ["out", second], ["in", message({ id: 1, result: {} })], ["in", message({ id: 2, result: {} })], ["out", later]]);
    const swapped = shaped([["mark", 0], ["out", second], ["out", first], ["in", message({ id: 2, result: {} })], ["in", message({ id: 1, result: {} })], ["out", later]]);
    expect(together).toEqual(swapped);
    const sequential = shaped([["mark", 0], ["out", first], ["in", message({ id: 1, result: {} })], ["out", second], ["in", message({ id: 2, result: {} })], ["out", later]]);
    expect(together).not.toEqual(sequential);
  });

  test("scratch and ports in answers", () => {
    const subs = new Subs({ root: "/tmp/run/A", tap: 9401, chrome: 9400 });
    expect(subs.text("saved to /tmp/run/A/home/x.png via --port 9401 and 127.0.0.1:9400/json, not 94011"))
      .toBe("saved to <SCRATCH>/home/x.png via --port <TAP> and 127.0.0.1:<CHROME>/json, not 94011");
  });

  test("read stamp and file times", () => {
    const found = answer({ exit: 0, out: "rows\n[read 2026-11-19 17:49:34 UTC]\n", err: "" }, new Subs({}), new Ids(), new Map());
    expect(found["out"]).toBe("rows\n[read <TIME>]\n");
    expect(fileValue({ pid: 4, started: 1, ids: { x: [1, 1795110280.4] }, next: 3 })).toEqual({ pid: "<PID>", started: "<TIME>", ids: { x: [1, "<TIME>"] }, next: 3 });
  });

  test("the fixture folder reads the same from any checkout", () => {
    const here = new Subs({ root: "/tmp/run/A", fixture_dir: "/clone/one/tests/fixtures/browse" });
    const there = new Subs({ root: "/tmp/run/B", fixture_dir: "/clone/two/tests/fixtures/browse" });
    const said = (folder: string) => `[Errno 2] No such file or directory: '${folder}/no-such-script.js'`;
    expect(here.text(said("/clone/one/tests/fixtures/browse"))).toBe(there.text(said("/clone/two/tests/fixtures/browse")));
    expect(here.text("/clone/two/tests/fixtures/browse/x")).toBe("/clone/two/tests/fixtures/browse/x");
  });

  test("a temporary tab nonce is dropped only from createTarget", () => {
    const made = { method: "Target.createTarget", params: { url: "about:blank#ardia-temp-0a1b", background: true } };
    expect(withoutTempNonce(made).params).toEqual({ url: "about:blank", background: true });
    const other = { method: "Page.navigate", params: { url: "about:blank#ardia-temp-0a1b" } };
    expect(withoutTempNonce(other)).toBe(other);
    const plain = { method: "Target.createTarget", params: { url: "about:blank#elsewhere" } };
    expect(withoutTempNonce(plain)).toBe(plain);
  });

  test("credentials never reach normalized output", () => {
    const secret = "s3cret-PW-123";
    const found = shaped([["mark", 0],
      ["out", message({ id: 1, method: "Fetch.continueWithAuth", sessionId: "S", params: { requestId: "R", authChallengeResponse: { response: "ProvideCredentials", username: "alice-user", password: secret } } })],
      ["out", message({ id: 2, method: "Network.setExtraHTTPHeaders", sessionId: "S", params: { headers: { authorization: `Basic ${secret}`, "X-Plain": "kept" } } })],
      ["out", message({ id: 3, method: "Storage.setCookies", params: { cookies: [{ name: "sid", value: secret }] } })]]);
    const text = JSON.stringify(found);
    expect(text).not.toContain(secret);
    expect(text).not.toContain("alice-user");
    expect(text).toContain("<REDACTED>");
    expect(text).toContain("kept");
  });

  test("request rows mask only the row id", () => {
    const out = "[82589.4] GET http://x/a.json (Fetch) 200\n[1.2] is not a row\nsee [82589.4] GET\n";
    expect(answer({ exit: 0, out, err: "" }, new Subs({}), new Ids(), new Map())["out"]).toBe("[<REQUEST>] GET http://x/a.json (Fetch) 200\n[1.2] is not a row\nsee [82589.4] GET\n");
  });

  test("console capture is the only Runtime.enable allowed", () => {
    const folder = scratch();
    try {
      const file = path.join(folder, "t.jsonl");
      writeFileSync(file, ["Runtime.enable", "Debugger.enable"].map((method) => JSON.stringify({ k: "out", m: JSON.stringify({ id: 1, method, sessionId: "S" }) })).join("\n") + "\n");
      expect(checks(file)).toEqual(["row 8: Debugger.enable sent on a page session", "row 8: Runtime.enable sent on a page session"]);
      expect(checks(file, true)).toEqual(["row 8: Debugger.enable sent on a page session"]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
    expect(capturesConsole([{ argv: ["open", "x", "--capture-console"] }])).toBe(true);
    expect(capturesConsole([{ argv: ["errors"] }])).toBe(true);
    expect(capturesConsole([{ argv: ["network", "requests"] }])).toBe(false);
  });

  test("replay maps the fixture port each recording stored", () => {
    const folder = scratch();
    try {
      const replay = path.join(folder, "x.jsonl.gz");
      expect(recordedFixture(replay)).toBe(RECORDED_FIXTURE);
      writeFileSync(path.join(folder, "x.result.json.gz"), gzipSync(JSON.stringify({ subs: { fixture: 9499 } })));
      expect(recordedFixture(replay)).toBe(9499);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("every rule is named", () => {
    for (const rule of ["browser-ids", "message-id", "concurrency", "scratch", "ports", "ids-in-answers", "session-key", "tabs-file", "file-times", "read-stamp", "metrics", "racy-steps",
      "request-rows", "divergences", "secrets", "json-error-code", "open-moved-tab"]) {
      expect(Object.keys(RULES)).toContain(rule);
    }
  });

  test("racy steps keep only the exit status", () => {
    const folder = scratch();
    try {
      const empty = path.join(folder, "empty.jsonl");
      writeFileSync(empty, "");
      const steps = [{ exit: 1, out: "", err: "✗ one\n", answers: [{ answer: { code: "navigation_failed", exit: 1 } }] }, { exit: 0, out: "x\n", err: "", answers: [] }];
      const found = run({ root: "/tmp/none", transcript: empty, steps, files: {}, subs: {} }, null, [0]);
      expect(found.answers[0]).toEqual({ exit: 1, err: "<racy>", out: "<racy>", answers: "<racy>" });
      expect((found.answers[1] as Record<string, unknown>)["out"]).toBe("x\n");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("the TypeScript client's --json error code compares as Python's line without one", () => {
    const python = '{"success":false,"data":null,"error":"No dialog is currently open"}\n';
    expect(withoutClientErrorCode('{"success":false,"data":null,"error":"No dialog is currently open","code":"command_failed"}\n')).toBe(python);
    expect(withoutClientErrorCode('{"success":false,"data":null,"error":"x","code":"tab_gone"}\n')).toBe('{"success":false,"data":null,"error":"x","code":"tab_gone"}\n');
  });

  test("Python's moved-tab notice reads as the TypeScript one", () => {
    const python = "✓ Fixture Form\n  http://127.0.0.1:9419/form.html\n→ [t3] is this session's tab now, a background tab of its own, since this session uses your tab [t2] and won't navigate it; `tab t2` goes back; it takes input without being shown\n";
    const typescript = "→ Opened in a new background tab [t3]; the tab you picked with `tab active` [t2] is unchanged (`open --here <url>` navigates it, `tab t2` goes back)\n✓ Fixture Form\n  http://127.0.0.1:9419/form.html\n";
    expect(typescriptMovedTab(python)).toBe(typescript);
    expect(typescriptMovedTab(typescript)).toBe(typescript);
  });
});

describe("port blocks", () => {
  const saved = { base: process.env["ARDIA_M3_PORT_BASE"], ports: process.env["ARDIA_M3_PORTS"] };

  beforeEach(() => {
    delete process.env["ARDIA_M3_PORTS"];
  });

  afterEach(() => {
    for (const [name, value] of [["ARDIA_M3_PORT_BASE", saved.base], ["ARDIA_M3_PORTS", saved.ports]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test("the block follows the base", () => {
    process.env["ARDIA_M3_PORT_BASE"] = "9440";
    expect(portRange()).toEqual([9440, 9459]);
    delete process.env["ARDIA_M3_PORT_BASE"];
    expect(portRange()).toEqual([9600, 9619]);
    for (const bad of ["94x0", "80", "65530"]) {
      process.env["ARDIA_M3_PORT_BASE"] = bad;
      expect(() => portBase()).toThrow(PortsBusy);
    }
  });

  test("the old range variable is refused", () => {
    process.env["ARDIA_M3_PORTS"] = "9400-9419";
    expect(() => portRange()).toThrow(PortsBusy);
  });

  test("a bound port in the block stops the run before anything starts", async () => {
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
    const port = (holder.address() as net.AddressInfo).port;
    try {
      await expect(checkBlock(port - 3, port + 2)).rejects.toThrow(String(port));
    } finally {
      holder.close();
    }
  });

  test("a replay tap rewrites the recorded fixture port", () => {
    expect(new Subs({ fixture: 9459 }).text("http://127.0.0.1:9459/login.html and localhost:9459")).toBe("http://127.0.0.1:<FIXTURE>/login.html and localhost:<FIXTURE>");
    expect(new Subs({}).text("http://127.0.0.1:9419/x")).toBe("http://127.0.0.1:<FIXTURE>/x");
  });
});

describe("divergences", () => {
  test("the busy probe compares equal across worlds only when the scenario names it", () => {
    const python: Item[] = [["mark", 3], ["out", message({ id: 1, method: "Runtime.evaluate", sessionId: "S", params: { expression: "1", returnByValue: true } })]];
    const ts: Item[] = [["mark", 3], ["out", message({ id: 4, method: "Runtime.evaluate", sessionId: "S", params: { expression: "1", contextId: 2, returnByValue: true } })]];
    expect(compared(shaped(python), shaped(ts), LIVE).length).toBeGreaterThan(0);
    const named = namesFor({ divergences: ["busy-probe-isolated"] });
    expect(compared(shaped(python, {}, named), shaped(ts, {}, named), LIVE)).toEqual([]);
    const other: Item[] = [["mark", 3], ["out", message({ id: 4, method: "Runtime.evaluate", sessionId: "S", params: { expression: "2", contextId: 2 } })]];
    expect(compared(shaped(python, {}, named), shaped(other, {}, named), LIVE).length).toBeGreaterThan(0);
    expect(() => namesFor({ divergences: ["no-such-divergence"] })).toThrow();
  });

  test("world handles compare with Python context ids without shifting other ids", () => {
    const call = { functionDeclaration: "() => document.title", arguments: [], returnByValue: true, awaitPromise: true };
    const python: Item[] = [["mark", 1], ["out", message({ id: 1, method: "Runtime.callFunctionOn", sessionId: "SESSION-A", params: { ...call, executionContextId: 5 } })],
      ["in", message({ id: 1, result: {} })], ["out", message({ id: 2, method: "DOM.describeNode", sessionId: "SESSION-A", params: { objectId: "NODE-1" } })]];
    const ts: Item[] = [["mark", 1], ["out", message({ id: 7, method: "Runtime.evaluate", sessionId: "SESSION-B", params: { expression: "globalThis", contextId: 5, returnByValue: false } })],
      ["in", message({ id: 7, result: { result: { objectId: "HANDLE-XYZ" } } })],
      ["out", message({ id: 10, method: "Page.getFrameTree", sessionId: "SESSION-B", params: {} })],
      ["in", message({ id: 10, result: {} })],
      ["out", message({ id: 8, method: "Runtime.callFunctionOn", sessionId: "SESSION-B", params: { ...call, objectId: "HANDLE-XYZ" } })],
      ["in", message({ id: 8, result: {} })], ["out", message({ id: 9, method: "DOM.describeNode", sessionId: "SESSION-B", params: { objectId: "NODE-2" } })]];
    const names = namesFor({});
    expect(names).toEqual(["world-handle", "oopif-auto-attach", "temp-tab-marker", "shadow-pierce"]);
    expect(compared(shaped(python, {}, []), shaped(ts, {}, []), LIVE).length).toBeGreaterThan(0);
    expect(compared(shaped(python, {}, names), shaped(ts, {}, names), LIVE)).toEqual([]);
  });

  test("only world handles lose their object id", () => {
    const call = { functionDeclaration: "function () { return this.go(); }", arguments: [], returnByValue: true, awaitPromise: true };
    const python: Item[] = [["mark", 2], ["out", message({ id: 1, method: "Runtime.callFunctionOn", sessionId: "S", params: { ...call, objectId: "CONTROLLER-1" } })]];
    const aimedWrong: Item[] = [["mark", 2], ["out", message({ id: 7, method: "Runtime.evaluate", sessionId: "S", params: { expression: "globalThis", contextId: 5, returnByValue: false } })],
      ["in", message({ id: 7, result: { result: { objectId: "HANDLE-1" } } })],
      ["out", message({ id: 8, method: "Runtime.callFunctionOn", sessionId: "S", params: { ...call, objectId: "HANDLE-1" } })]];
    const aimedRight: Item[] = [["mark", 2], ["out", message({ id: 8, method: "Runtime.callFunctionOn", sessionId: "S", params: { ...call, objectId: "CONTROLLER-9" } })]];
    const names = namesFor({});
    expect(compared(shaped(python, {}, names), shaped(aimedWrong, {}, names), LIVE).length).toBeGreaterThan(0);
    expect(compared(shaped(python, {}, names), shaped(aimedRight, {}, names), LIVE)).toEqual([]);
  });

  test("every divergence names its row or decision", () => {
    for (const [name, entry] of Object.entries(DIVERGENCES)) expect(Number.isInteger(entry.row) || typeof entry.decision === "string", name).toBe(true);
  });

  test("the transcript check finds page-session enables and a main-world probe", () => {
    const folder = scratch();
    try {
      const file = path.join(folder, "t.jsonl");
      const lines = [{ id: 1, method: "Runtime.enable", sessionId: "S" }, { id: 2, method: "Runtime.enable" }, { id: 3, method: "Debugger.enable", sessionId: "S" },
        { id: 4, method: "Runtime.evaluate", sessionId: "T", params: { expression: "1" } }, { id: 5, method: "Page.createIsolatedWorld", sessionId: "S", params: { frameId: "F" } },
        { id: 6, method: "Runtime.evaluate", sessionId: "S", params: { expression: "1" } }, { id: 7, method: "Runtime.evaluate", sessionId: "S", params: { expression: "1", contextId: 3 } },
        { id: 8, method: "Runtime.callFunctionOn", sessionId: "S", params: { executionContextId: 3 } },
        { id: 9, method: "Runtime.evaluate", sessionId: "S", params: { expression: "globalThis", contextId: 3, returnByValue: false } },
        { id: 10, method: "Runtime.callFunctionOn", sessionId: "S", params: { objectId: "H" } }];
      writeFileSync(file, lines.map((line) => `${JSON.stringify({ k: "out", m: JSON.stringify(line) })}\n`).join(""));
      expect(checks(file)).toEqual(["a page call named a numeric execution context instead of its world handle", "a world handle was used before its loader was checked by Page.getFrameTree",
        "row 8: Debugger.enable sent on a page session", "row 8: Runtime.enable sent on a page session",
        "row 8: the busy probe ran in the page's main world though the page had an isolated world"]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
