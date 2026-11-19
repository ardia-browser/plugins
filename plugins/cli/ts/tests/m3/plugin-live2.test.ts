import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import { methodsBetweenMarks, pluginViolations } from "./plugin-rules.ts";
import { CHROME, entries, pageTarget, startWorld, step, stopWorld, tap, type World } from "./plugin-world.ts";

setDefaultTimeout(120_000);
const BASE = Number(process.env["ARDIA_F1_PORTS"] ?? "9660") + 5;

describe.skipIf(!CHROME)("plugin mode phase 2 against headless Chrome for Testing, through the CDP tap", () => {
  let world: World;
  let loader = "";

  async function marked(name: string, argv: string[], options: Record<string, unknown> = {}) {
    await tap(world, "mark", { step: name });
    return step(world, argv, { expect_loader: loader, ...options });
  }

  beforeAll(async () => {
    world = await startWorld(BASE);
    const target = await pageTarget(world);
    const picked = await step(world, ["tab", target], { json: true });
    loader = String((JSON.parse(picked.out) as { data: { loader: string } }).data.loader);
    expect((await step(world, ["snapshot", "-i"], { expect_loader: loader })).exit).toBe(0);
  });

  afterAll(async () => {
    if (world) {
      if (process.env["ARDIA_F1_SENT2"]) fs.writeFileSync(process.env["ARDIA_F1_SENT2"], JSON.stringify(Object.fromEntries(methodsBetweenMarks(entries(world))), null, 1));
      await stopWorld(world);
    }
  });

  test("get reads titles, URLs, text, HTML, values, attributes, counts and boxes without page script", async () => {
    expect((await marked("get title", ["get", "title"])).out).toBe("Form page\n");
    expect((await marked("get url", ["get", "url"])).out).toBe(`http://127.0.0.1:${world.sitePort}/form\n`);
    expect((await marked("get text", ["get", "text", "#list"])).out).toBe("one\ntwo\nthree\nfour\nfive\nsix\n");
    expect((await marked("get text ref", ["get", "text", "@e3"])).out).toBe("Save\n");
    expect((await marked("get html", ["get", "html", "#list"])).out).toBe("<p>one</p><p>two</p><p>three</p><p>four</p><p>five</p><p>six</p>\n");
    expect((await marked("get attr", ["get", "attr", "@e4", "href"])).out).toBe("/done\n");
    expect((await marked("get count", ["get", "count", "p"])).out).toBe("8\n");
    const box = await marked("get box", ["get", "box", "@e3"], { json: true });
    expect(Object.keys((JSON.parse(box.out) as { data: Record<string, number> }).data)).toEqual(["x", "y", "width", "height"]);
    expect((await marked("get styles", ["get", "styles", "@e3"])).exit).toBe(77);
  });

  test("type sends one key event at a time; get value reads it back from the AX tree", async () => {
    const typed = await marked("type", ["type", "--delay=10", "--", "@e2", "hi"]);
    expect(typed.exit).toBe(0);
    expect(typed.out).toContain('~ textbox "Name" [ref=e2]: hi (was empty)');
    expect((await marked("get value", ["get", "value", "@e2"])).out).toBe("hi\n");
  });

  test("is answers from the box model and the AX tree", async () => {
    expect((await marked("is visible", ["is", "visible", "@e1"])).out).toBe("true\n");
    expect((await marked("is hidden", ["is", "visible", "#hidden"])).out).toBe("false\n");
    expect((await marked("is enabled", ["is", "enabled", "@e3"])).out).toBe("true\n");
    expect((await marked("is checked", ["is", "checked", "@e3"])).out).toBe("false\n");
  });

  test("scroll sends a mouse wheel over the page or the element", async () => {
    expect((await marked("scroll", ["scroll", "down", "100"])).exit).toBe(0);
    expect((await marked("scroll -s", ["scroll", "-s", "#list", "down", "40"])).exit).toBe(0);
  });

  test("find searches the AX tree, never the DOM search [its clicks need the tap's Ardia.dispatchClick emulation]", async () => {
    const found = await marked("find role", ["find", "--name=Save", "--exact", "--", "role", "button", "click"], { json: true });
    expect(found.exit).toBe(0);
    expect((JSON.parse(found.out) as { data: { clicked: string } }).data.clicked).toBe("@e3");
    expect((await marked("find partial", ["find", "--name=Sa", "--partial", "--", "role", "button", "click"])).exit).toBe(0);
    expect((await marked("find text", ["find", "text", "three", "text"])).out).toBe("three\n");
    const labelled = await marked("find label", ["find", "label", "Name", "fill", "Ada"]);
    expect(labelled.out).toContain('~ textbox "Name" [ref=e2]: Ada');
    expect((await marked("find placeholder", ["find", "placeholder", "Your name", "focus"])).exit).toBe(0);
    expect(await marked("find missing", ["find", "--name=Nope", "--", "role", "button", "click"], { json: true })).toMatchObject({ exit: 1, code: "not_found" });
  });

  test("wait polls the AX tree for text, the frame tree for URLs, lifecycle events for loads, and boxes for states", async () => {
    expect((await marked("wait text", ["wait", "--text=Saved", "--timeout=5000"])).out).toBe("Saved\n");
    expect((await marked("wait url", ["wait", "--url=**/form", "--timeout=5000"])).exit).toBe(0);
    expect((await marked("wait load", ["wait", "--load=load", "--timeout=5000"])).exit).toBe(0);
    expect((await marked("wait selector", ["wait", "--state=visible", "--timeout=5000", "--", "#status"])).exit).toBe(0);
    expect((await marked("wait hidden", ["wait", "--state=hidden", "--timeout=5000", "--", "#hidden"])).exit).toBe(0);
    expect((await marked("wait ms", ["wait", "50"])).exit).toBe(0);
    expect(await marked("wait timeout", ["wait", "--text=Nowhere", "--timeout=400"], { json: true })).toMatchObject({ exit: 1, code: "timeout" });
    expect((await marked("wait fn", ["wait", "--fn", "true"])).exit).toBe(77);
    const contract = await marked("wait contract", ["wait", "--text=Saved", "--url=**/done", "--load=load", "--state=visible", "--timeout=5000"]);
    expect(contract.exit).toBe(0);
  });

  test("the tap: (a) no forbidden method was ever sent, (b) no input was ever pipelined", () => {
    const all = entries(world);
    expect(pluginViolations(all)).toEqual([]);
    const methods = new Set(all.filter((entry) => entry.k === "out").map((entry) => (JSON.parse(String(entry.m)) as { method: string }).method));
    expect(methods.has("Input.dispatchMouseEvent")).toBe(true);
    expect(methods.has("Accessibility.getFullAXTree")).toBe(true);
  });
});
