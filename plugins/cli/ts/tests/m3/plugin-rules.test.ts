import { describe, expect, test } from "bun:test";
import { type Entry } from "./canon.ts";
import { pluginViolations } from "./plugin-rules.ts";
import { checkRequest, PluginPolicy } from "../../src/browse/plugin/policy.ts";
import { comboEvents, editingCommand } from "../../src/browse/plugin/input.ts";
import { credentialId, pluginSessionKey, sameCredential } from "../../src/browse/plugin/key.ts";

const out = (id: number, method: string, params: Record<string, unknown> = {}, c = 0): Entry => ({ k: "out", c, m: JSON.stringify({ id, method, params, sessionId: "S" }) });
const answer = (id: number, c = 0): Entry => ({ k: "in", c, m: JSON.stringify({ id, result: {}, sessionId: "S" }) });
const CREDENTIAL = "p.Ab3_-9xYz0Ab3_-9xYz0Ab3_-9xYz0Ab3_-9xYz0Q7w";

describe("the tap checks", () => {
  test("a clean click passes", () => {
    const entries = [
      out(1, "DOM.scrollIntoViewIfNeeded"), answer(1),
      out(2, "DOM.getContentQuads"), answer(2),
      out(3, "Input.dispatchMouseEvent", { type: "mousePressed", x: 5, y: 5, button: "left" }), answer(3),
      out(4, "Input.dispatchMouseEvent", { type: "mouseReleased", x: 5, y: 5, button: "left" }), answer(4),
    ];
    expect(pluginViolations(entries)).toEqual([]);
  });

  test("(a) a forbidden method fails, and so does any method off the list", () => {
    const found = pluginViolations([out(1, "Runtime.evaluate"), answer(1), out(2, "DOM.resolveNode"), out(3, "Page.createIsolatedWorld"), out(4, "DOM.performSearch"), out(5, "Input.dispatchDragEvent"), out(6, "Network.enable")]);
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
    const found = pluginViolations(entries);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ rule: "pipelined", method: "Input.dispatchKeyEvent" });
  });

  test("(b) input on another connection doesn't count, and answered input frees the next", () => {
    expect(pluginViolations([out(1, "Input.insertText", { text: "a" }), out(1, "Input.insertText", { text: "b" }, 1), answer(1), answer(1, 1), out(2, "Input.insertText", { text: "c" })])).toEqual([]);
  });

  test("key events carry no native codes and only allowed commands", () => {
    const found = pluginViolations([
      out(1, "Input.dispatchKeyEvent", { type: "rawKeyDown", nativeVirtualKeyCode: 65 }), answer(1),
      out(2, "Input.dispatchKeyEvent", { type: "rawKeyDown", commands: ["copy"] }), answer(2),
      out(3, "Input.dispatchKeyEvent", { type: "rawKeyDown", commands: ["selectAll"] }), answer(3),
    ]);
    expect(found.map((item) => item.detail)).toEqual(["nativeVirtualKeyCode", 'commands ["copy"]']);
  });

  test("a press released somewhere else is a drag", () => {
    const found = pluginViolations([
      out(1, "Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 1 }), answer(1),
      out(2, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 9, y: 9 }), answer(2),
      out(3, "Input.dispatchMouseEvent", { type: "mouseReleased", x: 9, y: 9 }), answer(3),
    ]);
    expect(found.map((item) => item.rule)).toEqual(["drag", "drag"]);
  });
});

describe("the daemon's own policy", () => {
  test("refuses what the engine refuses before anything is sent", () => {
    for (const method of ["Runtime.evaluate", "Runtime.enable", "DOM.resolveNode", "Page.createIsolatedWorld", "DOM.performSearch", "Input.dispatchDragEvent", "Network.enable"]) {
      expect(() => checkRequest(method, {})).toThrow(PluginPolicy);
    }
    expect(() => checkRequest("DOM.getBoxModel", { objectId: "1" })).toThrow(PluginPolicy);
    expect(() => checkRequest("Input.dispatchKeyEvent", { type: "keyDown", nativeVirtualKeyCode: 1 })).toThrow(PluginPolicy);
    expect(() => checkRequest("Input.dispatchKeyEvent", { type: "keyDown", commands: ["paste"] })).toThrow(PluginPolicy);
    expect(() => checkRequest("Input.dispatchMouseEvent", { type: "mouseMoved", buttons: 1 })).toThrow(PluginPolicy);
    expect(() => checkRequest("Input.dispatchMouseEvent", { type: "mousePressed", button: "middle" })).toThrow(PluginPolicy);
    expect(() => checkRequest("Input.dispatchKeyEvent", { type: "rawKeyDown", commands: ["selectAll"] })).not.toThrow();
  });

  test("key combos map to the editing allowlist and never to clipboard or undo commands", () => {
    const commands = (combo: string) => comboEvents(combo).flatMap((event) => (event["commands"] as string[] | undefined) ?? []);
    expect(commands("Meta+a")).toEqual(["selectAll"]);
    expect(commands("Meta+c")).toEqual([]);
    expect(commands("Meta+v")).toEqual([]);
    expect(commands("Meta+z")).toEqual([]);
    expect(commands("Alt+ArrowLeft")).toEqual(["moveWordLeft"]);
    expect(commands("Shift+Meta+ArrowRight")).toEqual(["moveToEndOfLineAndModifySelection"]);
    expect(commands("Backspace")).toEqual(["deleteBackward"]);
    expect(commands("Enter")).toEqual([]);
    expect(editingCommand("ArrowDown", 0, false)).toBe("moveDown");
    for (const combo of ["Enter", "Meta+a", "Meta+c", "Alt+ArrowLeft", "a", "Shift+Tab"]) {
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
