import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { parseConfig } from "../../src/browse/daemon/config.ts";
import { Daemon } from "../../src/browse/daemon/server.ts";
import { PathError } from "../../src/browse/paths.ts";
import { dumps } from "../../src/json.ts";
import { ask, config, type Scratch, scratch, socketFile, until, quietWatchdog } from "./daemon-helpers.ts";

setDefaultTimeout(90_000);
const CHROME = process.env["ARDIA_M3_CHROME"];
const FIRST_PORT = Number(process.env["ARDIA_D2_CHROME_PORT"] ?? "9531");
const PAGE = "data:text/html,<title>Idle tab</title><p>still here</p>";
const home = process.cwd();
const made: Scratch[] = [];
const browsers: ChildProcess[] = [];

function fresh(): Scratch {
  const found = scratch();
  made.push(found);
  return found;
}

function answers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/json/version", timeout: 500, agent: false }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on("error", () => resolve(false));
    request.on("timeout", () => request.destroy());
  });
}

async function chrome(found: Scratch, port: number): Promise<ChildProcess> {
  const child = spawn(
    CHROME as string,
    [
      "--headless",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--mute-audio",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${path.join(found.root, `profile-${port}`)}`,
      "about:blank",
    ],
    { stdio: "ignore", detached: true },
  );
  browsers.push(child);
  const deadline = performance.now() + 30_000;
  while (performance.now() < deadline && !(await answers(port))) await new Promise((resolve) => setTimeout(resolve, 100));
  if (!(await answers(port))) throw new Error(`headless Chrome didn't answer on ${port}`);
  return child;
}

function kill(child: ChildProcess): void {
  try {
    process.kill(-(child.pid as number), "SIGKILL");
  } catch {}
}

function daemonFor(found: Scratch, session: string, port: number): Daemon {
  const text = dumps(config(found.data, session, {}, port), "spaced");
  return quietWatchdog(new Daemon(parseConfig(text)));
}

afterEach(() => {
  process.chdir(home);
  for (const child of browsers.splice(0)) kill(child);
});

afterAll(() => {
  for (const found of made.splice(0)) found.done();
});

describe("the folder check", () => {
  test("a Browse folder swapped after it was opened stops the daemon before it listens", async () => {
    const found = fresh();
    const daemon = daemonFor(found, "swap", 9);
    fs.renameSync(found.browse, `${found.browse}.old`);
    fs.mkdirSync(found.browse, { mode: 0o700 });
    const failure = await daemon.run().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PathError);
    expect((failure as Error).message).toBe("the Browse folder changed while the daemon started");
    expect(fs.readdirSync(found.browse)).toEqual([]);
  });
});

describe.skipIf(!CHROME)("against headless Chrome for Testing", () => {
  test("an idle connection is dropped, and the next command reconnects with a new link to the same tab", async () => {
    const found = fresh();
    const port = FIRST_PORT;
    await chrome(found, port);
    const daemon = daemonFor(found, "idle", port);
    daemon.connectedIdle = 1;
    const running = daemon.run();
    await until(() => fs.existsSync(socketFile(found.data, daemon.key)), 5000);
    const opened = await ask(found.data, daemon.key, ["open", PAGE], { no_changes: true });
    expect(opened).toMatchObject({ exit: 0 });
    expect(String(opened["out"])).toStartWith("✓ Idle tab\n");
    const first = daemon.state.browser;
    expect(first?.alive).toBe(true);
    expect(await until(() => !daemon.state.connected, 6000)).toBe(true);
    expect(first?.closedByUs).toBe(true);
    const again = await ask(found.data, daemon.key, ["get", "title"]);
    expect(again).toMatchObject({ exit: 0, out: "Idle tab\n" });
    expect((again["metrics"] as Record<string, unknown>)["reconnected_after_idle"]).toBe(true);
    expect(daemon.state.browser).not.toBe(first);
    expect(daemon.state.connected).toBe(true);
    await ask(found.data, daemon.key, ["close"]);
    expect(await running).toBe(0);
  });

  test("a browser that dies while connected ends the daemon: connection loss is terminal", async () => {
    const found = fresh();
    const port = FIRST_PORT + 1;
    const browser = await chrome(found, port);
    const daemon = daemonFor(found, "lost", port);
    const running = daemon.run();
    await until(() => fs.existsSync(socketFile(found.data, daemon.key)), 5000);
    expect((await ask(found.data, daemon.key, ["open", PAGE], { no_changes: true }))["exit"]).toBe(0);
    kill(browser);
    const started = performance.now();
    expect(await running).toBe(0);
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(daemon.state.lost).toBe(true);
    expect(fs.existsSync(socketFile(found.data, daemon.key))).toBe(false);
  });

  test("while disconnected, the watch notices the browser is gone and ends the daemon", async () => {
    const found = fresh();
    const port = FIRST_PORT + 2;
    const browser = await chrome(found, port);
    const daemon = daemonFor(found, "watch", port);
    daemon.connectedIdle = 1;
    const running = daemon.run();
    await until(() => fs.existsSync(socketFile(found.data, daemon.key)), 5000);
    expect((await ask(found.data, daemon.key, ["open", PAGE], { no_changes: true }))["exit"]).toBe(0);
    expect(await until(() => !daemon.state.connected, 6000)).toBe(true);
    kill(browser);
    const started = performance.now();
    expect(await running).toBe(0);
    expect(performance.now() - started).toBeLessThan(8000);
    expect(daemon.state.lost).toBe(false);
  });
});
