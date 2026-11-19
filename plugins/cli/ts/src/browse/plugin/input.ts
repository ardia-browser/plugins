import { pyLen } from "../../pylib/str.ts";
import { sleep } from "../cdp/cancel.ts";
import { Usage } from "../daemon-errors.ts";
import { CHAR_TO_KEY_INFO, pauseAfter } from "../input/human.ts";
import { MODIFIER_BITS, MODIFIER_KEYS, parseCombo, parseKey } from "../input/keys.ts";
import { type PluginPage } from "./page.ts";

export const BUTTONS: Readonly<Record<string, number>> = { left: 1, right: 2 };
const SHORTCUT = MODIFIER_BITS["Meta"] as number;
const WORD = MODIFIER_BITS["Alt"] as number;
const SHIFT = MODIFIER_BITS["Shift"] as number;
const CONTROL = MODIFIER_BITS["Control"] as number;
const MOVES: Readonly<Record<string, readonly [string, string, string]>> = {
  ArrowLeft: ["moveLeft", "moveWordLeft", "moveToBeginningOfLine"],
  ArrowRight: ["moveRight", "moveWordRight", "moveToEndOfLine"],
  ArrowUp: ["moveUp", "moveUp", "moveToBeginningOfDocument"],
  ArrowDown: ["moveDown", "moveDown", "moveToEndOfDocument"],
};
const DELETES: Readonly<Record<string, readonly [string, string]>> = {
  Backspace: ["deleteBackward", "deleteWordBackward"],
  Delete: ["deleteForward", "deleteWordForward"],
};

export function editingCommand(key: string, bits: number, single: boolean): string | null {
  const move = MOVES[key];
  if (move !== undefined && !(bits & CONTROL)) {
    const base = bits & SHORTCUT ? move[2] : bits & WORD ? move[1] : move[0];
    return bits & SHIFT ? `${base}AndModifySelection` : base;
  }
  const remove = DELETES[key];
  if (remove !== undefined && !(bits & (SHIFT | CONTROL | SHORTCUT))) return bits & WORD ? remove[1] : remove[0];
  if (single && key.toLowerCase() === "a" && bits & SHORTCUT && !(bits & (SHIFT | WORD))) return "selectAll";
  return null;
}

type KeyParams = Record<string, unknown>;

function keyParams(kind: "keyDown" | "keyUp", key: string, code: string, keycode: number, bits: number, text: string | null = null, commands: string[] = []): KeyParams {
  const params: KeyParams = { type: kind, key, code, windowsVirtualKeyCode: keycode, modifiers: bits };
  if (kind === "keyDown" && text !== null) {
    params["text"] = text;
    params["unmodifiedText"] = text;
  }
  if (kind === "keyDown" && text === null) params["type"] = "rawKeyDown";
  if (commands.length > 0) params["commands"] = commands;
  return params;
}

export function comboEvents(combo: string): KeyParams[] {
  const [modifiers, last] = parseCombo(combo);
  const events: KeyParams[] = [];
  let bits = 0;
  for (const modifier of modifiers) {
    const [key, code, keycode] = MODIFIER_KEYS[modifier] as readonly [string, string, number];
    bits |= MODIFIER_BITS[modifier] as number;
    events.push(keyParams("keyDown", key, code, keycode, bits));
  }
  if (last !== null) {
    const [key, code, keycode, given] = parseKey(last);
    let text = given;
    if (bits & (CONTROL | SHORTCUT | WORD)) text = null;
    else if (text !== null && bits & SHIFT && pyLen(text) === 1) text = text.toUpperCase();
    const command = editingCommand(key, bits, pyLen(last) === 1);
    events.push(keyParams("keyDown", key, code, keycode, bits, text, command ? [command] : []));
    events.push(keyParams("keyUp", key, code, keycode, bits));
  }
  for (const modifier of [...modifiers].reverse()) {
    const [key, code, keycode] = MODIFIER_KEYS[modifier] as readonly [string, string, number];
    bits &= ~(MODIFIER_BITS[modifier] as number);
    events.push(keyParams("keyUp", key, code, keycode, bits));
  }
  return events;
}

export function charEvents(char: string): KeyParams[] {
  const [key, code, keycode] = CHAR_TO_KEY_INFO.get(char) ?? [char, "", 0];
  if (char === "\n") return [keyParams("keyDown", "Enter", "Enter", 13, 0, "\r"), keyParams("keyUp", "Enter", "Enter", 13, 0)];
  return [keyParams("keyDown", key, code, keycode, 0, char), keyParams("keyUp", key, code, keycode, 0)];
}

export async function pressCombo(page: PluginPage, combo: string): Promise<void> {
  for (const params of comboEvents(combo)) await page.send("Input.dispatchKeyEvent", params);
}

export async function clearField(page: PluginPage): Promise<void> {
  await pressCombo(page, "Meta+a");
  await pressCombo(page, "Backspace");
}

export async function typeText(page: PluginPage, text: string, delay: number, humanize: boolean): Promise<void> {
  for (const char of text) {
    for (const params of charEvents(char)) await page.send("Input.dispatchKeyEvent", params);
    const pause = humanize ? pauseAfter(char) : delay / 1000;
    if (pause > 0) await sleep(pause);
  }
}

export function buttonOf(given: unknown): string {
  const button = typeof given === "string" && given ? given : "left";
  if (!Object.hasOwn(BUTTONS, button)) throw new Usage(`--button takes left or right in plugin mode, not ${button}`);
  return button;
}

export async function clickAt(page: PluginPage, x: number, y: number, button: string): Promise<void> {
  const mask = BUTTONS[button] as number;
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons: mask, clickCount: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount: 1 });
}

export async function wheelAt(page: PluginPage, x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
  await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY, button: "none", buttons: 0 });
}
