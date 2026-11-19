import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BUILT_LIBC } from "./libc-loaded.ts";
import { closeOnExecFrom, dlopenReason, errnoError, flock, interruptsIgnored, LibcUnavailable, listAt, loadLibc, mkdirAt, openAt, peerUid, sizeAt as rawSizeAt, strerror, unlinkAt, watchLifeline } from "../src/libc.ts";
import { close, closeDir, listDir, openPrivate, openPrivateFile, PathError, readPrivate, renameIn, sizeAt, takeLock, unlinkQuietly, writePrivate } from "../src/privatefs.ts";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PYTHON = process.env.ARDIA_TEST_PYTHON ?? "python3";
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ardia-libc-")));
const { O_RDONLY, O_RDWR, O_CREAT } = fs.constants;
process.on("exit", () => fs.rmSync(scratch, { recursive: true, force: true }));

function compiler(): string[] {
  return process.platform === "darwin" ? ["/usr/bin/xcrun", "clang", "-bundle", "-undefined", "dynamic_lookup"] : ["cc", "-shared", "-fPIC"];
}

function failsToLoad(file: string): LibcUnavailable {
  try {
    loadLibc(file);
  } catch (error) {
    assert.ok(error instanceof LibcUnavailable);
    assert.equal(error.file, file);
    assert.ok(!error.message.includes("\n"));
    loadLibc(BUILT_LIBC);
    return error;
  }
  assert.fail(`${file} loaded`);
}

test("a missing, corrupt or incomplete addon fails closed and names the file and the reason", () => {
  const missing = failsToLoad(path.join(scratch, "nowhere.so"));
  assert.match(missing.reason, /no such file|No such file/);
  const corrupt = path.join(scratch, "corrupt.so");
  fs.writeFileSync(corrupt, Buffer.alloc(4096, 7));
  assert.notEqual(failsToLoad(corrupt).reason, "");
  const source = path.join(scratch, "empty.c");
  fs.writeFileSync(source, "void *napi_register_module_v1(void *env, void *exports) { (void)env; return exports; }\n");
  const empty = path.join(scratch, "empty.so");
  const [program = "cc", ...words] = compiler();
  const built = spawnSync(program, [...words, "-o", empty, source]);
  assert.equal(built.status, 0, built.stderr?.toString());
  assert.equal(failsToLoad(empty).reason, "it has no peerUid");
});

test("dyld's reason is cut to its first try", () => {
  const message = "dlopen(/x/a.so, 0x0001): tried: '/x/a.so' (mach-o file, but is an incompatible architecture (have 'x86_64', need 'arm64')), '/y' (no such file)";
  assert.equal(dlopenReason(new Error(message)), "mach-o file, but is an incompatible architecture (have 'x86_64', need 'arm64')");
  assert.equal(dlopenReason(new Error("/x/a.so: cannot open shared object file: No such file or directory\nmore")), "/x/a.so: cannot open shared object file: No such file or directory");
});

test("errors carry the errno code Node would give", () => {
  const dir = fs.openSync(scratch, O_RDONLY);
  try {
    assert.throws(() => openAt(dir, "absent", O_RDONLY), { code: "ENOENT", syscall: "openat" });
    assert.throws(() => openAt(dir, "a\0b", O_RDONLY), { code: "EINVAL" });
    assert.throws(() => listAt(-1), { code: "EBADF" });
  } finally {
    fs.closeSync(dir);
  }
});

test("the peer of a Unix socket is this user, and a file isn't a socket", async () => {
  const where = path.join(scratch, "s.sock");
  const server = net.createServer(() => {}).listen(where);
  await new Promise((resolve) => server.once("listening", resolve));
  const socket = net.createConnection({ path: where });
  await new Promise((resolve) => socket.once("connect", resolve));
  try {
    const fd = (socket as unknown as { _handle: { fd: number } })._handle.fd;
    assert.equal(peerUid(fd), process.getuid?.());
    const file = fs.openSync(path.join(scratch, "plain"), "w");
    assert.throws(() => peerUid(file), { code: "ENOTSOCK" });
    fs.closeSync(file);
  } finally {
    socket.destroy();
    server.close();
  }
});

test("an ignored SIGINT is read as ignored, a default one isn't", () => {
  assert.equal(interruptsIgnored(), false);
  const script = `import { loadLibc, interruptsIgnored } from ${JSON.stringify(path.join(CLI, "ts", "src", "libc.ts"))}; loadLibc(${JSON.stringify(BUILT_LIBC)}); process.stdout.write(String(interruptsIgnored()));`;
  const run = (ignore: boolean) =>
    spawnSync("/bin/sh", ["-c", `${ignore ? "trap '' INT; " : ""}exec "$0" -e "$1"`, process.execPath, script], { encoding: "utf8" });
  assert.equal(run(true).stdout, "true");
  assert.equal(run(false).stdout, "false");
});

function listedFresh(root: string): Buffer[] {
  const dir = openPrivate(root, ["Telemetry", "Local"], false);
  try {
    return listDir(dir);
  } finally {
    closeDir(dir);
  }
}

test("private files are reached through the folder's descriptor, never the working directory", () => {
  const root = path.join(scratch, "root");
  fs.mkdirSync(root, { mode: 0o700 });
  const gone = path.join(scratch, "gone");
  fs.mkdirSync(gone);
  const before = process.cwd();
  const chdir = process.chdir;
  process.chdir(gone);
  fs.rmdirSync(gone);
  process.chdir = () => assert.fail("privatefs changed the working directory");
  try {
    const dir = openPrivate(root, ["Telemetry", "Local"], true);
    writePrivate("a.json", dir, Buffer.from("[1]"));
    assert.equal(readPrivate("a.json", dir, 10)?.toString(), "[1]");
    assert.equal(sizeAt(dir, "a.json"), 3);
    renameIn(dir, "a.json", "b.json");
    assert.deepEqual(listedFresh(root), [Buffer.from("b.json")]);
    unlinkQuietly("b.json", dir);
    unlinkQuietly("b.json", dir);
    assert.deepEqual(listedFresh(root), []);
    fs.symlinkSync("/etc", path.join(root, "Telemetry", "Link"));
    const telemetry = openPrivate(root, ["Telemetry"], false);
    assert.throws(() => openPrivate(root, ["Telemetry", "Link"], false), PathError);
    fs.symlinkSync("/etc/hosts", path.join(root, "Telemetry", "file-link"));
    assert.throws(() => openPrivateFile("file-link", telemetry, O_RDONLY), { code: "ELOOP" });
    closeDir(telemetry);
    closeDir(dir);
  } finally {
    process.chdir = chdir;
    process.chdir(before);
  }
});

const PYTHON_LOCK = `
import sys, time
sys.path.insert(0, sys.argv[2])
from ardia_cli.browse import paths
dir_fd = paths.open_private(__import__("pathlib").Path(sys.argv[1]), "Telemetry")
if sys.argv[3] == "hold":
    lock = paths.take_lock("cli-queue.lock", dir_fd)
    print("held" if lock is not None else "busy", flush=True)
    sys.stdin.read()
else:
    print("busy" if paths.take_lock("cli-queue.lock", dir_fd) is None else "took", flush=True)
`;

test("the lock is Python's flock both ways", async () => {
  const root = path.join(scratch, "locks");
  fs.mkdirSync(path.join(root, "Telemetry"), { recursive: true, mode: 0o700 });
  const holder = spawn(PYTHON, ["-I", "-c", PYTHON_LOCK, root, CLI, "hold"], { stdio: ["pipe", "pipe", "inherit"] });
  const first = await new Promise<string>((resolve) => holder.stdout.once("data", (chunk: Buffer) => resolve(chunk.toString().trim())));
  assert.equal(first, "held");
  const dir = openPrivate(root, ["Telemetry"], false);
  try {
    assert.equal(takeLock("cli-queue.lock", dir), undefined);
    holder.stdin.end();
    await new Promise((resolve) => holder.once("exit", resolve));
    const mine = takeLock("cli-queue.lock", dir);
    assert.notEqual(mine, undefined);
    const python = spawnSync(PYTHON, ["-I", "-c", PYTHON_LOCK, root, CLI, "try"], { encoding: "utf8" });
    assert.equal(python.stdout.trim(), "busy", python.stderr);
    close(mine);
    const after = spawnSync(PYTHON, ["-I", "-c", PYTHON_LOCK, root, CLI, "try"], { encoding: "utf8" });
    assert.equal(after.stdout.trim(), "took", after.stderr);
  } finally {
    closeDir(dir);
  }
});

test("a lock file another program created with loose permissions is tightened, as Python does", () => {
  const root = path.join(scratch, "loose");
  fs.mkdirSync(path.join(root, "Telemetry"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, "Telemetry", "x.lock"), "", { mode: 0o644 });
  const dir = openPrivate(root, ["Telemetry"], false);
  const lock = takeLock("x.lock", dir);
  assert.equal(fs.fstatSync(lock ?? -1).mode & 0o777, 0o600);
  close(lock);
  const created = openPrivateFile("made", dir, O_RDWR | O_CREAT);
  assert.equal(fs.fstatSync(created).mode & 0o777, 0o600);
  close(created);
  closeDir(dir);
});

test("error text is this libc's, as Python's os.strerror gives it", () => {
  const codes = [0, ...Array.from({ length: 140 }, (_, index) => index + 1), 999, 99_999];
  const script = "import json, os, sys; print(json.dumps([os.strerror(c) for c in json.loads(sys.argv[1])]))";
  const python = spawnSync(PYTHON, ["-I", "-c", script, JSON.stringify(codes)], { encoding: "utf8" });
  assert.equal(python.status, 0, python.stderr);
  assert.deepEqual(codes.map(strerror), JSON.parse(python.stdout));
  assert.equal(errnoError(os.constants.errno.EIO, "write").message, `EIO: ${JSON.parse(python.stdout)[os.constants.errno.EIO]}, write`);
});

test("every integer argument is taken exactly or refused with a thrown error", () => {
  const dir = fs.openSync(scratch, O_RDONLY);
  try {
    for (const bad of [4.5, 2 ** 32 + dir, -(2 ** 31) - 1, 2 ** 31, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => listAt(bad), RangeError, `${bad}`);
      assert.throws(() => peerUid(bad), RangeError, `${bad}`);
      assert.throws(() => strerror(bad), RangeError, `${bad}`);
      assert.throws(() => openAt(dir, "x", O_RDONLY, bad), RangeError, `${bad}`);
      assert.throws(() => mkdirAt(bad, "x", 0o700), RangeError, `${bad}`);
      assert.throws(() => watchLifeline(bad), RangeError, `${bad}`);
    }
    for (const bad of ["3", 3n, null, undefined, {}]) {
      assert.throws(() => rawSizeAt(bad as unknown as number, "x"), TypeError, String(bad));
      assert.throws(() => flock(bad as unknown as number, true, false), TypeError, String(bad));
    }
    assert.throws(() => flock(dir, 1 as unknown as boolean, false), TypeError);
    assert.ok(Array.isArray(listAt(dir + 0.0)));
    assert.throws(() => listAt(-1), { code: "EBADF" });
  } finally {
    fs.closeSync(dir);
  }
});

test("listing a folder leaves its descriptor where it was and gives each name's bytes", () => {
  const folder = fs.mkdtempSync(path.join(scratch, "listed-"));
  for (const name of ["a.jsonl", "b.jsonl", "c\u0661.jsonl"]) fs.writeFileSync(path.join(folder, name), "");
  const odd = Buffer.concat([Buffer.from(folder), Buffer.from("/\xff\xfe.jsonl", "latin1")]);
  let oddMade = true;
  try {
    fs.writeFileSync(odd, "");
  } catch {
    oddMade = false;
  }
  const dir = fs.openSync(folder, O_RDONLY);
  try {
    const names = listAt(dir).sort(Buffer.compare);
    const expected = [Buffer.from("a.jsonl"), Buffer.from("b.jsonl"), Buffer.from("c\u0661.jsonl")];
    if (oddMade) expected.push(Buffer.from("\xff\xfe.jsonl", "latin1"));
    assert.deepEqual(names, expected.sort(Buffer.compare));
    const offset = spawnSync(PYTHON, ["-I", "-c", "import os; print(os.lseek(3, 0, os.SEEK_CUR))"], { stdio: ["ignore", "pipe", "pipe", dir], encoding: "utf8" });
    assert.equal(offset.stdout.trim(), "0", offset.stderr);
    if (oddMade) {
      const oddName = names.find((name) => name[0] === 0xff) ?? Buffer.alloc(0);
      assert.equal(rawSizeAt(dir, oddName), 0);
      unlinkAt(dir, oddName);
      assert.equal(listAt(dir).length, 3);
    }
  } finally {
    fs.closeSync(dir);
  }
});

function folderOpenedBeforeItsFiles(): number {
  const folder = fs.mkdtempSync(path.join(scratch, "listed-later-"));
  fs.writeFileSync(path.join(folder, "before"), "");
  const dir = fs.openSync(folder, O_RDONLY);
  for (const name of ["after-1", "after-2"]) fs.writeFileSync(path.join(folder, name), "");
  return dir;
}

function offsetOf(dir: number): number {
  const done = spawnSync(PYTHON, ["-I", "-c", "import os; print(os.lseek(3, 0, os.SEEK_CUR))"], { stdio: ["ignore", "pipe", "pipe", dir], encoding: "utf8" });
  assert.equal(done.status, 0, done.stderr);
  return Number(done.stdout.trim());
}

test("listAt sees what os.listdir sees in a folder opened before its files were made", () => {
  const theirs = folderOpenedBeforeItsFiles();
  const mine = folderOpenedBeforeItsFiles();
  try {
    const script = "import json, os; print(json.dumps(sorted(os.listdir(3))))";
    const python = spawnSync(PYTHON, ["-I", "-c", script], { stdio: ["ignore", "pipe", "pipe", theirs], encoding: "utf8" });
    assert.equal(python.status, 0, python.stderr);
    const names = listAt(mine).map((name) => name.toString()).sort();
    assert.deepEqual([names, offsetOf(mine)], [JSON.parse(python.stdout), offsetOf(theirs)]);
  } finally {
    fs.closeSync(theirs);
    fs.closeSync(mine);
  }
});

test("a write to a full non-blocking pipe fails with EAGAIN at once and never waits", () => {
  const script = path.join(scratch, "write-full.ts");
  fs.writeFileSync(script, `import { loadLibc, writeWhole, writtenBefore } from ${JSON.stringify(path.resolve(CLI, "ts", "src", "libc.ts"))};
loadLibc(${JSON.stringify(BUILT_LIBC)});
try { writeWhole(1, Buffer.alloc(1 << 20, 121)); process.exit(3); } catch (error) { process.exitCode = Math.abs((error as NodeJS.ErrnoException).errno ?? 0) === ${os.constants.errno.EAGAIN} && writtenBefore(error) === 0 ? 0 : 4; }
`);
  const filler = [
    "import fcntl, os, subprocess, sys",
    "r, w = os.pipe()",
    "fcntl.fcntl(w, fcntl.F_SETFL, fcntl.fcntl(w, fcntl.F_GETFL) | os.O_NONBLOCK)",
    "for size in (65536, 1):",
    "    while True:",
    "        try: os.write(w, b'x' * size)",
    "        except BlockingIOError: break",
    "child = subprocess.run([sys.argv[1], sys.argv[2]], stdout=w, timeout=20)",
    "sys.exit(child.returncode)",
  ].join("\n");
  const ran = spawnSync(PYTHON, ["-c", filler, process.execPath, script], { timeout: 30000 });
  assert.equal(ran.status, 0, ran.stderr?.toString());
});

test("closeOnExecFrom takes only an integer descriptor of 3 or above", () => {
  for (const wrong of [2, -1, 1.5, Number.NaN, 2 ** 31]) assert.throws(() => closeOnExecFrom(wrong), RangeError, String(wrong));
  assert.throws(() => closeOnExecFrom("3" as unknown as number), TypeError);
  assert.ok(closeOnExecFrom(3) >= 0);
});

test("closeOnExecFrom marks a descriptor above the soft limit that the caller left open", () => {
  const script = path.join(scratch, "mark-high.ts");
  fs.writeFileSync(script, `import { closeOnExecFrom, loadLibc } from ${JSON.stringify(path.resolve(CLI, "ts", "src", "libc.ts"))};
loadLibc(${JSON.stringify(BUILT_LIBC)});
process.exitCode = closeOnExecFrom(3) >= 1 ? 0 : 5;
`);
  const wrapper = [
    "import os, resource, subprocess, sys",
    "r, w = os.pipe()",
    "os.dup2(w, 42)",
    "os.close(w)",
    "def lower(): resource.setrlimit(resource.RLIMIT_NOFILE, (32, resource.getrlimit(resource.RLIMIT_NOFILE)[1]))",
    "child = subprocess.run([sys.argv[1], sys.argv[2]], pass_fds=(42,), preexec_fn=lower, timeout=30)",
    "sys.exit(child.returncode)",
  ].join("\n");
  const ran = spawnSync(PYTHON, ["-c", wrapper, process.execPath, script], { timeout: 60000 });
  assert.equal(ran.status, 0, ran.stderr?.toString());
});
