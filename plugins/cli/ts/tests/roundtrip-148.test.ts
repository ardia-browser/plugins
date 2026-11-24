import { expect, test } from "bun:test";
import { rebound } from "../src/browse/commands/batch.ts";
import { asksHelp } from "../src/browse/commands/index.ts";
import { labelShaped } from "../src/browse/commands/act.ts";
import { type Field, fieldLine, fieldSpecs, formSummary, maskedValue, rowsText, splitTop } from "../src/browse/commands/extract.ts";
import { absoluteUrls, contentOf, fetchedOf, fetchedText, share } from "../src/browse/commands/read-urls.ts";
import { checkedState } from "../src/browse/commands/read.ts";
import { StaleRef, Usage } from "../src/browse/daemon-errors.ts";
import { stepsData, stepsText } from "../src/browse/script/script.ts";
import { compactTree, type Trimmed } from "../src/browse/snapshot/compact.ts";
import { Node } from "../src/browse/snapshot/tree.ts";
import { placeEndpointFlags } from "../src/endpoint-flags.ts";

function text(name: string): Node {
  return new Node("StaticText", name);
}

function control(role: string, name: string, ref: string, value = "", children: Node[] = []): Node {
  return new Node(role, name, value, new Map(), 1, children, ref);
}

function lines(nodes: readonly Node[], depth = 0): string[] {
  return nodes.flatMap((node) => [`${"  ".repeat(depth)}${node.role}${node.name ? ` "${node.name}"` : ""}`, ...lines(node.children, depth + 1)]);
}

test("a stale ref is rebound only where it is a selector", () => {
  expect(rebound(["click", "@e14"], "e14", "e352")).toEqual(["click", "@e352"]);
  expect(rebound(["fill", "ref=e14", "x"], "e14", "e352")).toEqual(["fill", "ref=e352", "x"]);
  expect(rebound(["fill", "[ref=e14]", "x"], "e14", "e352")).toEqual(["fill", "[ref=e352]", "x"]);
  expect(rebound(["fill", "--selector=@e14", "x"], "e14", "e352")).toEqual(["fill", "--selector=@e352", "x"]);
  expect(rebound(["click", "e14"], "e14", "e352")).toEqual(["click", "e352"]);
  expect(rebound(["fill", "@e5", "e14"], "e14", "e352")).toBeNull();
  expect(rebound(["drag", "@e1", "@e14"], "e14", "e352")).toEqual(["drag", "@e1", "@e352"]);
  expect(rebound(["click", "#save"], "e14", "e352")).toBeNull();
});

test("a stale ref error carries its successor and matches without changing its message", () => {
  const error = new StaleRef("e14", "the element was removed from the page");
  expect(error.text).toBe("Stale ref @e14: the element was removed from the page. Run `ardia browse snapshot -i` again and use the new refs");
  expect(error.successor).toBeNull();
  expect(error.matches).toEqual([]);
  expect(error.ambiguous).toBe(false);
  expect(error.staleRef).toBe("e14");
  expect(error.code).toBe("stale_ref");
});

test("the lean snapshot drops labels and values that repeat a control, and lifts list and row wrappers", () => {
  const tree = [
    new Node("form", "", "", new Map(), 1, [
      new Node("LabelText", "", "", new Map(), 2, [text("Full name")]),
      control("textbox", "Full name", "e11"),
      new Node("LabelText", "", "", new Map(), 3, [text("Email "), control("textbox", "Email", "e12", "a@b.c", [text("a@b.c")])]),
      control("combobox", "Country", "e16", "Mexico", [new Node("MenuListPopup", "", "", new Map(), 4, [control("option", "Canada", "e17"), control("option", "Mexico", "e18")])]),
      new Node("table", "", "", new Map(), 5, [new Node("rowgroup", "", "", new Map(), 6, [new Node("row", "", "", new Map(), 7, [new Node("cell", "Mug")])])]),
      text("Shipping is free"),
    ]),
  ];
  const trimmed: Trimmed = { lines: 0 };
  const lean = lines(compactTree(tree, true, trimmed));
  expect(lean).toEqual([
    "form",
    '  textbox "Full name"',
    '  textbox "Email"',
    '  combobox "Country"',
    '    option "Canada"',
    '    option "Mexico"',
    "  table",
    "    row",
    '      cell "Mug"',
    '  StaticText "Shipping is free"',
  ]);
  expect(trimmed.lines).toBeGreaterThan(5);
  const full = lines(compactTree(tree));
  expect(full).toContain("  LabelText");
  expect(full).toContain("    MenuListPopup");
  expect(full.length).toBeGreaterThan(lean.length);
});

test("query --fields splits on top-level commas and reads @attributes", () => {
  expect(splitTop('name=h2, price=.price,url=a[href*=","]@href')).toEqual(["name=h2", "price=.price", 'url=a[href*=","]@href']);
  expect(fieldSpecs(["name=h2,url=a@href", "img=@src", ".title"])).toEqual([
    { key: "name", selector: "h2", attribute: null },
    { key: "url", selector: "a", attribute: "href" },
    { key: "img", selector: null, attribute: "src" },
    { key: ".title", selector: ".title", attribute: null },
  ]);
  expect(fieldSpecs(['tag=a[data-x="a=b"]'])).toEqual([{ key: "tag", selector: 'a[data-x="a=b"]', attribute: null }]);
  expect(() => fieldSpecs(["=h2"])).toThrow(Usage);
  expect(rowsText(".card", 2, 2, [{ name: "Red Mug" }, { name: "Blue Cup" }])).toBe('2 rows for .card:\n{"name": "Red Mug"}\n{"name": "Blue Cup"}');
  expect(rowsText(".card", 1, 3, [{ name: "Red Mug" }]).split("\n")[0]).toBe("1 of 3 rows for .card (--limit 3 for more):");
  expect(rowsText(".none", 0, 0, [])).toBe("No visible matches for .none");
});

test("form lines show role, label, state, validation and ref, and mask secrets", () => {
  const field = (extra: Partial<Field>): Field => ({
    ref: "e1", role: "textbox", label: "Email", type: "email", name: "email", value: "", checked: null, disabled: false, required: true, readonly: false, invalid: "Please fill out this field.", options: null, ...extra,
  });
  expect(fieldLine(field({}))).toBe('- textbox "Email" [type=email, required, invalid: Please fill out this field., ref=e1]: (empty)');
  expect(fieldLine(field({ role: "radio", type: "radio", label: "Pro", name: "plan", checked: false, required: false, invalid: "" }))).toBe('- radio "Pro" [checked=false, group=plan, ref=e1]');
  expect(fieldLine(field({ role: "combobox", type: "select", label: "Country", value: "Mexico", options: 2, required: false, invalid: "" }))).toBe('- combobox "Country" [ref=e1]: Mexico (of 2)');
  expect(formSummary([field({}), field({ required: false, invalid: "", value: "x" })])).toBe("form: 2 fields, 1 required, 1 required and empty, 1 invalid");
  expect(maskedValue({ type: "password", value: "hunter2", label: "Password" })).toBe("••••");
  expect(maskedValue({ type: "text", value: "4111 1111 1111 1111", label: "Number" })).toBe("••••");
  expect(maskedValue({ type: "text", value: "123456", label: "One-time code" })).toBe("••••");
  expect(maskedValue({ type: "text", value: "Ana", label: "Name" })).toBe("Ana");
  expect(maskedValue({ type: "checkbox", value: null, label: "Terms" })).toBeNull();
});

test("read-urls resolves addresses, turns HTML into text and reports each failure on its own", () => {
  expect(absoluteUrls(["/p/1", "https://a.example/x"], "http://127.0.0.1:8000/list")).toEqual(["http://127.0.0.1:8000/p/1", "https://a.example/x"]);
  expect(() => absoluteUrls(["javascript:alert(1)"], "http://127.0.0.1/")).toThrow(Usage);
  expect(() => absoluteUrls(["/p/1"], "about:blank")).toThrow(Usage);
  const html = contentOf("<html><title>P1</title><nav>menu</nav><h1>Product</h1><p>Details.</p><script>x()</script></html>", "text/html");
  expect(html).toEqual({ content: "# Product\n\nDetails.", title: "P1" });
  expect(contentOf('{"a": 1}', "application/json").content).toBe('{"a": 1}');
  const good = fetchedOf({ url: "http://x/p", finalUrl: "http://x/p", status: 200, ok: true, contentType: "text/plain", body: "a".repeat(1000), binary: false, truncated: false }, "http://x", 400);
  expect(good.error).toBeNull();
  expect(good.truncated).toBe(true);
  expect(good.content.length).toBe(400);
  expect(good.chars).toBe(1000);
  const missing = fetchedOf({ url: "http://x/m", status: 404, ok: false, contentType: "text/html", body: "<p>nope</p>", binary: false }, "http://x", 400);
  expect(missing.error).toBe("HTTP 404");
  const blocked = fetchedOf({ url: "https://other/x", error: "Failed to fetch" }, "http://x", 400);
  expect(blocked.error).toContain("`ardia browse read <url>` loads it in a tab");
  expect(fetchedOf({ url: "http://x/t", error: "timeout" }, "http://x", 400).error).toBe("timed out");
  expect(fetchedOf({ url: "http://x/i.png", status: 200, contentType: "image/png", binary: true }, "http://x", 400).error).toContain("isn't text");
  const shown = fetchedText([good, missing, blocked], "http://x", 0.25);
  expect(shown.split("\n")[0]).toBe("read-urls: 1 of 3 read in 250 ms, from http://x with its cookies");
  expect(shown).toContain("## [2] ✗ http://x/m: HTTP 404");
  expect(shown).toContain("[cut at 400 of 1,000 characters; --max-chars or --full shows more]");
  expect(share(12000, 3, null)).toBe(4000);
  expect(share(12000, 100, null)).toBe(400);
  expect(share(12000, 3, 50)).toBe(50);
});

test("a failed script lists the calls before it with their lines", () => {
  const source = "await page.click('#a');\nconst t = await page.text('#b');\nawait page.click('#c');";
  const steps = [
    { call: 2, command: "get", line: 2, ok: true },
    { call: 1, command: "click", line: 1, ok: true },
    { call: 3, command: "click", line: 3, ok: false },
  ];
  expect(stepsText(steps, source)).toBe("calls before it stopped (2 of 3 ok): line 1 click ✓ · line 2 get ✓ · line 3 click ✗");
  expect(stepsData(steps, source).map((step) => step["call"])).toEqual([1, 2, 3]);
  expect(stepsText([], source)).toBe("");
  const many = Array.from({ length: 15 }, (_, index) => ({ call: index + 1, command: "get", line: 1, ok: true }));
  expect(stepsText(many, source)).toContain("15 of 15 ok, 3 earlier not shown");
});

test("--port and --session go anywhere: browse gets the session, other commands ignore both", () => {
  expect(placeEndpointFlags(["tabs", "--port", "9371"]).argv).toEqual(["tabs"]);
  expect(placeEndpointFlags(["methods", "--port=9371"]).argv).toEqual(["methods"]);
  expect(placeEndpointFlags(["--port", "9", "star"])).toEqual({ argv: ["star"], dropped: ["--port"] });
  expect(placeEndpointFlags(["--session", "x", "windows", "--json"]).argv).toEqual(["windows", "--json"]);
  expect(placeEndpointFlags(["tabs", "move", "tab-1", "--session", "s", "--group", "G"]).argv).toEqual(["tabs", "move", "tab-1", "--group", "G"]);
  expect(placeEndpointFlags(["--session", "s", "--port", "9", "browse", "tab"]).argv).toEqual(["--port", "9", "browse", "--session", "s", "tab"]);
  expect(placeEndpointFlags(["--session=s", "notes", "get"]).argv).toEqual(["notes", "--session=s", "get"]);
  expect(placeEndpointFlags(["browse", "--port", "9", "snapshot"]).argv).toEqual(["browse", "--port", "9", "snapshot"]);
  expect(placeEndpointFlags(["scripts", "test", "x.user.ts", "--port", "9"]).argv).toEqual(["scripts", "test", "x.user.ts", "--port", "9"]);
  expect(placeEndpointFlags(["--port", "9", "scripts", "test", "x.user.ts"]).argv).toEqual(["--port", "9", "scripts", "test", "x.user.ts"]);
  expect(placeEndpointFlags(["scripts", "list", "--port", "9"]).argv).toEqual(["scripts", "list"]);
  expect(placeEndpointFlags(["on", "tab.opened", "--", "echo", "--port", "1"]).argv).toEqual(["on", "tab.opened", "--", "echo", "--port", "1"]);
  expect(placeEndpointFlags(["--port"]).argv).toEqual(["--port"]);
  expect(placeEndpointFlags(["tabs", "--port"]).argv).toEqual(["tabs", "--port"]);
  expect(placeEndpointFlags(["computer", "--port", "9"]).argv).toEqual(["computer", "--port", "9"]);
});

test("--help on a batch line is help, except inside free text", () => {
  expect(asksHelp("network", ["requests", "--help"])).toBe(true);
  expect(asksHelp("snapshot", ["-h"])).toBe(true);
  expect(asksHelp("fill", ["@e1", "--help"])).toBe(false);
  expect(asksHelp("fill", ["--help"])).toBe(true);
  expect(asksHelp("click", ["--", "--help"])).toBe(false);
  expect(asksHelp("click", ["@e1"])).toBe(false);
});

test("a plain label is tried as a field label; refs and CSS-looking selectors aren't", () => {
  expect(labelShaped("Full name")).toBe(true);
  expect(labelShaped("Email")).toBe(true);
  expect(labelShaped("@e5")).toBe(false);
  expect(labelShaped("e5")).toBe(false);
  expect(labelShaped("#email")).toBe(false);
  expect(labelShaped(".field input")).toBe(false);
  expect(labelShaped("text=Save")).toBe(false);
  expect(labelShaped("//input")).toBe(false);
  expect(labelShaped("42")).toBe(false);
});

test("find … is and is take the same states", () => {
  for (const state of ["checked", "unchecked", "disabled", "enabled", "visible", "hidden", "editable", "required"]) expect(() => checkedState(state, "x")).not.toThrow();
  expect(() => checkedState("bogus", "state for find … is")).toThrow("Unknown state for find … is: bogus");
});
