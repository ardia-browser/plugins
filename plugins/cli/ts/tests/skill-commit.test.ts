import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import "./libc-loaded.ts";
import { commitPack, recoverAside } from "../src/skill-commit.ts";

const DIRS = [".claude/skills"];

function home(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ardia-skill-commit-")));
  fs.mkdirSync(path.join(root, ".claude", "skills"), { recursive: true });
  return root;
}

test("publishing swaps the new pack into place in one step and leaves nothing beside it", () => {
  const root = home();
  const parent = path.join(root, ".claude", "skills");
  const folder = path.join(parent, "ardia");
  commitPack(folder, DIRS, [], [["SKILL.md", Buffer.from("one\n")]], ".ardia.json", Buffer.from("{}\n"));
  fs.writeFileSync(path.join(folder, "notes.txt"), "kept\n");
  commitPack(folder, DIRS, ["SKILL.md"], [["SKILL.md", Buffer.from("two\n")]], ".ardia.json", Buffer.from("{}\n"));
  expect(fs.readFileSync(path.join(folder, "SKILL.md"), "utf8")).toBe("two\n");
  expect(fs.readFileSync(path.join(folder, "notes.txt"), "utf8")).toBe("kept\n");
  expect(fs.readdirSync(parent)).toEqual(["ardia"]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a run that died with the old pack set aside is restored or finished by the next one", () => {
  const root = home();
  const parent = path.join(root, ".claude", "skills");
  const folder = path.join(parent, "ardia");
  fs.mkdirSync(path.join(parent, ".ardia.old"));
  fs.writeFileSync(path.join(parent, ".ardia.old", "SKILL.md"), "old\n");
  recoverAside(parent, "ardia");
  expect(fs.readFileSync(path.join(folder, "SKILL.md"), "utf8")).toBe("old\n");
  expect(fs.readdirSync(parent)).toEqual(["ardia"]);
  fs.mkdirSync(path.join(parent, ".ardia.old"));
  fs.writeFileSync(path.join(parent, ".ardia.old", "SKILL.md"), "older\n");
  commitPack(folder, DIRS, ["SKILL.md"], [["SKILL.md", Buffer.from("new\n")]], ".ardia.json", Buffer.from("{}\n"));
  expect(fs.readFileSync(path.join(folder, "SKILL.md"), "utf8")).toBe("new\n");
  expect(fs.readdirSync(parent)).toEqual(["ardia"]);
  fs.rmSync(root, { recursive: true, force: true });
});
