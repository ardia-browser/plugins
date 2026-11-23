import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import type { Entry } from "../canon.ts";
import { ReplayConn } from "../replay.ts";
import { BLOCK, CHROME_ENV, launchChrome, portBase, stop } from "./infra.ts";
import { DATA_ROOT, HARNESS, LINK_TRANSCRIPTS, TRANSCRIPTS, tsProgram } from "./paths.ts";
import { pyLoads } from "./pyvalues.ts";
import { linkResultText, publish, pythonLinkText, pythonResultText, recordedResultText } from "./runner.ts";
import type { ReplayRun } from "./side.ts";

const RECORD_MS = 600_000;
const RECORD_PORT_BASE = String(portBase() + BLOCK);

function unzipped(file: string): string {
  return gunzipSync(readFileSync(file)).toString("utf8");
}

function results(root: string): string[] {
  return [...new Bun.Glob("**/*.result.json.gz").scanSync({ cwd: root })].sort().map((relative) => path.join(root, relative));
}

describe("recordings are written the way Python wrote them", () => {
  test("every scenario result is json.dumps(sort_keys=True, indent=1) with a newline, byte for byte", () => {
    const files = results(TRANSCRIPTS);
    expect(files.length).toBeGreaterThanOrEqual(70);
    for (const file of files) {
      const text = unzipped(file);
      expect(pythonResultText(pyLoads(text) as never), path.relative(TRANSCRIPTS, file)).toBe(text);
    }
  });

  test("every link result is json.dumps with its keys in order, byte for byte", () => {
    const files = results(LINK_TRANSCRIPTS);
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const file of files) {
      const text = unzipped(file);
      expect(pythonLinkText(pyLoads(text) as never), path.relative(LINK_TRANSCRIPTS, file)).toBe(text);
    }
  });

  test("a recorded answer keeps integers past 2^53 and the order of integer-like keys", () => {
    const run = { root: "/r", transcript: "/r/t", steps: [{ exit: 0, out: "", err: "", answers: [], seconds: 0.5 }], files: {}, subs: { fixture: 9619 }, tap: {},
      answerLines: [['{"answer": {"exit": 0, "n": 9007199254740993, "keys": {"5": 5, "2": 2}}}']] } as unknown as ReplayRun;
    const text = recordedResultText(run);
    expect(text).toContain('"n": 9007199254740993');
    expect(text).toContain('"keys": {\n       "2": 2,\n       "5": 5\n      }');
    expect(linkResultText('[{"ok": {"5": 5, "2": 2, "big": 9007199254740993}}]', { root: "/r" })).toBe('{"outcomes": [{"ok": {"5": 5, "2": 2, "big": 9007199254740993}}], "subs": {"root": "/r"}}');
  });

  test("an integral float stays a float and a whole number stays an int", () => {
    const text = '{\n "a": 1.0,\n "b": 2,\n "c": [\n  0.5,\n  1e-05\n ]\n}\n';
    expect(pythonResultText(pyLoads(text) as never)).toBe(text);
  });
});

type Sent = { id: number; text: string };

function conversation(literal: boolean) {
  const session = "S1";
  const tree = { frameTree: { frame: { id: "F", loaderId: "L", url: "http://127.0.0.1:9619/a.html" } } };
  const recorded: Entry[] = [
    { k: "out", c: 0, t: 1, m: JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true, flatten: true, waitForDebuggerOnStart: false }, sessionId: session }) },
    { k: "in", c: 0, t: 2, m: JSON.stringify({ id: 1, result: {}, sessionId: session }) },
    { k: "out", c: 0, t: 3, m: JSON.stringify({ id: 2, method: "Runtime.evaluate", params: { contextId: 7, expression: "globalThis", returnByValue: false }, sessionId: session }) },
    { k: "in", c: 0, t: 4, m: JSON.stringify({ id: 2, result: { result: { type: "object", className: "Window", objectId: "-9.1.2" } }, sessionId: session }) },
    { k: "out", c: 0, t: 5, m: JSON.stringify({ id: 3, method: "Page.getFrameTree", params: {}, sessionId: session }) },
    { k: "in", c: 0, t: 6, m: JSON.stringify({ id: 3, result: tree, sessionId: session }) },
  ];
  const sent: Sent[] = [];
  const notes: string[] = [];
  const failures: string[] = [];
  const replay = new ReplayConn(recorded, {
    batch: (work) => work(),
    send: (text) => sent.push({ id: Number((JSON.parse(text) as { id?: number }).id), text }),
    close: () => {},
    note: (kind) => notes.push(kind),
    fail: (report) => failures.push(report),
  }, { lookahead: 8, repeats: () => false }, undefined, undefined, false, literal);
  replay.start();
  for (const [index, line] of recorded.filter((entry) => entry.k === "out").entries()) {
    const request = JSON.parse(line.m as string) as Record<string, unknown>;
    replay.request(JSON.stringify({ ...request, id: 100 + index }));
  }
  return { sent, notes, failures, remaining: replay.remaining() };
}

function readyProbe(literal: boolean, handle = "-1.2.1", loaded = true) {
  const session = "S1";
  const recorded: Entry[] = [
    { k: "out", c: 0, t: 1, m: JSON.stringify({ id: 1, method: "Runtime.callFunctionOn", params: { functionDeclaration: "() => document.title", objectId: "-1.2.1" }, sessionId: session }) },
    ...(loaded ? [{ k: "in", c: 0, t: 1.5, m: JSON.stringify({ method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId: session }) }] : []),
    { k: "in", c: 0, t: 2, m: JSON.stringify({ id: 1, result: { result: { type: "string", value: "Fixture" } }, sessionId: session }) },
  ];
  const sent: string[] = [];
  const notes: string[] = [];
  const failures: string[] = [];
  const replay = new ReplayConn(recorded, {
    batch: (work) => work(),
    send: (text) => sent.push(text),
    close: () => {},
    note: (kind) => notes.push(kind),
    fail: (report) => failures.push(report),
  }, { lookahead: 8, repeats: (form) => form.includes("document.readyState") }, undefined, undefined, false, literal);
  replay.start();
  replay.request(JSON.stringify({ id: 50, method: "Runtime.callFunctionOn", params: { functionDeclaration: "() => document.readyState", objectId: handle }, sessionId: session }));
  replay.request(JSON.stringify({ id: 51, method: "Runtime.callFunctionOn", params: { functionDeclaration: "() => document.title", objectId: "-1.2.1" }, sessionId: session }));
  return { sent, notes, failures };
}

function earlyTree(laterLoader: string, gated = false) {
  const session = "S1";
  const tree = (loader: string) => ({ frameTree: { frame: { id: "F", loaderId: loader, url: "http://127.0.0.1:9619/a.html" } } });
  const title = { functionDeclaration: "() => document.title", objectId: "-1.2.1" };
  const recorded: Entry[] = [
    { k: "out", c: 0, t: 1, m: JSON.stringify({ id: 1, method: "Page.getFrameTree", params: {}, sessionId: session }) },
    { k: "in", c: 0, t: 2, m: JSON.stringify({ id: 1, result: tree("L1"), sessionId: session }) },
    { k: "out", c: 0, t: 3, m: JSON.stringify({ id: 2, method: "Runtime.callFunctionOn", params: title, sessionId: session }) },
    { k: "in", c: 0, t: 4, m: JSON.stringify({ id: 2, result: { result: { type: "string", value: "A" } }, sessionId: session }) },
    { k: "out", c: 0, t: 5, m: JSON.stringify({ id: 3, method: "Page.getFrameTree", params: {}, sessionId: session }) },
    { k: "in", c: 0, t: 6, m: JSON.stringify({ id: 3, result: tree(laterLoader), sessionId: session }) },
    ...(gated ? [{ k: "in", c: 0, t: 7, m: JSON.stringify({ method: "Page.frameNavigated", params: { frame: { id: "F", loaderId: "L1" } }, sessionId: session }) }] : []),
  ];
  const sent: string[] = [];
  const notes: string[] = [];
  const replay = new ReplayConn(recorded, {
    batch: (work) => work(),
    send: (text) => sent.push(text),
    close: () => {},
    note: (kind) => notes.push(kind),
    fail: () => {},
  }, { lookahead: 8, repeats: (form) => form.includes("Page.getFrameTree") }, undefined, undefined, false, true);
  replay.start();
  replay.request(JSON.stringify({ id: 10, method: "Page.getFrameTree", params: {}, sessionId: session }));
  replay.request(JSON.stringify({ id: 11, method: "Page.getFrameTree", params: {}, sessionId: session }));
  replay.request(JSON.stringify({ id: 12, method: "Runtime.callFunctionOn", params: title, sessionId: session }));
  return { sent, notes };
}

describe("a TypeScript recording replays literally", () => {
  test("an early probe whose later recorded answer is the same gets the last answer instead of jumping ahead", () => {
    const { sent, notes } = earlyTree("L1");
    expect(notes).toEqual(["repeat"]);
    expect(sent.map((text) => (JSON.parse(text) as { id: number }).id)).toEqual([10, 11, 12]);
  });

  test("an early probe whose later recorded answer changed still takes that answer", () => {
    const { notes } = earlyTree("L2");
    expect(notes).not.toContain("repeat");
  });

  test("an early probe whose later recorded request gates an event takes that request, so the event still arrives", () => {
    const { sent, notes } = earlyTree("L1", true);
    expect(notes).not.toContain("repeat");
    expect(sent.some((text) => text.includes("Page.frameNavigated"))).toBe(true);
  });

  test("a readyState probe the recording never needed reads as loaded, and the run goes on", () => {
    const { sent, notes, failures } = readyProbe(true);
    expect(failures).toEqual([]);
    expect(notes).toEqual(["assumed-loaded"]);
    expect(sent.map((text) => JSON.parse(text) as Record<string, unknown>).find((message) => message["id"] === 50)).toEqual({ id: 50, result: { result: { type: "string", value: "complete" } }, sessionId: "S1" });
    expect(sent.some((text) => text.includes('"value":"Fixture"'))).toBe(true);
  });

  test("the loaded answer is only for a handle the recording used, on a session it saw load", () => {
    expect(readyProbe(true, "no-such-handle").failures.length).toBe(1);
    expect(readyProbe(true, "-1.2.1", false).failures.length).toBe(1);
  });

  test("a Python recording still fails on a probe it never recorded", () => {
    const { failures } = readyProbe(false);
    expect(failures.length).toBe(1);
    expect(failures[0]).toContain("document.readyState");
  });

  test("its own setAutoAttach, world handle and frame tree are answered from the recording", () => {
    const { sent, notes, failures, remaining } = conversation(true);
    expect(failures).toEqual([]);
    expect(notes).toEqual([]);
    expect(remaining).toEqual([]);
    expect(sent.map((item) => item.id)).toEqual([100, 101, 102]);
    expect(sent[1]?.text).toContain('"objectId":"-9.1.2"');
  });

  test("a Python recording still gets the shims for what Python never sent", () => {
    const { notes, remaining } = conversation(false);
    expect(notes).toContain("synthesized");
    expect(notes).toContain("divergence");
    expect(remaining.some((form) => form.includes("Target.setAutoAttach"))).toBe(true);
  });
});

describe("publishing a recording", () => {
  test("a failure on the second file puts the first back and leaves nothing staged", () => {
    const folder = mkdtempSync(path.join(tmpdir(), "ardia-m3-publish-"));
    try {
      const [a, b, newA, newB] = ["a.jsonl.gz", "b.result.json.gz", "new-a", "new-b"].map((name) => path.join(folder, name)) as [string, string, string, string];
      writeFileSync(a, "old a");
      mkdirSync(b);
      writeFileSync(path.join(b, "blocker"), "x");
      writeFileSync(newA, "new a");
      writeFileSync(newB, "new b");
      expect(() => publish([[newA, a], [newB, b]])).toThrow();
      expect(readFileSync(a, "utf8")).toBe("old a");
      expect(readdirSync(folder).sort()).toEqual(["a.jsonl.gz", "b.result.json.gz", "new-a", "new-b"]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("a pair publishes whole", () => {
    const folder = mkdtempSync(path.join(tmpdir(), "ardia-m3-publish-"));
    try {
      const [a, b, newA, newB] = ["x/a", "x/b", "new-a", "new-b"].map((name) => path.join(folder, name)) as [string, string, string, string];
      writeFileSync(newA, "A");
      writeFileSync(newB, "B");
      publish([[newA, a], [newB, b]]);
      expect([readFileSync(a, "utf8"), readFileSync(b, "utf8")]).toEqual(["A", "B"]);
      expect(readdirSync(path.join(folder, "x")).sort()).toEqual(["a", "b"]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

const chrome = process.env[CHROME_ENV];
const live = process.platform === "darwin" && chrome !== undefined && existsSync(chrome) && existsSync(tsProgram());

function copiedRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "ardia-m3-record-"));
  for (const part of ["elastic.json", "protocol.schema.json"]) cpSync(path.join(DATA_ROOT, part), path.join(root, part));
  mkdirSync(path.join(root, "scenarios", "daemon"), { recursive: true });
  cpSync(path.join(DATA_ROOT, "scenarios", "daemon", "close_reopen.json"), path.join(root, "scenarios", "daemon", "close_reopen.json"));
  mkdirSync(path.join(root, "link-scenarios"), { recursive: true });
  cpSync(path.join(DATA_ROOT, "link-scenarios", "round_trips.json"), path.join(root, "link-scenarios", "round_trips.json"));
  mkdirSync(path.join(root, "transcripts"), { recursive: true });
  mkdirSync(path.join(root, "link-transcripts"), { recursive: true });
  return root;
}

function harness(root: string, ...argv: string[]): { status: number | null; out: string } {
  const done = spawnSync(process.execPath, [path.join(HARNESS, "main.ts"), ...argv], {
    env: { ...process.env, ARDIA_M3_DATA_ROOT: root, ARDIA_M3_PORT_BASE: RECORD_PORT_BASE },
    encoding: "utf8",
    timeout: RECORD_MS - 10_000,
  });
  return { status: done.status, out: `${done.stdout}${done.stderr}` };
}

describe.skipIf(!live)("record and live against headless Chromium", () => {
  test("a recording made from TypeScript replays, says who made it, and live agrees with itself", () => {
    const root = copiedRoot();
    try {
      const recorded = harness(root, "record", "daemon/close_reopen", "--verify", "2");
      expect(recorded.status, recorded.out).toBe(0);
      const result = pyLoads(unzipped(path.join(root, "transcripts", "daemon", "close_reopen.result.json.gz"))) as Record<string, unknown>;
      expect(result["recorder"]).toBe("ts");
      const meta = JSON.parse(unzipped(path.join(root, "transcripts", "daemon", "close_reopen.jsonl.gz")).split("\n")[0] as string) as Record<string, unknown>;
      expect(meta).toMatchObject({ k: "meta", mode: "live", recorder: "ts" });
      const replayed = harness(root, "replay", "daemon/close_reopen");
      expect(replayed.status, replayed.out).toBe(0);
      const twin = harness(root, "live", "daemon/close_reopen");
      expect(twin.status, twin.out).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, RECORD_MS);

  test("the link driver records and replays from TypeScript", () => {
    const root = copiedRoot();
    try {
      const recorded = harness(root, "link-record", "round_trips", "--verify", "2");
      expect(recorded.status, recorded.out).toBe(0);
      expect(existsSync(path.join(root, "link-transcripts", "round_trips.result.json.gz"))).toBe(true);
      const replayed = harness(root, "link-replay", "round_trips");
      expect(replayed.status, replayed.out).toBe(0);
      const twin = harness(root, "link-live", "round_trips");
      expect(twin.status, twin.out).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, RECORD_MS);

  test("record and link-record without scenarios refuse rather than rewriting every transcript", () => {
    const root = copiedRoot();
    try {
      const refused = harness(root, "record");
      expect(refused.status).toBe(2);
      expect(refused.out).toContain("record needs the scenarios to record");
      const links = harness(root, "link-record");
      expect(links.status).toBe(2);
      expect(links.out).toContain("link-record needs the link scenarios to record");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a second Chromium on a port another one holds is refused, not mistaken for its own", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), "ardia-m3-chrome-"));
    const port = portBase() + BLOCK + 18;
    const first = await launchChrome(port, path.join(folder, "a", "profile"), [800, 600]);
    try {
      await expect(launchChrome(port, path.join(folder, "b", "profile"), [800, 600])).rejects.toThrow("didn't answer as itself");
    } finally {
      await stop(first);
      rmSync(folder, { recursive: true, force: true });
    }
  }, 90_000);
});
