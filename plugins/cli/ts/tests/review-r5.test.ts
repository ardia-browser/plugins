import "./libc-loaded.ts";
import { describe, expect, test } from "bun:test";
import vm from "node:vm";
import { capture, drainSource, type Pages, RECORDER_SOURCE, recorderSource, STOP_DRAIN } from "../src/browse/commands/record.ts";
import { settledClicks } from "../src/browse/flows/compile.ts";
import { COLLECT, INVOKE_BOUND, normalizeTools } from "../src/browse/read/webmcp.ts";
import type { Listener } from "../src/browse/state/state.ts";

function control(type: string, checked = false) {
  const el: Record<string, unknown> = { nodeType: 1, localName: "input", type, checked, id: "", labels: [], classList: [], parentElement: null, previousElementSibling: null, isContentEditable: false, innerText: "", textContent: "", form: null };
  el["getAttribute"] = (name: string) => (name === "type" ? type : name === "aria-label" ? "Stock" : null);
  el["hasAttribute"] = () => false;
  el["closest"] = () => el;
  el["ownerDocument"] = { querySelectorAll: () => [el], getElementById: () => null };
  return el;
}

function frame(binding: string | null, delivered: string[] | null) {
  const handlers = new Map<string, (event: unknown) => void>();
  const globals: Record<string, unknown> = {
    addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler),
    removeEventListener: (name: string) => handlers.delete(name),
    CSS: { escape: (text: string) => text },
    document: { activeElement: null, body: {} },
    location: { href: "https://app.example.com/" },
    crypto: { getRandomValues: (bytes: Uint8Array) => { for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256); return bytes; } },
    Date,
    JSON,
  };
  if (binding && delivered) globals[binding] = (payload: string) => delivered.push(payload);
  const context = vm.createContext(globals);
  vm.runInContext("var globalThis = this; var window = this; window.top = window;", context);
  const drain = () => (vm.runInContext(`(${drainSource(binding)})()`, context) as string[]).map((item) => JSON.parse(item));
  return { handlers, drain };
}

describe("the recorder's transport", () => {
  test("events go through the binding when it's there, and never to the console", () => {
    expect(RECORDER_SOURCE).not.toMatch(/console\.|sessionStorage|localStorage/u);
    const delivered: string[] = [];
    const page = frame("__ardiaRecordabc", delivered);
    expect(page.drain()).toEqual([]);
    const box = control("checkbox");
    page.handlers.get("pointerdown")!({ isTrusted: true, button: 0, composedPath: () => [box] });
    expect(delivered.map((item) => JSON.parse(item).kind)).toEqual(["click"]);
    expect(page.drain()).toEqual([]);
  });

  test("without the binding the same events wait in the world's queue for the poll", () => {
    const page = frame("__ardiaRecordmissing", null);
    page.drain();
    page.handlers.get("pointerdown")!({ isTrusted: true, button: 0, composedPath: () => [control("checkbox")] });
    expect(page.drain().map((event) => event.kind)).toEqual(["click"]);
  });

  test("each install numbers its presses under its own id, so two frames never confirm each other's", () => {
    const left = frame(null, null);
    const right = frame(null, null);
    left.drain();
    right.drain();
    const leftBox = control("checkbox", false);
    const rightBox = control("checkbox", false);
    left.handlers.get("pointerdown")!({ isTrusted: true, button: 0, composedPath: () => [leftBox] });
    right.handlers.get("pointerdown")!({ isTrusted: true, button: 0, composedPath: () => [rightBox] });
    leftBox["checked"] = true;
    left.handlers.get("click")!({ isTrusted: true, button: 0, composedPath: () => [leftBox] });
    const events = [...left.drain(), ...right.drain()].map((event, index) => ({ ...event, at: index + 1 }));
    const presses = events.filter((event) => event.kind === "click");
    expect(presses).toHaveLength(2);
    expect(presses[0].pointer).not.toBe(presses[1].pointer);
    expect(presses[0].pointer.endsWith(":1") && presses[1].pointer.endsWith(":1")).toBe(true);
    const settled = settledClicks(events);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ kind: "click", pointer: presses[0].pointer, checked: true });
  });
});

describe("capture over a binding", () => {
  type Fake = Pages & { log: string[] };
  function fakePages(sessions: string[], refuse: boolean, own: (session: string | null | undefined, context: unknown) => boolean, onDrain: (fn: string) => void): Fake {
    const log: string[] = [];
    return {
      log,
      frames: () => ["main"],
      call: async (fn) => {
        log.push(fn === STOP_DRAIN ? "stop" : "drain");
        onDrain(fn);
        return [];
      },
      closed: () => false,
      refresh: async () => {},
      sessions: () => sessions,
      bind: async (session, binding) => {
        log.push(`bind ${session} ${binding.startsWith("__ardiaRecord")}`);
        if (refuse) throw new Error("Runtime.addBinding isn't allowed");
      },
      unbind: async (session) => {
        log.push(`unbind ${session}`);
      },
      ownWorld: own,
    };
  }

  test("events are taken only from the recording's binding, in ardia's own world of a bound session, OOPIFs included", async () => {
    const listeners: Listener[] = [];
    const ctx = { state: { listeners } };
    const page = { url: "https://app.example.com/", crashed: false };
    let fired = false;
    const payload = (kind: string, at: number) => JSON.stringify({ kind, at, target: { tag: "button", role: "button", name: "Go" } });
    const pages = fakePages(["S1", "S2"], false, (session, context) => (session === "S1" && context === 1) || (session === "S2" && context === 5), () => {
      if (fired) return;
      fired = true;
      const listener = listeners[0]!;
      listener(page as never, "Runtime.bindingCalled", { name: "__ardiaRecordtest", executionContextId: 1, payload: payload("click", 1) }, "S1");
      listener(page as never, "Runtime.bindingCalled", { name: "__ardiaRecordtest", executionContextId: 5, payload: payload("click", 2) }, "S2");
      listener(page as never, "Runtime.bindingCalled", { name: "__ardiaRecordother", executionContextId: 1, payload: payload("click", 3) }, "S1");
      listener(page as never, "Runtime.bindingCalled", { name: "__ardiaRecordtest", executionContextId: 99, payload: payload("click", 4) }, "S1");
      listener(page as never, "Runtime.bindingCalled", { name: "__ardiaRecordtest", executionContextId: 1, payload: payload("click", 5) }, "S9");
    });
    const result = await capture(ctx as never, page as never, 3, 0.2, pages, "__ardiaRecordtest");
    expect(result.transport).toBe("binding");
    expect(result.events.map((event) => event.at)).toEqual([1, 2]);
    expect(pages.log.filter((line) => line.startsWith("bind"))).toEqual(["bind S1 true", "bind S2 true"]);
    expect(pages.log.slice(-3)).toEqual(["stop", "unbind S1", "unbind S2"]);
    expect(listeners).toEqual([]);
  });

  test("a refused binding falls back to polling, and nothing is unbound", async () => {
    const pages = fakePages(["S1"], true, () => true, () => {});
    const result = await capture({ state: { listeners: [] } } as never, { url: "https://app.example.com/", crashed: false } as never, 0.3, 0.1, pages, "__ardiaRecordtest");
    expect(result.transport).toBe("poll");
    expect(pages.log.some((line) => line.startsWith("unbind"))).toBe(false);
  });

  test("the binding name is random per recording", () => {
    expect(recorderSource("__ardiaRecordaaaa")).toContain("__ardiaRecordaaaa");
    expect(recorderSource(null)).not.toContain("__ardiaRecordaaaa");
  });
});

describe("site tool invocation can't be redirected by the page", () => {
  test("replacing the handler's own call method doesn't change what runs", async () => {
    const calls: string[] = [];
    const execute = async (args: { q: string }) => {
      calls.push(`execute ${args.q}`);
      return "real";
    };
    (execute as unknown as { call: unknown }).call = () => {
      calls.push("hijacked");
      return "hijacked";
    };
    const document = { modelContext: { tools: new Map<string, unknown>([["lookup", { description: "d", execute }]]) }, querySelectorAll: () => [] };
    const context = vm.createContext({ document, navigator: {}, setTimeout, Promise, JSON, Map, Array, Object, Reflect });
    const collected = await vm.runInContext(`(${COLLECT})(null)`, context);
    const [tool] = normalizeTools({ tools: (collected as { entry: unknown }[]).map((item) => item.entry) });
    const invoke = vm.runInContext(`(${INVOKE_BOUND})`, context) as (...args: unknown[]) => Promise<unknown>;
    expect(await invoke.call(collected, "lookup", { q: "x" }, tool!.fingerprint)).toEqual({ via: "document.modelContext", binding: "handler", result: "real" });
    expect(calls).toEqual(["execute x"]);
  });

  test("a provider that fails while the call re-checks it is reported as that failure", async () => {
    let listings = 0;
    const holder = {
      listTools: async () => {
        listings += 1;
        if (listings > 1) throw new Error("provider went down");
        return [{ name: "lookup", description: "d" }];
      },
      executeTool: async () => "should not run",
    };
    const context = vm.createContext({ document: { modelContext: holder, querySelectorAll: () => [] }, navigator: {}, setTimeout, Promise, JSON, Map, Array, Object, Reflect });
    const collected = await vm.runInContext(`(${COLLECT})(null)`, context);
    const [tool] = normalizeTools({ tools: (collected as { entry: unknown }[]).map((item) => item.entry) });
    const invoke = vm.runInContext(`(${INVOKE_BOUND})`, context) as (...args: unknown[]) => Promise<Record<string, unknown>>;
    const answer = await invoke.call(collected, "lookup", {}, tool!.fingerprint);
    expect(answer["failed"]).toEqual(["document.modelContext: provider went down"]);
  });
});
