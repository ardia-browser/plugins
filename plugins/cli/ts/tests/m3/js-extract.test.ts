import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import * as js from "../../src/browse/js/index.ts";

const TS = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const DIR = path.join(TS, "src", "browse", "js");
const PYTHON = process.env.ARDIA_TEST_PYTHON ?? "python3";
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, "manifest.json"), "utf8")) as Record<string, { python: string; sha256: string }>;

test("every extracted file matches its manifest hash", () => {
  const files = fs.readdirSync(DIR).filter((name) => name.endsWith(".js.txt")).sort();
  assert.deepEqual(files, Object.keys(manifest).sort());
  for (const [file, entry] of Object.entries(manifest)) {
    const digest = createHash("sha256").update(fs.readFileSync(path.join(DIR, file))).digest("hex");
    assert.equal(digest, entry.sha256, file);
  }
});

test("the bundled strings are the files' exact text", () => {
  const values = Object.values(js);
  assert.equal(values.length, Object.keys(manifest).length);
  for (const [file, entry] of Object.entries(manifest)) {
    const name = entry.python.split(".").at(-1) as string;
    const module = entry.python.split(".").at(-2) as string;
    const key = module === "js" ? name : `${module.toUpperCase()}_${name}`;
    const value = (js as Record<string, string>)[key];
    assert.equal(value, fs.readFileSync(path.join(DIR, file), "utf8"), file);
  }
});

test("the Python sources haven't moved since the extraction", () => {
  const run = spawnSync(PYTHON, [path.join(TS, "scripts", "extract-js.py"), "--check"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
});
