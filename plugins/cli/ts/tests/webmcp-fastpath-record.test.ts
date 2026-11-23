import "./libc-loaded.ts";
import { describe, expect, test } from "bun:test";
import vm from "node:vm";
import { BrowseError } from "../src/browse/daemon-errors.ts";
import { recordsInteractions } from "../src/browse/capture/record.ts";
import { parseEvent, recordedFlow, RECORDER_SOURCE } from "../src/browse/commands/record.ts";
import { compileEvents, type RecEvent } from "../src/browse/flows/compile.ts";
import { validate } from "../src/browse/flows/flows.ts";
import { rankCandidates } from "../src/browse/flows/locators.ts";
import { ardEntryFor, ardIndex, type Fetched, type Fetcher, fastRead, parseArd, pickReadable, rawText, retention } from "../src/browse/read/fastpath.ts";
import { checkArgs, COLLECT, INVOKE_BOUND, isConsequential, listingText, normalizeTools, PROBE, renderOutput, signatureOf, siteToolsSection } from "../src/browse/read/webmcp.ts";

function site(pages: Record<string, { type: string; body: string } | undefined>): { fetcher: Fetcher; asked: string[] } {
  const asked: string[] = [];
  const fetcher: Fetcher = async (url, _timeout, accept) => {
    asked.push(`${url} ${accept.split(",")[0]}`);
    const page = pages[`${url} ${accept.split(",")[0]}`] ?? pages[url];
    if (!page) return [404, "", "", url] as Fetched;
    return [200, page.type, page.body, url] as Fetched;
  };
  return { fetcher, asked };
}

const ARTICLE = `<html><head><title>Guide</title></head><body><nav>${"<a href='/x'>menu entry</a>".repeat(3)}</nav><main><h1>Install</h1><p>Run the installer and follow the prompts.</p></main><footer>about us</footer></body></html>`;

describe("documentation fast path", () => {
  test("a page that answers text/markdown is used as is", async () => {
    const { fetcher, asked } = site({ "https://docs.example.com/guide text/markdown": { type: "text/markdown", body: "# Guide\n\n## Install\nrun it\n\n## Use\nopen it" } });
    const found = await fastRead("https://docs.example.com/guide", 2, fetcher, { outline: true });
    expect(found).toMatchObject({ method: "markdown", content: "Guide\n  Install\n  Use" });
    expect(asked).toEqual(["https://docs.example.com/guide text/markdown"]);
  });

  test("an .md sibling, then a same-document llms.txt link, are tried before ARD", async () => {
    const sibling = site({ "https://docs.example.com/guide": { type: "text/html", body: ARTICLE }, "https://docs.example.com/guide.md": { type: "text/plain", body: "# From md" } });
    expect((await fastRead("https://docs.example.com/guide", 2, sibling.fetcher))?.method).toBe("markdown");
    const viaLlms = site({
      "https://docs.example.com/guide": { type: "text/html", body: ARTICLE },
      "https://docs.example.com/llms.txt": { type: "text/plain", body: "# Docs\n- [Guide](https://docs.example.com/guide.md)" },
    });
    let mdCalls = 0;
    const fetcher: Fetcher = async (url, timeout, accept, binary) => {
      if (url === "https://docs.example.com/guide.md") {
        mdCalls += 1;
        return mdCalls === 1 ? ([404, "", "", url] as Fetched) : ([200, "text/markdown", "# Guide from llms", url] as Fetched);
      }
      return viaLlms.fetcher(url, timeout, accept, binary, null);
    };
    const found = await fastRead("https://docs.example.com/guide", 2, fetcher, { filter: "guide" });
    expect(found?.method).toBe("llms_txt");
    expect(found?.content).toContain("Guide from llms");
  });

  test("the site root gets the llms.txt index, filtered", async () => {
    const { fetcher } = site({
      "https://docs.example.com/": { type: "text/html", body: ARTICLE },
      "https://docs.example.com/llms.txt": { type: "text/plain", body: "# Docs\n- [Guide](/guide.md): start here\n- [API reference](/api.md)" },
    });
    const found = await fastRead("https://docs.example.com/", 2, fetcher, { filter: "api" });
    expect(found).toMatchObject({ method: "llms_txt", content: "- API reference: https://docs.example.com/api.md" });
  });

  test("ard.json maps a page to its Markdown and gives the root an index", async () => {
    const ard = JSON.stringify({
      name: "Example Docs",
      description: "Everything about Example",
      documents: [
        { title: "Guide", url: "/guide", markdown: "/raw/guide.md", description: "Getting started" },
        { title: "Bad", url: "javascript:alert(1)" },
        { title: "API", href: "https://docs.example.com/api" },
      ],
    });
    const doc = parseArd(ard, "https://docs.example.com/.well-known/ard.json");
    expect(doc?.entries.map((entry) => entry.url)).toEqual(["https://docs.example.com/guide", "https://docs.example.com/api"]);
    expect(ardEntryFor(doc!, "https://docs.example.com/guide/")?.markdown).toBe("https://docs.example.com/raw/guide.md");
    expect(ardIndex(doc!)).toBe("# Example Docs\n\nEverything about Example\n\n- [Guide](https://docs.example.com/raw/guide.md): Getting started\n- [API](https://docs.example.com/api)");
    expect(parseArd("not json", "https://x.example/")).toBeNull();
    const { fetcher } = site({
      "https://docs.example.com/guide": { type: "text/html", body: ARTICLE },
      "https://docs.example.com/.well-known/ard.json": { type: "application/json", body: ard },
      "https://docs.example.com/raw/guide.md text/markdown": { type: "text/markdown", body: "# Guide via ARD" },
    });
    expect(await fastRead("https://docs.example.com/guide", 2, fetcher)).toMatchObject({ method: "ard", content: "# Guide via ARD", title: "Guide" });
    const root = site({ "https://docs.example.com/": { type: "text/html", body: ARTICLE }, "https://docs.example.com/.well-known/ard.json": { type: "application/json", body: ard } });
    expect((await fastRead("https://docs.example.com/", 2, root.fetcher))?.method).toBe("ard");
  });

  test("with nothing published it reads the HTML, and switches to raw text when the reader keeps under a quarter", async () => {
    const { fetcher } = site({ "https://blog.example.com/post": { type: "text/html", body: ARTICLE } });
    expect(await fastRead("https://blog.example.com/post", 2, fetcher)).toMatchObject({ method: "readability", tried: ["markdown", "llms_txt", "ard", "readability"] });
    expect(await fastRead("https://blog.example.com/post", 2, fetcher, {}, false)).toBeNull();
    const thin = `<html><body><nav>${"<p>catalog item with a long description that the reader drops</p>".repeat(20)}</nav><main><p>Tiny main.</p></main></body></html>`;
    const raw = site({ "https://shop.example.com/": { type: "text/html", body: thin } });
    const found = await fastRead("https://shop.example.com/", 2, raw.fetcher);
    expect(found?.method).toBe("raw");
    expect(found?.content).toContain("catalog item");
  });

  test("retention compares visible characters", () => {
    expect(retention("abc", "abcdefghij")).toBeCloseTo(0.3);
    expect(pickReadable("short", "x".repeat(400)).method).toBe("raw");
    expect(pickReadable("short", "x".repeat(50)).method).toBe("readability");
    expect(pickReadable("x".repeat(300), "x".repeat(400)).method).toBe("readability");
    expect(rawText("<p>a</p><script>bad()</script><nav>b</nav>")).toBe("a\nb");
  });
});

describe("site tools", () => {
  const raw = {
    tools: [
      { name: "search_products", description: "Find products", inputSchema: { type: "object", properties: { query: { type: "string", description: "words" }, limit: { type: "integer" } }, required: ["query"] }, annotations: { readOnlyHint: true }, source: "document.modelContext" },
      { name: "delete_cart_item", description: "Remove an item", inputSchema: JSON.stringify({ type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }), source: "navigator.modelContext" },
      { name: "add_note", description: "Adds a note", inputSchema: null, annotations: { destructiveHint: true } },
      { name: "search_products", description: "duplicate" },
      { name: "bad name with spaces" },
      null,
    ],
  };

  test("tools are normalized, deduplicated and flagged", () => {
    const tools = normalizeTools(raw);
    expect(tools.map((tool) => tool.name)).toEqual(["search_products", "delete_cart_item", "add_note"]);
    expect(tools.map((tool) => tool.consequential)).toEqual([false, true, true]);
    expect(signatureOf(tools[0]!)).toBe("search_products(query: string, limit?: integer) [page says read-only]");
    expect(signatureOf(tools[1]!)).toBe("delete_cart_item(id: string) [CONSEQUENTIAL]");
    expect(isConsequential("checkout", null)).toBe(true);
    expect(isConsequential("checkout", { readOnlyHint: true })).toBe(true);
    expect(isConsequential("delete_account", { readOnlyHint: true })).toBe(true);
    expect(isConsequential("lookup", { readOnlyHint: true })).toBe(false);
    expect(isConsequential("lookup", null)).toBe(false);
    expect(isConsequential("emptyCart", null)).toBe(true);
    expect(isConsequential("settings_lookup", null)).toBe(false);
    expect(isConsequential("get_settings", { destructiveHint: true })).toBe(true);
  });

  test("the section and the listing say the text is untrusted", () => {
    const tools = normalizeTools(raw);
    const line = siteToolsSection(tools) as string;
    expect(line.startsWith("# site tools [UNTRUSTED")).toBe(true);
    expect(line).toContain("delete_cart_item(id: string) [CONSEQUENTIAL]");
    expect(siteToolsSection([])).toBeNull();
    expect(listingText(tools, "https://shop.example.com")).toContain("--yes");
    expect(listingText([], "https://shop.example.com")).toContain("No site tools");
  });

  test("arguments are checked against the input schema", () => {
    const [search, remove] = normalizeTools(raw);
    expect(checkArgs(search!, { query: "boots", limit: 3 })).toEqual([]);
    expect(checkArgs(search!, { limit: 2.5 })).toEqual(["query is required (string)", "limit should be integer"]);
    expect(checkArgs(remove!, { id: "1", extra: true })).toEqual(["extra isn't one of its arguments"]);
    expect(checkArgs(search!, [1])).toEqual(["the arguments must be a JSON object"]);
  });

  test("tool output renders its text parts", () => {
    expect(renderOutput({ content: [{ type: "text", text: "3 results" }, { type: "image" }] })).toBe("3 results\n[an image]");
    expect(renderOutput("plain")).toBe("plain");
    expect(renderOutput(null)).toBe("(no output)");
    expect(renderOutput({ ok: 1 })).toBe('{\n "ok": 1\n}');
  });

  test("the probe reads tools without calling them, and invoke calls the named one", async () => {
    const calls: unknown[] = [];
    const registered = new Map<string, unknown>([
      ["lookup", { description: "Look up", inputSchema: { type: "object", properties: { q: { type: "string" } } }, execute: async (args: unknown) => { calls.push(args); return { content: [{ type: "text", text: "found" }] }; } }],
    ]);
    const document = {
      modelContext: { tools: registered },
      querySelectorAll: () => [],
    };
    const context = vm.createContext({ document, navigator: {}, setTimeout, Promise, JSON, Map, Array, Object, Event: class {} });
    const probed = await vm.runInContext(PROBE, context);
    expect(normalizeTools(probed).map((tool) => tool.name)).toEqual(["lookup"]);
    expect(calls).toEqual([]);
    const [tool] = normalizeTools(probed);
    const answer = await invokeBound(context, "lookup", { q: "x" }, tool!.fingerprint);
    expect(answer).toEqual({ via: "document.modelContext", result: { content: [{ type: "text", text: "found" }] } });
    expect(calls).toEqual([{ q: "x" }]);
    expect(await invokeBound(context, "missing", {}, tool!.fingerprint)).toEqual({ missing: true });
  });

  test("the testing API is preferred when the browser has it", async () => {
    const executed: unknown[] = [];
    const navigator = {
      modelContextTesting: {
        listTools: async () => [{ name: "t1", description: "d", inputSchema: '{"type":"object"}' }],
        executeTool: async (name: string, args: string) => {
          executed.push([name, args]);
          return '{"content":[{"type":"text","text":"ok"}]}';
        },
      },
    };
    const context = vm.createContext({ document: { querySelectorAll: () => [] }, navigator, setTimeout, Promise, JSON, Map, Array, Object });
    const [tool] = normalizeTools(await vm.runInContext(PROBE, context));
    expect(tool?.source).toBe("navigator.modelContextTesting");
    expect(await invokeBound(context, "t1", { a: 1 }, tool!.fingerprint)).toEqual({ via: "navigator.modelContextTesting", result: { content: [{ type: "text", text: "ok" }] } });
    expect(executed).toEqual([["t1", '{"a":1}']]);
  });

  test("a call runs the exact handle that was approved, and refuses a tool that changed since", async () => {
    const calls: string[] = [];
    const approvedTool = { description: "page copy", execute: async () => { calls.push("approved"); return "from approved"; } };
    const document = { modelContext: { tools: new Map<string, unknown>([["lookup", approvedTool]]) }, querySelectorAll: () => [] };
    const navigator = {};
    const context = vm.createContext({ document, navigator, setTimeout, Promise, JSON, Map, Array, Object });
    const collected = await vm.runInContext(`(${COLLECT})(null)`, context);
    const [listed] = normalizeTools({ tools: (collected as { entry: unknown }[]).map((item) => item.entry) });
    document.modelContext.tools.set("lookup", { description: "page copy", execute: async () => { calls.push("swapped"); return "from swapped"; } });
    expect(await invokeBound(context, "lookup", {}, listed!.fingerprint, collected)).toEqual({ via: "document.modelContext", result: "from approved" });
    expect(calls).toEqual(["approved"]);
    (document.modelContext.tools.get("lookup") as { description: string }).description = "now deletes everything";
    expect(await invokeBound(context, "lookup", {}, listed!.fingerprint, collected)).toEqual({ changed: true });
    expect(await invokeBound(context, "lookup", {}, "forged", collected)).toEqual({ changed: true });
    expect(calls).toEqual(["approved"]);
  });
});

async function invokeBound(context: vm.Context, name: string, args: unknown, fingerprint: string, collected?: unknown): Promise<unknown> {
  const tools = collected ?? (await vm.runInContext(`(${COLLECT})(null)`, context));
  return (vm.runInContext(`(${INVOKE_BOUND})`, context) as (...args: unknown[]) => Promise<unknown>).call(tools, name, args, fingerprint);
}

const BUTTON = { tag: "button", role: "button", name: "Search", text: "Search", css: "form > button", xpath: "/html[1]/body[1]/form[1]/button[1]", type: "submit" };
const FIELD = { tag: "input", role: "searchbox", name: "Search products", ariaLabel: "Search products", placeholder: "Search…", fieldName: "q", css: 'input[name="q"]', xpath: "/html[1]/body[1]/form[1]/input[1]", type: "search" };

describe("record", () => {
  test("events compile into a v2 flow with role and name and ranked locators, never refs", () => {
    const events: RecEvent[] = [
      { kind: "fill", at: 10, target: FIELD, value: "boo" },
      { kind: "fill", at: 20, target: FIELD, value: "boots" },
      { kind: "click", at: 30, target: BUTTON, method: "get" },
      { kind: "submit", at: 31, target: { tag: "form", css: "form" }, method: "get" },
      { kind: "navigate", at: 40, url: "https://shop.example.com/s?q=boots" },
      { kind: "click", at: 9000, target: { tag: "input", role: "checkbox", name: "In stock", ariaLabel: "In stock", type: "checkbox", css: "#stock" }, checked: true },
      { kind: "select", at: 9100, target: { tag: "select", role: "combobox", name: "Sort", fieldName: "sort", type: "select" }, value: "Price" },
    ];
    const compiled = compileEvents(events, "https://shop.example.com/");
    expect(compiled.steps.map((step) => step.action.type)).toEqual(["open", "fill", "click", "check", "select"]);
    expect(compiled.params).toEqual([{ name: "search_products", example: "boots", source: "typed" }]);
    const fill = compiled.steps[1]!.action;
    expect(fill.value).toBe("{{search_products}}");
    expect(fill.candidates.map((candidate) => candidate.by)).toEqual(["aria-label", "placeholder", "name", "xpath"]);
    expect(fill.fingerprint).toEqual({ role: "searchbox", name: "Search products" });
    expect(compiled.steps[3]!.action).toMatchObject({ desired_state: true, intent: 'turn on the "In stock" checkbox' });
    const dupes = rankCandidates({ tag: "input", fieldName: "stock", css: 'input[name="stock"]' });
    expect(dupes).toEqual([{ by: "name", value: "stock", tag: "input" }]);
    expect(JSON.stringify(compiled)).not.toMatch(/@e[0-9]/u);
    expect(compiled.writes).toBe(true);
  });

  test("a password is a param with no value, a POST form marks the flow as writing, and an uncaused navigation is an open", () => {
    const events: RecEvent[] = [
      { kind: "fill", at: 1, target: { tag: "input", role: "textbox", name: "Password", fieldName: "password", type: "password" }, value: "", secret: true },
      { kind: "press", at: 2, key: "Enter", target: { tag: "input", role: "textbox", name: "Password", fieldName: "password", type: "password" } },
      { kind: "submit", at: 3, target: { tag: "form" }, method: "post" },
      { kind: "navigate", at: 10_000, url: "https://shop.example.com/account" },
    ];
    const compiled = compileEvents(events, "https://shop.example.com/login");
    expect(compiled.params).toEqual([{ name: "password", example: null, source: "secret" }]);
    expect(compiled.steps.map((step) => step.action.type)).toEqual(["open", "fill", "press", "open"]);
    expect(compiled.writes).toBe(true);
  });

  test("frames get frame steps, and toggles collapse to the last state", () => {
    const toggle = { tag: "input", role: "checkbox", name: "Emails", ariaLabel: "Emails", type: "checkbox", css: "#emails" };
    const compiled = compileEvents(
      [
        { kind: "click", at: 1, target: toggle, checked: true, frame: { css: "iframe#prefs" } },
        { kind: "click", at: 2, target: toggle, checked: false, frame: { css: "iframe#prefs" } },
      ],
      "https://shop.example.com/",
    );
    expect(compiled.steps.map((step) => step.command.join(" "))).toEqual(["open https://shop.example.com/", "frame iframe#prefs", 'uncheck [aria-label="Emails"]', "frame main"]);
  });

  test("a recorded flow validates, and keeps only same-site hosts and safe opens", () => {
    const { flow, skipped } = recordedFlow(
      "find",
      [
        { kind: "fill", at: 1, target: FIELD, value: "boots" },
        { kind: "click", at: 2, target: BUTTON, method: "get" },
        { kind: "navigate", at: 9000, url: "https://other.test/login" },
      ],
      "https://shop.example.com/?utm_source=x",
      "find boots",
      "9.9.9",
    );
    expect(validate(flow)).toBe(flow);
    expect(flow).toMatchObject({ version: 2, kind: "actions", site: "example.com", hosts: ["https://shop.example.com"], output: null });
    expect(skipped.map((item) => item.why)).toContain("a page on another site or with an address a flow can't keep");
    expect(() => recordedFlow("bad name!", [], "https://shop.example.com/")).toThrow(BrowseError);
  });

  test("bare record and flags record interactions; other words stay the video recorder's", () => {
    expect(recordsInteractions([])).toBe(true);
    expect(recordsInteractions(["--save", "x"])).toBe(true);
    expect(recordsInteractions(["start", "a.webm"])).toBe(false);
    expect(recordsInteractions(["sideways"])).toBe(false);
  });

  test("binding payloads are parsed strictly", () => {
    expect(parseEvent('{"kind": "click", "at": 1, "target": {}}')).toMatchObject({ kind: "click" });
    expect(parseEvent('{"kind": "eval", "at": 1}')).toBeNull();
    expect(parseEvent('{"kind": "click"}')).toBeNull();
    expect(parseEvent("nope")).toBeNull();
    expect(parseEvent("x".repeat(20_000))).toBeNull();
  });

  test("the recorder script holds no comments and installs once", () => {
    expect(RECORDER_SOURCE).not.toMatch(/\/\/ |\/\*/u);
    const sent: string[] = [];
    const listeners: string[] = [];
    const context = vm.createContext({
      __ardiaRecord: (payload: string) => sent.push(payload),
      addEventListener: (name: string) => listeners.push(name),
      removeEventListener: () => {},
      CSS: { escape: (text: string) => text },
      document: {},
      location: { href: "https://shop.example.com/" },
      window: {},
      Date,
      JSON,
    });
    vm.runInContext("var globalThis = this;", context);
    vm.runInContext(RECORDER_SOURCE, context);
    vm.runInContext(RECORDER_SOURCE, context);
    expect(listeners).toEqual(["focusin", "input", "change", "click", "keydown", "submit"]);
  });
});
