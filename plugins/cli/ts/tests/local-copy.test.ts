import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";
import "./libc-loaded.ts";
import { close, closeDir, openPrivate, takeLock } from "../src/privatefs.ts";
import { discardSpool, isLocalFile, keepLocalCopy } from "../src/spool.ts";
import { oracle } from "./oracle-fixtures.ts";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAX_LOCAL_BYTES = 4 * 1024 * 1024;
const OTHER_DIGITS = "cli-١٩٩٩-٠١-٠١.jsonl";
const FROZEN = oracle<{ names: [string, boolean][]; keep_local_copy: { kept: boolean; date_mark: string; copies: Record<string, number> } }>("local-copy");

test("the shared table of decimal digits is sorted, disjoint ranges of hex code points, starting with ASCII", () => {
  const lines = fs.readFileSync(path.join(CLI, "py-decimals.txt"), "utf8").split("\n").filter((line) => line !== "");
  assert.ok(lines.length > 50);
  assert.equal(lines[0], "0030 0039");
  let last = -1;
  for (const line of lines) {
    const match = /^([0-9A-F]{4,6}) ([0-9A-F]{4,6})$/.exec(line);
    assert.ok(match, line);
    const [low, high] = [Number.parseInt(match[1] as string, 16), Number.parseInt(match[2] as string, 16)];
    assert.ok(low > last + 1 && high >= low && high <= 0x10ffff, line);
    last = high;
  }
});

test("a local copy's name matches as Python's pattern does", () => {
  assert.equal(FROZEN.names.length, 9);
  assert.deepEqual(FROZEN.names.map(([name]) => isLocalFile(name)), FROZEN.names.map(([, want]) => want));
});

function seeded(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ardia-local-")));
  const local = path.join(root, "Telemetry", "local");
  fs.mkdirSync(local, { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(root, "Telemetry"), 0o700);
  fs.writeFileSync(path.join(local, OTHER_DIGITS), `${"x".repeat(1023)}\n`.repeat(MAX_LOCAL_BYTES / 1024 + 8), { mode: 0o600 });
  return root;
}

function copies(root: string): Record<string, number> {
  const local = path.join(root, "Telemetry", "local");
  return Object.fromEntries(fs.readdirSync(local).filter((name) => name.endsWith(".jsonl")).sort().map((name) => [name, fs.statSync(path.join(local, name)).size]));
}

test("a copy dated in other digits counts against the cap, as in Python", () => {
  const mine = seeded();
  try {
    assert.equal(keepLocalCopy(mine, [new Map([["event", "cli_command"]])], false), FROZEN.keep_local_copy.kept);
    const dated = /^cli-[0-9]{4}-[0-9]{2}-[0-9]{2}\.jsonl$/;
    const shown = Object.fromEntries(Object.entries(copies(mine)).map(([name, size]) => [dated.test(name) ? `cli-${FROZEN.keep_local_copy.date_mark}.jsonl` : name, size]));
    assert.deepEqual(shown, FROZEN.keep_local_copy.copies);
  } finally {
    fs.rmSync(mine, { recursive: true, force: true });
  }
});

test("discarding the spool lets go of its lock even when the spool can't be removed", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ardia-spool-")));
  try {
    const telemetry = path.join(root, "Telemetry");
    fs.mkdirSync(path.join(telemetry, "cli-queue.jsonl", "inside"), { recursive: true });
    fs.chmodSync(telemetry, 0o700);
    discardSpool(root);
    const dir = openPrivate(root, ["Telemetry"], false);
    try {
      const lock = takeLock("cli-queue.lock", dir);
      assert.notEqual(lock, undefined, "the spool lock was still held");
      close(lock);
    } finally {
      closeDir(dir);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
