import { describe, expect, test } from "bun:test";
import { PREPARE_ACTION } from "../../src/browse/act/pointer.ts";
import { FIELD_FACTS } from "../../src/browse/act/fields.ts";
import { fieldTarget } from "../../src/browse/commands/batch.ts";
import { dispatch } from "../../src/browse/commands/all.ts";
import { Ctx } from "../../src/browse/commands/ctx.ts";
import { BrowseError } from "../../src/browse/daemon-errors.ts";
import { begin } from "../../src/browse/metrics.ts";
import { CLICKABLES } from "../../src/browse/snapshot/collect.ts";
import { State } from "../../src/browse/state/state.ts";

const FIELDS: Record<string, { backend: number; name: string }> = {
  "#a": { backend: 11, name: "First" },
  "#b": { backend: 12, name: "Last" },
  "#c": { backend: 13, name: "City" },
  "#boom": { backend: 14, name: "Broken" },
  "#go": { backend: 15, name: "Save" },
};

class FormBrowser {
  readonly alive = true;
  readonly closedByUs = false;
  readonly sent: string[] = [];
  readonly values = new Map<number, string>();
  readonly counts = { mousedown: 0, mouseup: 0, click: 0, mousemove: 0, keydown: 0, keyup: 0, wheel: 0, beforeinput: 0, input: 0 };
  focused: number | null = null;

  async send(method: string, params: Record<string, unknown> | null = null): Promise<Record<string, unknown>> {
    this.sent.push(method);
    await new Promise((resolve) => setImmediate(resolve));
    if (method === "Target.attachToTarget") return { sessionId: "S1" };
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "F", url: "https://form.example/", loaderId: "L1", securityOrigin: "https://form.example" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
    if (method === "Runtime.evaluate" && params?.["expression"] === "globalThis") return { result: { type: "object", objectId: "WORLD" } };
    if (method === "Runtime.callFunctionOn") return { result: this.call(String(params?.["functionDeclaration"]), (params?.["arguments"] as { value?: unknown; objectId?: string }[]) ?? []) };
    if (method === "DOM.describeNode") return { node: { backendNodeId: FIELDS[String(params?.["objectId"])]?.backend ?? 1, nodeName: "INPUT" } };
    if (method === "DOM.getContentQuads") return { quads: [[10, 10, 110, 10, 110, 40, 10, 40]] };
    if (method === "DOM.focus") this.focused = Number(params?.["backendNodeId"]);
    if (method === "Input.insertText" && this.focused !== null) {
      this.values.set(this.focused, String(params?.["text"]));
      this.counts.beforeinput += 1;
      this.counts.input += 1;
    }
    if (method === "Input.dispatchKeyEvent") {
      if (params?.["type"] === "keyDown") {
        this.counts.keydown += 1;
        if (this.focused !== null && typeof params["text"] === "string") this.values.set(this.focused, (this.values.get(this.focused) ?? "") + params["text"]);
      }
      if (params?.["type"] === "keyUp") this.counts.keyup += 1;
    }
    if (method === "Input.dispatchMouseEvent") {
      if (params?.["type"] === "mousePressed") this.counts.mousedown += 1;
      if (params?.["type"] === "mouseReleased") this.counts.mouseup += 1;
    }
    if (method === "Accessibility.getFullAXTree") return { nodes: this.tree() };
    return {};
  }

  tree(): Record<string, unknown>[] {
    const fields = Object.values(FIELDS);
    const nodes: Record<string, unknown>[] = [
      { nodeId: "1", ignored: false, role: { value: "RootWebArea" }, name: { value: "Form" }, backendDOMNodeId: 1, childIds: fields.map((field) => String(field.backend)) },
    ];
    for (const field of fields) {
      const button = field.name === "Save";
      nodes.push({
        nodeId: String(field.backend),
        parentId: "1",
        ignored: false,
        role: { value: button ? "button" : "textbox" },
        name: { value: field.name },
        ...(button ? {} : { value: { value: this.values.get(field.backend) ?? "" } }),
        backendDOMNodeId: field.backend,
        childIds: [],
      });
    }
    return nodes;
  }

  call(source: string, args: { value?: unknown; objectId?: string }[]): Record<string, unknown> {
    const target = args[0]?.objectId ?? "";
    if (source.includes("ardiaBrowse.query")) {
      const selector = String(args[0]?.value);
      return FIELDS[selector] ? { type: "object", subtype: "node", objectId: selector } : { type: "object", subtype: "null" };
    }
    if (source === CLICKABLES) return { value: { known: [], hints: [], fresh: 0, title: "Form" } };
    if (source === FIELD_FACTS) {
      if (target === "#boom") return { value: { tag: "div", editable: false, disabled: false, kind: null, shown: true } };
      return { value: { tag: "input", type: "text", editable: true, disabled: false, value: "", kind: null, shown: true, connected: true } };
    }
    if (source === PREPARE_ACTION) return { value: { connected: true, shown: true, width: 1280, height: 800, box: true, cover: null, x: 60, y: 25, counts: { ...this.counts } } };
    if (source.includes("inputWatch") || source.includes("ardiaBrowseInputWatch")) return { value: { ...this.counts, activeFrame: false } };
    if (source.includes("ardiaBrowse.info")) return { value: { tag: "input", type: "text", editable: true, value: "", connected: true } };
    if (source.includes("api.filterField(field)")) return { value: false };
    if (source.includes("isConnected")) return { value: true };
    if (source.includes("visibilityState")) return { value: false };
    if (source.includes("document.title")) return { value: "Form" };
    return { value: null };
  }

  count(method: string): number {
    return this.sent.filter((sent) => sent === method).length;
  }
}

function setup(): { state: State; browser: FormBrowser } {
  const state = new State({ session: "t", key: "", browseFd: null, noAutoDialog: false, pinTab: false }, () => Promise.reject(new Error("unused")));
  state.instance = "I";
  state.targetInfos = new Map([["T", { targetId: "T", url: "https://form.example/", type: "page" }]]);
  state.current = "T";
  const browser = new FormBrowser();
  state.browser = browser as never;
  return { state, browser };
}

function changedRefs(data: unknown): unknown[] {
  const changes = (data as { changes?: { changed?: unknown[] } } | null)?.changes;
  return changes?.changed ?? [];
}

async function batch(state: State, lines: string[]): Promise<{ results: { success: boolean; text?: string; result: unknown }[]; text: string }> {
  return begin({ argv: ["batch"] }, async () => {
    await state.page("T");
    try {
      const result = await dispatch(new Ctx(state, {}, "/", {}, null, "batch"), "batch", lines);
      return { results: (result.data as { results: { success: boolean; result: unknown }[] }).results, text: result.text ?? "" };
    } catch (error) {
      if (error instanceof BrowseError) throw new Error(`batch failed: ${error.message}`);
      throw error;
    }
  });
}

describe("a batch looks at the page once around a run of independent field lines", () => {
  test("four fills read the accessibility tree twice, and the last line reports every field", async () => {
    const { state, browser } = setup();
    const { results, text } = await batch(state, ["fill #a one", "fill #b two", "fill #c three", "click #go"]);
    expect(browser.count("Accessibility.getFullAXTree")).toBe(3);
    expect(browser.count("Input.insertText")).toBe(3);
    expect(text).toContain("✓ fill #a one");
    expect(text).toContain("✓ fill #b two");
    expect(changedRefs(results[0]?.result)).toEqual([]);
    expect(changedRefs(results[1]?.result)).toEqual([]);
    expect(changedRefs(results[2]?.result)).toHaveLength(3);
  });

  test("consecutive clicks reuse the previous line's view as their before", async () => {
    const { state, browser } = setup();
    await batch(state, ["click #go", "click #go", "click #go"]);
    expect(browser.count("Accessibility.getFullAXTree")).toBe(4);
    expect(browser.count("Input.dispatchMouseEvent")).toBe(9);
  });

  test("a held line that fails still reports what the lines before it changed", async () => {
    const { state, browser } = setup();
    const { results } = await batch(state, ["fill #a one", "fill #b two", "fill #boom x", "fill #c three"]);
    expect(results.map((result) => result.success)).toEqual([true, true, false, true]);
    expect(browser.values.get(11)).toBe("one");
    expect(browser.values.get(13)).toBe("three");
    expect(changedRefs(results[1]?.result)).toHaveLength(2);
    expect(changedRefs(results[3]?.result)).toHaveLength(1);
  });
});

describe("fieldTarget", () => {
  test("finds the selector of a field line", () => {
    expect(fieldTarget(["fill", "#a", "x"])).toBe("#a");
    expect(fieldTarget(["fill", "--no-humanize", "@e3", "x"])).toBe("@e3");
    expect(fieldTarget(["fill", "-s", "#b", "x"])).toBe("#b");
    expect(fieldTarget(["check", "@e9"])).toBe("@e9");
    expect(fieldTarget(["type", "--delay", "50", "#a", "x"])).toBeNull();
    expect(fieldTarget(["click", "#go"])).toBeNull();
  });
});

class DialogBrowser extends FormBrowser {
  opened: (() => void) | null = null;

  override async send(method: string, params: Record<string, unknown> | null = null): Promise<Record<string, unknown>> {
    if (method === "Input.dispatchMouseEvent" && params?.["type"] === "mousePressed" && this.opened !== null) {
      this.sent.push(method);
      this.opened();
      this.opened = null;
      return new Promise(() => {});
    }
    return super.send(method, params);
  }
}

function dialogSetup(): { state: State; browser: DialogBrowser } {
  const { state } = setup();
  const browser = new DialogBrowser();
  state.browser = browser as never;
  browser.opened = () => {
    const page = state.pages.get("T");
    if (page) page.dialog = { type: "confirm", message: "Discard the draft?" };
  };
  return { state, browser };
}

describe("a JavaScript dialog in a batch", () => {
  test("--bail stops at the line that opened it and runs nothing after", async () => {
    const { state, browser } = dialogSetup();
    const started = performance.now();
    const { results } = await batch(state, ["--bail", "click #go", "fill #a one", "fill #b two"]);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(results.map((result) => [result.success, (result as { code?: string }).code ?? null])).toEqual([
      [false, "dialog_blocked"],
      [false, "not_run"],
      [false, "not_run"],
    ]);
    expect((results[0] as { error?: string }).error).toContain('`click` opened a JavaScript confirm dialog saying "Discard the draft?"');
    expect((results[1] as { error?: string }).error).toContain("a JavaScript dialog is open and --bail stops here");
    expect(browser.count("Input.insertText")).toBe(0);
  });

  test("without --bail each later line fails fast instead of hanging on the frozen page", async () => {
    const { state, browser } = dialogSetup();
    const started = performance.now();
    const { results } = await batch(state, ["click #go", "fill #a one"]);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(results.map((result) => (result as { code?: string }).code ?? null)).toEqual(["dialog_blocked", "dialog_blocked"]);
    expect((results[1] as { error?: string }).error).toContain("so `fill` wasn't sent");
    expect(browser.count("Input.insertText")).toBe(0);
  });
});
