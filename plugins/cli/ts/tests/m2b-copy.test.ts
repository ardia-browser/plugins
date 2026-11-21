import "./libc-loaded.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { ConfigError } from "../src/config-files.ts";
import { copyTree, verifyCopy } from "../src/plugins-cli.ts";

function scratch(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ardia-m2b-copy-")));
}

function plugin(root: string): string {
  const source = path.join(root, "source");
  fs.mkdirSync(path.join(source, "page"), { recursive: true });
  fs.writeFileSync(path.join(source, "plugin.json"), "{}");
  fs.writeFileSync(path.join(source, "page", "index.html"), "<p>");
  fs.chmodSync(path.join(source, "page", "index.html"), 0o640);
  return source;
}

function refused(run: () => void, words: string): void {
  assert.throws(run, (error: unknown) => error instanceof ConfigError && error.message.includes(words));
}

test("a plugin copies with its contents and modes", () => {
  const root = scratch();
  const target = path.join(root, "copy");
  copyTree(plugin(root), target);
  assert.equal(fs.readFileSync(path.join(target, "page", "index.html"), "utf8"), "<p>");
  assert.equal(fs.statSync(path.join(target, "page", "index.html")).mode & 0o777, 0o640);
  verifyCopy(target);
});

test("the copy itself refuses a link and leaves no link behind", () => {
  const root = scratch();
  const source = plugin(root);
  fs.symlinkSync("/etc", path.join(source, "page", "outside"));
  const target = path.join(root, "copy");
  refused(() => copyTree(source, target), "is a link");
  const left: string[] = [];
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      const entry = path.join(dir, name);
      if (fs.lstatSync(entry).isSymbolicLink()) left.push(entry);
      else if (fs.lstatSync(entry).isDirectory()) walk(entry);
    }
  };
  if (fs.existsSync(target)) walk(target);
  assert.deepEqual(left, []);
});

test("a FIFO in a plugin is refused, not read", () => {
  const root = scratch();
  const source = plugin(root);
  execFileSync("/usr/bin/mkfifo", [path.join(source, "pipe")]);
  refused(() => copyTree(source, path.join(root, "copy")), "isn't a regular file");
});

test("the finished copy is refused if a link, hard link or FIFO appears in it", () => {
  for (const [plant, words] of [
    [(dir: string) => fs.symlinkSync("/etc", path.join(dir, "late")), "is a link"],
    [(dir: string) => fs.linkSync(path.join(dir, "plugin.json"), path.join(dir, "twin")), "hard link"],
    [(dir: string) => execFileSync("/usr/bin/mkfifo", [path.join(dir, "pipe")]), "isn't a regular file"],
  ] as [(dir: string) => void, string][]) {
    const root = scratch();
    const target = path.join(root, "copy");
    copyTree(plugin(root), target);
    plant(target);
    refused(() => verifyCopy(target), words);
  }
});
