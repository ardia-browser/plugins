import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { SKILL_FILES } from "../src/skill-files.ts";

const SKILL_DIR = path.resolve(import.meta.dir, "..", "assets", "skill");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [path.relative(SKILL_DIR, full).split(path.sep).join("/")];
  });
}

test("every file under assets/skill is embedded, with the same text, and nothing else is", () => {
  const onDisk = walk(SKILL_DIR).sort();
  expect(SKILL_FILES.map(([name]) => name).sort()).toEqual(onDisk);
  for (const [name, text] of SKILL_FILES) expect(text, name).toBe(readFileSync(path.join(SKILL_DIR, name), "utf8"));
});
