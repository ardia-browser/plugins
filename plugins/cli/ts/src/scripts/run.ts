import { spawn } from "node:child_process";
import { Interrupted } from "./output.ts";

const STOP_POLL_MS = 50;

export class Timeout extends Error {
  override readonly name = "Timeout";
}

export type Captured = { status: number | null; stdout: string; stderr: string };

const groups = new Set<number>();
let exitHooked = false;

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
}

function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", () => {
    for (const pid of groups) killGroup(pid);
  });
}

export function runCaptured(argv: string[], options: { cwd: string; timeoutMs: number; stopped?: () => boolean }): Promise<Captured> {
  hookExit();
  return new Promise((resolve, reject) => {
    const [program, ...args] = argv as [string, ...string[]];
    const child = spawn(program, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    const pid = child.pid;
    if (pid !== undefined) groups.add(pid);
    let stoppedEarly = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (pid !== undefined) killGroup(pid);
    }, options.timeoutMs);
    const watch = setInterval(() => {
      if (!options.stopped?.() || stoppedEarly) return;
      stoppedEarly = true;
      if (pid !== undefined) killGroup(pid);
    }, STOP_POLL_MS);
    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(watch);
      if (pid !== undefined) groups.delete(pid);
      run();
    };
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (status) =>
      finish(() => {
        if (stoppedEarly) reject(new Interrupted());
        else if (timedOut) reject(new Timeout());
        else resolve({ status, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
      }),
    );
  });
}
