import type { Value } from "./json.ts";
import { isSpace, strip } from "./py.ts";
import { codePoints } from "./pystr.ts";
import { lower, reprText } from "./pyvalue.ts";
import { sortPy } from "./config-files.ts";
import { didYouMean } from "./schema-check.ts";

const MODIFIERS: Record<string, string> = {
  cmd: "cmd",
  command: "cmd",
  opt: "opt",
  option: "opt",
  alt: "opt",
  ctrl: "ctrl",
  control: "ctrl",
  shift: "shift",
  fn: "fn",
};
const KEYS = new Set([
  ...Array.from({ length: 20 }, (_, index) => `f${index + 1}`),
  "space",
  "tab",
  "return",
  "escape",
  "delete",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
]);
const GLYPHS = codePoints("⌘⌥⌃⇧🌐");

export function shortcutProblem(value: Value | undefined): string | undefined {
  if (typeof value !== "string" || value === "" || GLYPHS.some((glyph) => value.includes(glyph))) return undefined;
  const shown = reprText(value);
  const text = strip(value, isSpace);
  if (text !== value) return `${shown} has spaces around it`;
  let parts: string[];
  if (text === "+") parts = ["+"];
  else if (text.endsWith("++")) parts = [...text.slice(0, -2).split("+"), "+"];
  else parts = text.split("+");
  const key = parts.at(-1) as string;
  const modifiers = parts.slice(0, -1);
  const seen = new Set<string>();
  for (const modifier of modifiers) {
    const canonical = Object.hasOwn(MODIFIERS, lower(modifier)) ? MODIFIERS[lower(modifier)] : undefined;
    if (canonical === undefined) {
      if (!modifier) return `${shown} has an empty part between + signs`;
      return `${shown} has an unknown modifier ${modifier}${didYouMean(lower(modifier), Object.keys(MODIFIERS))}`;
    }
    if (seen.has(canonical)) return `${shown} repeats ${modifier}`;
    seen.add(canonical);
  }
  if (!key) return `${shown} ends without a key`;
  const points = codePoints(key);
  if (points.length === 1) {
    if (isSpace(key)) return `${shown} uses a space character; write space`;
    return undefined;
  }
  if (KEYS.has(lower(key))) return undefined;
  if (Object.hasOwn(MODIFIERS, lower(key))) return `${shown} has no key after its modifiers`;
  return `${shown} has an unknown key ${key}${didYouMean(lower(key), sortPy([...KEYS]))}`;
}
