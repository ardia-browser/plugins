import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SOURCE = process.env["D7_SOURCE"] ?? path.resolve(import.meta.dir, "../../src");
const LIBC = process.env["ARDIA_TEST_LIBC"] ?? path.resolve(import.meta.dir, "../../dist/ardia-libc.so");

function tempDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ardia-d7exit-")));
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
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

function daemonLike(dir: string, mode: "exit" | "watchdog" | "settled"): { status: number | null; orphan: number } {
  const pidFile = path.join(dir, "pid");
  const holder = mode === "settled" ? `sleep 30 >/dev/null 2>&1 & echo $! > ${pidFile}; exit 0` : `sleep 30 & echo $! > ${pidFile}; exit 0`;
  const script = path.join(dir, "daemon.ts");
  fs.writeFileSync(
    script,
    [
      `import fs from "node:fs";`,
      `import { armWatchdog, loadLibc } from ${JSON.stringify(path.join(SOURCE, "libc.ts"))};`,
      `import { run } from ${JSON.stringify(path.join(SOURCE, "browse/auth/run.ts"))};`,
      `loadLibc(${JSON.stringify(LIBC)});`,
      `const ran = run(["/bin/sh", "-c", ${JSON.stringify(holder)}], { timeout: 60 }).then(() => "settled", () => "failed");`,
      `const end = Date.now() + 5000;`,
      `while (!fs.existsSync(${JSON.stringify(pidFile)}) && Date.now() < end) await Bun.sleep(20);`,
      mode === "settled" ? `console.log(await ran);` : `await Bun.sleep(300);`,
      mode === "watchdog"
        ? `armWatchdog(fs.openSync(${JSON.stringify(dir)}, "r"), "no-such.sock", 0n, 0n, 200, 3); const stuck = Date.now() + 10000; while (Date.now() < stuck) {} process.exit(9);`
        : `process.exit(0);`,
    ].join("\n"),
  );
  const done = spawnSync(process.execPath, [script], { timeout: 30000, encoding: "utf8" });
  return { status: done.status, orphan: Number(fs.readFileSync(pidFile, "utf8")) };
}

describe("helpers and the daemon's exit", () => {
  test("an unsettled helper whose leader exited but whose child holds stdout is killed when the daemon exits", async () => {
    const { status, orphan } = daemonLike(tempDir(), "exit");
    expect(status).toBe(0);
    const gone = await until(() => !alive(orphan), 2000);
    if (!gone) process.kill(orphan, "SIGKILL");
    expect(gone).toBe(true);
  });

  test("the native watchdog's _exit kills it too, without the JavaScript exit hook", async () => {
    const { status, orphan } = daemonLike(tempDir(), "watchdog");
    expect(status).toBe(3);
    const gone = await until(() => !alive(orphan), 2000);
    if (!gone) process.kill(orphan, "SIGKILL");
    expect(gone).toBe(true);
  });

  test("a settled run's detached orphan is left alone", async () => {
    const { status, orphan } = daemonLike(tempDir(), "settled");
    expect(status).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const left = alive(orphan);
    if (left) process.kill(orphan, "SIGKILL");
    expect(left).toBe(true);
  });
});
