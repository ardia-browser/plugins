import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { parseConfig } from "../../src/browse/daemon/config.ts";
import { Daemon } from "../../src/browse/daemon/server.ts";
import { spawnDaemon } from "../../src/browse/daemon/spawn.ts";
import { StubState } from "../../src/browse/daemon/stub/state.ts";
import { StubPage } from "../../src/browse/daemon/stub/page.ts";
import { Cancelled } from "../../src/browse/cdp/cancel.ts";
import { browseDir, closeFd, lockHeld, socketIsOurs } from "../../src/browse/paths.ts";
import { BUILT_LIBC } from "../libc-loaded.ts";
import { dumps } from "../../src/json.ts";
import { alive, ask, config, keyOf, PYTHON, sessionMeta, raw, type Scratch, scratch, socketFile, staleSocket, start, tsChoice, until } from "./daemon-helpers.ts";

setDefaultTimeout(90_000);
const TS_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const CHROME = process.env["ARDIA_M3_CHROME"];
const CHROME_PORT = Number(process.env["ARDIA_D2_CHROME_PORT"] ?? "9531") + 3;
const home = process.cwd();
const made: Scratch[] = [];
const pids: number[] = [];
const servers: (net.Server | http.Server)[] = [];
const browsers: ChildProcess[] = [];

function fresh(): Scratch {
  const found = scratch();
  made.push(found);
  return found;
}

afterEach(() => {
  process.chdir(home);
  for (const pid of pids.splice(0)) if (alive(pid)) process.kill(pid, "SIGKILL");
  for (const server of servers.splice(0)) server.close();
  for (const child of browsers.splice(0)) {
    try {
      process.kill(-(child.pid as number), "SIGKILL");
    } catch {}
  }
});

afterAll(() => {
  for (const found of made.splice(0)) found.done();
});

function listening<T extends net.Server | http.Server>(server: T): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port)));
}

function tricklingVersion(): Promise<number> {
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100000\r\n\r\n{");
    const drip = setInterval(() => socket.write(" "), 300);
    socket.on("close", () => clearInterval(drip));
  });
  return listening(server);
}

function stalledHandshake(): Promise<number> {
  const server = http.createServer();
  let port = 0;
  server.on("request", (_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/stalled` }));
  });
  server.on("upgrade", (_request, socket) => socket.on("error", () => {}));
  return listening(server).then((found) => {
    port = found;
    return found;
  });
}

function inProcess(found: Scratch, session: string, port: number): Daemon {
  return new Daemon(parseConfig(dumps(config(found.data, session, {}, port), "spaced")));
}

function exitOf(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}

describe("shutdown", () => {
  test("a socket file replaced while the daemon runs is left alone at exit", async () => {
    const found = fresh();
    const { key, pid } = await start(found.data, "replaced");
    pids.push(pid);
    fs.unlinkSync(socketFile(found.data, key));
    staleSocket(socketFile(found.data, key));
    const replacement = fs.lstatSync(socketFile(found.data, key)).ino;
    process.kill(pid, "SIGTERM");
    expect(await until(() => !alive(pid), 15_000)).toBe(true);
    expect(fs.lstatSync(socketFile(found.data, key)).ino).toBe(replacement);
  });

  test("a client that goes away during close doesn't strand the session", async () => {
    const found = fresh();
    const port = await stalledHandshake();
    const daemon = inProcess(found, "strand", port);
    daemon.state.opened.add("NOT-A-REAL-TARGET");
    const running = daemon.run();
    await until(() => fs.existsSync(socketFile(found.data, daemon.key)), 5000);
    const sent = raw(socketFile(found.data, daemon.key), `${JSON.stringify({ argv: ["close"], options: {} })}\n`, { timeoutMs: 300 });
    expect((await sent).text).toBe("");
    const ended = await Promise.race([running.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 25_000))]);
    expect(ended).toBe(true);
    const dir = browseDir(found.data);
    try {
      expect(lockHeld(`${daemon.key}.lock`, dir)).toBe(false);
    } finally {
      closeFd(dir);
    }
  });

  test("endpoint discovery that never finishes doesn't hold up a SIGTERM", async () => {
    const found = fresh();
    const port = await tricklingVersion();
    const { key, pid } = await start(found.data, "hang", tsChoice(), {}, port);
    pids.push(pid);
    const pending = ask(found.data, key, ["get", "title"]).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const sent = performance.now();
    process.kill(pid, "SIGTERM");
    expect(await until(() => !alive(pid), 20_000)).toBe(true);
    expect(performance.now() - sent).toBeLessThan(12_000);
    await pending;
  });

  test("a cleanup step that never finishes is cut off at its deadline, and the watchdog is disarmed", async () => {
    const found = fresh();
    const daemon = inProcess(found, "cutoff", 9);
    const calls: string[] = [];
    Object.assign(daemon, {
      settleTimeout: 0.2,
      cleanupTimeout: 0.3,
      watchdog: { arm: () => (calls.push("arm"), 0), disarm: () => (calls.push("disarm"), 0) },
      cleanupInner: () => new Promise(() => {}),
    });
    const running = daemon.run();
    await until(() => fs.existsSync(socketFile(found.data, daemon.key)), 5000);
    daemon.beginStop();
    expect(await Promise.race([running, new Promise((resolve) => setTimeout(() => resolve("stuck"), 5000))])).toBe(0);
    expect(calls).toEqual(["arm", "disarm"]);
    expect(fs.existsSync(socketFile(found.data, daemon.key))).toBe(false);
  });

  test("stopping arms the native watchdog once, on the bound socket, for settle plus cleanup, and a hung stop never disarms it", async () => {
    const found = fresh();
    const daemon = inProcess(found, "watchdog", 9);
    const armed: unknown[][] = [];
    let disarmed = 0;
    Object.assign(daemon, {
      settleTimeout: 0.2,
      cleanupTimeout: 0.3,
      watchdog: { arm: (...args: unknown[]) => (armed.push(args), 0), disarm: () => ((disarmed += 1), 0) },
      cleanup: () => new Promise(() => {}),
    });
    void daemon.run();
    await until(() => fs.existsSync(socketFile(found.data, daemon.key)), 5000);
    const bound = fs.lstatSync(socketFile(found.data, daemon.key), { bigint: true });
    daemon.beginStop();
    daemon.beginStop();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(armed).toEqual([[daemon.dirFd, `${daemon.key}.sock`, bound.dev, bound.ino, 500, 1]]);
    expect(disarmed).toBe(0);
  });
});

describe("attach", () => {
  test("a cancelled attach publishes no session and leaves the page to be enabled", async () => {
    const state = new StubState({ session: "s", key: "k", browseFd: null, noAutoDialog: false, pinTab: false }, () => Promise.reject(new Error("unused")));
    const sent: string[] = [];
    const browser = {
      send(method: string) {
        sent.push(method);
        if (method === "Target.attachToTarget") return Promise.resolve({ sessionId: "SESSION" });
        if (method === "Page.enable") return Promise.reject(new Cancelled());
        return Promise.resolve({});
      },
    };
    const page = new StubPage(state, "TARGET");
    const failure = await page.attach(browser as never).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Cancelled);
    expect(page.sessionId).toBeNull();
    expect(page.needsEnable).toBe(true);
    expect(state.sessions.has("SESSION")).toBe(false);
    expect(sent).toContain("Target.detachFromTarget");
  });
});

describe("tokens and the spawn", () => {
  test("the daemon's environment carries no endpoint variable; the client's choice moves into the config", async () => {
    const found = fresh();
    const dir = browseDir(found.data);
    const saved = { ...process.env };
    Object.assign(process.env, {
      ARDIA_WS: "ws://127.0.0.1:1/devtools/browser/x?token=SECRET-WS-TOKEN-1",
      ARDIA_CDP_URL: "ws://127.0.0.1:2/devtools/browser/y?token=SECRET-CDP-TOKEN-2",
      AGENT_BROWSER_CDP: "ws://127.0.0.1:3/devtools/browser/z?token=SECRET-AB-TOKEN-3",
      ARDIA_PORT: "4444",
    });
    try {
      const probe = "import os, sys, json\nprint(json.dumps({'env': sorted(k for k in os.environ if k in ('ARDIA_WS', 'ARDIA_CDP_URL', 'AGENT_BROWSER_CDP', 'ARDIA_PORT')), 'config': json.loads(sys.stdin.read())}))";
      const blank = config(found.data, "envs");
      blank.set("ws", null);
      blank.set("port", null);
      const spawned = spawnDaemon(dir, keyOf("envs"), blank, { kind: "python", python: PYTHON, code: probe });
      await exitOf(spawned.child);
      const seen = JSON.parse(fs.readFileSync(path.join(found.browse, `${keyOf("envs")}.log`), "utf8"));
      expect(seen.env).toEqual([]);
      expect(seen.config.ws).toBe("ws://127.0.0.1:1/devtools/browser/x?token=SECRET-WS-TOKEN-1");
      expect(seen.config.port).toBeNull();
    } finally {
      for (const name of ["ARDIA_WS", "ARDIA_CDP_URL", "AGENT_BROWSER_CDP", "ARDIA_PORT"]) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
      closeFd(dir);
    }
  });

  test("the daemon cleans the endpoint label it writes, whatever the client sent", async () => {
    const found = fresh();
    const { key, pid } = await start(found.data, "label", tsChoice(), { endpoint_label: "user:pw@127.0.0.1:9/devtools/browser/x?token=abcdefabcdefabcdef#frag" });
    pids.push(pid);
    const meta = await sessionMeta(found.data, key);
    expect(meta.endpoint).toBe("127.0.0.1:9/devtools/browser/x");
    await ask(found.data, key, ["close"]);
  });
});

describe("render", () => {
  test("capping a 100 MB answer doesn't build a per-character array", () => {
    const found = fresh();
    const tmp = path.join(found.root, "tmp");
    fs.mkdirSync(tmp);
    const script = `const { cap } = await import(${JSON.stringify(path.join(TS_DIR, "src", "browse", "daemon", "render.ts"))});
const text = "abcdefghi\\n".repeat(10_000_000);
const before = process.memoryUsage().rss;
const started = performance.now();
const out = cap(text, {}, "get");
console.log(JSON.stringify({ grew: process.memoryUsage().rss - before, ms: performance.now() - started, length: out.length }));`;
    const ran = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, TMPDIR: tmp }, encoding: "utf8", timeout: 60_000, maxBuffer: 1 << 20 });
    expect(ran.status).toBe(0);
    const result = JSON.parse(ran.stdout.trim());
    expect(result.length).toBeLessThan(13_000);
    expect(result.grew).toBeLessThan(400 * 1024 * 1024);
  });
});

describe("requests", () => {
  test("a request line is limited to exactly 16 MiB, its newline included", async () => {
    const found = fresh();
    const { key, pid } = await start(found.data, "limit");
    pids.push(pid);
    const line = (total: number) => {
      const head = '{"argv": ["session"], "options": {}, "pad": "';
      const tail = '"}\n';
      return head + "a".repeat(total - head.length - tail.length) + tail;
    };
    const fits = await raw(socketFile(found.data, key), line(16 * 1024 * 1024));
    expect(JSON.parse(fits.text)["out"]).toBe("limit\n");
    const over = await raw(socketFile(found.data, key), line(16 * 1024 * 1024 + 1));
    expect(over).toEqual({ text: "", closed: true });
    await ask(found.data, key, ["close"]);
  });
});

describe("the addon's statAt", () => {
  test("refuses the current-directory descriptor, negative descriptors and extra arguments, and gives exact ids", () => {
    const module = { exports: {} as Record<string, (...args: unknown[]) => unknown> };
    process.dlopen(module, BUILT_LIBC);
    const statAt = module.exports["statAt"] as (...args: unknown[]) => unknown;
    const found = fresh();
    fs.writeFileSync(path.join(found.root, "file"), "x");
    const dir = fs.openSync(found.root, "r");
    try {
      expect(statAt(-2, "file")).toBeLessThan(0);
      expect(statAt(-1, "file")).toBeLessThan(0);
      expect(statAt(dir, "file", 1)).toBeLessThan(0);
      const info = statAt(dir, "file") as unknown[];
      expect(typeof info[2]).toBe("bigint");
      expect(typeof info[3]).toBe("bigint");
      expect(info[3]).toBe(fs.statSync(path.join(found.root, "file"), { bigint: true }).ino);
    } finally {
      fs.closeSync(dir);
    }
    const held = browseDir(fresh().data);
    try {
      expect(socketIsOurs("missing.sock", held)).toBeNull();
    } finally {
      closeFd(held);
    }
  });
});

describe.skipIf(!CHROME)("caller attribution against headless Chrome for Testing", () => {
  test("the caller is announced to Ardia on connect and again when it changes", async () => {
    const found = fresh();
    const child = spawn(
      CHROME as string,
      ["--headless", "--no-first-run", "--no-default-browser-check", `--remote-debugging-port=${CHROME_PORT}`, `--user-data-dir=${path.join(found.root, "profile")}`, "about:blank"],
      { stdio: "ignore", detached: true },
    );
    browsers.push(child);
    let version: Record<string, string> | null = null;
    const deadline = performance.now() + 30_000;
    while (version === null && performance.now() < deadline) {
      version = await fetch(`http://127.0.0.1:${CHROME_PORT}/json/version`)
        .then((response) => response.json() as Promise<Record<string, string>>)
        .catch(() => null);
      if (version === null) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const browserPath = new URL((version as Record<string, string>)["webSocketDebuggerUrl"] as string).pathname;
    fs.mkdirSync(path.join(found.data, "Chromium"), { mode: 0o700 });
    const controlFile = path.join(found.data, "Chromium", "ArdiaControl.json");
    fs.writeFileSync(controlFile, JSON.stringify({ port: CHROME_PORT, browser: browserPath, token: "t0k3n-t0k3n-t0k3n-t0k3n", pid: process.pid, generation: 1 }), { mode: 0o600 });
    const heard: unknown[] = [];
    const control = net.createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
          const message = JSON.parse(buffer.slice(0, at));
          buffer = buffer.slice(at + 1);
          heard.push(message);
          const result = message.method === "hello" ? { app: "Ardia", protocol: 4 } : { ok: true };
          socket.write(`${JSON.stringify({ id: message.id, result })}\n`);
        }
      });
      socket.on("error", () => {});
    });
    servers.push(control);
    const previousUmask = process.umask(0o177);
    await new Promise<void>((resolve) => control.listen(path.join(found.data, "ArdiaControl.sock"), () => resolve()));
    process.umask(previousUmask);
    const token = config(found.data, "caller");
    token.set("port", null);
    token.set("endpoint_label", "Ardia");
    const daemon = new Daemon(parseConfig(dumps(token, "spaced")));
    const running = daemon.run();
    await until(() => fs.existsSync(socketFile(found.data, daemon.key)), 5000);
    const page = "data:text/html,<title>Caller</title>";
    await ask(found.data, daemon.key, ["open", page], { no_changes: true }, { caller: { name: "first-agent" } });
    await ask(found.data, daemon.key, ["get", "title"], {}, { caller: { name: "second-agent" } });
    await ask(found.data, daemon.key, ["get", "title"], {}, { caller: { name: "second-agent" } });
    await ask(found.data, daemon.key, ["close"], {}, { caller: { name: "second-agent" } });
    await running;
    const said = heard.map((message) => {
      const fields = message as { method: string; params?: { caller?: { name: string } } };
      return fields.method === "hello" ? `hello:${fields.params?.caller?.name}` : fields.method;
    });
    expect(said).toEqual(["hello:first-agent", "caller", "hello:second-agent", "caller"]);
  });
});

