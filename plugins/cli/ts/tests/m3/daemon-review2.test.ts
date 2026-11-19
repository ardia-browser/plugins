import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { Cancelled, withSignal } from "../../src/browse/cdp/cancel.ts";
import { parseConfig } from "../../src/browse/daemon/config.ts";
import { Daemon } from "../../src/browse/daemon/server.ts";
import { daemonEnvironment } from "../../src/browse/daemon/spawn.ts";
import { StubPage } from "../../src/browse/daemon/stub/page.ts";
import { StubState } from "../../src/browse/daemon/stub/state.ts";
import { Gated } from "../../src/browse/daemon-errors.ts";
import { resolve } from "../../src/browse/endpoint.ts";
import { closeFd } from "../../src/browse/paths.ts";
import * as temptabs from "../../src/browse/state/temptabs.ts";
import { dumps } from "../../src/json.ts";
import { BUILT_LIBC } from "../libc-loaded.ts";
import { alive, ask, config, keyOf, lockHolder, PROGRAM, type Scratch, scratch, socketFile, staleSocket, start, until, quietWatchdog } from "./daemon-helpers.ts";

setDefaultTimeout(120_000);
const CHROME = process.env["ARDIA_M3_CHROME"];
const CHROME_PORT = Number(process.env["ARDIA_D2_CHROME_PORT"] ?? "9531") + 4;
const home = process.cwd();
const made: Scratch[] = [];
const pids: number[] = [];
const servers: (net.Server | http.Server)[] = [];
const children: ChildProcess[] = [];

function fresh(): Scratch {
  const found = scratch();
  made.push(found);
  return found;
}

afterEach(() => {
  process.chdir(home);
  for (const pid of pids.splice(0)) if (alive(pid)) process.kill(pid, "SIGKILL");
  for (const server of servers.splice(0)) server.close();
  for (const child of children.splice(0)) {
    try {
      process.kill(-(child.pid as number), "SIGKILL");
    } catch {}
    try {
      child.kill("SIGKILL");
    } catch {}
  }
});

afterAll(() => {
  for (const found of made.splice(0)) found.done();
});

function inProcess(found: Scratch, session: string, port = 9): Daemon {
  return quietWatchdog(new Daemon(parseConfig(dumps(config(found.data, session, {}, port), "spaced"))));
}

function plainConfig(found: Scratch, session: string, extra: Record<string, unknown> = {}, port = 9): string {
  return JSON.stringify({ ...Object.fromEntries([...config(found.data, session, {}, port)].map(([name, value]) => [name, typeof value === "bigint" ? Number(value) : value])), ...extra });
}

function exitOf(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}

function addon(): Record<string, (...args: unknown[]) => unknown> {
  const module = { exports: {} as Record<string, (...args: unknown[]) => unknown> };
  process.dlopen(module, BUILT_LIBC);
  return module.exports;
}

describe("the native watchdog", () => {
  test("exits with its code and unlinks the socket while JavaScript is stuck", async () => {
    const found = fresh();
    staleSocket(path.join(found.root, "s.sock"));
    const script = `const module = { exports: {} };
process.dlopen(module, ${JSON.stringify(BUILT_LIBC)});
const fs = require("node:fs");
const dir = fs.openSync(${JSON.stringify(found.root)}, "r");
const info = fs.statSync(${JSON.stringify(path.join(found.root, "s.sock"))}, { bigint: true });
console.log(module.exports.armWatchdog(dir, "s.sock", info.dev, info.ino, 300, 7));
console.log(module.exports.armWatchdog(dir, "s.sock", info.dev, info.ino, 300, 7));
const until = performance.now() + 5000;
while (performance.now() < until) {}
console.log("still here");`;
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    children.push(child);
    let out = "";
    child.stdout?.on("data", (chunk) => (out += chunk));
    const started = performance.now();
    expect(await exitOf(child)).toBe(7);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(out.trim().split("\n")).toEqual(["0", String(-16)]);
    expect(fs.existsSync(path.join(found.root, "s.sock"))).toBe(false);
  });

  test("leaves a replaced socket alone and refuses bad arguments", async () => {
    const found = fresh();
    staleSocket(path.join(found.root, "s.sock"));
    const script = `const module = { exports: {} };
process.dlopen(module, ${JSON.stringify(BUILT_LIBC)});
const fs = require("node:fs");
const dir = fs.openSync(${JSON.stringify(found.root)}, "r");
const info = fs.statSync(${JSON.stringify(path.join(found.root, "s.sock"))}, { bigint: true });
const bad = [
  [-2, "s.sock", info.dev, info.ino, 300, 3],
  [dir, "../s.sock", info.dev, info.ino, 300, 3],
  [dir, "s.sock", 1, info.ino, 300, 3],
  [dir, "s.sock", info.dev, info.ino, 0, 3],
  [dir, "s.sock", info.dev, info.ino, 300, 256],
  [dir, "s.sock", info.dev, info.ino, 300, 3, 20000],
  [dir, "s.sock", info.dev, info.ino, 300, 3, 0, 1],
];
for (const args of bad) {
  let said;
  try { said = module.exports.armWatchdog(...args); } catch (error) { said = "threw"; }
  console.log(String(said));
}
console.log(module.exports.armWatchdog(dir, "s.sock", info.dev, info.ino + 1n, 300, 5));
setTimeout(() => {}, 5000);`;
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    children.push(child);
    let out = "";
    child.stdout?.on("data", (chunk) => (out += chunk));
    expect(await exitOf(child)).toBe(5);
    const lines = out.trim().split("\n");
    expect(lines.slice(0, 7).every((line) => line === "threw" || Number(line) < 0)).toBe(true);
    expect(lines[7]).toBe("0");
    expect(fs.existsSync(path.join(found.root, "s.sock"))).toBe(true);
  });

  test("a daemon whose log is a full non-blocking pipe still serves and shuts down", async () => {
    const found = fresh();
    fs.mkdirSync(found.browse, { mode: 0o700 });
    const fifo = path.join(found.root, "log.fifo");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const reader = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const writer = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    const block = Buffer.alloc(4096, 0x78);
    for (;;) {
      try {
        fs.writeSync(writer, block);
      } catch {
        break;
      }
    }
    const child = spawn(PROGRAM, ["daemon"], { stdio: ["pipe", writer, writer], detached: true });
    children.push(child);
    fs.closeSync(writer);
    child.stdin?.end(plainConfig(found, "fullpipe", { debug: true }));
    const key = keyOf("fullpipe");
    try {
      expect(await until(() => fs.existsSync(socketFile(found.data, key)), 10_000)).toBe(true);
      await Promise.all(Array.from({ length: 20 }, () => fetchLine(socketFile(found.data, key))));
      const answered = await Promise.race([ask(found.data, key, ["session"]), new Promise((resolve) => setTimeout(() => resolve("stuck"), 5000))]);
      expect(answered).not.toBe("stuck");
      const sent = performance.now();
      process.kill(child.pid as number, "SIGTERM");
      const ended = await Promise.race([exitOf(child), new Promise((resolve) => setTimeout(() => resolve("stuck"), 20_000))]);
      expect(ended).not.toBe("stuck");
      expect(performance.now() - sent).toBeLessThan(16_000);
    } finally {
      fs.closeSync(reader);
    }
  });
});

function fetchLine(file: string): Promise<void> {
  return new Promise((resolve) => {
    const socket = net.connect(file);
    socket.on("error", () => resolve());
    socket.on("close", () => resolve());
    socket.once("connect", () => socket.end("{not json at all, so the daemon logs a stack trace}\n"));
  });
}

describe("attach", () => {
  function setup(onSend: (method: string, page: StubPage) => Promise<unknown>) {
    const state = new StubState({ session: "s", key: "k", browseFd: null, noAutoDialog: false, pinTab: false }, () => Promise.reject(new Error("unused")));
    const page = new StubPage(state, "TARGET");
    const sent: string[] = [];
    const browser = {
      send(method: string) {
        sent.push(method);
        if (method === "Target.attachToTarget") return Promise.resolve({ sessionId: "SESSION" });
        if (method === "Page.getFrameTree") return Promise.resolve({ frameTree: { frame: { id: "F", loaderId: "L", url: "about:blank" } } });
        return onSend(method, page);
      },
    };
    return { state, page, sent, browser };
  }

  test("a session detached while Page.enable runs isn't published", async () => {
    const { state, page, browser } = setup((method, current) => {
      if (method === "Page.enable") current.detach();
      return Promise.resolve({});
    });
    const failure = await page.attach(browser as never).catch((error: unknown) => error);
    expect((failure as { code?: string }).code).toBe("tab_detached");
    expect(page.sessionId).toBeNull();
    expect(page.needsEnable).toBe(true);
    expect(state.sessions.size).toBe(0);
  });

  test("the crash branch publishes only a session that is still attached", async () => {
    const { page, browser } = setup((method, current) => {
      if (method === "Inspector.enable") {
        current.detach();
        return Promise.reject(new Gated("Inspector.enable"));
      }
      return Promise.resolve({});
    });
    page.crashed = true;
    const failure = await page.attach(browser as never).catch((error: unknown) => error);
    expect((failure as { code?: string }).code).toBe("tab_detached");
    expect(page.sessionId).toBeNull();
  });

  test("a detached session found by getLayoutMetrics isn't swallowed", async () => {
    const { page, browser } = setup((method, current) => {
      if (method === "Page.getLayoutMetrics") current.detach();
      return Promise.resolve({});
    });
    const failure = await page.attach(browser as never).catch((error: unknown) => error);
    expect((failure as { code?: string }).code).toBe("tab_detached");
    expect(page.sessionId).toBeNull();
  });
});

describe("temporary tabs", () => {
  test("a createTarget reply that arrives after the deadline is closed, and counted", async () => {
    const closed: string[] = [];
    const state = new StubState({ session: "s", key: "k", browseFd: null, noAutoDialog: false, pinTab: false }, () => Promise.reject(new Error("unused")));
    const browser = {
      alive: true,
      send(method: string, params: Record<string, unknown>) {
        if (method === "Target.createTarget") return new Promise((resolve) => setTimeout(() => resolve({ targetId: "LATE" }), 400));
        if (method === "Target.closeTarget") {
          closed.push(String(params["targetId"]));
          return Promise.resolve({});
        }
        if (method === "Target.getTargets") return Promise.resolve({ targetInfos: [] });
        return Promise.resolve({});
      },
    };
    Object.assign(state, { browser });
    const previous = temptabs.limits.shield;
    temptabs.limits.shield = 0.1;
    try {
      const owned: string[] = [];
      const failure = await temptabs.create(state, owned).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Cancelled);
      expect(owned).toEqual([]);
      expect(await until(() => closed.includes("LATE"), 3000)).toBe(true);
      expect(temptabs.counters.lateCreatesClosed).toBe(1);
    } finally {
      temptabs.limits.shield = previous;
    }
  });
});

describe("the spawn's endpoint variables", () => {
  const base = () => {
    const found = config("/tmp/x", "s");
    found.set("ws", null);
    found.set("port", null);
    return found;
  };

  test("ARDIA_PORT is read as Python reads an int", () => {
    for (const [given, port] of [["+9222", 9222n], ["9_222", 9222n], [" 9222 ", 9222n]] as const) {
      const { config: folded, env } = daemonEnvironment(base(), { ARDIA_PORT: given, ARDIA_CDP_URL: "ws://127.0.0.1:1/devtools/browser/q?token=T0KENT0KENT0KEN" });
      expect(folded.get("port")).toBe(port);
      expect(folded.get("ws")).toBeNull();
      expect(Object.keys(env)).toEqual([]);
    }
  });

  test("an invalid ARDIA_PORT stays an error even with ARDIA_CDP_URL set", () => {
    const { config: folded, env } = daemonEnvironment(base(), { ARDIA_PORT: "nine", ARDIA_CDP_URL: "ws://127.0.0.1:1/devtools/browser/q?token=T0KENT0KENT0KEN" });
    expect(folded.get("ws")).toBeNull();
    expect(folded.get("port")).toBeNull();
    expect(env).toEqual({ ARDIA_PORT: "nine" });
  });
});

describe("callers", () => {
  test("a queued command's caller isn't taken until it holds the lock", async () => {
    const found = fresh();
    const daemon = inProcess(found, "callers");
    await daemon.lock.acquire();
    daemon.state.caller = { name: "running-agent", app: null };
    const queued = withSignal(null, () => daemon.execute({ argv: ["session"], options: {}, caller: { name: "queued-agent" } }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(daemon.state.caller?.name).toBe("running-agent");
    daemon.lock.release();
    await queued;
    expect(daemon.state.caller?.name).toBe("queued-agent");
    closeFd(daemon.lockFd);
  });
});

describe("socket publication", () => {
  test("binding leaves nothing behind and sweeps an old bind folder first", async () => {
    const found = fresh();
    fs.mkdirSync(found.browse, { mode: 0o700 });
    const key = keyOf("publish");
    const leftover = path.join(found.browse, `.${key}.bind`);
    fs.mkdirSync(leftover, { mode: 0o700 });
    staleSocket(path.join(leftover, "old.sock"));
    const { pid } = await start(found.data, "publish");
    pids.push(pid);
    expect(await until(() => fs.existsSync(path.join(found.browse, `${key}.json`)), 5000)).toBe(true);
    expect(fs.readdirSync(found.browse).filter((name) => name.startsWith(".")).sort()).toEqual([]);
    expect((await ask(found.data, key, ["session"]))["out"]).toBe("publish\n");
    await ask(found.data, key, ["close"]);
  });

  test("the addon's exclusive rename never replaces an entry", () => {
    const found = fresh();
    fs.writeFileSync(path.join(found.root, "a"), "a");
    fs.writeFileSync(path.join(found.root, "b"), "b");
    const dir = fs.openSync(found.root, "r");
    try {
      const exports = addon();
      expect(exports["renameExclusiveAt"]?.(dir, "a", dir, "b")).toBe(-17);
      expect(fs.readFileSync(path.join(found.root, "b"), "utf8")).toBe("b");
      expect(exports["renameExclusiveAt"]?.(dir, "a", dir, "c")).toBe(0);
      expect(exports["removeDirAt"]?.(dir, "missing")).toBe(-2);
    } finally {
      fs.closeSync(dir);
    }
  });
});

describe("close", () => {
  test("close gives up on the queue after its wait and answers busy", async () => {
    const found = fresh();
    const daemon = inProcess(found, "closewait");
    Object.assign(daemon, { closeWait: 0.3 });
    await daemon.lock.acquire();
    daemon.running = { name: "script", since: performance.now() / 1000 };
    const answer = await Promise.race([
      withSignal(null, () => daemon.execute({ argv: ["close"], options: {} })),
      new Promise((resolve) => setTimeout(() => resolve("stuck"), 5000)),
    ]);
    expect(answer).not.toBe("stuck");
    const [code, , err] = answer as [number, string, string];
    expect(code).toBe(1);
    expect(err).toStartWith("✗ This session is still running `script`");
    expect(daemon.stopping).toBe(false);
    daemon.lock.release();
    closeFd(daemon.lockFd);
  });
});

describe("endpoints", () => {
  test("control-file discovery honours cancellation", async () => {
    const found = fresh();
    fs.mkdirSync(path.join(found.data, "Chromium"), { mode: 0o700 });
    fs.writeFileSync(path.join(found.data, "Chromium", "ArdiaControl.json"), JSON.stringify({ port: 9, browser: "/devtools/browser/a", token: "t0k3n-t0k3n-t0k3n-t0k3n", pid: process.pid }), { mode: 0o600 });
    const stop = new AbortController();
    stop.abort();
    const failure = await resolve({ data_dir: found.data }, stop.signal).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Cancelled);
  });

  test("the instance kept in the tab registry carries no user info", async () => {
    const endpoint = await resolve({ ws: "ws://user:secret@127.0.0.1:1/devtools/browser/abc" });
    expect(endpoint.instance).toBe("127.0.0.1:1/devtools/browser/abc");
    const plain = await resolve({ ws: "ws://127.0.0.1:1/devtools/browser/abc" });
    expect(plain.instance).toBe(endpoint.instance);
  });
});

describe.skipIf(!CHROME)("lock contention against headless Chrome for Testing", () => {
  test("a stop that runs into held registry and claims locks still ends at the watchdog", async () => {
    const found = fresh();
    const chrome = spawn(
      CHROME as string,
      ["--headless", "--no-first-run", "--no-default-browser-check", `--remote-debugging-port=${CHROME_PORT}`, `--user-data-dir=${path.join(found.root, "profile")}`, "about:blank"],
      { stdio: "ignore", detached: true },
    );
    children.push(chrome);
    let version: Record<string, string> | null = null;
    const deadline = performance.now() + 30_000;
    while (version === null && performance.now() < deadline) {
      version = await fetch(`http://127.0.0.1:${CHROME_PORT}/json/version`)
        .then((response) => response.json() as Promise<Record<string, string>>)
        .catch(() => null);
      if (version === null) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const slow = http.createServer((_request, response) => {
      setTimeout(() => {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(version));
      }, 2750);
    });
    servers.push(slow);
    const port = await new Promise<number>((resolve) => slow.listen(0, "127.0.0.1", () => resolve((slow.address() as net.AddressInfo).port)));
    const { key, pid } = await start(found.data, "contended", undefined, {}, port);
    pids.push(pid);
    const registry = await lockHolder(path.join(found.browse, "tabs.lock"));
    fs.mkdirSync(path.join(found.browse, "claims"), { mode: 0o700, recursive: true });
    const claims = await lockHolder(path.join(found.browse, "claims", ".lock"));
    try {
      const pending = ask(found.data, key, ["open", "data:text/html,<title>x</title>"], { no_changes: true }).catch(() => null);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const sent = performance.now();
      process.kill(pid, "SIGTERM");
      expect(await until(() => !alive(pid), 40_000, 100)).toBe(true);
      const took = performance.now() - sent;
      expect(took).toBeLessThan(16_500);
      expect(fs.existsSync(socketFile(found.data, key))).toBe(false);
      await pending;
    } finally {
      registry.release();
      claims.release();
    }
  });
});

