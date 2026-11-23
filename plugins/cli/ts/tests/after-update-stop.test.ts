import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, test } from "bun:test";
import { BUILT_LIBC } from "./libc-loaded.ts";
import { flock } from "../src/libc.ts";
import { SKILL_FILES } from "../src/skill-files.ts";

const TS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROGRAM = process.env.ARDIA_TS_CLI ?? path.join(TS, "dist", "ardia-ts");
const EXIT_BOUND_MS = 300;
const QUIET_AFTER_MS = 400;

const stalled: net.Socket[] = [];
const proxy = net.createServer((socket) => {
  stalled.push(socket);
  socket.on("error", () => {});
});
await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const PROXY = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;
afterAll(() => {
  for (const socket of stalled) socket.destroy();
  proxy.close();
});

const started: number[] = [];
const homes: string[] = [];
afterEach(() => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

type Box = { home: string; cli: string; env: Record<string, string> };

function box(): Box {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ardia-after-update-")));
  homes.push(home);
  fs.mkdirSync(path.join(home, ".claude"));
  const cli = path.join(home, "cli");
  const env = {
    HOME: home,
    PATH: "/usr/bin:/bin",
    ARDIA_CLI_HOME: cli,
    ARDIA_DATA_DIR: path.join(home, "data"),
    XDG_CONFIG_HOME: path.join(home, "xdg-config"),
    XDG_CACHE_HOME: path.join(home, "xdg-cache"),
    XDG_DATA_HOME: path.join(home, "xdg-data"),
    XDG_STATE_HOME: path.join(home, "xdg-state"),
    ARDIA_TELEMETRY: "0",
    DO_NOT_TRACK: "1",
    HTTPS_PROXY: PROXY,
    https_proxy: PROXY,
    TMPDIR: path.join(home, "tmp"),
  };
  fs.mkdirSync(env.TMPDIR);
  return { home, cli, env };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = performance.now() + ms;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const LEAVING_PARENT = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const [program, pidFile, logFile, ...argv] = process.argv.slice(1);
const log = fs.openSync(logFile, "w");
const child = spawn(program, argv, { stdio: ["ignore", log, log], detached: true });
fs.writeFileSync(pidFile, String(child.pid));
process.exit(0);
`;

const BLOCKING_PARENT = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const [program, pidFile, logFile, ...argv] = process.argv.slice(1);
const log = fs.openSync(logFile, "w");
const blockTerm = "use POSIX; sigprocmask(SIG_BLOCK, POSIX::SigSet->new(SIGTERM)) or die; exec { $ARGV[0] } @ARGV or die";
const child = spawn("/usr/bin/perl", ["-e", blockTerm, program, ...argv], { stdio: ["ignore", log, log] });
fs.writeFileSync(pidFile, String(child.pid));
setInterval(() => {}, 1000);
`;

const PARENT = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const [program, pidFile, logFile, ...argv] = process.argv.slice(1);
const log = fs.openSync(logFile, "w");
const child = spawn(program, argv, { stdio: ["ignore", log, log] });
fs.writeFileSync(pidFile, String(child.pid));
setInterval(() => {}, 1000);
`;

type Launched = { parent: ChildProcess; child: number; log: string };

async function launch(b: Box, argv: string[], script = PARENT): Promise<Launched> {
  const pidFile = path.join(b.home, "tmp", "child.pid");
  const log = path.join(b.home, "tmp", "child.log");
  const parent = spawn(process.execPath, ["-e", script, PROGRAM, pidFile, log, ...argv], { env: b.env, detached: true, stdio: "ignore" });
  started.push(parent.pid as number);
  await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8") !== "", 10_000, "the child's pid");
  const child = Number(fs.readFileSync(pidFile, "utf8"));
  started.push(child);
  return { parent, child, log };
}

function snapshot(root: string): Map<string, string> {
  const seen = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (full === path.join(root, "tmp")) continue;
      const info = fs.lstatSync(full);
      seen.set(full, info.isDirectory() ? "folder" : `${info.isSymbolicLink() ? "link" : "file"}:${info.size}:${info.mtimeMs}`);
      if (info.isDirectory() && !info.isSymbolicLink()) walk(full);
    }
  };
  walk(root);
  return seen;
}

function leftovers(root: string, seen = snapshot(root)): string[] {
  return [...seen.keys()].filter((full) => /^\.((skills|driver)-|ardia-skill-)|\.stage-|\.old$|\.ardia-new$/.test(path.basename(full)));
}

function assertSkillConsistent(folder: string): void {
  if (!fs.existsSync(folder)) return;
  const marker = JSON.parse(fs.readFileSync(path.join(folder, ".ardia-skill"), "utf8")) as { files: string[] };
  assert.deepEqual([...marker.files].sort(), SKILL_FILES.map(([name]) => name).sort());
  for (const [name, text] of SKILL_FILES) assert.equal(fs.readFileSync(path.join(folder, name), "utf8"), text, name);
}

type Stop = "parent dies" | NodeJS.Signals;

async function stopAndCheck(b: Box, launched: Launched, how: Stop): Promise<number> {
  const before = snapshot(b.home);
  const sent = performance.now();
  if (how === "parent dies") process.kill(launched.parent.pid as number, "SIGKILL");
  else process.kill(launched.child, how);
  await until(() => !alive(launched.child), 5_000, "the command to exit").catch(() => {});
  const took = performance.now() - sent;
  const stillRunning = alive(launched.child);
  const atExit = snapshot(b.home);
  await new Promise((resolve) => setTimeout(resolve, QUIET_AFTER_MS));
  const later = snapshot(b.home);
  assert.equal(stillRunning, false, `the command outlived its stop (${how}) by 5 s: ${fs.readFileSync(launched.log, "utf8")}`);
  assert.ok(took < EXIT_BOUND_MS, `the command took ${Math.round(took)} ms to stop after ${how}`);
  assert.deepEqual(later, atExit, "something wrote into the data folder after the command was gone");
  for (const [full, facts] of atExit) assert.equal(before.get(full), facts, `${full} was written after ${how}`);
  const rolledBack = new Set(leftovers(b.home, before));
  for (const full of before.keys()) assert.ok(atExit.has(full) || [...rolledBack].some((left) => full === left || full.startsWith(`${left}/`)), `${full} was removed after ${how}`);
  console.log(`${how}: stopped in ${Math.round(took)} ms`);
  assert.deepEqual(leftovers(b.home), [], "a staging folder was left behind instead of rolled back");
  assertSkillConsistent(path.join(b.home, ".claude", "skills", "ardia"));
  return took;
}

const downloadInFlight = (b: Box) => () => {
  const versions = path.join(b.cli, "cua-driver");
  if (!fs.existsSync(versions)) return false;
  return fs.readdirSync(versions).some((version) => {
    try {
      return fs.readdirSync(path.join(versions, version)).some((name) => name.startsWith(".skills-"));
    } catch {
      return false;
    }
  });
};

const STOPS: Stop[] = ["parent dies", "SIGTERM", "SIGINT", "SIGHUP"];

for (const how of STOPS) {
  test(`skills install --auto stops cleanly mid-download when ${how}`, async () => {
    const b = box();
    const launched = await launch(b, ["skills", "install", "--auto"]);
    await until(downloadInFlight(b), 10_000, "the cua-driver skill download");
    await stopAndCheck(b, launched, how);
    assert.ok(fs.existsSync(path.join(b.home, ".claude", "skills", "ardia", ".ardia-skill")));
    assert.equal(fs.existsSync(path.join(b.home, ".claude", "skills", "cua-driver")), false);
  }, 30_000);

  test(`skills refresh stops cleanly mid-download when ${how}`, async () => {
    const b = box();
    const folder = path.join(b.home, ".claude", "skills", "ardia");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, ".ardia-skill"), JSON.stringify({ vendor: "ardia", version: "0.0.1", files: ["SKILL.md"] }));
    fs.writeFileSync(path.join(folder, "SKILL.md"), "old\n");
    const launched = await launch(b, ["skills", "refresh"]);
    await until(downloadInFlight(b), 10_000, "the cua-driver skill download");
    await stopAndCheck(b, launched, how);
    assert.equal(fs.existsSync(path.join(b.cli, "skills.json")), false);
  }, 30_000);

  test.skipIf(process.platform !== "darwin")(`computer refresh stops while it waits for the Applications lock when ${how}`, async () => {
    const b = box();
    const lockFolder = path.join(b.cli, "cua-driver");
    fs.mkdirSync(lockFolder, { recursive: true });
    const lock = fs.openSync(path.join(lockFolder, ".applications.lock"), fs.constants.O_RDWR | fs.constants.O_CREAT, 0o600);
    try {
      assert.equal(flock(lock, true, false), true);
      const launched = await launch(b, ["computer", "refresh"]);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      assert.ok(alive(launched.child), fs.readFileSync(launched.log, "utf8"));
      await stopAndCheck(b, launched, how);
    } finally {
      fs.closeSync(lock);
    }
  }, 30_000);
}

for (const argv of [["skills", "install", "--auto"], ["skills", "refresh"]]) {
  test(`${argv.join(" ")} started by a parent that is already gone stops before it writes`, async () => {
    const b = box();
    const before = snapshot(b.home);
    const launched = await launch(b, argv, LEAVING_PARENT);
    await until(() => !alive(launched.child), 5_000, "the orphaned command to exit").catch(() => {});
    assert.equal(alive(launched.child), false, fs.readFileSync(launched.log, "utf8"));
    assert.deepEqual(snapshot(b.home), before);
  }, 30_000);
}

test.skipIf(process.platform !== "darwin")("skills install --auto started with SIGTERM blocked, as older Ardias start it on macOS, stops when Ardia goes away", async () => {
  const b = box();
  const launched = await launch(b, ["skills", "install", "--auto"], BLOCKING_PARENT);
  await until(downloadInFlight(b), 10_000, "the cua-driver skill download");
  process.kill(launched.child, "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(alive(launched.child), "SIGTERM wasn't blocked, so this test proves nothing");
  await stopAndCheck(b, launched, "parent dies");
}, 30_000);

const BLOCKED_WRITER = `
const fs = require("node:fs");
const [libc, after, built, staged, ready] = process.argv.slice(1);
const { loadLibc, writeWhole } = require(libc);
const { armAfterUpdateGuard, rollbackOnStop } = require(after);
loadLibc(built);
armAfterUpdateGuard();
fs.mkdirSync(staged);
rollbackOnStop(() => fs.rmSync(staged, { recursive: true, force: true }));
fs.writeFileSync(ready, "1");
writeWhole(2, Buffer.alloc(4096, 120));
setInterval(() => {}, 1000);
`;

test("a SIGINT that lands while a write is blocked still rolls back what was staged", async () => {
  const b = box();
  const fifo = path.join(b.home, "tmp", "stderr.fifo");
  execFileSync("/usr/bin/mkfifo", [fifo]);
  const holder = fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
  const writer = fs.openSync(fifo, fs.constants.O_WRONLY);
  try {
    const chunk = Buffer.alloc(4096, 120);
    for (;;) {
      try {
        fs.writeSync(holder, chunk);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EAGAIN") break;
        throw error;
      }
    }
    const staged = path.join(b.home, ".skills-staged");
    const ready = path.join(b.home, "tmp", "ready");
    const src = path.join(TS, "src");
    const child = spawn(process.execPath, ["-e", BLOCKED_WRITER, path.join(src, "libc.ts"), path.join(src, "after-update.ts"), BUILT_LIBC, staged, ready], { stdio: ["ignore", "ignore", writer] });
    started.push(child.pid as number);
    const exited = new Promise<NodeJS.Signals | number | null>((resolve) => child.once("exit", (code, signal) => resolve(signal ?? code)));
    await until(() => fs.existsSync(ready), 10_000, "the writer to stage its folder");
    await new Promise((resolve) => setTimeout(resolve, 300));
    process.kill(child.pid as number, "SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const drain = Buffer.alloc(65536);
    for (;;) {
      try {
        if (fs.readSync(holder, drain) === 0) break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EAGAIN") break;
        throw error;
      }
    }
    const outcome = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve("still running"), 5_000))]);
    assert.equal(outcome, "SIGINT");
    assert.equal(fs.existsSync(staged), false, "the staged folder outlived the SIGINT");
  } finally {
    fs.closeSync(writer);
    fs.closeSync(holder);
  }
}, 30_000);
