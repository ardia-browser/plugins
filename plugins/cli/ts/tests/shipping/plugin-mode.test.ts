import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync, type StdioOptions } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { BUILT_LIBC } from "../libc-loaded.ts";
import { flock, nonBlocking } from "../../src/libc.ts";
import { systemPipe } from "../system-libc.ts";

const PROGRAM = process.env["ARDIA_TS_CLI"] ?? path.resolve(import.meta.dir, "..", "..", "dist", "ardia-ts");
const BUILT = fs.existsSync(PROGRAM) && fs.existsSync(BUILT_LIBC);
const REQUIRED = (process.env["ARDIA_TEST_REQUIRES"] ?? "").split(",").includes("ts");
const CREDENTIAL = `p.${"Ab3_-9xYz0".repeat(4)}Q7w`;
const BROWSER = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const CREDENTIAL_FD = 4;
const READY_FD = 5;
const LONG_DATA_DIR = 94;
const MAX_REQUEST = 16 * 1024 * 1024;
const TEST_BUILD = "plugin-mode-test";
const OVERSIZED = "✗ the ardia browse daemon closed the connection before taking the command (see the session log)\n";
const INSTALL_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

if (REQUIRED && !BUILT) throw new Error(`ARDIA_TEST_REQUIRES=ts, and ${PROGRAM} or ${BUILT_LIBC} isn't built`);

type Ran = { status: number | null; signal: NodeJS.Signals | null; stdout: Buffer; stderr: Buffer };

function finished(child: ChildProcess, timeoutMs: number): Promise<Ran> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`ardia didn't finish in ${timeoutMs} ms`));
    }, timeoutMs);
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

function stampedSessionKey(keySource: string, session: string): string {
  return createHash("sha256").update(`\0${keySource}\0${session}\0build:${TEST_BUILD}`, "utf8").digest("hex").slice(0, 24);
}

function lockHolders(files: string[]): number[] {
  if (files.length === 0) return [];
  const listed = spawnSync("lsof", ["-t", ...files], { encoding: "utf8", timeout: 20_000 });
  const pids = (listed.stdout ?? "")
    .split(/\s+/)
    .filter((word) => word !== "")
    .map(Number);
  return [...new Set(pids)].filter((pid) => pid !== process.pid).sort((a, b) => a - b);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    out.push(full);
    if (fs.lstatSync(full).isDirectory()) walk(full, out);
  }
  return out;
}

function tcpServer(onConnection: (socket: net.Socket) => void): Promise<{ port: number; close(): void }> {
  const server = net.createServer(onConnection);
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.close() })),
  );
}

class RelativeDaemon {
  readonly requests: Record<string, unknown>[] = [];
  private lock: number | null;
  private readonly server: net.Server;

  private constructor(lock: number, server: net.Server) {
    this.lock = lock;
    this.server = server;
  }

  static async start(browse: string, key: string, reply: Record<string, unknown>, requestWaitMs?: number): Promise<RelativeDaemon> {
    fs.mkdirSync(browse, { recursive: true, mode: 0o700 });
    const lock = fs.openSync(path.join(browse, `${key}.lock`), fs.constants.O_RDWR | fs.constants.O_CREAT, 0o600);
    if (!flock(lock, true, false)) throw new Error("the fake daemon's lock is held");
    const daemon = new RelativeDaemon(lock, net.createServer());
    daemon.server.on("connection", (socket) => {
      if (requestWaitMs !== undefined) socket.setTimeout(requestWaitMs, () => socket.destroy());
      let buffered = "";
      socket.on("data", (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        const end = buffered.indexOf("\n");
        if (end < 0) return;
        daemon.requests.push(JSON.parse(buffered.slice(0, end)) as Record<string, unknown>);
        socket.end(`${JSON.stringify(reply)}\n`);
      });
      socket.on("error", () => {});
    });
    const here = process.cwd();
    process.chdir(browse);
    try {
      await new Promise<void>((resolve) => daemon.server.listen(`${key}.sock`, () => resolve()));
    } finally {
      process.chdir(here);
    }
    fs.chmodSync(path.join(browse, `${key}.sock`), 0o600);
    return daemon;
  }

  close(): void {
    if (this.lock === null) return;
    this.server.close();
    fs.closeSync(this.lock);
    this.lock = null;
  }
}

describe.skipIf(!BUILT)("ardia browse for a plugin", () => {
  let root = "";
  let box = "";
  let dataDir = "";
  const cleanups: (() => void)[] = [];

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync("/tmp/arin"));
    fs.mkdirSync(path.join(root, "bin"));
    fs.copyFileSync(PROGRAM, path.join(root, "bin", "ardia"));
    fs.chmodSync(path.join(root, "bin", "ardia"), 0o755);
    fs.copyFileSync(BUILT_LIBC, path.join(root, "bin", "ardia-libc.so"));
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  beforeEach(() => {
    box = fs.realpathSync(fs.mkdtempSync("/tmp/arpl"));
    for (const name of ["home", "data", "cli-home", "tmp"]) fs.mkdirSync(path.join(box, name));
    fs.chmodSync(path.join(box, "data"), 0o700);
    fs.writeFileSync(path.join(box, "data", "ArdiaControl.json"), JSON.stringify({ port: 9, token: "decoy-token-never-read" }));
    dataDir = path.join(box, "data");
  });

  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    for (const pid of daemonPids()) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    fs.rmSync(box, { recursive: true, force: true });
  });

  function daemonPids(): number[] {
    if (!fs.existsSync(path.join(box, "data"))) return [];
    return lockHolders(walk(path.join(box, "data")).filter((file) => file.endsWith(".lock")));
  }

  function useLongDataDir(): string {
    const data = path.join(box, "data");
    const padding = LONG_DATA_DIR - data.length - 1;
    expect(padding).toBeGreaterThan(0);
    dataDir = path.join(data, "d".repeat(padding));
    fs.mkdirSync(dataDir, { mode: 0o700 });
    expect(Buffer.byteLength(dataDir)).toBe(LONG_DATA_DIR);
    expect(Buffer.byteLength(path.join(dataDir, "Browse", `${"0".repeat(24)}.sock`))).toBeGreaterThan(103);
    return dataDir;
  }

  function pluginEnv(port: number): Record<string, string> {
    return {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: path.join(box, "home"),
      TMPDIR: path.join(box, "tmp"),
      LANG: "en_US.UTF-8",
      ARDIA_DATA_DIR: dataDir,
      ARDIA_CLI_HOME: path.join(box, "cli-home"),
      ARDIA_TELEMETRY: "0",
      NO_COLOR: "1",
      ARDIA_BROWSE_FOR_PLUGIN: "1",
      ARDIA_PLUGIN_CREDENTIAL_FD: String(CREDENTIAL_FD),
      ARDIA_PLUGIN_ENDPOINT: `ws://127.0.0.1:${port}/devtools/browser/${BROWSER}`,
    };
  }

  function plainEnv(): Record<string, string> {
    const env = Object.fromEntries(Object.entries(pluginEnv(9)).filter(([name]) => !name.startsWith("ARDIA_BROWSE") && !name.startsWith("ARDIA_PLUGIN")));
    return { ...env, ARDIA_BROWSE_BUILD: TEST_BUILD };
  }

  function start(argv: string[], env: Record<string, string>, stdio: StdioOptions = ["ignore", "pipe", "pipe"], program = path.join(root, "bin", "ardia")): ChildProcess {
    return spawn(program, argv, { env, cwd: path.join(box, "tmp"), stdio, detached: true });
  }

  function credentialPipe(text: string | null): { reader: number; writer: number | null } {
    const { read, write } = systemPipe();
    if (text === null) return { reader: read, writer: write };
    fs.writeSync(write, text);
    fs.closeSync(write);
    return { reader: read, writer: null };
  }

  function withCredential(reader: number): StdioOptions {
    return ["ignore", "pipe", "pipe", "ignore", reader];
  }

  async function liveDaemon(requestWaitMs?: number): Promise<RelativeDaemon> {
    const key = stampedSessionKey(`token:${dataDir}`, "default");
    const daemon = await RelativeDaemon.start(path.join(dataDir, "Browse"), key, { exit: 0, out: "2\n", err: "" }, requestWaitMs);
    cleanups.push(() => daemon.close());
    return daemon;
  }

  async function waitUntilReading(ready: number): Promise<void> {
    nonBlocking(ready);
    const deadline = performance.now() + 30_000;
    const byte = Buffer.alloc(1);
    try {
      while (performance.now() < deadline) {
        try {
          if (fs.readSync(ready, byte, 0, 1, null) === 1) {
            expect(byte.toString()).toBe("r");
            return;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
        }
        await Bun.sleep(20);
      }
      throw new Error("the client never said it had started reading stdin");
    } finally {
      fs.closeSync(ready);
    }
  }

  function tree(): Map<string, string> {
    const found = new Map<string, string>();
    for (const file of walk(box).sort()) {
      if (file === path.join(box, "tmp") || file.startsWith(`${path.join(box, "tmp")}/`)) continue;
      const info = fs.lstatSync(file, { bigint: true });
      found.set(path.relative(box, file), `${info.mode} ${info.size} ${info.mtimeNs}`);
    }
    return found;
  }

  test("plugin mode runs only browse", async () => {
    for (const words of [["tabs"], ["--session", "x", "browse", "get", "title"], ["--timeout", "5", "browse", "get", "title"], ["--version"]]) {
      const done = await finished(start(words, pluginEnv(9)), 60_000);
      expect(done.status, `${words.join(" ")}: ${done.stderr}`).toBe(77);
      expect(done.stderr.toString().startsWith("✗ ardia browse for a plugin")).toBe(true);
    }
  }, 120_000);

  test("a plugin step reads its credential and starts nothing", async () => {
    let asked = false;
    const tokens = await tcpServer(() => {
      asked = true;
    });
    cleanups.push(() => tokens.close());
    const { reader } = credentialPipe(CREDENTIAL);
    const child = start(["browse", "--session", "plugin-ai", "--json", "get", "--", "title"], pluginEnv(tokens.port), withCredential(reader));
    fs.closeSync(reader);
    const done = await finished(child, 60_000);
    expect([done.status, done.stderr.toString()]).toEqual([77, ""]);
    const answer = JSON.parse(done.stdout.toString()) as Record<string, unknown>;
    expect([answer["success"], answer["code"]]).toEqual([false, "plugin_daemon_unavailable"]);
    expect(done.stdout.toString()).not.toContain(CREDENTIAL.slice(2));
    await Bun.sleep(1000);
    expect(asked).toBe(false);
    const browse = path.join(dataDir, "Browse");
    expect(fs.existsSync(browse) ? fs.readdirSync(browse) : []).toEqual([]);
    expect(daemonPids()).toEqual([]);
  }, 120_000);

  test("Ctrl-C ends the credential read", async () => {
    useLongDataDir();
    const neverEnds = async (json: boolean) => {
      const { reader, writer } = credentialPipe(null);
      cleanups.push(() => fs.closeSync(writer as number));
      const argv = ["browse", "--session", "plugin-ai", ...(json ? ["--json"] : []), "get", "--", "title"];
      const child = start(argv, pluginEnv(9), withCredential(reader));
      fs.closeSync(reader);
      const ran = finished(child, 30_000);
      await Bun.sleep(700);
      const started = performance.now();
      process.kill(-(child.pid as number), "SIGINT");
      const done = await ran;
      return { done, waited: performance.now() - started };
    };
    const plain = await neverEnds(false);
    expect([plain.done.status, plain.done.stdout.toString(), plain.done.stderr.toString()]).toEqual([130, "", "✗ interrupted\n"]);
    expect(plain.waited).toBeLessThan(1200);
    const json = await neverEnds(true);
    expect([json.done.status, json.done.stderr.toString()]).toEqual([130, ""]);
    expect((JSON.parse(json.done.stdout.toString()) as Record<string, unknown>)["code"]).toBe("interrupted");
  }, 120_000);

  test("a missing addon is one JSON line under --json, and names the addon either way", async () => {
    const bare = path.join(box, "no-addon");
    fs.mkdirSync(path.join(bare, "bin"), { recursive: true });
    fs.copyFileSync(path.join(root, "bin", "ardia"), path.join(bare, "bin", "ardia"));
    fs.chmodSync(path.join(bare, "bin", "ardia"), 0o755);
    useLongDataDir();
    for (const json of [true, false]) {
      const argv = ["browse", "--session", "plugin-ai", ...(json ? ["--json"] : []), "get", "--", "title"];
      const done = await finished(start(argv, pluginEnv(9), ["ignore", "pipe", "pipe"], path.join(bare, "bin", "ardia")), 60_000);
      expect(done.status, done.stderr.toString()).toBe(252);
      if (json) {
        expect(done.stderr.toString()).toBe("");
        const answer = JSON.parse(done.stdout.toString()) as Record<string, string>;
        expect([answer["success"], answer["code"]]).toEqual([false as unknown as string, "internal_error"]);
        expect(answer["error"]).toContain("ardia-libc.so");
        expect(done.stdout.toString().split("\n").length - 1).toBe(1);
      } else {
        expect(done.stdout.toString()).toBe("");
        expect(done.stderr.toString()).toContain("ardia-libc.so");
      }
    }
  }, 120_000);

  describe("telemetry", () => {
    async function runWithSharing(telemetry: string | null) {
      fs.writeFileSync(path.join(dataDir, "telemetry.json"), JSON.stringify({ sharing: true, installId: INSTALL_ID }));
      fs.mkdirSync(path.join(dataDir, "Telemetry"), { mode: 0o700, recursive: true });
      let heard = false;
      const listener = await tcpServer((socket) => {
        heard = true;
        socket.destroy();
      });
      cleanups.push(() => listener.close());
      const env: Record<string, string> = Object.fromEntries(Object.entries(pluginEnv(9)).filter(([name]) => name !== "ARDIA_TELEMETRY"));
      if (telemetry !== null) env["ARDIA_TELEMETRY"] = telemetry;
      env["ARDIA_TELEMETRY_URL"] = `http://127.0.0.1:${listener.port}/v1/logs`;
      const { reader } = credentialPipe(CREDENTIAL);
      const before = tree();
      const child = start(["browse", "--session", "plugin-ai", "--json", "get", "--", "title"], env, withCredential(reader));
      fs.closeSync(reader);
      const done = await finished(child, 60_000);
      await Bun.sleep(3000);
      const spool = path.join(dataDir, "Telemetry", "cli-queue.jsonl");
      const events = fs.existsSync(spool) ? fs.readFileSync(spool, "utf8").split("\n").filter(Boolean) : [];
      return { done, heard, events, flushed: fs.existsSync(path.join(dataDir, "Telemetry", "cli-flush.json")), before };
    }

    test("with sharing on, a plugin call records no telemetry or usage", async () => {
      const run = await runWithSharing(null);
      expect(run.done.status, run.done.stderr.toString()).toBe(77);
      expect([run.heard, run.events, run.flushed]).toEqual([false, [], false]);
      expect(tree()).toEqual(run.before);
    }, 120_000);

    test("with telemetry off, a plugin call records nothing", async () => {
      const run = await runWithSharing("0");
      expect(run.done.status, run.done.stderr.toString()).toBe(77);
      expect([run.heard, run.events, run.flushed]).toEqual([false, [], false]);
    }, 120_000);

    test("a refused leading data dir writes nothing anywhere", async () => {
      const elsewhere = path.join(box, "elsewhere");
      fs.mkdirSync(path.join(elsewhere, "Telemetry"), { recursive: true, mode: 0o700 });
      fs.chmodSync(elsewhere, 0o700);
      fs.writeFileSync(path.join(elsewhere, "telemetry.json"), JSON.stringify({ sharing: true, installId: INSTALL_ID }));
      let heard = false;
      const listener = await tcpServer((socket) => {
        heard = true;
        socket.destroy();
      });
      cleanups.push(() => listener.close());
      const env: Record<string, string> = Object.fromEntries(Object.entries(pluginEnv(9)).filter(([name]) => name !== "ARDIA_TELEMETRY"));
      env["ARDIA_TELEMETRY_URL"] = `http://127.0.0.1:${listener.port}/v1/logs`;
      const before = tree();
      const done = await finished(start(["--data-dir", elsewhere, "browse", "--session", "plugin-ai", "--json", "get", "title"], env), 60_000);
      expect(done.status, done.stderr.toString()).toBe(77);
      expect((JSON.parse(done.stdout.toString()) as Record<string, unknown>)["code"]).toBe("plugin_refused");
      await Bun.sleep(2000);
      expect(heard).toBe(false);
      expect(tree()).toEqual(before);
    }, 120_000);

    test("an account-relative data dir under --json is one JSON refusal", async () => {
      const before = tree();
      const done = await finished(start(["--data-dir", "~nobody/x", "browse", "--session", "plugin-ai", "--json", "get", "title"], pluginEnv(9)), 60_000);
      expect([done.status, done.stderr.toString()]).toEqual([77, ""]);
      expect(done.stdout.toString().split("\n").length - 1).toBe(1);
      expect((JSON.parse(done.stdout.toString()) as Record<string, unknown>)["code"]).toBe("plugin_refused");
      expect(tree()).toEqual(before);
    }, 120_000);
  });

  describe.skipIf(process.platform !== "darwin")("a running daemon under a long data dir", () => {
    test("normal browse reaches it", async () => {
      useLongDataDir();
      const key = stampedSessionKey(`token:${dataDir}`, "default");
      const daemon = await RelativeDaemon.start(path.join(dataDir, "Browse"), key, { exit: 0, out: "Long dirs work\n", err: "" });
      cleanups.push(() => daemon.close());
      const done = await finished(start(["browse", "get", "title"], plainEnv()), 60_000);
      expect([done.status, done.stdout.toString(), done.stderr.toString()]).toEqual([0, "Long dirs work\n", ""]);
      expect(daemon.requests.length).toBe(1);
    }, 120_000);

    test("a slow stdin writer is read to the end before the daemon is asked", async () => {
      useLongDataDir();
      const daemon = await liveDaemon(1500);
      const child = start(["browse", "eval", "--stdin"], plainEnv(), ["pipe", "pipe", "pipe"]);
      const ran = finished(child, 60_000);
      await Bun.sleep(3000);
      child.stdin?.end("1+1");
      const done = await ran;
      expect([done.status, done.stdout.toString(), done.stderr.toString()]).toEqual([0, "2\n", ""]);
      expect(daemon.requests.map((request) => request["stdin"])).toEqual(["1+1"]);
    }, 120_000);

    async function oversized(size: number, closeAfter: boolean) {
      const daemon = await liveDaemon();
      const { read, write } = systemPipe();
      const child = start(["browse", "eval", "--stdin"], plainEnv(), [read, "pipe", "pipe"]);
      fs.closeSync(read);
      const ran = finished(child, 60_000);
      fs.write(write, Buffer.alloc(size, 0x31), () => {
        if (closeAfter) fs.close(write, () => {});
      });
      if (!closeAfter) cleanups.push(() => fs.close(write, () => {}));
      const done = await ran;
      return { done, requests: daemon.requests };
    }

    test("stdin over the daemon's request limit stops the read and sends nothing", async () => {
      useLongDataDir();
      const { done, requests } = await oversized(MAX_REQUEST + 1, false);
      expect([done.status, done.stdout.toString(), requests]).toEqual([2, "", []]);
      expect(done.stderr.toString()).toBe(OVERSIZED);
    }, 120_000);

    test("a request the envelope pushes over the limit is refused before connecting", async () => {
      useLongDataDir();
      const { done, requests } = await oversized(MAX_REQUEST - 64, true);
      expect([done.status, done.stdout.toString(), requests]).toEqual([2, "", []]);
      expect(done.stderr.toString()).toBe(OVERSIZED);
    }, 120_000);

    test("a daemon gone while stdin was read is started again and takes that input", async () => {
      useLongDataDir();
      const daemon = await liveDaemon();
      const input = systemPipe();
      const signal = systemPipe();
      const env = { ...plainEnv(), ARDIA_TEST_STDIN_READY_FD: String(READY_FD) };
      const child = start(["browse", "eval", "--stdin"], env, [input.read, "pipe", "pipe", "ignore", "ignore", signal.write]);
      fs.closeSync(input.read);
      fs.closeSync(signal.write);
      const ran = finished(child, 60_000);
      await waitUntilReading(signal.read);
      daemon.close();
      for (const name of fs.readdirSync(path.join(dataDir, "Browse"))) {
        if (name.endsWith(".sock")) fs.unlinkSync(path.join(dataDir, "Browse", name));
      }
      fs.writeSync(input.write, "1+1");
      fs.closeSync(input.write);
      const done = await ran;
      const started = daemonPids();
      expect(daemon.requests).toEqual([]);
      expect(started.length).toBeGreaterThan(0);
      expect([done.status, done.stdout.toString(), done.stderr.toString()]).toEqual([2, "", "✗ Ardia isn't running, or Command Line isn't installed (Settings › Plugins).\n"]);
    }, 120_000);

    test("Ctrl-C while stdin is read answers one JSON line", async () => {
      useLongDataDir();
      await liveDaemon();
      const input = systemPipe();
      cleanups.push(() => fs.closeSync(input.write));
      const signal = systemPipe();
      const env = { ...plainEnv(), ARDIA_TEST_STDIN_READY_FD: String(READY_FD) };
      const child = start(["browse", "--json", "eval", "--stdin"], env, [input.read, "pipe", "pipe", "ignore", "ignore", signal.write]);
      fs.closeSync(input.read);
      fs.closeSync(signal.write);
      const ran = finished(child, 30_000);
      await waitUntilReading(signal.read);
      process.kill(-(child.pid as number), "SIGINT");
      const done = await ran;
      expect(done.status, done.stderr.toString()).toBe(130);
      expect(JSON.parse(done.stdout.toString())).toEqual({ success: false, data: null, error: "interrupted", code: "interrupted" });
      expect(done.stdout.toString().split("\n").length - 1).toBe(1);
      expect(done.stderr.toString()).toBe("");
    }, 120_000);
  });
});
