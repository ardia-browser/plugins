import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import "./libc-loaded.ts";
import { Float, type JsonObject, object, type Value } from "../src/json.ts";
import { registerGroup, unregisterGroup } from "../src/libc.ts";
import { cleanEvent } from "../src/telemetry-schema.ts";
import { consentedInstall, readConsent } from "../src/telemetry.ts";
import { loadPlist } from "../src/plist.ts";
import { liveGroups, run as runGroup, spawnGroup } from "../src/proc/group.ts";
import { run as runAuth } from "../src/browse/auth/run.ts";
import { closeEncoder, spawnEncoder } from "../src/browse/capture/record.ts";
import { textFromBytes, tools } from "../src/browse/read/pdftext.ts";
import { withSignal } from "../src/browse/cdp/cancel.ts";
import { sessionId } from "../src/browse/local.ts";
import { Decider } from "../src/hooks/decide.ts";
import { hookFrom, type Hook } from "../src/hooks/model.ts";
import { HookRunner } from "../src/hooks/runner.ts";
import { Connection, UNREADABLE_LINE } from "../src/connection.ts";

const scratch = fs.realpathSync(fs.mkdtempSync(path.join("/tmp", "codex-r2-")));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
let counter = 0;

function folder(): string {
  counter += 1;
  const dir = path.join(scratch, `c${counter}`);
  fs.mkdirSync(dir);
  return dir;
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

function readPid(file: string): number {
  return Number(fs.readFileSync(file, "utf8").trim());
}

function value(item: unknown): Value {
  if (Array.isArray(item)) return item.map(value);
  if (item !== null && typeof item === "object") return new Map(Object.entries(item).map(([key, inner]) => [key, value(inner)]));
  if (typeof item === "number") return Number.isInteger(item) ? BigInt(item) : new Float(item);
  return item as Value;
}

function hook(item: Record<string, unknown>): Hook {
  return hookFrom(value(item) as JsonObject);
}

function memoryLog(): { lines: string[]; write: (text: string) => void; close: () => void } {
  const lines: string[] = [];
  return { lines, write: (text) => lines.push(text), close: () => {} };
}

type Sent = [number, string];

async function watchingSignals<T>(work: (sent: Sent[]) => Promise<T>): Promise<T> {
  const sent: Sent[] = [];
  const real = process.kill.bind(process);
  process.kill = ((pid: number, signal?: string | number) => {
    if (signal !== 0 && signal !== undefined) sent.push([pid, String(signal)]);
    return real(pid, signal as never);
  }) as typeof process.kill;
  try {
    return await work(sent);
  } finally {
    process.kill = real;
  }
}

function groupSignals(sent: Sent[], pid: number): string[] {
  return sent.filter(([target]) => target === -pid || target === pid).map(([, signal]) => signal);
}

const TERM_LOGGER = (marker: string, pidFile: string) => `trap 'echo term >> ${marker}' TERM; echo $$ > ${pidFile}; while :; do sleep 0.05; done`;

describe("telemetry codes at upload", () => {
  const record = (properties: [string, Value][]): JsonObject =>
    object([
      ["event", "cli_command"],
      ["uuid", "0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0"],
      ["timestamp", "2026-11-20T12:00:00Z"],
      ["distinct_id", "local"],
      ["properties", object(properties)],
    ]);
  const cleaned = (properties: [string, Value][]) => (cleanEvent(record(properties)) as JsonObject).get("properties") as JsonObject;

  test("an error code outside the CLI's fixed sets is sent as other", () => {
    expect(cleaned([["error_code", "acme_private_board"]]).get("error_code")).toBe("other");
    expect(cleaned([["error_code", "tab_not_found"]]).get("error_code")).toBe("tab_not_found");
    expect(cleaned([["error_code", "stdout_closed"]]).get("error_code")).toBe("stdout_closed");
    expect(cleaned([["error_code", "unknown_command"]]).get("error_code")).toBe("unknown_command");
    expect(cleaned([["error_code", "unhandled_exception"]]).get("error_code")).toBe("unhandled_exception");
    expect(cleaned([["error_code", null]]).get("error_code")).toBe(null);
  });

  test("watch_report keeps only the app's FB- reference format", () => {
    expect(cleaned([["watch_report", "FB-1234"]]).get("watch_report")).toBe("FB-1234");
    for (const odd of ["fb-1234", "FB-1", "FB-12345678901234567", "FB-12 34", "FB-1234\n", "XFB-1234"]) {
      expect(cleaned([["watch_report", odd]]).has("watch_report")).toBe(false);
    }
  });
});

describe("telemetry consent is strict JSON", () => {
  const INSTALL = "0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0";
  const write = (body: string) => {
    const root = folder();
    fs.writeFileSync(path.join(root, "telemetry.json"), body, { mode: 0o600 });
    return root;
  };

  test("a plain consent file is read", () => {
    expect(consentedInstall(write(`{"sharing": true, "installId": "${INSTALL}"}`))).toBe(INSTALL);
  });

  for (const literal of ["NaN", "Infinity", "-Infinity"]) {
    test(`a consent file with an unquoted ${literal} gives no consent`, () => {
      const root = write(`{"sharing": true, "installId": "${INSTALL}", "watchUntil": ${literal}}`);
      expect(readConsent(root)).toBeUndefined();
      expect(consentedInstall(root)).toBeUndefined();
    });
  }
});

function bplist(objects: Buffer[], top: number, refSize: number): Buffer {
  const header = Buffer.from("bplist00", "latin1");
  const offsets: number[] = [];
  let at = header.length;
  for (const item of objects) {
    offsets.push(at);
    at += item.length;
  }
  const tableAt = at;
  const offsetSize = tableAt < 256 ? 1 : tableAt < 65536 ? 2 : 4;
  const table = Buffer.alloc(offsets.length * offsetSize);
  offsets.forEach((offset, index) => table.writeUIntBE(offset, index * offsetSize, offsetSize));
  const trailer = Buffer.alloc(32);
  trailer[6] = offsetSize;
  trailer[7] = refSize;
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(BigInt(top), 16);
  trailer.writeBigUInt64BE(BigInt(tableAt), 24);
  return Buffer.concat([header, ...objects, table, trailer]);
}

function arrayOf(refs: number[], refSize: number): Buffer {
  const body = Buffer.alloc(1 + refs.length * refSize);
  body[0] = 0xa0 | refs.length;
  refs.forEach((ref, index) => body.writeUIntBE(ref, 1 + index * refSize, refSize));
  return body;
}

describe("binary plist bounds", () => {
  const truncated: [string, Buffer][] = [
    ["an 8-byte integer", Buffer.from([0x13, 0x01, 0x02])],
    ["a 4-byte integer", Buffer.from([0x12, 0x01])],
    ["a double", Buffer.from([0x23, 0x01, 0x02])],
    ["a float", Buffer.from([0x22, 0x01])],
    ["a date", Buffer.from([0x33, 0x01, 0x02, 0x03])],
    ["an extended length", Buffer.from([0x5f, 0x13, 0x00, 0x00])],
    ["an extended length marker", Buffer.from([0x5f])],
  ];
  for (const [name, body] of truncated) {
    test(`${name} cut short before the offset table is malformed`, () => {
      const padded = Buffer.concat([body, Buffer.alloc(0)]);
      const data = bplist([padded], 0, 1);
      expect(data.length).toBeGreaterThanOrEqual(40);
      expect(() => loadPlist(data)).toThrow();
    });
  }

  test("a whole 8-byte integer still decodes", () => {
    expect(loadPlist(bplist([Buffer.from([0x13, 0, 0, 0, 0, 0, 0, 0, 7])], 0, 1))).toBe(7n);
  });

  function chains(depthA: number, depthB: number): Buffer {
    const refSize = 2;
    const objects: Buffer[] = [];
    const aStart = 1;
    const bStart = aStart + depthA;
    objects.push(arrayOf([aStart, bStart], refSize));
    for (let index = 0; index < depthA; index += 1) objects.push(index === depthA - 1 ? arrayOf([], refSize) : arrayOf([aStart + index + 1], refSize));
    for (let index = 0; index < depthB; index += 1) objects.push(arrayOf([index === depthB - 1 ? aStart : bStart + index + 1], refSize));
    return bplist(objects, 0, refSize);
  }

  test("a cached subtree reused deep down counts toward the 512-level cap", () => {
    expect(() => loadPlist(chains(300, 300))).toThrow();
  });

  test("shared subtrees inside the cap still decode", () => {
    const top = loadPlist(chains(200, 200)) as unknown[];
    expect(Array.isArray(top)).toBe(true);
    expect(top.length).toBe(2);
  });
});

describe("one stop path for helpers", () => {
  test("pdftext: a cancelled extraction sends TERM first, then one KILL to a helper that ignores it", async () => {
    const dir = folder();
    const marker = path.join(dir, "marker");
    const pidFile = path.join(dir, "pid");
    const fake = path.join(dir, "osascript");
    fs.writeFileSync(fake, `#!/bin/sh\n${TERM_LOGGER(marker, pidFile)}\n`, { mode: 0o755 });
    const saved = tools.osascript;
    tools.osascript = fake;
    try {
      await watchingSignals(async (sent) => {
        const abort = new AbortController();
        const extraction = withSignal(abort.signal, () => textFromBytes(Buffer.from("%PDF-1.4\n")));
        const settled = extraction.catch((error: unknown) => error);
        expect(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim() !== "", 3000)).toBe(true);
        const pid = readPid(pidFile);
        abort.abort();
        await settled;
        expect(await until(() => !alive(pid), 3000)).toBe(true);
        expect(groupSignals(sent, pid)).toEqual(["SIGTERM", "SIGKILL"]);
        expect(fs.readFileSync(marker, "utf8")).toContain("term");
      });
    } finally {
      tools.osascript = saved;
    }
  });

  test("record: a cancelled encoder stop sends TERM, then one KILL to an ffmpeg that ignores it", async () => {
    const dir = folder();
    const marker = path.join(dir, "marker");
    const pidFile = path.join(dir, "pid");
    const fake = path.join(dir, "ffmpeg");
    fs.writeFileSync(fake, `#!/bin/sh\n${TERM_LOGGER(marker, pidFile)}\n`, { mode: 0o755 });
    await watchingSignals(async (sent) => {
      const encoder = await spawnEncoder(fake, path.join(dir, "out.webm"));
      expect(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim() !== "", 3000)).toBe(true);
      const pid = readPid(pidFile);
      const abort = new AbortController();
      const closing = withSignal(abort.signal, () => closeEncoder(encoder)).catch((error: unknown) => error);
      await Bun.sleep(100);
      abort.abort();
      await closing;
      expect(await until(() => !alive(pid), 3000)).toBe(true);
      expect(groupSignals(sent, pid)).toEqual(["SIGTERM", "SIGKILL"]);
      expect(fs.readFileSync(marker, "utf8")).toContain("term");
      expect(liveGroups()).not.toContain(pid);
    });
  });

  test("decide: a timed-out decision program gets TERM, then one KILL", async () => {
    const dir = folder();
    const marker = path.join(dir, "marker");
    const pidFile = path.join(dir, "pid");
    const decider = new Decider(memoryLog());
    const slow = hook({ name: "slow", on: "link.opening", run: ["/bin/sh", "-c", TERM_LOGGER(marker, pidFile)] });
    const accepted = new Map<string, [string, Hook]>([["slow", ["rev", slow]]]);
    const answers: unknown[] = [];
    await watchingSignals(async (sent) => {
      decider.handle(value({ decide: "d1", event: "link.opening", hook: "slow", revision: "rev", deadline: 400, data: { url: "https://a/" } }) as JsonObject, accepted, {
        answer: async (_ident, answer) => {
          answers.push(answer);
          return true;
        },
      });
      expect(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim() !== "", 3000)).toBe(true);
      const pid = readPid(pidFile);
      expect(await until(() => !alive(pid), 4000)).toBe(true);
      await decider.stop();
      expect(groupSignals(sent, pid)).toEqual(["SIGTERM", "SIGKILL"]);
      expect(fs.readFileSync(marker, "utf8")).toContain("term");
      expect(answers).toEqual([]);
    });
  });

  test("hooks: stopping the runner while its timeout is already stopping the hook sends one TERM and one KILL", async () => {
    const dir = folder();
    const pidFile = path.join(dir, "pid");
    const runner = new HookRunner(hook({ name: "stubborn", on: ["tab.opened"], run: ["/bin/sh", "-c", `trap '' TERM; echo $$ > ${pidFile}; while :; do sleep 0.05; done`], timeout: 0.3 }), memoryLog(), true, 100, 1.5);
    await watchingSignals(async (sent) => {
      const once = runner.runOnce(value({ event: "tab.opened" }) as JsonObject);
      expect(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim() !== "", 3000)).toBe(true);
      const pid = readPid(pidFile);
      await until(() => groupSignals(sent, pid).length > 0, 2000);
      await runner.stop(0.3);
      await once;
      expect(await until(() => !alive(pid), 4000)).toBe(true);
      await Bun.sleep(300);
      expect(groupSignals(sent, pid)).toEqual(["SIGTERM", "SIGKILL"]);
      expect(liveGroups()).not.toContain(pid);
    });
  });

  test("run: a timed-out helper that ignores TERM gets exactly one KILL after the grace", async () => {
    const dir = folder();
    const pidFile = path.join(dir, "pid");
    await watchingSignals(async (sent) => {
      const failed = await runGroup(["/bin/sh", "-c", `trap '' TERM; echo $$ > ${pidFile}; while :; do sleep 0.05; done`], { timeout: 0.3, grace: 0.2 }).catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(Error);
      const pid = readPid(pidFile);
      expect(await until(() => !alive(pid), 3000)).toBe(true);
      await Bun.sleep(200);
      expect(groupSignals(sent, pid)).toEqual(["SIGTERM", "SIGKILL"]);
    });
  });
});

describe("the helper registry fails closed", () => {
  function fillTable(): number[] {
    const fakes: number[] = [];
    for (let pid = 900_000; fakes.length < 300; pid += 1) {
      if (registerGroup(pid) !== 0) break;
      fakes.push(pid);
    }
    return fakes;
  }

  test("spawnGroup kills a helper the full table can't hold and fails", async () => {
    const dir = folder();
    const pidFile = path.join(dir, "pid");
    const fakes = fillTable();
    try {
      const outcome = await spawnGroup(["/bin/sh", "-c", `echo $$ > ${pidFile}; exec sleep 30`]).then(
        (child) => child,
        (error: unknown) => error,
      );
      expect(outcome).toBeInstanceOf(Error);
      expect(String((outcome as Error).message)).toContain("helper");
      if (fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim() !== "") expect(await until(() => !alive(readPid(pidFile)), 2000)).toBe(true);
    } finally {
      for (const pid of fakes) unregisterGroup(pid);
    }
    expect(fakes.length).toBe(256);
  });

  test("the browse auth runner fails the same way", async () => {
    const fakes = fillTable();
    try {
      const outcome = await runAuth(["/bin/sh", "-c", "exit 0"], { timeout: 5 }).catch((error: unknown) => error);
      expect(outcome).toBeInstanceOf(Error);
    } finally {
      for (const pid of fakes) unregisterGroup(pid);
    }
  });
});

describe("system helpers by absolute path", () => {
  test.if(process.platform === "darwin")("osascript is /usr/bin/osascript", () => {
    expect(tools.osascript).toBe("/usr/bin/osascript");
  });

  test.if(process.platform === "darwin")("worktree session ids ask /usr/bin/git, not a git earlier on PATH", () => {
    const repo = folder();
    fs.mkdirSync(path.join(repo, ".git"));
    const fakeBin = folder();
    fs.writeFileSync(path.join(fakeBin, "git"), "#!/bin/sh\necho /\n", { mode: 0o755 });
    const sub = path.join(repo, "sub");
    fs.mkdirSync(sub);
    const script = path.join(folder(), "session.ts");
    const source = path.resolve(import.meta.dir, "../src/browse/local.ts");
    fs.writeFileSync(script, `import { sessionId } from ${JSON.stringify(source)};\nconsole.log(sessionId(["--scope", "worktree"], ${JSON.stringify(sub)}));\nconsole.log(sessionId(["--scope", "cwd"], "/"));\n`);
    const done = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 20000, env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` } });
    const [worktree, root] = done.stdout.trim().split("\n");
    expect(worktree).toMatch(/^s-[0-9a-f]{8}$/);
    expect(worktree).not.toBe(root);
  });
});

describe("control connection failures wake everyone", () => {
  test("a reply nested too deeply fails a request blocked in drain at once", async () => {
    const dir = folder();
    const where = path.join(dir, "s.sock");
    const server = Bun.spawn(
      [
        "/usr/bin/python3",
        "-I",
        "-c",
        "import socket,sys,time\ns=socket.socket(socket.AF_UNIX)\ns.bind(sys.argv[1])\ns.listen(1)\nprint('ready',flush=True)\nc,_=s.accept()\ntime.sleep(0.4)\nc.sendall(b'['*10000+b']'*10000+b'\\n')\ntime.sleep(20)",
        where,
      ],
      { stdout: "pipe", stderr: "inherit" },
    );
    try {
      const reader = server.stdout.getReader();
      await reader.read();
      const socket = net.connect(where);
      await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
      const fd = (socket as unknown as { _handle: { fd: number } })._handle.fd;
      const connection = new Connection(socket, fd, () => false, () => {});
      const started = performance.now();
      const big = "x".repeat(900 * 1024);
      const outcomes = await Promise.all([
        connection.request("big", object([["blob", big]]), 10).catch((error: unknown) => error),
        connection.request("small", undefined, 10).catch((error: unknown) => error),
      ]);
      const took = performance.now() - started;
      connection.close();
      for (const outcome of outcomes) expect(String((outcome as Error).message)).toBe(UNREADABLE_LINE);
      expect(took).toBeLessThan(3000);
    } finally {
      server.kill("SIGKILL");
      await server.exited;
    }
  }, 15000);
});
