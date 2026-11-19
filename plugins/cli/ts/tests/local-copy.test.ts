import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import "./libc-loaded.ts";
import { close, closeDir, openPrivate, takeLock } from "../src/privatefs.ts";
import { discardSpool, isLocalFile, keepLocalCopy } from "../src/spool.ts";

const CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const PYTHON = process.env.ARDIA_TEST_PYTHON ?? "python3";
const MAX_LOCAL_BYTES = 4 * 1024 * 1024;
const OTHER_DIGITS = "cli-١٩٩٩-٠١-٠١.jsonl";

function python(script: string, input: unknown): unknown {
  const done = spawnSync(PYTHON, ["-I", "-c", script, JSON.stringify(input)], { encoding: "utf8" });
  assert.equal(done.status, 0, done.stderr);
  return JSON.parse(done.stdout);
}

test("the shared table of decimal digits is exactly what Python's re calls \\d", () => {
  const table = fs.readFileSync(path.join(CLI, "py-decimals.txt"), "utf8");
  const script = [
    "import json, sys",
    "ranges, start = [], None",
    "for code in range(sys.maxunicode + 2):",
    "    decimal = code <= sys.maxunicode and chr(code).isdecimal()",
    "    if decimal and start is None: start = code",
    "    if not decimal and start is not None: ranges.append(f'{start:04X} {code - 1:04X}'); start = None",
    "print(json.dumps(ranges))",
  ].join("\n");
  assert.deepEqual(table.split("\n").filter((line) => line !== ""), python(script, null));
});

test("a local copy's name matches as Python's pattern does", () => {
  const names = ["cli-2026-11-19.jsonl", OTHER_DIGITS, "cli-２026-11-19.jsonl", "cli-²026-11-19.jsonl", "cli-𝟎026-11-19.jsonl",
    "cli-2026-11-1.jsonl", "cli-2026/11-19.jsonl", "cli-2026-11-19.jsonl\n", "xcli-2026-11-19.jsonl"];
  const script = "import json, re, sys; print(json.dumps([bool(re.fullmatch(r'cli-\\d{4}-\\d{2}-\\d{2}\\.jsonl', n)) for n in json.loads(sys.argv[1])]))";
  assert.deepEqual(names.map(isLocalFile), python(script, names));
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
  const theirs = seeded();
  try {
    assert.ok(keepLocalCopy(mine, [new Map([["event", "cli_command"]])], false));
    const script = `import json, sys; sys.path.insert(0, ${JSON.stringify(CLI)}); from pathlib import Path; from ardia_cli import telemetry; `
      + "print(json.dumps(telemetry.keep_local_copy(Path(json.loads(sys.argv[1])), [{'event': 'cli_command'}], False)))";
    assert.equal(python(script, theirs), true);
    assert.deepEqual(copies(mine), copies(theirs));
  } finally {
    fs.rmSync(mine, { recursive: true, force: true });
    fs.rmSync(theirs, { recursive: true, force: true });
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
