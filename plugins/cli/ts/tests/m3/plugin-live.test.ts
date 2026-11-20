import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import { methodsBetweenMarks, pluginViolations } from "./plugin-rules.ts";
import { CHROME, CREDENTIAL, entries, OTHER_CREDENTIAL, pageTarget, startWorld, step, stopWorld, tap, type World } from "./plugin-world.ts";

setDefaultTimeout(120_000);
const BASE = Number(process.env["ARDIA_F1_PORTS"] ?? "9460");
const CONTRACT_SNAPSHOT = '- heading "Sign up" [level=1, ref=e1]\n- LabelText\n  - StaticText "Name "\n  - textbox "Name" [ref=e2]\n- button "Save" [ref=e3]\n- link "Next" [ref=e4]\n';
const CHANGED = "The page loaded a new document, so this step didn't count. Ardia checks it again for the next step";

describe.skipIf(!CHROME)("plugin mode against headless Chrome for Testing, through the CDP tap", () => {
  let world: World;
  let target = "";
  let loader = "";
  const sent = new Map<string, string[]>();

  async function marked(name: string, argv: string[], options: Record<string, unknown> = {}, credential?: string | null) {
    return step(world, argv, options, credential === undefined ? CREDENTIAL : credential, world.key, name);
  }

  beforeAll(async () => {
    world = await startWorld(BASE);
    target = await pageTarget(world);
  });

  afterAll(async () => {
    if (world) {
      for (const [name, methods] of methodsBetweenMarks(entries(world))) sent.set(name, methods);
      if (process.env["ARDIA_F1_SENT"]) fs.writeFileSync(process.env["ARDIA_F1_SENT"], JSON.stringify(Object.fromEntries(sent), null, 1));
      await stopWorld(world);
    }
  });

  test("pick: tab <targetId> --json carries the loader, and so does every answer", async () => {
    const picked = await marked("pick", ["tab", target], { json: true });
    expect(picked.exit).toBe(0);
    const data = (JSON.parse(picked.out) as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ tabId: "t1", appTabId: null, targetId: target, title: "Form page", url: `http://127.0.0.1:${world.sitePort}/form` });
    loader = String(data["loader"]);
    expect(loader).toMatch(/^[0-9A-F]{32}$/u);
    expect(picked.loader).toBe(loader);
    const text = await step(world, ["tab", target]);
    expect(text.out).toBe(`✓ Form page\n  http://127.0.0.1:${world.sitePort}/form\n`);
  });

  test("snapshot -c reads the AX tree only and gives the contract's refs", async () => {
    const shot = await marked("snapshot", ["snapshot", "--compact", "--"], { expect_loader: loader });
    expect(shot.exit).toBe(0);
    expect(shot.out.startsWith(CONTRACT_SNAPSHOT)).toBe(true);
    const json = await step(world, ["snapshot", "-i"], { json: true, expect_loader: loader });
    const data = (JSON.parse(json.out) as { data: Record<string, unknown> }).data;
    expect(data["origin"]).toBe(`http://127.0.0.1:${world.sitePort}/`);
    expect(data["refs"]).toEqual({ e1: { name: "Sign up", role: "heading" }, e2: { name: "Name", role: "textbox" }, e3: { name: "Save", role: "button" }, e4: { name: "Next", role: "link" } });
  });

  test("fill @ref text: focus, select-all and delete-backward commands, then insertText", async () => {
    const filled = await marked("fill", ["fill", "--", "@e2", "Ada"], { expect_loader: loader });
    expect(filled).toMatchObject({ exit: 0, err: "" });
    expect(filled.out).toBe(
      '✓ Done\nchanges:\n~ textbox "Name" [ref=e2]: Ada (was empty)\n→ Nothing else on the page changed yet. Some fields only apply when you press Enter or leave them: `press Enter` or `press Tab`, then check again\n',
    );
    const again = await step(world, ["fill", "--", "@e2", "Grace"], { expect_loader: loader });
    expect(again.out).toContain("~ textbox \"Name\" [ref=e2]: Grace (was 'Ada')");
    const refused = await marked("fill-refused", ["fill", "--", "@e1", "Ada"], { expect_loader: loader });
    expect(refused).toMatchObject({ exit: 1, out: "", err: '✗ @e1 is a h1 "Sign up", which takes no typing; use click, select or check\n', code: "not_editable" });
  });

  test("press <key>: key events with editing commands only from the allowlist", async () => {
    for (const key of ["Enter", "Meta+a", "Alt+ArrowLeft", "Shift+Tab"]) {
      const pressed = await marked(`press ${key}`, ["press", "--", key], { expect_loader: loader });
      expect(pressed.exit).toBe(0);
      expect(pressed.out.startsWith("✓ Done\nchanges")).toBe(true);
    }
    for (const key of ["Meta+z", "Meta+c", "Meta+v", "Shift+Delete", "é"]) {
      const refused = await marked(`press ${key}`, ["press", "--", key], { expect_loader: loader });
      expect(refused).toMatchObject({ exit: 77, code: "plugin_refused" });
      expect((methodsBetweenMarks(entries(world)).get(`press ${key}`) ?? []).filter((method) => method.startsWith("Input."))).toEqual([]);
    }
  });

  test("type sends key events where the engine allows them and insertText for the rest", async () => {
    const typed = await marked("type mixed", ["type", "--", "@e2", "aé中"], { expect_loader: loader, no_changes: true });
    expect(typed.exit).toBe(0);
    const sent = methodsBetweenMarks(entries(world)).get("type mixed") ?? [];
    expect(sent.filter((method) => method === "Input.insertText")).toHaveLength(2);
    expect(sent.filter((method) => method === "Input.dispatchKeyEvent")).toHaveLength(2);
  });

  test("click @ref: scrollIntoViewIfNeeded, getContentQuads, then Ardia.dispatchClick [tap emulates Ardia.dispatchClick]", async () => {
    const clicked = await marked("click", ["click", "--", "@e3"], { expect_loader: loader, json: true });
    expect(clicked.exit).toBe(0);
    const data = (JSON.parse(clicked.out) as { data: { clicked: string; changes: Record<string, unknown> } }).data;
    expect(data.clicked).toBe("@e3");
    expect(data.changes["title"]).toEqual({ from: "Form page", to: "Pressed" });
    expect(await step(world, ["click", "--", "@e99"], { json: true })).toMatchObject({ exit: 1, out: '{"success":false,"data":null,"error":"Unknown ref: e99","code":"unknown_ref"}\n' });
    expect((await step(world, ["click", "--button=middle", "--", "@e3"])).exit).not.toBe(0);
  });

  test("the before-check refuses a stale loader and runs nothing", async () => {
    const before = await tap(world, "state");
    const stale = await marked("stale", ["click", "--", "@e3"], { expect_loader: "STALE", json: true });
    expect(stale).toMatchObject({ exit: 1, code: "document_changed" });
    expect(JSON.parse(stale.out)).toEqual({ success: false, data: null, error: CHANGED, code: "document_changed" });
    const methods = methodsBetweenMarks(entries(world)).get("stale") ?? [];
    expect(methods.filter((method) => method.startsWith("Input."))).toEqual([]);
    expect(Number((await tap(world, "state"))["requests"])).toBeGreaterThan(Number(before["requests"]));
  });

  test("engine refusals keep their codes, from the CDP error only", async () => {
    await tap(world, "fault", { kind: "error", method: "Input.insertText", at: 1, message: "ardia: tab_out_of_scope: the tab moved to another window" });
    const scope = await marked("scope", ["fill", "--", "@e2", "Ada"], { json: true });
    expect(scope.out).toBe('{"success":false,"data":null,"error":"Input.insertText: ardia: tab_out_of_scope: the tab moved to another window","code":"tab_out_of_scope"}\n');
    await tap(world, "fault", { kind: "error", method: "Ardia.dispatchClick", at: 1, message: "ardia: document_changed: no act lease covers this document" });
    const lease = await marked("lease", ["click", "--", "@e3"], { json: true });
    expect(lease.out).toBe('{"success":false,"data":null,"error":"Ardia.dispatchClick: ardia: document_changed: no act lease covers this document","code":"document_changed"}\n');
    await tap(world, "fault", { kind: "error", method: "Input.insertText", at: 1, message: "page said ardia: tab_out_of_scope" });
    const quoted = await step(world, ["fill", "--", "@e2", "Ada"], { json: true });
    expect(quoted.code).not.toBe("tab_out_of_scope");
    await tap(world, "fault", {});
  });

  test("an unanswered input event holds back the next one: nothing is pipelined", async () => {
    await tap(world, "fault", { kind: "hold", method: "Input.insertText", at: 1 });
    const held = await marked("held", ["fill", "--", "@e2", "Zed"], { no_changes: true });
    expect(held).toMatchObject({ exit: 1, code: "outcome_unknown" });
    const behind = await marked("behind", ["press", "--", "Enter"], { no_changes: true });
    expect(behind).toMatchObject({ exit: 1, code: "input_unanswered" });
    expect(await tap(world, "release")).toMatchObject({ released: true });
    await tap(world, "fault", {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await marked("after release", ["press", "--", "Escape"], { no_changes: true })).exit).toBe(0);
  });

  test("a step without the activity's credential, or with another one, is refused before anything is sent", async () => {
    const before = Number((await tap(world, "state"))["requests"]);
    expect(await step(world, ["snapshot"], {}, null)).toMatchObject({ exit: 77, code: "plugin_refused" });
    expect(await step(world, ["snapshot"], {}, OTHER_CREDENTIAL)).toMatchObject({ exit: 77, code: "plugin_refused" });
    expect(await step(world, ["eval", "1"], {})).toMatchObject({ exit: 77, code: "plugin_refused" });
    expect(Number((await tap(world, "state"))["requests"])).toBe(before);
  });

  test("nothing is written beside the socket, lock and log", () => {
    const names = fs.readdirSync(world.found.browse).sort();
    expect(names).toEqual([`${world.key}.lock`, `${world.key}.log`, `${world.key}.sock`].sort());
    expect(fs.readFileSync(`${world.found.browse}/${world.key}.log`, "utf8")).not.toContain("Ab3_-9xYz0");
  });

  test("the after-check: a click that navigates answers document_changed_after (the step ran) [tap emulates Ardia.dispatchClick]", async () => {
    const shot = await step(world, ["snapshot", "-i"], { expect_loader: loader });
    expect(shot.exit).toBe(0);
    const after = await marked("navigate", ["click", "--", "@e4"], { expect_loader: loader, json: true });
    expect(after).toMatchObject({ exit: 1, code: "document_changed_after" });
    expect(JSON.parse(after.out)).toMatchObject({ success: false, data: { ran: true }, code: "document_changed_after" });
    expect(after.loader).not.toBe(loader);
    const picked = await step(world, ["tab", target], { json: true });
    expect((JSON.parse(picked.out) as { data: { title: string; loader: string } }).data).toMatchObject({ title: "Done", loader: after.loader });
  });

  test("the tap: (a) no forbidden method was ever sent, (b) no input was ever pipelined", () => {
    const all = entries(world);
    expect(pluginViolations(all)).toEqual([]);
    const methods = new Set(all.filter((entry) => entry.k === "out").map((entry) => (JSON.parse(String(entry.m)) as { method: string }).method));
    expect([...methods].filter((method) => method.startsWith("Runtime.") || method === "DOM.resolveNode")).toEqual([]);
    expect(methods.has("Input.insertText")).toBe(true);
    expect(methods.has("Ardia.dispatchClick")).toBe(true);
    expect(all.some((entry) => entry.k === "emulated")).toBe(true);
  });
});
