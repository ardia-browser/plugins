import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { install, refresh } from "../src/skills.ts";
import { SKILL_FILES } from "../src/skill-files.ts";

let home = "";
let saved: string | undefined;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ardia-skills-")));
  saved = process.env.HOME;
  process.env.HOME = home;
  process.env.ARDIA_CLI_HOME = path.join(home, "cli");
});

afterEach(() => {
  process.env.HOME = saved;
  delete process.env.ARDIA_CLI_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

const folder = () => path.join(home, ".agents", "skills", "ardia");

function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const info = fs.lstatSync(full);
      if (info.isDirectory()) walk(full, `${prefix}${name}/`);
      else out.push(`${prefix}${name}:${info.isSymbolicLink() ? "link" : fs.readFileSync(full, "utf8")}`);
    }
  };
  walk(root, "");
  return out;
}

test("a failed update leaves the old install exactly as it was", async () => {
  fs.mkdirSync(path.join(folder(), "references"), { recursive: true });
  fs.writeFileSync(path.join(folder(), ".ardia-skill"), JSON.stringify({ vendor: "ardia", files: ["SKILL.md", "references/old.md"] }));
  fs.writeFileSync(path.join(folder(), "SKILL.md"), "old skill\n");
  fs.writeFileSync(path.join(folder(), "references", "old.md"), "old ref\n");
  fs.mkdirSync(path.join(folder(), "references", "config.md"));
  const before = tree(folder());
  const done = await install(["general"], false, false);
  assert.equal(done.status, 1);
  assert.match(done.out[0] ?? "", /references\/config\.md is a folder; move it away first$/);
  assert.deepEqual(tree(folder()), before);
  assert.deepEqual(fs.readdirSync(path.dirname(folder())).sort(), ["ardia"]);
});

test("a symlinked ancestor of the destination is never followed", async () => {
  const elsewhere = path.join(home, "elsewhere");
  fs.mkdirSync(elsewhere);
  fs.mkdirSync(path.join(home, ".agents"));
  fs.symlinkSync(elsewhere, path.join(home, ".agents", "skills"));
  const done = await install(["general"], false, false);
  assert.equal(done.status, 1);
  assert.match(done.out[0] ?? "", /\.agents\/skills isn't a plain folder; move it away first$/);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
  fs.writeFileSync(path.join(elsewhere, "keep.txt"), "x");
  fs.mkdirSync(path.join(elsewhere, "ardia"));
  fs.writeFileSync(path.join(elsewhere, "ardia", ".ardia-skill"), JSON.stringify({ vendor: "ardia", files: ["SKILL.md"] }));
  const refreshed = await refresh();
  assert.deepEqual(refreshed.out, [`skipped ${folder()}: not installed by ardia skills install (no .ardia-skill marker)`]);
  assert.deepEqual(fs.readdirSync(path.join(elsewhere, "ardia")), [".ardia-skill"]);
});

test("--replace overwrites only the shipped files and keeps the rest of a foreign folder", async () => {
  fs.mkdirSync(folder(), { recursive: true });
  fs.writeFileSync(path.join(folder(), "SKILL.md"), "theirs\n");
  fs.writeFileSync(path.join(folder(), "notes.txt"), "keep me\n");
  const done = await install(["general"], false, false, true);
  assert.equal(done.status, 0, done.out.join("\n"));
  assert.equal(fs.readFileSync(path.join(folder(), "notes.txt"), "utf8"), "keep me\n");
  assert.equal(fs.readFileSync(path.join(folder(), "SKILL.md"), "utf8"), SKILL_FILES[0]?.[1]);
  const marker = JSON.parse(fs.readFileSync(path.join(folder(), ".ardia-skill"), "utf8"));
  assert.deepEqual(marker.files, SKILL_FILES.map(([name]) => name));
});

test("--replace removes a linked folder, never its target", async () => {
  const target = path.join(home, "target");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "SKILL.md"), "theirs\n");
  fs.mkdirSync(path.dirname(folder()), { recursive: true });
  fs.symlinkSync(target, folder());
  const done = await install(["general"], false, false, true);
  assert.equal(done.status, 0, done.out.join("\n"));
  assert.equal(fs.lstatSync(folder()).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(target), ["SKILL.md"]);
  assert.equal(fs.readFileSync(path.join(target, "SKILL.md"), "utf8"), "theirs\n");
});
