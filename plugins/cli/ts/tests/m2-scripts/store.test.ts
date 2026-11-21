import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import "../libc-loaded.ts";
import { removeDirAt, statAt, statBytesAt, swapAt } from "../../src/libc.ts";
import { parseScripts } from "../../src/scripts/args.ts";
import { findEsbuild, installed, packagedExecutable } from "../../src/scripts/build.ts";
import { exists, OsError, openDir, readFile, removeTree, StoreError, stagingDir, writeAtomic, writeFile } from "../../src/scripts/store-fs.ts";

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ardia-scripts-store-")));
const { O_RDONLY, O_DIRECTORY } = fs.constants;
process.on("exit", () => fs.rmSync(scratch, { recursive: true, force: true }));

function folder(name: string): [string, number] {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir);
  return [dir, fs.openSync(dir, O_RDONLY | O_DIRECTORY)];
}

test("one addon answers D7's statAt and removeDirAt call shapes and the store's raw-byte names, and swapAt exchanges folders", () => {
  const [dir, fd] = folder("addon");
  fs.mkdirSync(path.join(dir, "a"));
  fs.mkdirSync(path.join(dir, "b"));
  fs.writeFileSync(path.join(dir, "a", "marker"), "a");
  fs.symlinkSync("a", path.join(dir, "link"));
  const info = statAt(fd, "a");
  const real = fs.statSync(path.join(dir, "a"), { bigint: true });
  assert.equal(info.mode & 0o170000, 0o040000);
  assert.equal(info.uid, process.getuid?.());
  assert.equal(info.dev, real.dev);
  assert.equal(info.ino, real.ino);
  assert.ok(Math.abs(info.mtime - Number(real.mtimeMs) / 1000) < 1);
  assert.equal(statAt(fd, "link").mode & 0o170000, 0o120000);
  const bytes = statBytesAt(fd, Buffer.from("link"));
  assert.equal(bytes.mode & 0o170000, 0o120000);
  assert.equal(typeof bytes.ino, "bigint");
  for (const name of ["a/marker", ".", ".."]) assert.throws(() => statAt(fd, name), (error: NodeJS.ErrnoException) => error.code === "EINVAL");
  swapAt(fd, "a", "b");
  assert.ok(fs.existsSync(path.join(dir, "b", "marker")));
  assert.throws(() => removeDirAt(fd, "b"), (error: NodeJS.ErrnoException) => error.code === "ENOTEMPTY");
  assert.throws(() => removeDirAt(fd, "b/x"), (error: NodeJS.ErrnoException) => error.code === "EINVAL");
  removeDirAt(fd, "a");
  fs.rmSync(path.join(dir, "b", "marker"));
  removeDirAt(fd, Buffer.from("b"));
  assert.throws(() => swapAt(fd, "a", "b"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  fs.closeSync(fd);
});

test("writes refuse to replace a file and leave no temp file behind; atomic writes replace whole", () => {
  const [dir, fd] = folder("writes");
  writeFile(fd, "one", Buffer.from("1\n"));
  assert.throws(() => writeFile(fd, "one", Buffer.from("2\n")), (error: unknown) => error instanceof OsError && error.message === "[Errno 17] File exists: 'one'");
  assert.equal((fs.statSync(path.join(dir, "one")).mode & 0o777) & ~process.umask(), 0o644 & ~process.umask());
  writeAtomic(fd, "generation", Buffer.from("7\n"));
  writeAtomic(fd, "generation", Buffer.from("8\n"));
  assert.deepEqual(fs.readdirSync(dir).sort(), ["generation", "one"]);
  assert.equal(fs.readFileSync(path.join(dir, "generation"), "utf8"), "8\n");
  fs.mkdirSync(path.join(dir, "generation-dir"));
  assert.throws(() => writeAtomic(fd, "generation-dir", Buffer.from("9\n")));
  assert.deepEqual(fs.readdirSync(dir).sort(), ["generation", "generation-dir", "one"]);
  fs.closeSync(fd);
});

test("reads refuse links, folders and FIFOs the way the Python store does", () => {
  const [dir, fd] = folder("reads");
  fs.writeFileSync(path.join(dir, "real"), "x");
  fs.symlinkSync("real", path.join(dir, "link"));
  fs.mkdirSync(path.join(dir, "sub"));
  assert.equal(readFile(fd, "missing"), null);
  assert.equal(readFile(fd, "real")?.toString(), "x");
  assert.throws(() => readFile(fd, "link"), (error: unknown) => error instanceof StoreError && error.message === "link is a symbolic link");
  assert.throws(() => readFile(fd, "sub"), (error: unknown) => error instanceof StoreError && error.message === "sub isn't a regular file");
  assert.throws(() => openDir(fd, "real", false), (error: unknown) => error instanceof StoreError && /not a folder/.test(error.message));
  assert.throws(() => openDir(fd, "link", false), (error: unknown) => error instanceof StoreError && /symbolic link/.test(error.message));
  fs.closeSync(fd);
});

test("removeTree removes a staged folder without following links out of it", () => {
  const [dir, fd] = folder("trees");
  const outside = path.join(scratch, "kept");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "keep"), "k");
  const [name, staged] = stagingDir(fd, "stage-x");
  assert.match(name, /^\.stage-x-[0-9a-f]{12}$/);
  fs.mkdirSync(path.join(dir, name, "deep", "deeper"), { recursive: true });
  fs.writeFileSync(path.join(dir, name, "deep", "deeper", "f"), "f");
  fs.symlinkSync(outside, path.join(dir, name, "deep", "out"));
  fs.closeSync(staged);
  removeTree(fd, name);
  assert.equal(exists(fd, name), false);
  assert.ok(fs.existsSync(path.join(outside, "keep")));
  removeTree(fd, "never-there");
  fs.closeSync(fd);
});

test("the argv parser serves only what argparse reads the same way", () => {
  assert.deepEqual(parseScripts(["scripts", "list", "--json", "--data-dir=/d"]), { sub: "list", match: null, json: true, dataDir: "/d" });
  assert.deepEqual(parseScripts(["--data-dir", "/a", "scripts", "list", "--data-dir", "/b"]), { sub: "list", match: null, json: false, dataDir: "/b" });
  assert.deepEqual(parseScripts(["scripts", "new", "--match", "x", "n", "--match=y"]), { sub: "new", match: ["x", "y"], json: false, name: "n" });
  assert.deepEqual(parseScripts(["scripts", "install", "-"]), { sub: "install", match: null, json: false, file: "-" });
  assert.deepEqual(parseScripts(["scripts", "new", "-5"]), { sub: "new", match: null, json: false, name: "-5" });
  for (const argv of [
    ["scripts"], ["scripts", "test", "x"], ["scripts", "list", "-h"], ["scripts", "list", "--js"], ["scripts", "list", "x"], ["scripts", "new"],
    ["scripts", "new", "a", "b"], ["scripts", "new", "x", "--match"], ["scripts", "new", "x", "--match", "-y"],
    ["--json", "scripts", "new", "x"], ["--port", "9", "scripts", "list"], ["scripts", "list", "--json=1"], ["scripts", "list", "--"], ["--data-dir"],
  ]) {
    assert.equal(parseScripts(argv), undefined, JSON.stringify(argv));
  }
});

test("a packaged ardia runs only <root>/libexec/esbuild; the test override and PATH count only outside a package", () => {
  const root = path.join(scratch, "root");
  fs.mkdirSync(path.join(root, "libexec"), { recursive: true });
  const elsewhere = path.join(scratch, "elsewhere");
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(elsewhere, "esbuild"), "#!/bin/sh\n", { mode: 0o755 });
  const saved = { override: process.env.ARDIA_TEST_ESBUILD, path: process.env.PATH };
  process.env.ARDIA_TEST_ESBUILD = path.join(elsewhere, "esbuild");
  process.env.PATH = `${elsewhere}:/usr/bin:/bin`;
  try {
    assert.equal(packagedExecutable("/$bunfs/root/ardia-ts"), true);
    assert.equal(packagedExecutable(path.join(scratch, "src", "main.ts")), false);
    assert.equal(installed(true), true);
    assert.equal(installed(false), false);
    assert.equal(findEsbuild(root, true), null);
    const bundled = path.join(root, "libexec", "esbuild");
    fs.writeFileSync(bundled, "#!/bin/sh\n", { mode: 0o755 });
    assert.equal(findEsbuild(root, true), bundled);
    fs.chmodSync(bundled, 0o644);
    assert.equal(findEsbuild(root, true), null);
    fs.rmSync(bundled);
    fs.symlinkSync(path.join(elsewhere, "esbuild"), bundled);
    assert.equal(findEsbuild(root, true), null);
    assert.equal(findEsbuild(root, false), path.join(elsewhere, "esbuild"));
    delete process.env.ARDIA_TEST_ESBUILD;
    assert.equal(findEsbuild(root, false), path.join(elsewhere, "esbuild"));
  } finally {
    for (const [key, value] of [["ARDIA_TEST_ESBUILD", saved.override], ["PATH", saved.path]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
