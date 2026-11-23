import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { browseDir, closeFd } from "../../src/browse/paths.ts";
import { awaitDaemon, DaemonDidNotStart, spawnDaemon } from "../../src/browse/daemon/spawn.ts";
import { servedTable } from "../../src/served.ts";
import {
  alive,
  ask,
  config,
  connectSession,
  keyOf,
  lockHolder,
  PROGRAM,
  pythonChoice,
  raw,
  type Scratch,
  scratch,
  socketFile,
  staleSocket,
  start,
  tsChoice,
  until,
  sessionMeta,
} from "./daemon-helpers.ts";

setDefaultTimeout(60_000);
const OVERSIZED_WRITE_MS = 50_000;

function exitOf(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}
const made: Scratch[] = [];
const pids: number[] = [];

function fresh(): Scratch {
  const found = scratch();
  made.push(found);
  return found;
}

afterEach(() => {
  for (const pid of pids.splice(0)) if (alive(pid)) process.kill(pid, "SIGKILL");
  for (const found of made.splice(0)) found.done();
});

describe("spawn from the TS client", () => {
  test("starts the TS daemon detached with its config on stdin, and it answers with its version", async () => {
    const found = fresh();
    const { key, pid } = await start(found.data, "spawned");
    pids.push(pid);
    const answer = await ask(found.data, key, ["session"]);
    expect(answer).toMatchObject({ exit: 0, out: "spawned\n", err: "" });
    expect(String(answer["daemon"])).toMatch(/^ts\//u);
    const meta = await sessionMeta(found.data, key);
    expect(meta).toMatchObject({ session: "spawned", namespace: "", endpoint: "--port 9", pid });
    expect(fs.statSync(socketFile(found.data, key)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(found.browse, `${key}.log`)).mode & 0o777).toBe(0o600);
    expect((await ask(found.data, key, ["close"]))["out"]).toBe("✓ Session spawned closed (0 tabs it opened)\n");
    expect(await until(() => !alive(pid), 10_000)).toBe(true);
    expect(fs.existsSync(socketFile(found.data, key))).toBe(false);
    expect(fs.existsSync(path.join(found.browse, `${key}.json`))).toBe(false);
  });

  test("starts Python's daemon through the same module", async () => {
    const found = fresh();
    const { key, pid } = await start(found.data, "py", pythonChoice());
    pids.push(pid);
    const answer = await ask(found.data, key, ["session"]);
    expect(answer).toMatchObject({ exit: 0, out: "py\n" });
    expect(answer["daemon"]).toBeUndefined();
    await ask(found.data, key, ["close"]);
    expect(await until(() => !alive(pid), 10_000)).toBe(true);
  });

  test("a daemon that exits before it listens fails fast with the log's tail", async () => {
    const found = fresh();
    const dir = browseDir(found.data);
    try {
      const bad = config(found.data, "bad", { key: "not-a-key" });
      const spawned = spawnDaemon(dir, keyOf("bad"), bad, tsChoice());
      const started = performance.now();
      const failure = await awaitDaemon(dir, keyOf("bad"), spawned, () => connectSession(found.data, keyOf("bad"))).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(DaemonDidNotStart);
      expect(String((failure as Error).message)).toBe("the ardia browse daemon exited before it listened: ardia-ts daemon: key must be 24 lowercase hex digits");
      expect(performance.now() - started).toBeLessThan(10_000);
    } finally {
      closeFd(dir);
    }
  });
});

describe("the hidden subcommand", () => {
  test("is refused with arguments or without a config", () => {
    const extra = spawn(PROGRAM, ["daemon", "now"], { stdio: ["pipe", "pipe", "pipe"] });
    extra.stdin.end("{}");
    return Promise.all([
      new Promise<void>((resolve) => {
        let err = "";
        extra.stderr.on("data", (chunk) => (err += chunk));
        extra.once("exit", (code) => {
          expect(code).toBe(2);
          expect(err).toContain("the browse daemon is started by `ardia browse`");
          resolve();
        });
      }),
      new Promise<void>((resolve) => {
        const empty = spawn(PROGRAM, ["daemon"], { stdio: ["pipe", "pipe", "pipe"] });
        let err = "";
        empty.stderr.on("data", (chunk) => (err += chunk));
        empty.stdin.end("[]");
        empty.once("exit", (code) => {
          expect(code).toBe(2);
          expect(err).toBe("ardia-ts daemon: the config on stdin isn't a JSON object\n");
          resolve();
        });
      }),
    ]);
  });
});

describe("the session folder", () => {
  test("a stale socket is replaced under the lock", async () => {
    const found = fresh();
    fs.mkdirSync(found.browse, { mode: 0o700 });
    const key = keyOf("stale");
    staleSocket(socketFile(found.data, key));
    const before = fs.lstatSync(socketFile(found.data, key)).ino;
    const { pid } = await start(found.data, "stale");
    pids.push(pid);
    expect(fs.lstatSync(socketFile(found.data, key)).ino).not.toBe(before);
    expect((await ask(found.data, key, ["session"]))["out"]).toBe("stale\n");
    await ask(found.data, key, ["close"]);
  });

  test("a lock held by another process: the new daemon exits 0 and leaves the socket alone", async () => {
    const found = fresh();
    fs.mkdirSync(found.browse, { mode: 0o700 });
    const key = keyOf("held");
    const holder = await lockHolder(path.join(found.browse, `${key}.lock`));
    try {
      staleSocket(socketFile(found.data, key));
      const before = fs.lstatSync(socketFile(found.data, key)).ino;
      const dir = browseDir(found.data);
      try {
        const spawned = spawnDaemon(dir, key, config(found.data, "held"), tsChoice());
        const code = await exitOf(spawned.child);
        expect(code).toBe(0);
        expect(fs.lstatSync(socketFile(found.data, key)).ino).toBe(before);
        const waited = await awaitDaemon(dir, key, spawned, () => connectSession(found.data, key), 400).catch((error: unknown) => error);
        expect(String((waited as Error).message)).toBe("the ardia browse daemon didn't start in 15 s");
      } finally {
        closeFd(dir);
      }
    } finally {
      holder.release();
    }
  });

  test("a Browse folder swapped for a symlink is refused with exit 2", async () => {
    const found = fresh();
    const elsewhere = path.join(found.root, "elsewhere");
    fs.mkdirSync(elsewhere, { mode: 0o700 });
    fs.symlinkSync(elsewhere, found.browse);
    const child = spawn(PROGRAM, ["daemon"], { stdio: ["pipe", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (chunk) => (err += chunk));
    child.stdin.end(JSON.stringify(Object.fromEntries([...config(found.data, "link")].map(([name, value]) => [name, typeof value === "bigint" ? Number(value) : value]))));
    const code = await exitOf(child);
    expect(code).toBe(2);
    expect(err).toBe("ardia browse daemon: Browse is a symbolic link or not a folder\n");
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  test("a data folder that isn't private stays unused", async () => {
    const found = fresh();
    fs.mkdirSync(found.browse, { mode: 0o755 });
    fs.chmodSync(found.browse, 0o755);
    const child = spawn(PROGRAM, ["daemon"], { stdio: ["pipe", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (chunk) => (err += chunk));
    child.stdin.end(JSON.stringify(Object.fromEntries([...config(found.data, "open")].map(([name, value]) => [name, typeof value === "bigint" ? Number(value) : value]))));
    expect(await exitOf(child)).toBe(2);
    expect(err).toBe("ardia browse daemon: Browse must be private (mode 0700)\n");
  });
});

for (const [label, choose] of [["ts", tsChoice], ["python", pythonChoice]] as const) {
describe(`requests (${label} daemon)`, () => {
  test("an oversized request is dropped without an answer and the daemon keeps serving", async () => {
    const found = fresh();
    const { key, pid } = await start(found.data, "big", choose());
    pids.push(pid);
    const huge = Buffer.alloc(16 * 1024 * 1024 + 2, 0x61);
    const result = await raw(socketFile(found.data, key), huge, { timeoutMs: OVERSIZED_WRITE_MS });
    expect(result).toEqual({ text: "", closed: true });
    const broken = await raw(socketFile(found.data, key), "{not json}\n");
    expect(broken).toEqual({ text: "", closed: true });
    expect((await ask(found.data, key, ["session"]))["out"]).toBe("big\n");
    const log = fs.readFileSync(path.join(found.browse, `${key}.log`), "utf8");
    expect(log).toContain("request failed");
    await ask(found.data, key, ["close"]);
  });

  test("a client that hangs up cancels its command; the next one runs", async () => {
    const found = fresh();
    const { key, pid } = await start(found.data, "gone", choose());
    pids.push(pid);
    const line = `${JSON.stringify({ argv: ["wait", "20000"], options: {} })}\n`;
    const hung = await raw(socketFile(found.data, key), line, { end: true, timeoutMs: 5000 });
    expect(hung).toEqual({ text: "", closed: true });
    const started = performance.now();
    expect((await ask(found.data, key, ["session"]))["out"]).toBe("gone\n");
    expect(performance.now() - started).toBeLessThan(5000);
    await ask(found.data, key, ["close"]);
  });

  test("commands queue in order; beside_if_busy answers busy at once; close refuses what queued before it and ends the session", async () => {
    const found = fresh();
    const { key, pid } = await start(found.data, "queue", choose());
    pids.push(pid);
    const first = ask(found.data, key, ["wait", "1500"]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const busy = await ask(found.data, key, ["wait", "10"], {}, { beside_if_busy: true });
    expect(busy).toMatchObject({ exit: 1, code: "session_busy", busy_elsewhere: true });
    expect(String(busy["err"])).toMatch(/^✗ This session is still running `wait` for [0-9]+ s; this command didn't run\./u);
    const second = ask(found.data, key, ["session"]);
    const closing = ask(found.data, key, ["close"]);
    expect((await first)["exit"]).toBe(0);
    expect(await second).toMatchObject({ exit: 1, code: "session_closing", err: "✗ Session queue is closing; start a new command after it ends\n" });
    expect((await closing)["out"]).toBe("✓ Session queue closed (0 tabs it opened)\n");
    expect(await until(() => !alive(pid), 10_000)).toBe(true);
  });
});
}

describe("lifetime", () => {
  for (const [label, choose] of [["ts", tsChoice], ["python", pythonChoice]] as const) {
  test(`${label} daemon: SIGTERM during a request lets it finish within the settle time, then cleans up`, async () => {
    const found = fresh();
    const { key, pid } = await start(found.data, "term", choose());
    pids.push(pid);
    const pending = ask(found.data, key, ["wait", "1000"]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    process.kill(pid, "SIGTERM");
    expect((await pending)["exit"]).toBe(0);
    expect(await until(() => !alive(pid), 10_000)).toBe(true);
    expect(fs.existsSync(socketFile(found.data, key))).toBe(false);
    expect(fs.existsSync(path.join(found.browse, `${key}.json`))).toBe(false);
  });

  test(`${label} daemon: SIGINT during a long request cancels it after 5 s, with no answer`, async () => {
    const found = fresh();
    const { key, pid } = await start(found.data, "intr", choose());
    pids.push(pid);
    const pending = raw(socketFile(found.data, key), `${JSON.stringify({ argv: ["wait", "60000"], options: {} })}\n`, { timeoutMs: 30_000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const sent = performance.now();
    process.kill(pid, "SIGINT");
    expect(await pending).toEqual({ text: "", closed: true });
    const waited = performance.now() - sent;
    expect(waited).toBeGreaterThan(4500);
    expect(await until(() => !alive(pid), 12_000)).toBe(true);
    expect(fs.existsSync(socketFile(found.data, key))).toBe(false);
  });

  }

  test("a command started while closing is refused with session_closing", async () => {
    const found = fresh();
    const { key, pid } = await start(found.data, "closing");
    pids.push(pid);
    const pending = ask(found.data, key, ["wait", "1500"]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    process.kill(pid, "SIGHUP");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const refused = await ask(found.data, key, ["session"]).catch(() => null);
    if (refused !== null) expect(refused).toMatchObject({ exit: 1, code: "session_closing" });
    expect((await pending)["exit"]).toBe(0);
    expect(await until(() => !alive(pid), 10_000)).toBe(true);
  });

  test("with no connection it exits after its idle timeout and removes its files", async () => {
    const found = fresh();
    const started = performance.now();
    const { key, pid } = await start(found.data, "idle", tsChoice(), { idle_timeout_ms: 1500n });
    pids.push(pid);
    expect(await until(() => !alive(pid), 10_000)).toBe(true);
    expect(performance.now() - started).toBeGreaterThan(1400);
    expect(fs.existsSync(socketFile(found.data, key))).toBe(false);
    expect(fs.existsSync(path.join(found.browse, `${key}.json`))).toBe(false);
    expect(fs.readdirSync(found.browse).sort()).toEqual(["claims", `${key}.lock`, `${key}.log`]);
  });

  test("the install lease is taken beside the program and dropped at exit", async () => {
    const found = fresh();
    const install = path.join(found.root, "0.9.0");
    fs.mkdirSync(path.join(install, "libexec"), { recursive: true });
    fs.mkdirSync(path.join(install, ".leases"));
    fs.copyFileSync(PROGRAM, path.join(install, "libexec", "ardia-ts"));
    fs.chmodSync(path.join(install, "libexec", "ardia-ts"), 0o755);
    fs.copyFileSync(path.join(path.dirname(PROGRAM), "ardia-libc.so"), path.join(install, "libexec", "ardia-libc.so"));
    const link = path.join(found.root, "current");
    fs.symlinkSync(path.join(install, "libexec", "ardia-ts"), link);
    const { key, pid } = await start(found.data, "lease", { kind: "ts", program: link });
    pids.push(pid);
    expect(fs.readdirSync(path.join(install, ".leases"))).toEqual([String(pid)]);
    await ask(found.data, key, ["close"]);
    expect(await until(() => !alive(pid), 10_000)).toBe(true);
    expect(fs.readdirSync(path.join(install, ".leases"))).toEqual([]);
  });
});
