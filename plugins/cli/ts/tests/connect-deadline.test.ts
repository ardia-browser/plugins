import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import "./libc-loaded.ts";
import { startDaemon } from "../src/browse/spawn.ts";
import { NoDaemon } from "../src/browse/session.ts";
import { Call } from "../src/telemetry.ts";

test("every connect while a daemon starts shares the start's one deadline", async () => {
  const box = mkdtempSync(path.join(tmpdir(), "deadline-"));
  chmodSync(box, 0o700);
  const python = path.join(box, "python");
  writeFileSync(python, "#!/bin/sh\nsleep 0.4\n");
  chmodSync(python, 0o755);
  const seen: unknown[] = [];
  const started = performance.now();
  try {
    await assert.rejects(
      startDaemon(box, "k", new Map(), python, new Call([]), async (deadline?: number) => {
        seen.push(deadline);
        throw new NoDaemon("not yet");
      }),
      /exited before it listened/,
    );
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
  assert.ok(seen.length > 1, `${seen.length} attempts`);
  assert.equal(new Set(seen).size, 1, "one deadline for every attempt");
  const deadline = seen[0] as number;
  assert.ok(typeof deadline === "number" && deadline > started + 14_000 && deadline <= performance.now() + 15_000);
});
