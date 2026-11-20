#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";

const ROW = /^\s*\{"([^"]*)", (\d+), "((?:[^"\\]|\\.)*)", "((?:[^"\\]|\\.)*)", "((?:[^"\\]|\\.)*)"\},$/u;
const CLIPBOARD = /^\s*\{(\d+), (\d+), "((?:[^"\\]|\\.)*)"\},$/u;

function unescapeC(text: string): string {
  return text.replace(/\\(.)/gu, "$1");
}

function rows(file: string, pattern: RegExp): RegExpExecArray[] {
  const found = fs.readFileSync(file, "utf8").split("\n").map((line) => pattern.exec(line)).filter((match): match is RegExpExecArray => match !== null);
  if (found.length === 0) throw new Error(`no rows in ${file}`);
  return found;
}

export function generate(dir: string): string {
  const keys = rows(path.join(dir, "ac_cli_plugin_key_table.h"), ROW).map((match) =>
    `  [${JSON.stringify(match[1])}, ${match[2]}, ${JSON.stringify(unescapeC(match[3] as string))}, ${JSON.stringify(unescapeC(match[4] as string))}, ${JSON.stringify(unescapeC(match[5] as string))}],`,
  );
  const clipboard = rows(path.join(dir, "ac_cli_plugin_clipboard_keys.h"), CLIPBOARD).map((match) => `  [${match[1]}, ${match[2]}, ${JSON.stringify(unescapeC(match[3] as string))}],`);
  return [
    "export type KeyRow = readonly [code: string, windowsKeyCode: number, base: string, shifted: string, named: string];",
    "export type ClipboardKey = readonly [windowsKeyCode: number, modifiers: number, domKey: string];",
    "",
    "export const KEY_ROWS: readonly KeyRow[] = [",
    ...keys,
    "];",
    "",
    "export const CLIPBOARD_KEYS: readonly ClipboardKey[] = [",
    ...clipboard,
    "];",
    "",
  ].join("\n");
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) {
    process.stderr.write("usage: bun scripts/plugin-key-table.ts <dir holding ac_cli_plugin_key_table.h and ac_cli_plugin_clipboard_keys.h>\n");
    process.exit(64);
  }
  process.stdout.write(generate(dir));
}
