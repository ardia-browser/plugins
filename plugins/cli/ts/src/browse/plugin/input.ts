import { pyLen } from "../../pylib/str.ts";
import { sleep } from "../cdp/cancel.ts";
import { Usage } from "../daemon-errors.ts";
import { pauseAfter } from "../input/human.ts";
import { MODIFIER_BITS, MODIFIER_KEYS, parseCombo, parseKey } from "../input/keys.ts";
import { type PluginPage } from "./page.ts";
import { keyRefusal, tableKey } from "./keys.ts";
import { CLICK_METHOD } from "./policy.ts";
import { PluginRefused } from "./session.ts";

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

export class NoKey extends Error {}

function keyParams(kind: "keyDown" | "keyUp", key: string, bits: number, text: string | null = null, commands: string[] = []): KeyParams {
  const found = tableKey(key);
  if (found === null) throw new NoKey(`no key on the keyboard Ardia lets a plugin use types ${JSON.stringify(key)}`);
  const params: KeyParams = { type: kind, key, code: found.code, windowsVirtualKeyCode: found.windowsKeyCode, modifiers: bits };
  if (kind === "keyDown" && text !== null) {
    params["text"] = text;
    params["unmodifiedText"] = text;
  }
  if (kind === "keyDown" && text === null) params["type"] = "rawKeyDown";
  if (commands.length > 0) params["commands"] = commands;
  return params;
}

function checked(events: KeyParams[]): KeyParams[] | string {
  for (const event of events) {
    const refusal = keyRefusal(event);
    if (refusal !== null) return `Ardia refuses a plugin key event ${refusal}`;
  }
  return events;
}

export function uncheckedComboEvents(combo: string): KeyParams[] {
  const [modifiers, last] = parseCombo(combo);
  const events: KeyParams[] = [];
  let bits = 0;
  for (const modifier of modifiers) {
    bits |= MODIFIER_BITS[modifier] as number;
    events.push(keyParams("keyDown", (MODIFIER_KEYS[modifier] as readonly [string, string, number])[0], bits));
  }
  if (last !== null) {
    const [key, , , given] = parseKey(last);
    let text = given;
    if (bits & (CONTROL | SHORTCUT | WORD)) text = null;
    else if (text !== null && bits & SHIFT && pyLen(text) === 1) text = text.toUpperCase();
    const command = editingCommand(key, bits, pyLen(last) === 1);
    events.push(keyParams("keyDown", key, bits, text, command ? [command] : []));
    events.push(keyParams("keyUp", key, bits));
  }
  for (const modifier of [...modifiers].reverse()) {
    bits &= ~(MODIFIER_BITS[modifier] as number);
    events.push(keyParams("keyUp", (MODIFIER_KEYS[modifier] as readonly [string, string, number])[0], bits));
  }
  return events;
}

export function comboEvents(combo: string): KeyParams[] {
  let events: KeyParams[];
  try {
    events = uncheckedComboEvents(combo);
  } catch (error) {
    if (error instanceof NoKey) throw new PluginRefused(`\`press ${combo}\`: ${error.message}; use \`type\` for text. Nothing was sent`);
    throw error;
  }
  const allowed = checked(events);
  if (typeof allowed === "string") throw new PluginRefused(`\`press ${combo}\`: ${allowed}, so nothing was sent`);
  return allowed;
}

export function charEvents(char: string): KeyParams[] | null {
  try {
    const events = char === "\n" ? [keyParams("keyDown", "Enter", 0, "\r"), keyParams("keyUp", "Enter", 0)] : [keyParams("keyDown", char, 0, char), keyParams("keyUp", char, 0)];
    const allowed = checked(events);
    return typeof allowed === "string" ? null : allowed;
  } catch (error) {
    if (error instanceof NoKey) return null;
    throw error;
  }
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
    const events = charEvents(char);
    if (events === null) await page.send("Input.insertText", { text: char });
    else for (const params of events) await page.send("Input.dispatchKeyEvent", params);
    const pause = humanize ? pauseAfter(char) : delay / 1000;
    if (pause > 0) await sleep(pause);
  }
}

export function buttonOf(given: unknown): string {
  const button = typeof given === "string" && given ? given : "left";
  if (!Object.hasOwn(BUTTONS, button)) throw new Usage(`--button takes left or right in plugin mode, not ${button}`);
  return button;
}

export async function clickAt(page: PluginPage, x: number, y: number, button: string, clickCount = 1): Promise<void> {
  await page.send(CLICK_METHOD, { x, y, button, clickCount, modifiers: 0 });
}

export async function wheelAt(page: PluginPage, x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
  await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY, button: "none", buttons: 0 });
}
