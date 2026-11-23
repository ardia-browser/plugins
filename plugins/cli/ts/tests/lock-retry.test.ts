import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";
import { BUILT_LIBC } from "./libc-loaded.ts";
import { lockHolder } from "./peers.ts";

const SOURCES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ardia-lock-retry-")));
process.on("exit", () => fs.rmSync(scratch, { recursive: true, force: true }));

test("a lock held elsewhere is retried and given up on without the JIT", async () => {
  fs.mkdirSync(path.join(scratch, "data"), { mode: 0o700 });
  const holder = await lockHolder(path.join(scratch, "data", "busy.lock"));
  try {
    const script = `import { loadLibc } from ${JSON.stringify(path.join(SOURCES, "libc.ts"))};
import { openPrivate, takeLockRetrying } from ${JSON.stringify(path.join(SOURCES, "privatefs.ts"))};
loadLibc(${JSON.stringify(BUILT_LIBC)});
const dir = openPrivate(${JSON.stringify(scratch)}, ["data"], false);
const started = performance.now();
try {
  const lock = takeLockRetrying("busy.lock", dir);
  console.log(JSON.stringify({ taken: lock !== undefined, waitedMs: performance.now() - started }));
} catch (error) {
  console.log(JSON.stringify({ error: String(error) }));
}`;
    const ran = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, BUN_JSC_useJIT: "0" }, timeout: 60000 });
    assert.equal(ran.status, 0, ran.stderr?.toString());
    const outcome = JSON.parse(ran.stdout.toString()) as { taken?: boolean; waitedMs?: number; error?: string };
    assert.equal(outcome.error, undefined);
    assert.equal(outcome.taken, false);
    assert.ok((outcome.waitedMs ?? 0) >= 6, `gave up after ${outcome.waitedMs} ms, so it never slept between attempts`);
  } finally {
    holder.release();
    await holder.exited;
  }
});
