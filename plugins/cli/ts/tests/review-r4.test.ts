import "./libc-loaded.ts";
import { describe, expect, test } from "bun:test";
import vm from "node:vm";
import { DRAIN, finalDrain, type Pages, RECORDER_SOURCE, STOP_DRAIN } from "../src/browse/commands/record.ts";
import { compileEvents, type RecEvent, settledClicks } from "../src/browse/flows/compile.ts";
import { listedMarkdown } from "../src/browse/read/fastpath.ts";
import { COLLECT, discoveryErrors, INVOKE_BOUND, normalizeTools, PROBE } from "../src/browse/read/webmcp.ts";
import { Page, RECORD_MARK } from "../src/browse/state/page.ts";

function recorderPage() {
  const lines: string[] = [];
  const handlers = new Map<string, (event: unknown) => void>();
  const removed: string[] = [];
  const storageTouched: string[] = [];
  const storage = new Proxy({}, { get: (_target, key) => { storageTouched.push(String(key)); return () => null; } });
  const context = vm.createContext({
    addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler),
    removeEventListener: (name: string) => {
      removed.push(name);
      handlers.delete(name);
    },
    sessionStorage: storage,
    localStorage: storage,
    console: { debug: (line: string) => lines.push(line) },
    CSS: { escape: (text: string) => text },
    document: { activeElement: null, body: {} },
    location: { href: "https://app.example.com/" },
    Date,
    JSON,
  });
  vm.runInContext("var globalThis = this; var window = this; window.top = window;", context);
  const take = () => lines.splice(0).map((line) => {
    expect(line.startsWith(RECORD_MARK)).toBe(true);
    return JSON.parse(line.slice(RECORD_MARK.length));
  });
  const drain = () => {
    expect(vm.runInContext(`(${DRAIN})()`, context)).toEqual([]);
    return take();
  };
  const stop = () => {
    vm.runInContext(`(${STOP_DRAIN})()`, context);
    return take();
  };
  return { handlers, removed, storageTouched, drain, stop };
}

function control(type: string, checked = false) {
  const el: Record<string, unknown> = { nodeType: 1, localName: type === "button" ? "button" : "input", type, checked, id: "", labels: [], classList: [], parentElement: null, previousElementSibling: null, isContentEditable: false, innerText: "Find", textContent: "Find", form: null };
  el["getAttribute"] = (name: string) => (name === "type" ? type : name === "aria-label" ? "Find" : null);
  el["hasAttribute"] = () => false;
  el["closest"] = () => el;
  el["ownerDocument"] = { querySelectorAll: () => [el], getElementById: () => null };
  return el;
}

describe("the recorder keeps everything in its own world", () => {
  test("it never reads or writes page storage, and its source doesn't mention it", () => {
    expect(RECORDER_SOURCE).not.toMatch(/sessionStorage|localStorage/u);
    const page = recorderPage();
    page.drain();
    const button = control("button");
    page.handlers.get("pointerdown")!({ isTrusted: true, button: 0, composedPath: () => [button] });
    page.handlers.get("click")!({ isTrusted: true, button: 0, composedPath: () => [button] });
    page.handlers.get("pagehide")!({ isTrusted: true });
    page.drain();
    page.stop();
    expect(page.storageTouched).toEqual([]);
  });

  test("a press is queued at pointerdown and confirmed by its click", () => {
    const page = recorderPage();
    page.drain();
    const box = control("checkbox", false);
    page.handlers.get("pointerdown")!({ isTrusted: true, button: 0, composedPath: () => [box] });
    const early = page.drain();
    expect(early).toHaveLength(1);
    expect(early[0]).toMatchObject({ kind: "click", pointer: 1, checked: true });
    box["checked"] = true;
    page.handlers.get("click")!({ isTrusted: true, button: 0, composedPath: () => [box] });
    expect(page.drain()).toMatchObject([{ kind: "confirm", pointer: 1, checked: true }]);
    const keyboard = control("button");
    page.handlers.get("click")!({ isTrusted: true, button: 0, composedPath: () => [keyboard] });
    expect(page.drain()[0]).toMatchObject({ kind: "click" });
  });

  test("pagehide detaches every listener at once, and the next drain installs them again", () => {
    const page = recorderPage();
    page.drain();
    expect(page.handlers.size).toBe(8);
    page.handlers.get("pagehide")!({ isTrusted: true });
    expect(page.removed).toHaveLength(8);
    expect(page.handlers.size).toBe(0);
    page.drain();
    expect(page.handlers.size).toBe(8);
  });

  test("the stop drain looks at the frames again before draining", async () => {
    const calls: string[] = [];
    const pages: Pages = {
      frames: () => (calls.includes("refresh") ? ["fresh"] : ["stale"]),
      call: async (fn, frame) => {
        calls.push(`${fn === STOP_DRAIN ? "stop" : "?"} ${frame}`);
        return [];
      },
      closed: () => false,
      refresh: async () => {
        calls.push("refresh");
      },
    };
    await finalDrain(pages, []);
    expect(calls).toEqual(["refresh", "stop fresh"]);
  });
});

describe("pointer clicks settle into steps", () => {
  const target = { tag: "button", role: "button", name: "Find", ariaLabel: "Find", css: "form > button", type: "submit" };
  const click = (pointer: number, at: number): RecEvent => ({ kind: "click", pointer, at, target, checked: null, method: "get" });

  test("a confirmed press is kept with the state its click saw", () => {
    const box = { tag: "input", role: "checkbox", name: "Stock", ariaLabel: "Stock", type: "checkbox", css: "#stock" };
    const settled = settledClicks([{ kind: "click", pointer: 1, at: 1, target: box, checked: true }, { kind: "confirm", pointer: 1, at: 2, checked: false }]);
    expect(settled).toEqual([{ kind: "click", pointer: 1, at: 1, target: box, checked: false }]);
  });

  test("a press that never clicked is dropped, unless a navigation followed it", () => {
    expect(settledClicks([click(1, 10)])).toEqual([]);
    expect(settledClicks([click(1, 10), { kind: "navigate", at: 5000, url: "https://app.example.com/x" }])).toHaveLength(1);
    const navigated = [click(1, 10), { kind: "navigate" as const, at: 400, url: "https://app.example.com/results" }];
    expect(settledClicks(navigated)).toHaveLength(2);
    const compiled = compileEvents(navigated, "https://app.example.com/");
    expect(compiled.steps.map((step) => step.action.type)).toEqual(["open", "click"]);
  });
});

describe("site tool providers", () => {
  test("a provider whose listing throws or hangs is reported, not taken for no tools", async () => {
    const context = vm.createContext({
      document: { modelContext: { listTools: async () => { throw new Error("listing broke"); } }, querySelectorAll: () => [] },
      navigator: { modelContext: { getTools: () => new Promise(() => {}) } },
      setTimeout,
      Promise,
      JSON,
      Map,
      Array,
      Object,
    });
    const probed = await vm.runInContext(PROBE, context);
    expect(normalizeTools(probed)).toEqual([]);
    const errors = discoveryErrors(probed);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("listing broke");
    expect(errors[1]).toContain("didn't answer");
  }, 10_000);

  test("a tool dispatched by name is marked so, and a swapped provider object is refused", async () => {
    const calls: string[] = [];
    const executeTool = async (name: string) => {
      calls.push(name);
      return "ok";
    };
    const document: Record<string, unknown> = { modelContext: { tools: [{ name: "lookup", description: "d" }], executeTool }, querySelectorAll: () => [] };
    const context = vm.createContext({ document, navigator: {}, setTimeout, Promise, JSON, Map, Array, Object });
    const collected = await vm.runInContext(`(${COLLECT})(null)`, context);
    const [tool] = normalizeTools({ tools: (collected as { entry: unknown }[]).map((item) => item.entry) });
    expect(tool?.binding).toBe("name");
    const invoke = vm.runInContext(`(${INVOKE_BOUND})`, context) as (...args: unknown[]) => Promise<unknown>;
    expect(await invoke.call(collected, "lookup", {}, tool!.fingerprint)).toEqual({ via: "document.modelContext", binding: "name", result: "ok" });
    document["modelContext"] = { tools: [{ name: "lookup", description: "d" }], executeTool };
    expect(await invoke.call(collected, "lookup", {}, tool!.fingerprint)).toEqual({ changed: true });
    expect(calls).toEqual(["lookup"]);
  });
});

describe("listed Markdown is never a JSON scalar", () => {
  test("strings, numbers, booleans and null are refused", () => {
    for (const body of ['"secret value"', "42", "true", "null", '  "x"  ']) expect(listedMarkdown("application/octet-stream", body)).toBe(false);
    expect(listedMarkdown("application/octet-stream", "Plain text guide")).toBe(true);
  });
});

describe("recorder messages", () => {
  const owner = { worlds: new Map<string, [string | null, number, string]>([["frame", [null, 7, "handle"]]]), ownWorld: Page.prototype.ownWorld };
  const message = (context: number, value: string) => ({ executionContextId: context, args: [{ type: "string", value }] });

  test("only marked messages from ardia's own page world are read, so the page can't forge an event", () => {
    const payload = JSON.stringify({ kind: "click", at: 1 });
    expect(Page.prototype.recorderMessage.call(owner, message(7, RECORD_MARK + payload))).toBe(payload);
    expect(Page.prototype.recorderMessage.call(owner, message(3, RECORD_MARK + payload))).toBeNull();
    expect(Page.prototype.recorderMessage.call(owner, message(7, payload))).toBeNull();
  });

  test("the recorder speaks only through its marked console line", () => {
    expect(RECORDER_SOURCE).toContain("console.debug(");
    expect(RECORDER_SOURCE).not.toContain("__ardiaRecordQueue");
  });
});
