import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";
import { parseText } from "../src/json.ts";

const JSON_MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "json.ts");
const SCALE = 8;
const QUADRATIC_RATIO = SCALE * SCALE;
const LINEAR_RATIO_BOUND = 3 * SCALE;
const LARGE_PARSE_CAP_MS = 2000;
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

function timingScript(module: string): string {
  return `const { parseText } = await import(${JSON.stringify(module)});
const kinds = ${JSON.stringify(ESCAPE_KINDS)};
function escaped(escapes) {
  const parts = [];
  for (let index = 0; index < escapes; index += 1) parts.push("ab", kinds[index % kinds.length]);
  parts.push("x".repeat(escapes * 3 / 2));
  return '"' + parts.join("") + '"';
}
function best(text, rounds) {
  let fastest = Infinity;
  for (let round = 0; round < rounds; round += 1) {
    const started = process.cpuUsage();
    const parsed = parseText(text);
    const spent = process.cpuUsage(started);
    if (parsed !== JSON.parse(text)) process.exit(3);
    fastest = Math.min(fastest, (spent.user + spent.system) / 1000);
    if (fastest > ${LARGE_PARSE_CAP_MS}) break;
  }
  return fastest;
}
const small = escaped(100000 / ${SCALE}), large = escaped(100000);
best(small, 1);
const smallMs = best(small, 3), largeMs = best(large, 3);
console.log(JSON.stringify({ bytes: large.length, smallMs, largeMs }));`;
}

test("100k escapes in a 500 KB string parse in linear time without the JIT", () => {
  const ran = spawnSync(process.execPath, ["-e", timingScript(JSON_MODULE)], { env: { ...process.env, BUN_JSC_useJIT: "0" }, timeout: 120000 });
  assert.equal(ran.status, 0, ran.stderr?.toString());
  const { bytes, smallMs, largeMs } = JSON.parse(ran.stdout.toString()) as { bytes: number; smallMs: number; largeMs: number };
  assert.ok(bytes >= 500000, `${bytes}`);
  assert.ok(largeMs < LARGE_PARSE_CAP_MS, `100k escapes took ${largeMs.toFixed(0)} ms of CPU`);
  const ratio = largeMs / Math.max(smallMs, 1);
  assert.ok(ratio < LINEAR_RATIO_BOUND, `${SCALE}x the escapes took ${ratio.toFixed(1)}x the CPU (linear is ${SCALE}, quadratic ${QUADRATIC_RATIO})`);
});
