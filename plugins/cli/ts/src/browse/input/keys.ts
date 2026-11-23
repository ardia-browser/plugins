import { isSpace, strip } from "../../py.ts";
import { pyLen } from "../../pylib/str.ts";
import { Usage } from "../daemon-errors.ts";
import { CHAR_TO_KEY_INFO } from "./human.ts";

export const RELEASE_TIMEOUT = 2.0;
export const MODIFIER_BITS: Readonly<Record<string, number>> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
export const MODIFIER_KEYS: Readonly<Record<string, readonly [string, string, number]>> = {
  Alt: ["Alt", "AltLeft", 18],
  Control: ["Control", "ControlLeft", 17],
  Meta: ["Meta", "MetaLeft", 91],
  Shift: ["Shift", "ShiftLeft", 16],
};
export const MODIFIER_ALIASES: ReadonlyMap<string, string> = new Map([
  ["alt", "Alt"], ["option", "Alt"], ["control", "Control"], ["ctrl", "Control"], ["meta", "Meta"], ["cmd", "Meta"], ["command", "Meta"],
  ["super", "Meta"], ["shift", "Shift"], ["controlormeta", "Meta"],
]);

export type KeySpec = readonly [string, string, number, string | null];

export const NAMED_KEYS: ReadonlyMap<string, KeySpec> = (() => {
  const keys = new Map<string, KeySpec>([
    ["Enter", ["Enter", "Enter", 13, "\r"]],
    ["Tab", ["Tab", "Tab", 9, null]],
    ["Escape", ["Escape", "Escape", 27, null]],
    ["Backspace", ["Backspace", "Backspace", 8, null]],
    ["Delete", ["Delete", "Delete", 46, null]],
    ["Space", [" ", "Space", 32, " "]],
    ["ArrowUp", ["ArrowUp", "ArrowUp", 38, null]],
    ["ArrowDown", ["ArrowDown", "ArrowDown", 40, null]],
    ["ArrowLeft", ["ArrowLeft", "ArrowLeft", 37, null]],
    ["ArrowRight", ["ArrowRight", "ArrowRight", 39, null]],
    ["Home", ["Home", "Home", 36, null]],
    ["End", ["End", "End", 35, null]],
    ["PageUp", ["PageUp", "PageUp", 33, null]],
    ["PageDown", ["PageDown", "PageDown", 34, null]],
    ["Insert", ["Insert", "Insert", 45, null]],
  ]);
  for (let n = 1; n <= 12; n += 1) keys.set(`F${n}`, [`F${n}`, `F${n}`, 111 + n, null]);
  return keys;
})();

export const KEY_ALIASES: ReadonlyMap<string, string> = new Map([
  ["return", "Enter"], ["esc", "Escape"], ["del", "Delete"], ["up", "ArrowUp"], ["down", "ArrowDown"], ["left", "ArrowLeft"], ["right", "ArrowRight"],
  ["pgup", "PageUp"], ["pgdn", "PageDown"], [" ", "Space"], ["spacebar", "Space"],
]);

export const EDITING_SHORTCUTS: ReadonlyMap<string, string> = new Map([
  [JSON.stringify(["a"]), "selectAll"],
  [JSON.stringify(["z"]), "undo"],
  [JSON.stringify(["y"]), "redo"],
  [JSON.stringify(["z", "Shift"]), "redo"],
]);

export function humanizeDefault(env: Readonly<Record<string, string | undefined>>): boolean {
  const on = (name: string) => !["", "0", "false", "no", "off"].includes(strip(env[name] ?? "", isSpace).toLowerCase());
  return on("AGENT_BROWSER_HUMANIZE") && !on("AGENT_BROWSER_NO_HUMANIZE");
}

export function parseKey(name: string): KeySpec {
  const lowered = name.toLowerCase();
  const canonical = KEY_ALIASES.get(lowered) ?? name;
  const wanted = canonical.toLowerCase();
  for (const [known, spec] of NAMED_KEYS) if (known.toLowerCase() === wanted) return spec;
  const modifier = MODIFIER_ALIASES.get(lowered);
  if (modifier) {
    const [key, code, keycode] = MODIFIER_KEYS[modifier] as readonly [string, string, number];
    return [key, code, keycode, null];
  }
  if (pyLen(name) === 1) {
    const [key, code, keycode] = CHAR_TO_KEY_INFO.get(name) ?? [name, "", 0];
    return [key, code, keycode, name];
  }
  throw new Usage(`Unknown key: ${name}`);
}

export function parseCombo(combo: string): [string[], string | null] {
  let parts = combo !== "+" ? combo.split("+") : ["+"];
  if (combo.endsWith("++")) parts = [...combo.slice(0, -2).split("+"), "+"];
  parts = parts.filter((part) => part !== "");
  if (parts.length === 0) parts = [combo];
  const modifiers: string[] = [];
  for (const part of parts.slice(0, -1)) {
    const modifier = MODIFIER_ALIASES.get(part.toLowerCase());
    if (!modifier) throw new Usage(`Unknown modifier in ${combo}: ${part} (use Control, Alt, Shift or Meta)`);
    modifiers.push(modifier);
  }
  const last = parts.at(-1) as string;
  const lastModifier = MODIFIER_ALIASES.get(last.toLowerCase());
  if (lastModifier && modifiers.length === 0) return [[lastModifier], null];
  parseKey(last);
  return [modifiers, last];
}
