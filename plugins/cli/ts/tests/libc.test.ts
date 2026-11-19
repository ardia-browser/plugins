import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { BUILT_LIBC } from "./libc-loaded.ts";
import { dlopenReason, interruptsIgnored, LibcUnavailable, listAt, loadLibc, openAt, peerUid } from "../src/libc.ts";
import { close, closeDir, listDir, openPrivate, openPrivateFile, PathError, readPrivate, renameIn, sizeAt, takeLock, unlinkQuietly, writePrivate } from "../src/privatefs.ts";

const CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
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
    assert.deepEqual(listDir(dir), ["b.json"]);
    unlinkQuietly("b.json", dir);
    unlinkQuietly("b.json", dir);
    assert.deepEqual(listDir(dir), []);
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
