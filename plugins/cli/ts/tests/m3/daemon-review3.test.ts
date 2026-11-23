import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Cancelled, withSignal } from "../../src/browse/cdp/cancel.ts";
import { parseConfig } from "../../src/browse/daemon/config.ts";
import { FifoLock } from "../../src/browse/daemon/lock.ts";
import { Daemon } from "../../src/browse/daemon/server.ts";
import { Page } from "../../src/browse/state/page.ts";
import { State } from "../../src/browse/state/state.ts";
import { ConnectionLost, Gated, OutcomeUnknown } from "../../src/browse/daemon-errors.ts";
import { EndpointError, portNumber } from "../../src/browse/endpoint.ts";
import { browseDir, closeFd } from "../../src/browse/paths.ts";
import * as temptabs from "../../src/browse/state/temptabs.ts";
import { dumps } from "../../src/json.ts";
import { BUILT_LIBC } from "../libc-loaded.ts";
import { oracle } from "../oracle-fixtures.ts";
import { config, type Scratch, scratch, socketFile, staleSocket, until, quietWatchdog } from "./daemon-helpers.ts";

setDefaultTimeout(60_000);
const home = process.cwd();
const made: Scratch[] = [];
const children: ChildProcess[] = [];

function fresh(): Scratch {
  const found = scratch();
  made.push(found);
  return found;
}

afterEach(() => {
  process.chdir(home);
  for (const child of children.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
});

afterAll(() => {
  for (const found of made.splice(0)) found.done();
});

function inProcess(found: Scratch, session: string): Daemon {
  return quietWatchdog(new Daemon(parseConfig(dumps(config(found.data, session), "spaced"))));
}

function exitOf(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}

function nativeScript(found: Scratch, body: string): ChildProcess {
  const script = `const module = { exports: {} };
process.dlopen(module, ${JSON.stringify(BUILT_LIBC)});
const native = module.exports;
const fs = require("node:fs");
const dir = fs.openSync(${JSON.stringify(found.root)}, "r");
const info = fs.statSync(${JSON.stringify(path.join(found.root, "s.sock"))}, { bigint: true });
${body}`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  children.push(child);
  return child;
}

function output(child: ChildProcess): () => string {
  let out = "";
  child.stdout?.on("data", (chunk) => (out += chunk));
  return () => out;
}

describe("the watchdog is armed the moment a stop begins", () => {
  test("close arms it before it closes any tab", async () => {
    const found = fresh();
    const daemon = inProcess(found, "armfirst");
    const order: string[] = [];
    Object.assign(daemon, {
      watchdog: { arm: () => (order.push("arm"), 0), disarm: () => (order.push("disarm"), 0) },
      closeTabs: () => {
        order.push("closeTabs");
        const until = performance.now() + 50;
        while (performance.now() < until) {}
        return Promise.resolve();
      },
    });
    await withSignal(null, () => daemon.execute({ argv: ["close"], options: {} }));
    expect(order.slice(0, 2)).toEqual(["arm", "closeTabs"]);
    closeFd(daemon.lockFd);
  });

  test("a failed arm skips the cleanup, unlinks its own socket and exits with the shutdown code", async () => {
    const found = fresh();
    const daemon = inProcess(found, "armfails");
    const exits: number[] = [];
    let cleaned = false;
    Object.assign(daemon, {
      watchdog: { arm: () => -12, disarm: () => 0 },
      exit: (code: number) => exits.push(code),
      cleanupInner: () => {
        cleaned = true;
        return Promise.resolve();
      },
    });
    void daemon.run();
    await until(() => fs.existsSync(socketFile(found.data, daemon.key)), 5000);
    daemon.beginStop();
    expect(await until(() => exits.length > 0, 3000)).toBe(true);
    expect(exits).toEqual([1]);
    expect(cleaned).toBe(false);
    expect(fs.existsSync(socketFile(found.data, daemon.key))).toBe(false);
  });
});

describe("the native watchdog's states", () => {
  test("once the thread has claimed the fire, disarm fails and the fire completes", async () => {
    const found = fresh();
    staleSocket(path.join(found.root, "s.sock"));
    const child = nativeScript(
      found,
      `console.log(native.armWatchdog(dir, "s.sock", info.dev, info.ino, 100, 9, 600));
setTimeout(() => { console.log(native.disarmWatchdog()); setTimeout(() => console.log("survived"), 3000); }, 300);`,
    );
    const read = output(child);
    expect(await exitOf(child)).toBe(9);
    const lines = read().trim().split("\n");
    expect(lines[0]).toBe("0");
    expect(Number(lines[1])).toBeLessThan(0);
    expect(lines).not.toContain("survived");
    expect(fs.existsSync(path.join(found.root, "s.sock"))).toBe(false);
  });

  test("a disarm that wins stops the fire for good", async () => {
    const found = fresh();
    staleSocket(path.join(found.root, "s.sock"));
    const child = nativeScript(
      found,
      `console.log(native.armWatchdog(dir, "s.sock", info.dev, info.ino, 400, 9, 0));
setTimeout(() => { console.log(native.disarmWatchdog()); console.log(native.disarmWatchdog()); setTimeout(() => console.log("survived"), 1000); }, 100);`,
    );
    const read = output(child);
    expect(await exitOf(child)).toBe(0);
    const lines = read().trim().split("\n");
    expect([lines[0], lines[1], lines[3]]).toEqual(["0", "0", "survived"]);
    expect(Number(lines[2])).toBeLessThan(0);
    expect(fs.existsSync(path.join(found.root, "s.sock"))).toBe(true);
  });

  test("a descriptor that isn't a folder is refused", async () => {
    const found = fresh();
    staleSocket(path.join(found.root, "s.sock"));
    fs.writeFileSync(path.join(found.root, "plain"), "x");
    const child = nativeScript(found, `const file = fs.openSync(${JSON.stringify(path.join(found.root, "plain"))}, "r");
console.log(native.armWatchdog(file, "s.sock", info.dev, info.ino, 100, 9, 0));
setTimeout(() => console.log("survived"), 500);`);
    const read = output(child);
    expect(await exitOf(child)).toBe(0);
    expect(read().trim().split("\n")).toEqual([String(-20), "survived"]);
  });
});

describe("temporary tabs carry a marker until their answer is known", () => {
  function scene(onCreate: (url: string) => Promise<unknown>) {
    const found = fresh();
    const dir = browseDir(found.data);
    const state = new State({ session: "s", key: "a".repeat(24), browseFd: dir, noAutoDialog: false, pinTab: false }, () => Promise.reject(new Error("unused")));
    const targets: Record<string, unknown>[] = [];
    const closed: string[] = [];
    const browser = {
      alive: true,
      send(method: string, params: Record<string, unknown>) {
        if (method === "Target.createTarget") {
          targets.push({ targetId: "PENDING", type: "page", url: String(params["url"]) });
          return onCreate(String(params["url"]));
        }
        if (method === "Target.closeTarget") {
          closed.push(String(params["targetId"]));
          targets.splice(0, targets.length, ...targets.filter((info) => info["targetId"] !== params["targetId"]));
          return Promise.resolve({ success: true });
        }
        if (method === "Target.getTargets") return Promise.resolve({ targetInfos: [...targets] });
        return Promise.resolve({});
      },
    };
    Object.assign(state, { browser, instance: "inst" });
    return { found, dir, state, targets, closed };
  }

  test("a stop during a pending createTarget closes the marked tab", async () => {
    const { dir, state, targets, closed } = scene(() => new Promise(() => {}));
    const previous = temptabs.limits.shield;
    temptabs.limits.shield = 0.2;
    try {
      const failure = await temptabs.create(state, []).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Cancelled);
      expect(String(targets[0]?.["url"])).toMatch(/^about:blank#ardia-temp-[0-9a-f]{28}$/u);
      await temptabs.drain(state);
      expect(closed).toEqual(["PENDING"]);
      expect(state.registry.temporaries("inst")).toEqual([]);
    } finally {
      temptabs.limits.shield = previous;
      closeFd(dir);
    }
  });

  test("a createTarget whose answer never came is closed by the next connect's sweep", async () => {
    const { dir, state, closed } = scene(() => Promise.reject(new OutcomeUnknown("`Target.createTarget`", "Ardia didn't answer Target.createTarget in 30s after it was sent")));
    try {
      const failure = await temptabs.create(state, []).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(OutcomeUnknown);
      expect(closed).toEqual([]);
      const later = new State({ session: "s", key: "a".repeat(24), browseFd: dir, noAutoDialog: false, pinTab: false }, () => Promise.reject(new Error("unused")));
      Object.assign(later, { browser: (state as unknown as { browser: unknown }).browser, instance: "inst" });
      await temptabs.sweep(later);
      expect(closed).toEqual(["PENDING"]);
      expect(later.registry.temporaries("inst")).toEqual([]);
    } finally {
      closeFd(dir);
    }
  });
});

describe("the crashed-tab path", () => {
  function setup(onSend: (method: string) => Promise<unknown>, alive = true) {
    const state = new State({ session: "s", key: "k", browseFd: null, noAutoDialog: false, pinTab: false }, () => Promise.reject(new Error("unused")));
    const page = new Page(state, "TARGET");
    page.crashed = true;
    const browser = {
      alive,
      send(method: string) {
        if (method === "Target.attachToTarget") return Promise.resolve({ sessionId: "SESSION" });
        return onSend(method);
      },
    };
    return { page, browser };
  }

  test("a lost connection during Inspector.enable isn't swallowed", async () => {
    const { page, browser } = setup((method) => (method === "Inspector.enable" ? Promise.reject(new ConnectionLost()) : Promise.resolve({})));
    expect(await page.attach(browser as never).catch((error: unknown) => error)).toBeInstanceOf(ConnectionLost);
    expect(page.sessionId).toBeNull();
  });

  test("a crashed tab's session isn't published once the link is gone", async () => {
    const { page, browser } = setup((method) => (method === "Inspector.enable" ? Promise.reject(new Gated("Inspector.enable")) : Promise.resolve({})), false);
    expect(await page.attach(browser as never).catch((error: unknown) => error)).toBeInstanceOf(ConnectionLost);
    expect(page.sessionId).toBeNull();
  });
});

describe("the command lock", () => {
  test("a waiter whose deadline passed while the loop was busy is skipped, not granted", async () => {
    const lock = new FifoLock();
    await lock.acquire();
    const late = lock.acquire(0.025);
    const until = performance.now() + 70;
    while (performance.now() < until) {}
    lock.release();
    expect(await late).toBe(false);
    expect(lock.locked).toBe(false);
  });
});

describe("ARDIA_PORT reads as Python's int", () => {
  test("on the review's inputs and 2,000 fuzzed ones, value and message match Python 3.13", () => {
    const frozen = oracle<{ ports: [string, [string, string]][] }>("daemon-review3").ports;
    const ours = frozen.map(([text]): [string, string] => {
      try {
        return ["ok", String(portNumber(text))];
      } catch (error) {
        expect(error).toBeInstanceOf(EndpointError);
        return ["err", (error as Error).message];
      }
    });
    const differ = frozen.map(([text, python], index) => ({ text, ours: ours[index], python })).filter((row) => JSON.stringify(row.ours) !== JSON.stringify(row.python));
    expect(differ).toEqual([]);
    expect(frozen.length).toBe(2033);
  });
});
