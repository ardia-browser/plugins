import { CLIPBOARD_KEYS, KEY_ROWS, type KeyRow } from "./key-table.ts";

export const KEY_COMMANDS: ReadonlySet<string> = new Set([
  "selectAll",
  ...["moveToBeginningOfLine", "moveToEndOfLine", "moveToBeginningOfDocument", "moveToEndOfDocument", "moveLeft", "moveRight", "moveUp", "moveDown", "moveWordLeft", "moveWordRight"].flatMap(
    (name) => [name, `${name}AndModifySelection`],
  ),
  "deleteBackward",
  "deleteForward",
  "deleteWordBackward",
  "deleteWordForward",
  "insertNewline",
  "insertTab",
]);

export const ALT = 1;
export const CTRL = 2;
export const META = 4;
export const SHIFT = 8;
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);
const NAVIGATION_KEYS = new Set(["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);
const COMMAND_EVENT_TYPES = new Set(["keyDown", "rawKeyDown"]);
const EDITING_COMMANDS = new Set([...KEY_COMMANDS].map((command) => command.toLowerCase()));

export type KeyParams = Record<string, unknown>;

function rowHasKey(row: KeyRow, key: string): boolean {
  return key === row[2] || key === row[3] || key === row[4];
}

function rowFitsCode(row: KeyRow, code: number): boolean {
  const named = row[4];
  return (
    row[1] === code ||
    (named === "Shift" && code === 16) ||
    (named === "Control" && code === 17) ||
    (named === "Alt" && code === 18) ||
    (named === "Meta" && (code === 91 || code === 92 || code === 93))
  );
}

export function tableKey(key: string): { code: string; windowsKeyCode: number } | null {
  const row = KEY_ROWS.find((candidate) => rowHasKey(candidate, key));
  return row === undefined ? null : { code: row[0], windowsKeyCode: row[1] };
}

function agreementRefusal(key: string, code: string | undefined, windowsKeyCode: number, hasCode: boolean): string | null {
  if (key === "") return "with an empty key";
  let known = false;
  for (const row of KEY_ROWS) {
    if (!rowHasKey(row, key)) continue;
    known = true;
    if (hasCode && code !== row[0]) continue;
    if (!windowsKeyCode || rowFitsCode(row, windowsKeyCode)) return null;
  }
  if (known) return hasCode ? "with a code or key code that doesn't match its key" : "with a key code that doesn't match its key";
  if (hasCode || windowsKeyCode) return "with a code or key code for a key the layout doesn't know";
  return null;
}

function modifierRefusal(key: string, modifiers: number): string | null {
  const shift = modifiers & SHIFT;
  const others = modifiers & (ALT | CTRL | META);
  if (MODIFIER_KEYS.has(key)) return null;
  if (!others) return shift && (key === "Insert" || key === "Delete") ? "with Shift on Insert or Delete" : null;
  if (NAVIGATION_KEYS.has(key)) return null;
  if ((key === "a" || key === "A") && !shift && !(others & ALT)) return null;
  if ((key === "Backspace" || key === "Delete") && !shift) return null;
  return "with a modifier that isn't for moving, selecting or deleting";
}

function clipboardKey(windowsKeyCode: number, modifiers: number, key: string): boolean {
  return CLIPBOARD_KEYS.some(([code, wanted, domKey]) => wanted === modifiers && (domKey ? key === domKey : windowsKeyCode === code));
}

export function keyRefusal(params: KeyParams): string | null {
  if ("nativeVirtualKeyCode" in params || "isSystemKey" in params) return "with a native key code or a system key";
  const modifiers = Number(params["modifiers"] ?? 0);
  if (modifiers & ~(ALT | CTRL | META | SHIFT)) return "with unknown modifier bits";
  const windowsKeyCode = Number(params["windowsVirtualKeyCode"] ?? 0);
  if (windowsKeyCode < 0 || windowsKeyCode > 255) return "with a key code outside 0-255";
  const commands = params["commands"];
  if (commands !== undefined) {
    if (!Array.isArray(commands)) return "with those editing commands";
    if (commands.length > 0) {
      if (!COMMAND_EVENT_TYPES.has(String(params["type"]))) return "with editing commands on that event type";
      if (commands.some((command) => !EDITING_COMMANDS.has(String(command).toLowerCase()))) return "with that editing command";
    }
  }
  const hasCode = "code" in params;
  const code = hasCode ? String(params["code"]) : undefined;
  if (!("key" in params)) return windowsKeyCode || hasCode ? "with a key code or code but no key" : null;
  const key = String(params["key"]);
  if (key === "Copy" || key === "Cut" || key === "Paste") return "with a key that cuts, copies or pastes";
  const refusal = agreementRefusal(key, code, windowsKeyCode, hasCode) ?? modifierRefusal(key, modifiers);
  if (refusal === null && clipboardKey(windowsKeyCode, modifiers, key)) return "with a key that cuts, copies or pastes";
  return refusal;
}
