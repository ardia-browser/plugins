import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";
import { servedTable } from "../src/served.ts";

test("served.txt rows name one or two words, or a family, then the side", () => {
  const table = servedTable("--version rust\ntabs rust\n  skills   install ts \ncall * ts\nbad\ntabs rust extra\ntabs ts\n");
  assert.deepEqual([...table], [
    ["--version", "rust"],
    ["tabs", "rust"],
    ["skills install", "ts"],
    ["call *", "ts"],
  ]);
});

test("the shipped served.txt has one row per command, each served by TypeScript, and an argparse row", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.join(here, "..", "assets", "served.txt");
  const seen = new Set<string>();
  const problems: string[] = [];
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, index) => {
      const words = line.trim().split(/\s+/).filter((word) => word !== "");
      if (words.length === 0) return;
      const label = words.slice(0, -1).join(" ");
      const shape = words.length === 2 || (words.length === 3 && (words[1] === "*" || /^[a-z][a-z-]*$/.test(words[1] as string)));
      if (!shape || words.at(-1) !== "ts" || seen.has(label)) problems.push(`served.txt:${index + 1}: ${JSON.stringify(line)}`);
      seen.add(label);
    });
  assert.deepEqual(problems, []);
  assert.ok(seen.has("argparse"), "served.txt has no argparse row");
  assert.match(readFileSync(path.join(here, "..", "src", "served.ts"), "utf8"), /import table from "\.\.\/assets\/served\.txt" with \{ type: "text" \};/);
});
