import { describe, expect, test } from "bun:test";
import { type Entry } from "./canon.ts";
import { pluginViolations } from "./plugin-rules.ts";
import { type Browser } from "../../src/browse/cdp/browser.ts";
import { PluginLink } from "../../src/browse/plugin/link.ts";
import { HIDDEN_TAB, TAB_IN_USE, WHEEL_BUSY_WAITS, wheelAt } from "../../src/browse/plugin/input.ts";
import { actingStep } from "../../src/browse/plugin/acting.ts";
import { BrowseError } from "../../src/browse/daemon-errors.ts";
import { scrubPasswordValues } from "../../src/browse/plugin/protected.ts";
import { checkRequest, PluginPolicy } from "../../src/browse/plugin/policy.ts";
import { comboEvents, editingCommand } from "../../src/browse/plugin/input.ts";
import { PluginRefused } from "../../src/browse/plugin/session.ts";
import { credentialId, pluginSessionKey, sameCredential } from "../../src/browse/plugin/key.ts";

const out = (id: number, method: string, params: Record<string, unknown> = {}, c = 0): Entry => ({ k: "out", c, m: JSON.stringify({ id, method, params, sessionId: "S" }) });
const answer = (id: number, c = 0): Entry => ({ k: "in", c, m: JSON.stringify({ id, result: {}, sessionId: "S" }) });
const reply = (id: number, result: Record<string, unknown>, c = 0): Entry => ({ k: "in", c, m: JSON.stringify({ id, result }) });
const attachPage = (c: number, target = "T", session = "S", type = "page", first = 900): Entry[] => [
  { k: "out", c, m: JSON.stringify({ id: first, method: "Target.getTargets", params: {} }) },
  reply(first, { targetInfos: [{ targetId: target, type }] }, c),
  { k: "out", c, m: JSON.stringify({ id: first + 1, method: "Target.attachToTarget", params: { targetId: target, flatten: true } }) },
  reply(first + 1, { sessionId: session }, c),
];
const PRELUDE = [...attachPage(0), ...attachPage(1)];

function checked(entries: Entry[]) {
  return pluginViolations([...PRELUDE, ...entries]).map((item) => ({ ...item, at: item.at - PRELUDE.length }));
}

const CREDENTIAL = "p.Ab3_-9xYz0Ab3_-9xYz0Ab3_-9xYz0Ab3_-9xYz0Q7w";

describe("the tap checks", () => {
  test("a clean click passes", () => {
    const entries = [
      out(1, "DOM.getBoxModel", { backendNodeId: 3 }), answer(1),
      out(2, "DOM.getContentQuads"), answer(2),
      out(3, "Ardia.dispatchClick", { x: 5, y: 5, button: "left", clickCount: 1, modifiers: 0 }), answer(3),
      out(4, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5, button: "none", buttons: 0 }), answer(4),
      { k: "emulated", c: 0, m: JSON.stringify({ id: 2000000001, method: "Input.dispatchMouseEvent", params: { type: "mousePressed" } }) },
    ];
    expect(checked(entries)).toEqual([]);
  });

  test("(a) a forbidden method fails, and so does any method off the list", () => {
    const found = checked([out(1, "Runtime.evaluate"), answer(1), out(2, "DOM.resolveNode"), out(3, "Page.createIsolatedWorld"), out(4, "DOM.performSearch"), out(5, "Input.dispatchDragEvent"), out(6, "Network.enable")]);
    expect(found.map((item) => [item.rule, item.method])).toEqual([
      ["forbidden", "Runtime.evaluate"],
      ["forbidden", "DOM.resolveNode"],
      ["forbidden", "Page.createIsolatedWorld"],
      ["forbidden", "DOM.performSearch"],
      ["forbidden", "Input.dispatchDragEvent"],
      ["unlisted", "Network.enable"],
    ]);
  });

  test("(b) a second input before the first is answered fails, even when a read is answered in between", () => {
    const entries = [out(1, "Input.insertText", { text: "a" }), out(2, "DOM.getBoxModel"), answer(2), out(3, "Input.dispatchKeyEvent", { type: "keyUp", key: "a" }), answer(1), answer(3)];
    const found = checked(entries);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ rule: "pipelined", method: "Input.dispatchKeyEvent" });
  });

  test("(b) input on another connection doesn't count, and answered input frees the next", () => {
    expect(checked([out(1, "Input.insertText", { text: "a" }), out(1, "Input.insertText", { text: "b" }, 1), answer(1), answer(1, 1), out(2, "Input.insertText", { text: "c" })])).toEqual([]);
  });

  test("key events carry no native codes and only allowed commands", () => {
    const found = checked([
      out(1, "Input.dispatchKeyEvent", { type: "rawKeyDown", nativeVirtualKeyCode: 65 }), answer(1),
      out(2, "Input.dispatchKeyEvent", { type: "rawKeyDown", commands: ["copy"] }), answer(2),
      out(3, "Input.dispatchKeyEvent", { type: "rawKeyDown", commands: ["selectAll"] }), answer(3),
    ]);
    expect(found.map((item) => item.detail)).toEqual(["nativeVirtualKeyCode", 'commands ["copy"]']);
  });

  test("a mouse press, a release or a move holding a button is forbidden: clicks go through Ardia.dispatchClick", () => {
    const found = checked([
      out(1, "Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 1, button: "left", buttons: 1 }), answer(1),
      out(2, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 9, y: 9, buttons: 1 }), answer(2),
      out(3, "Input.dispatchMouseEvent", { type: "mouseReleased", x: 9, y: 9, button: "left" }), answer(3),
      out(4, "Input.dispatchMouseEvent", { type: "mouseWheel", x: 9, y: 9, button: "none", buttons: 0, deltaY: 10 }), answer(4),
    ]);
    expect(found.filter((item) => item.rule === "forbidden").map((item) => [item.rule, item.at])).toEqual([["forbidden", 0], ["forbidden", 2], ["forbidden", 4]]);
  });

  test("(b) Ardia.dispatchClick is one input command: nothing else may go out before it's answered", () => {
    const found = checked([out(1, "Ardia.dispatchClick", { x: 1, y: 1, button: "left", clickCount: 1, modifiers: 0 }), out(2, "Input.dispatchKeyEvent", { type: "keyUp", key: "a" }), answer(1), answer(2)]);
    expect(found.map((item) => item.rule)).toEqual(["pipelined"]);
  });
});

describe("(c) input goes out on the page target's own session", () => {
  const sent = (id: number, method: string, sessionId: string | undefined, params: Record<string, unknown> = {}, c = 0): Entry => ({ k: "out", c, m: JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }) });

  test("the page session passes; an iframe target's, a prerender's, an auto-attached one and the browser session fail", () => {
    const entries: Entry[] = [
      ...attachPage(0, "PAGE", "S-page", "page", 10),
      ...attachPage(0, "FRAME", "S-frame", "iframe", 20),
      { k: "out", c: 0, m: JSON.stringify({ id: 30, method: "Target.getTargets", params: {} }) },
      reply(30, { targetInfos: [{ targetId: "PRE", type: "page", subtype: "prerender" }] }),
      { k: "out", c: 0, m: JSON.stringify({ id: 31, method: "Target.attachToTarget", params: { targetId: "PRE", flatten: true } }) },
      reply(31, { sessionId: "S-pre" }),
      { k: "in", c: 0, m: JSON.stringify({ method: "Target.attachedToTarget", params: { sessionId: "S-auto", targetInfo: { targetId: "AUTO", type: "page" } } }) },
      sent(40, "Ardia.dispatchClick", "S-page", { x: 1, y: 1, button: "left", clickCount: 1, modifiers: 0 }), reply(40, {}),
      sent(41, "Input.insertText", "S-frame", { text: "a" }), reply(41, {}),
      sent(42, "Input.dispatchKeyEvent", "S-pre", { type: "keyUp", key: "a" }), reply(42, {}),
      sent(43, "Input.dispatchMouseEvent", "S-auto", { type: "mouseWheel", x: 1, y: 1, deltaX: 0, deltaY: 5, button: "none", buttons: 0 }), reply(43, {}),
      sent(44, "Ardia.dispatchClick", undefined, { x: 1, y: 1, button: "left", clickCount: 1, modifiers: 0 }), reply(44, {}),
      sent(45, "Accessibility.getFullAXTree", "S-frame"), reply(45, {}),
    ];
    const found = pluginViolations(entries).filter((item) => item.rule === "session");
    expect(found.map((item) => item.method)).toEqual(["Input.insertText", "Input.dispatchKeyEvent", "Input.dispatchMouseEvent", "Ardia.dispatchClick"]);
  });

  test("a page session the browser detached stops counting", () => {
    const found = pluginViolations([
      ...attachPage(0, "PAGE", "S-page", "page", 10),
      { k: "in", c: 0, m: JSON.stringify({ method: "Target.detachedFromTarget", params: { sessionId: "S-page" } }) },
      sent(40, "Input.insertText", "S-page", { text: "a" }), reply(40, {}),
    ]);
    expect(found.map((item) => item.rule)).toEqual(["session"]);
  });
});

describe("round 14: focus and scrolling are the page's own", () => {
  test("DOM.focus, Page.captureScreenshot, DOM.scrollIntoViewIfNeeded and Emulation.setFocusEmulationEnabled are forbidden", () => {
    const found = checked([out(1, "DOM.focus", { backendNodeId: 3 }), answer(1), out(2, "Page.captureScreenshot"), answer(2), out(3, "DOM.scrollIntoViewIfNeeded", { backendNodeId: 3 }), answer(3), out(4, "Emulation.setFocusEmulationEnabled", { enabled: true }), answer(4)]);
    expect(found.filter((item) => item.rule === "forbidden").map((item) => item.method)).toEqual(["DOM.focus", "Page.captureScreenshot", "DOM.scrollIntoViewIfNeeded", "Emulation.setFocusEmulationEnabled"]);
  });
});

describe("the daemon's own policy", () => {
  test("input is refused on any session but a page target's own, before anything is sent", async () => {
    const link = new PluginLink({} as Browser);
    link.pageSessions.add("S-page");
    for (const [method, params] of [["Input.insertText", { text: "a" }], ["Ardia.dispatchClick", { x: 1, y: 1, button: "left", clickCount: 1, modifiers: 0 }], ["Input.dispatchMouseEvent", { type: "mouseWheel", x: 1, y: 1, deltaX: 0, deltaY: 1, button: "none", buttons: 0 }]] as const) {
      for (const session of ["S-frame", null]) await expect(link.send(method, { ...params }, session)).rejects.toThrow(PluginPolicy);
    }
  });

  test("refuses what the engine refuses before anything is sent", () => {
    for (const method of ["DOM.focus", "Page.captureScreenshot", "DOM.scrollIntoViewIfNeeded", "Emulation.setFocusEmulationEnabled", "Runtime.evaluate", "Runtime.enable", "DOM.resolveNode", "Page.createIsolatedWorld", "DOM.performSearch", "Input.dispatchDragEvent", "Network.enable"]) {
      expect(() => checkRequest(method, {})).toThrow(PluginPolicy);
    }
    expect(() => checkRequest("DOM.getBoxModel", { objectId: "1" })).toThrow(PluginPolicy);
    expect(() => checkRequest("Input.dispatchKeyEvent", { type: "keyDown", nativeVirtualKeyCode: 1 })).toThrow(PluginPolicy);
    expect(() => checkRequest("Input.dispatchKeyEvent", { type: "keyDown", commands: ["paste"] })).toThrow(PluginPolicy);
    expect(() => checkRequest("Input.dispatchMouseEvent", { type: "mouseMoved", buttons: 1 })).toThrow(PluginPolicy);
    expect(() => checkRequest("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", buttons: 1 })).toThrow(PluginPolicy);
    expect(() => checkRequest("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left" })).toThrow(PluginPolicy);
    expect(() => checkRequest("Ardia.dispatchClick", { x: 1, y: 1, button: "middle", clickCount: 1, modifiers: 0 })).toThrow(PluginPolicy);
    expect(() => checkRequest("Ardia.dispatchClick", { x: 1, y: 1, button: "left", clickCount: 3, modifiers: 0 })).toThrow(PluginPolicy);
    expect(() => checkRequest("Ardia.dispatchClick", { x: 1, y: 1, button: "left", clickCount: 2, modifiers: 0 })).not.toThrow();
    expect(() => checkRequest("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1, button: "none", buttons: 0 })).not.toThrow();
    expect(() => checkRequest("Input.dispatchKeyEvent", { type: "rawKeyDown", commands: ["selectAll"] })).not.toThrow();
  });

  test("key combos map to the editing allowlist and never to clipboard or undo commands", () => {
    const commands = (combo: string) => comboEvents(combo).flatMap((event) => (event["commands"] as string[] | undefined) ?? []);
    expect(commands("Meta+a")).toEqual(["selectAll"]);
    for (const refused of ["Meta+c", "Meta+v", "Meta+z", "Meta+x", "Shift+Insert"]) expect(() => comboEvents(refused)).toThrow(PluginRefused);
    expect(commands("Alt+ArrowLeft")).toEqual(["moveWordLeft"]);
    expect(commands("Shift+Meta+ArrowRight")).toEqual(["moveToEndOfLineAndModifySelection"]);
    expect(commands("Backspace")).toEqual(["deleteBackward"]);
    expect(commands("Enter")).toEqual([]);
    expect(editingCommand("ArrowDown", 0, false)).toBe("moveDown");
    for (const combo of ["Enter", "Meta+a", "Alt+ArrowLeft", "a", "Shift+Tab"]) {
      for (const event of comboEvents(combo)) expect(() => checkRequest("Input.dispatchKeyEvent", event)).not.toThrow();
    }
  });

  test("the session key carries the credential's hash and \\0plugin, like the client and the Python reference", () => {
    expect(credentialId(CREDENTIAL)).toHaveLength(32);
    const key = pluginSessionKey("", CREDENTIAL, "plugin-ai");
    expect(key).toMatch(/^[0-9a-f]{24}$/u);
    expect(key).not.toBe(pluginSessionKey("", `${CREDENTIAL.slice(0, -1)}x`, "plugin-ai"));
    expect(sameCredential(CREDENTIAL, credentialId(CREDENTIAL))).toBe(true);
    expect(sameCredential(`${CREDENTIAL.slice(0, -1)}x`, credentialId(CREDENTIAL))).toBe(false);
  });
});

describe("protected fields", () => {
  test("password inputs lose their value attribute in HTML, whatever the quoting; other inputs keep theirs", () => {
    const html = `<input type="password" value="s1"><INPUT TYPE=PASSWORD VALUE=s2 id=a><input value='s3' type='password'/><input type="text" value="keep"><input value="s4" data-x=">" type="password">`;
    const scrubbed = scrubPasswordValues(html);
    for (const secret of ["s1", "s2", "s3", "s4"]) expect(scrubbed).not.toContain(secret);
    expect(scrubbed).toContain('value="keep"');
    expect(scrubbed).toContain('type="password"');
  });
});

describe("(e) wheels only inside an act", () => {
  const mark = (argv: string[]): Entry => ({ k: "mark", step: argv.join(" "), argv });
  const wheel = (id: number): Entry => ({ k: "out", c: 0, m: JSON.stringify({ id, method: "Input.dispatchMouseEvent", sessionId: "S", params: { type: "mouseWheel", x: 1, y: 1, deltaX: 0, deltaY: 5, button: "none", buttons: 0 } }) });

  test("a wheel in click, scroll or find-click passes; in snapshot, get, wait or find-text it fails", () => {
    const found = checked([
      mark(["click", "--", "@e3"]), wheel(1), answer(1),
      mark(["scroll", "down"]), wheel(2), answer(2),
      mark(["find", "--name=Save", "--", "role", "button", "click"]), wheel(3), answer(3),
      mark(["snapshot", "-c"]), wheel(4), answer(4),
      mark(["get", "box", "@e3"]), wheel(5), answer(5),
      mark(["wait", "--text=x"]), wheel(6), answer(6),
      mark(["find", "text", "three", "text"]), wheel(7), answer(7),
    ]);
    expect(found.filter((item) => item.rule === "wheel_outside_act").map((item) => item.at)).toEqual([10, 13, 16, 19]);
  });

  test("a wheel the page saw while hidden must have been refused with page_hidden", () => {
    const refused: Entry = { k: "in", c: 0, m: JSON.stringify({ id: 1, sessionId: "S", error: { code: -32000, message: "ardia: page hidden" } }) };
    expect(checked([mark(["scroll", "down"]), wheel(1), { k: "visibility", c: 0, wheel: 1, state: "hidden" }, refused])).toEqual([]);
    expect(checked([mark(["scroll", "down"]), wheel(2), { k: "visibility", c: 0, wheel: 2, state: "hidden" }, answer(2)]).map((item) => item.rule)).toEqual(["hidden_wheel"]);
  });
});

describe("plugin wheels: busy and page hidden", () => {
  function fakePage(replies: (BrowseError | null)[]) {
    let sent = 0;
    return {
      sent: () => sent,
      page: {
        async send(): Promise<Record<string, unknown>> {
          sent += 1;
          const next = replies.shift() ?? null;
          if (next !== null) throw next;
          return {};
        },
      } as never,
    };
  }
  const busy = () => new BrowseError("Input.dispatchMouseEvent: ardia: busy", null, "busy");

  test("busy is retried after 100, 200, 300, 400 and 500 ms, then the wheel goes out", async () => {
    const fake = fakePage([busy(), busy(), null]);
    const started = performance.now();
    await wheelAt(fake.page, 1, 1, 0, 10);
    expect(fake.sent()).toBe(3);
    expect(performance.now() - started).toBeGreaterThanOrEqual(290);
    expect(WHEEL_BUSY_WAITS).toEqual([0.1, 0.2, 0.3, 0.4, 0.5]);
  });

  test("busy after every wait answers busy; page hidden answers outside_viewport with the hidden-tab wording", async () => {
    await expect(wheelAt(fakePage([busy(), busy(), busy(), busy(), busy(), busy()]).page, 1, 1, 0, 10)).rejects.toMatchObject({ code: "busy", text: TAB_IN_USE });
    await expect(wheelAt(fakePage([new BrowseError("x", null, "page_hidden")]).page, 1, 1, 0, 10)).rejects.toMatchObject({ code: "outside_viewport", text: HIDDEN_TAB });
  });

  test("a wheel answered outcome unknown (round 18 replies on the renderer's acknowledgement) is never retried", async () => {
    const fake = fakePage([new BrowseError("Input.dispatchMouseEvent: ardia: outcome unknown", null, "outcome_unknown")]);
    await expect(wheelAt(fake.page, 1, 1, 0, 10)).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(fake.sent()).toBe(1);
  });

  test("the daemon's link never sends a wheel outside an acting step", async () => {
    let acting = false;
    const link = new PluginLink({} as Browser, () => acting);
    link.pageSessions.add("S");
    await expect(link.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 1, y: 1, deltaX: 0, deltaY: 1, button: "none", buttons: 0 }, "S")).rejects.toThrow(PluginPolicy);
    acting = true;
    expect(actingStep(["scroll", "down"])).toBe(true);
    expect(actingStep(["snapshot"])).toBe(false);
  });
});

describe("(f) nothing between steps", () => {
  test("a message after a step's answer and before the next step fails, in either direction", () => {
    const mark = (argv: string[]): Entry => ({ k: "mark", step: argv.join(" "), argv });
    const done: Entry = { k: "done", step: "x" };
    const event: Entry = { k: "in", c: 0, m: JSON.stringify({ method: "Page.lifecycleEvent", sessionId: "S", params: { name: "load" } }) };
    expect(checked([mark(["snapshot"]), out(1, "Accessibility.getFullAXTree"), answer(1), done, mark(["get", "title"]), out(2, "Target.getTargetInfo"), answer(2), done])).toEqual([]);
    const found = checked([mark(["snapshot"]), out(1, "Accessibility.getFullAXTree"), answer(1), done, event, out(3, "Page.handleJavaScriptDialog"), mark(["get", "title"])]);
    expect(found.filter((item) => item.rule === "between_steps").map((item) => item.method)).toEqual(["Page.lifecycleEvent", "Page.handleJavaScriptDialog"]);
    expect(checked([mark(["fill", "@e2", "x"]), out(4, "Input.insertText", { text: "x" }), done, answer(4), mark(["get", "title"])]).filter((item) => item.rule === "between_steps")).toEqual([]);
  });
});

