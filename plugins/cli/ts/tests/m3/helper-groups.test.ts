import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SOURCE = process.env["HELPERS_SOURCE"] ?? path.resolve(import.meta.dir, "../../src");
const LIBC = process.env["ARDIA_TEST_LIBC"] ?? path.resolve(import.meta.dir, "../../dist/ardia-libc.so");

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

function helperUnderWatchdog(kind: "encoder" | "group", exit: "watchdog" | "exit"): { status: number | null; pid: number } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ardia-helpers-")));
  const pidFile = path.join(dir, "pid");
  const fake = path.join(dir, "ffmpeg");
  fs.writeFileSync(fake, `#!/bin/sh\necho $$ > ${pidFile}\nexec sleep 30\n`, { mode: 0o755 });
  const start =
    kind === "encoder"
      ? `const { spawnEncoder } = await import(${JSON.stringify(path.join(SOURCE, "browse/capture/record.ts"))}); await spawnEncoder(${JSON.stringify(fake)}, ${JSON.stringify(path.join(dir, "out.webm"))});`
      : `const { spawnGroup } = await import(${JSON.stringify(path.join(SOURCE, "proc/group.ts"))}); await spawnGroup([${JSON.stringify(fake)}], { stdin: "pipe", stdout: "pipe" });`;
  const script = path.join(dir, "daemon.ts");
  fs.writeFileSync(
    script,
    [
      `import fs from "node:fs";`,
      `import { armWatchdog, loadLibc } from ${JSON.stringify(path.join(SOURCE, "libc.ts"))};`,
      `loadLibc(${JSON.stringify(LIBC)});`,
      start,
      `const end = Date.now() + 5000;`,
      `while (!(fs.existsSync(${JSON.stringify(pidFile)}) && fs.readFileSync(${JSON.stringify(pidFile)}, "utf8").endsWith("\\n")) && Date.now() < end) await Bun.sleep(20);`,
      exit === "watchdog"
        ? `armWatchdog(fs.openSync(${JSON.stringify(dir)}, "r"), "no-such.sock", 0n, 0n, 200, 3); const stuck = Date.now() + 10000; while (Date.now() < stuck) {} process.exit(9);`
        : `process.exit(0);`,
    ].join("\n"),
  );
  const done = spawnSync(process.execPath, [script], { timeout: 30000, encoding: "utf8" });
  return { status: done.status, pid: Number(fs.readFileSync(pidFile, "utf8")) };
}

describe("recording and PDF helpers are in the helper-group registry", () => {
  for (const kind of ["encoder", "group"] as const) {
    test(`${kind}: the native watchdog's _exit kills it`, async () => {
      const { status, pid } = helperUnderWatchdog(kind, "watchdog");
      expect(status).toBe(3);
      const gone = await until(() => !alive(pid), 2000);
      if (!gone) process.kill(pid, "SIGKILL");
      expect(gone).toBe(true);
    });

    test(`${kind}: the JavaScript exit hook kills it`, async () => {
      const { status, pid } = helperUnderWatchdog(kind, "exit");
      expect(status).toBe(0);
      const gone = await until(() => !alive(pid), 2000);
      if (!gone) process.kill(pid, "SIGKILL");
      expect(gone).toBe(true);
    });
  }
});
