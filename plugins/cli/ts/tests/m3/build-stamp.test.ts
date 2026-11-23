import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import "../libc-loaded.ts";
import { BUILT_LIBC } from "../libc-loaded.ts";
import { flock } from "../../src/libc.ts";
import { sessionKey } from "../../src/browse/request.ts";

const PROGRAM = path.resolve(import.meta.dir, "../../dist/ardia-ts");

function keyFor(build: string): string {
  const before = process.env["ARDIA_BROWSE_BUILD"];
  process.env["ARDIA_BROWSE_BUILD"] = build;
  try {
    return sessionKey("", "port:1", "default");
  } finally {
    if (before === undefined) delete process.env["ARDIA_BROWSE_BUILD"];
    else process.env["ARDIA_BROWSE_BUILD"] = before;
  }
}

async function fakeDaemon(browse: string, key: string): Promise<{ hits: () => number; close: () => void }> {
  const lock = fs.openSync(path.join(browse, `${key}.lock`), fs.constants.O_RDWR | fs.constants.O_CREAT, 0o600);
  flock(lock, true, false);
  let hits = 0;
  const server = net.createServer((socket) => {
    hits += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(path.join(browse, `${key}.sock`), resolve));
  fs.chmodSync(path.join(browse, `${key}.sock`), 0o600);
  return {
    hits: () => hits,
    close: () => {
      server.close();
      fs.closeSync(lock);
    },
  };
}

async function client(data: string, build: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = Bun.spawn([PROGRAM, "browse", "--port", "1", "get", "title"], {
      env: { PATH: "/usr/bin:/bin", HOME: data, ARDIA_DATA_DIR: data, ARDIA_TELEMETRY: "0", ARDIA_BROWSE_BUILD: build, ARDIA_BROWSE_AUTO_SESSION: "0", ARDIA_TEST_LIBC: BUILT_LIBC },
      stdout: "ignore",
      stderr: "ignore",
    });
    const timer = setTimeout(() => child.kill(), 20_000);
    void child.exited.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function stopDaemons(browse: string, except: string): void {
  for (const name of fs.readdirSync(browse)) {
    if (!name.endsWith(".json") || name.startsWith(except)) continue;
    try {
      const pid = Number(JSON.parse(fs.readFileSync(path.join(browse, name), "utf8")).pid);
      if (pid > 1) process.kill(pid, "SIGTERM");
    } catch {}
  }
}

test("a client never adopts a daemon from another build; it starts its own under its own key", async () => {
  const data = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ardia-stamp-")));
  const browse = path.join(data, "Browse");
  fs.mkdirSync(browse, { mode: 0o700 });
  const keyA = keyFor("build-A");
  const keyB = keyFor("build-B");
  expect(keyA).not.toBe(keyB);
  const daemonA = await fakeDaemon(browse, keyA);
  try {
    await client(data, "build-B");
    expect(daemonA.hits()).toBe(0);
    expect(fs.existsSync(path.join(browse, `${keyB}.log`))).toBe(true);
    await client(data, "build-A");
    expect(daemonA.hits()).toBeGreaterThan(0);
  } finally {
    daemonA.close();
    stopDaemons(browse, keyA);
    fs.rmSync(data, { recursive: true, force: true });
  }
}, 60_000);
