import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import "./libc-loaded.ts";
import { type JsonObject, object, type Value } from "../src/json.ts";
import { cleanEvent } from "../src/telemetry-schema.ts";
import { readConsent } from "../src/telemetry.ts";
import { run, RunCancelled } from "../src/proc/group.ts";
import { Connection } from "../src/connection.ts";
import { cliVersion } from "../src/version.ts";

const TS = path.resolve(import.meta.dir, "..");
const SOURCE = path.join(TS, "src");
const PROGRAM = process.env.ARDIA_TS_CLI ?? path.join(TS, "dist", "ardia-ts");
const CALLER = Buffer.from(JSON.stringify({ name: "test" })).toString("hex");
const INSTALL = "0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0";

const scratch = fs.realpathSync(fs.mkdtempSync(path.join("/tmp", "codex-r3-")));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
let counter = 0;

function folder(): string {
  counter += 1;
  const dir = path.join(scratch, `c${counter}`);
  fs.mkdirSync(dir);
  return dir;
}

function consentRoot(body: string | Buffer): string {
  const root = folder();
  fs.writeFileSync(path.join(root, "telemetry.json"), body, { mode: 0o600 });
  return root;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (check()) return true;
    await Bun.sleep(20);
  }
  return check();
}

describe("strict consent", () => {
  test("a duplicate key gives no consent, so a later sharing: true can't override false", () => {
    expect(readConsent(consentRoot(`{"sharing": false, "installId": "${INSTALL}", "sharing": true}`))).toBeUndefined();
  });

  test("a byte order mark gives no consent", () => {
    const body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`{"sharing": true, "installId": "${INSTALL}"}`)]);
    expect(readConsent(consentRoot(body))).toBeUndefined();
  });

  test("a consent file nested too deeply gives no consent and never throws", () => {
    const deep = `{"sharing": true, "installId": "${INSTALL}", "x": ${"[".repeat(12000)}${"]".repeat(12000)}}`;
    expect(() => readConsent(consentRoot(deep))).not.toThrow();
    expect(readConsent(consentRoot(deep))).toBeUndefined();
  });

  test("a plain consent file is still read", () => {
    expect(readConsent(consentRoot(`{"sharing": true, "installId": "${INSTALL}"}`))?.get("installId")).toBe(INSTALL);
  });
});

type Captured = { status: number | null; out: string; err: string; body: JsonObject | undefined };

async function feedbackWith(consent: string): Promise<Captured> {
  const home = folder();
  fs.mkdirSync(path.join(home, "data"));
  fs.writeFileSync(path.join(home, "data", "telemetry.json"), consent, { mode: 0o600 });
  let received = "";
  const server = net.createServer((socket) => {
    let seen = "";
    socket.on("data", (chunk) => {
      seen += chunk.toString("utf8");
      const split = seen.indexOf("\r\n\r\n");
      if (split < 0) return;
      const length = Number(/content-length: *(\d+)/i.exec(seen.slice(0, split))?.[1] ?? "0");
      if (Buffer.byteLength(seen.slice(split + 4)) < length) return;
      if (seen.startsWith("POST /api/feedback ")) received = seen.slice(split + 4);
      const answer = JSON.stringify({ id: "FB-AB12", upload_token: "tok_0123456789abcdef0123456789abcdef" });
      socket.end(`HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: ${answer.length}\r\n\r\n${answer}`);
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  try {
    const script = `exec "$0" --ardia-routed=2:0:3:${CALLER} feedback --title "click did nothing" "the button stayed the same" 3< <(sleep 30)`;
    const child = spawn("/bin/bash", ["-c", script, PROGRAM], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", HOME: home, ARDIA_CLI_HOME: path.join(home, "cli"), ARDIA_DATA_DIR: path.join(home, "data"), ARDIA_FEEDBACK_URL: `http://127.0.0.1:${port}` },
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk) => (out += chunk));
    child.stderr?.on("data", (chunk) => (err += chunk));
    const status = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    let body: JsonObject | undefined;
    if (received !== "") body = new Map(Object.entries(JSON.parse(received))) as JsonObject;
    return { status, out, err, body };
  } finally {
    server.close();
  }
}

describe("feedback and the consent file", () => {
  test("explicit feedback with a consent file nested too deeply still sends, as if there were no consent", async () => {
    const deep = `{"sharing": true, "installId": "${INSTALL}", "x": ${"[".repeat(12000)}${"]".repeat(12000)}}`;
    const done = await feedbackWith(deep);
    expect(done.status).toBe(0);
    expect(done.body).toBeDefined();
    expect(done.body?.get("install_id")).not.toBe(INSTALL);
  }, 30000);

  test("app version, build and channel from the consent file are sent only in their strict formats", async () => {
    const odd = await feedbackWith(JSON.stringify({ sharing: true, installId: INSTALL, lastVersion: "1.2.3; my secret", lastBuild: "../../etc/passwd", channel: "beta-for-acme" }));
    expect(odd.status).toBe(0);
    expect([odd.body?.get("app_version"), odd.body?.get("app_build"), odd.body?.get("channel")]).toEqual([null, null, null]);
    const good = await feedbackWith(JSON.stringify({ sharing: true, installId: INSTALL, lastVersion: "0.4.1-nightly.7", lastBuild: "1234", channel: "nightly" }));
    expect([good.body?.get("app_version"), good.body?.get("app_build"), good.body?.get("channel")]).toEqual(["0.4.1-nightly.7", "1234", "nightly"]);
    const numeric = await feedbackWith(`{"sharing": true, "installId": "${INSTALL}", "lastVersion": "0.4.1", "lastBuild": 812, "channel": "stable"}`);
    expect([numeric.body?.get("app_version"), numeric.body?.get("app_build"), numeric.body?.get("channel")]).toEqual(["0.4.1", "812", "stable"]);
  }, 60000);
});

describe("telemetry cli_version", () => {
  test("cli_version is the running build's at upload, whatever the spool says", () => {
    const record = object([
      ["event", "cli_command"],
      ["uuid", INSTALL],
      ["timestamp", "2026-11-20T12:00:00Z"],
      ["distinct_id", "local"],
      ["properties", object([["cli_version", "9.9.9"]])],
    ]);
    const properties = (cleanEvent(record) as JsonObject).get("properties") as JsonObject;
    expect(properties.get("cli_version")).toBe(cliVersion());
  });
});

describe("run() and an early abort", () => {
  test("an abort right after run() starts is not lost", async () => {
    for (let round = 0; round < 5; round += 1) {
      const abort = new AbortController();
      const running = run(["/usr/bin/true"], { timeout: 5, signal: abort.signal });
      abort.abort();
      expect(await running.catch((error: unknown) => error)).toBeInstanceOf(RunCancelled);
    }
  });
});

describe("registration needs the addon", () => {
  test("without the addon a helper is killed and the spawn fails", async () => {
    const dir = folder();
    const pidFile = path.join(dir, "pid");
    const script = path.join(dir, "spawn.ts");
    fs.writeFileSync(
      script,
      `const { spawnGroup, HelperUntracked } = await import(${JSON.stringify(path.join(SOURCE, "proc/group.ts"))});\n` +
        `const outcome = await spawnGroup(["/bin/sh", "-c", "echo $$ > ${pidFile}; exec sleep 30"]).then(() => "spawned", (error) => (error instanceof HelperUntracked ? "untracked" : String(error)));\n` +
        `console.log(outcome);\nprocess.exit(0);\n`,
    );
    const done = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 20000 });
    expect(done.stdout.trim()).toBe("untracked");
    if (fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim() !== "") {
      expect(await until(() => !alive(Number(fs.readFileSync(pidFile, "utf8"))), 2000)).toBe(true);
    }
  });
});

describe("the connection's interrupt callback", () => {
  test("stays registered while any request still waits", async () => {
    const where = path.join(folder(), "s.sock");
    const server = net.createServer((peer) => {
      let seen = "";
      peer.on("data", (chunk) => {
        seen += chunk.toString("utf8");
        for (let end = seen.indexOf("\n"); end >= 0; end = seen.indexOf("\n")) {
          const line = JSON.parse(seen.slice(0, end));
          seen = seen.slice(end + 1);
          if (line.method === "quick") setTimeout(() => peer.write(`${JSON.stringify({ id: line.id, ok: true })}\n`), 50);
        }
      });
      peer.on("error", () => {});
    });
    await new Promise<void>((resolve) => server.listen(where, resolve));
    const socket = net.connect(where);
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    const fd = (socket as unknown as { _handle: { fd: number } })._handle.fd;
    let interrupted = false;
    let registered: (() => void) | undefined;
    const connection = new Connection(socket, fd, () => interrupted, (wake) => {
      registered = wake;
    });
    const slow = connection.request("slow", undefined, 10).catch((error: unknown) => error);
    await Bun.sleep(20);
    const quick = await connection.request("quick", undefined, 10);
    expect((quick as Map<string, Value>).get("ok")).toBe(true);
    expect(registered).toBeDefined();
    const started = performance.now();
    interrupted = true;
    registered?.();
    const outcome = (await slow) as Error;
    expect(outcome.message).toBe("interrupted");
    expect(performance.now() - started).toBeLessThan(50);
    connection.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
