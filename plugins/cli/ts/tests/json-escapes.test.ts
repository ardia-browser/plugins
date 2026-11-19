import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { parseText } from "../src/json.ts";

const JSON_MODULE = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "src", "json.ts");
const PARSE_BOUND_MS = 400;
const ESCAPE_KINDS = ["\\n", "\\u0001", "\\\"", "\\ud83d\\ude00", "\\u00e9", "\\/"];

function escapeHeavy(escapes: number, plainBytes: number): string {
  const parts: string[] = [];
  for (let index = 0; index < escapes; index += 1) parts.push("ab", ESCAPE_KINDS[index % ESCAPE_KINDS.length] as string);
  parts.push("x".repeat(plainBytes));
  return `"${parts.join("")}"`;
}

test("a long string with many escapes parses as JSON.parse does", () => {
  const text = escapeHeavy(3000, 1000);
  assert.equal(parseText(text), JSON.parse(text));
});

test("a 500 KB string with 100k escapes parses in linear time without the JIT", () => {
  const script = `const { parseText } = await import(${JSON.stringify(JSON_MODULE)});
const parts = [];
const kinds = ${JSON.stringify(ESCAPE_KINDS)};
for (let index = 0; index < 100000; index += 1) parts.push("ab", kinds[index % kinds.length]);
parts.push("x".repeat(150000));
const text = '"' + parts.join("") + '"';
const started = performance.now();
const value = parseText(text);
const elapsed = performance.now() - started;
if (value !== JSON.parse(text)) process.exit(3);
console.log(JSON.stringify({ bytes: text.length, elapsed }));`;
  const ran = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, BUN_JSC_useJIT: "0" }, timeout: 120000 });
  assert.equal(ran.status, 0, ran.stderr?.toString());
  const { bytes, elapsed } = JSON.parse(ran.stdout.toString()) as { bytes: number; elapsed: number };
  assert.ok(bytes >= 500000, `${bytes}`);
  assert.ok(elapsed < PARSE_BOUND_MS, `parsing took ${elapsed.toFixed(0)} ms`);
});
