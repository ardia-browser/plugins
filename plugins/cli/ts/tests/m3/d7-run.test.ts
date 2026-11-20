import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run, RunTimedOut } from "../../src/browse/auth/run.ts";

function tempDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ardia-d7run-")));
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
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

describe("subprocess cleanup", () => {
  test("one TERM and at most one KILL per stop, and a descendant's TERM cleanup isn't cut short by its pipes closing", async () => {
    const dir = tempDir();
    const marker = path.join(dir, "cleaned");
    const pidFile = path.join(dir, "pid");
    const script = `(trap 'exec 1>&- 2>&-; sleep 0.15; touch ${marker}; exit 0' TERM; while :; do sleep 0.02; done) & echo $! > ${pidFile}; wait`;
    const sent: [number, string][] = [];
    const real = process.kill.bind(process);
    process.kill = ((pid: number, signal?: string | number) => {
      if (pid < 0 && signal !== 0 && signal !== undefined) sent.push([pid, String(signal)]);
      return real(pid, signal as never);
    }) as typeof process.kill;
    try {
      const started = performance.now();
      await expect(run(["/bin/sh", "-c", script], { timeout: 0.3, grace: 0.5 })).rejects.toBeInstanceOf(RunTimedOut);
      expect(performance.now() - started).toBeLessThan(450);
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      expect(await until(() => !alive(pid), 2000)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(fs.existsSync(marker)).toBe(true);
      expect(sent.filter(([, signal]) => signal === "SIGTERM").length).toBe(1);
      expect(sent.filter(([, signal]) => signal === "SIGKILL").length).toBeLessThanOrEqual(1);
    } finally {
      process.kill = real;
    }
  });

  test("a group that ignores TERM gets exactly one KILL at the end of the grace", async () => {
    const dir = tempDir();
    const pidFile = path.join(dir, "pid");
    const sent: string[] = [];
    const real = process.kill.bind(process);
    process.kill = ((pid: number, signal?: string | number) => {
      if (pid < 0 && signal !== 0 && signal !== undefined) sent.push(String(signal));
      return real(pid, signal as never);
    }) as typeof process.kill;
    try {
      await expect(run(["/bin/sh", "-c", `trap '' TERM; (trap '' TERM; sleep 30) & echo $! > ${pidFile}; wait`], { timeout: 0.2, grace: 0.3 })).rejects.toBeInstanceOf(RunTimedOut);
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      expect(await until(() => !alive(pid), 2000)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(sent).toEqual(["SIGTERM", "SIGKILL"]);
    } finally {
      process.kill = real;
    }
  });
});

describe("init-script reads", () => {
  type Reader = { read(buffer: Buffer, offset: number, length: number, position: null): Promise<{ bytesRead: number }> };
  function growing(chunks: Buffer[]): Reader {
    return {
      async read(buffer, offset, length) {
        const next = chunks.shift();
        if (next === undefined) return { bytesRead: 0 };
        const taken = next.subarray(0, length);
        taken.copy(buffer, offset);
        if (taken.length < next.length) chunks.unshift(next.subarray(taken.length));
        return { bytesRead: taken.length };
      },
    };
  }

  test("a file that grew after its stat is read whole, up to the cap", async () => {
    const { readCapped, MAX_INIT_SCRIPT } = await import("../../src/browse/commands/setup.ts");
    const text = await readCapped(growing([Buffer.from("x".repeat(10)), Buffer.from("y".repeat(70000))]), "/grew.js");
    expect(text.length).toBe(70010);
    await expect(readCapped(growing([Buffer.alloc(10, 0x20), Buffer.alloc(MAX_INIT_SCRIPT, 0x20)]), "/huge.js")).rejects.toThrow("--init-script /huge.js is over 4 MB");
    expect((await readCapped(growing([Buffer.alloc(MAX_INIT_SCRIPT, 0x20)]), "/exact.js")).length).toBe(MAX_INIT_SCRIPT);
  });
});
