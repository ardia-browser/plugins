import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PARITY } from "./cases.ts";
import type { EngineResult } from "./engine.ts";
import { programPath } from "./run.ts";

export const ENGINE_DEADLINE_MS = 30 * 60 * 1000;

export type EngineOptions = { root?: string; only?: string[]; timed?: boolean; jobs?: number; program?: string };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runEngineDetached(options: EngineOptions = {}): Promise<EngineResult> {
  const folder = mkdtempSync(join(tmpdir(), "ardia-parity-engine-"));
  const out = join(folder, "results.json");
  const log = join(folder, "engine.log");
  const args = [join(PARITY, "engine.ts"), "--out", out, "--parent", String(process.pid), "--program", options.program ?? programPath()];
  if (options.root) args.push("--root", options.root);
  if (options.only) args.push("--only", options.only.join(","));
  if (options.timed) args.push("--timed");
  if (options.jobs) args.push("--jobs", String(options.jobs));
  const logFd = openSync(log, "w");
  try {
    const starter = spawn("/bin/sh", ["-c", '"$@" &', "sh", process.execPath, ...args], { stdio: ["ignore", logFd, logFd], detached: true });
    await new Promise<void>((resolve, reject) => {
      starter.on("error", reject);
      starter.on("exit", () => resolve());
    });
  } finally {
    closeSync(logFd);
  }
  const startedAt = Date.now();
  const deadline = startedAt + ENGINE_DEADLINE_MS;
  let pid: number | undefined;
  try {
    for (;;) {
      if (existsSync(out)) return JSON.parse(readFileSync(out, "utf8")) as EngineResult;
      if (pid === undefined && existsSync(`${out}.pid`)) pid = Number(readFileSync(`${out}.pid`, "utf8")) || undefined;
      const started = pid !== undefined;
      if ((started && !alive(pid!)) || (!started && Date.now() > startedAt + 30_000)) {
        await sleep(200);
        if (existsSync(out)) continue;
        throw new Error(`the parity engine ${started ? "died" : "never started"}:\n${existsSync(log) ? readFileSync(log, "utf8").slice(-4000) : ""}`);
      }
      if (Date.now() > deadline) {
        if (pid !== undefined) process.kill(pid, "SIGTERM");
        throw new Error(`the parity engine didn't finish in ${ENGINE_DEADLINE_MS / 60000} minutes`);
      }
      await sleep(200);
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
