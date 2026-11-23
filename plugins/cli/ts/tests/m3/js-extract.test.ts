import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "bun:test";
import * as js from "../../src/browse/js/index.ts";

const DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "src", "browse", "js");

function exportName(file: string): string {
  const [module, ...rest] = file.replace(/\.js\.txt$/, "").split(".");
  const name = rest.join(".").toUpperCase().replaceAll("-", "_");
  return module === "js" ? name : `${(module as string).toUpperCase()}_${name}`;
}

test("the bundled strings are the files' exact text, one export per file", () => {
  const files = fs.readdirSync(DIR).filter((name) => name.endsWith(".js.txt")).sort();
  assert.ok(files.length > 30);
  assert.deepEqual(files.map(exportName).sort(), Object.keys(js).sort());
  for (const file of files) assert.equal((js as Record<string, string>)[exportName(file)], fs.readFileSync(path.join(DIR, file), "utf8"), file);
});
