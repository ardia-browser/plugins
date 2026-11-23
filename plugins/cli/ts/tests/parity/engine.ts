import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { CASE_ROOT, loadCases } from "./cases.ts";
import { reap, type Spawner } from "./observe.ts";
import { DEFAULT_JOBS, type Outcome, programPath, runCases } from "./run.ts";

export type EngineResult = { total: number; ms: number; strayRoutes: string[]; outcomes: Outcome[] };

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function cpuFromTimes(text: string): number | undefined {
  const children = text.trim().split("\n")[1];
  if (children === undefined) return undefined;
  const seconds = [...children.matchAll(/(\d+)m([\d.]+)s/g)].map((match) => Number(match[1]) * 60 + Number(match[2]));
  return seconds.length === 2 ? seconds[0]! + seconds[1]! : undefined;
}

const timedSpawner: Spawner = (argv, options) => {
  const times = `${options.env.ARDIA_PARITY_BOX}.times`;
  return spawn("/bin/bash", ["-c", '"$@"; status=$?; times > "$0"; exit $status', times, ...argv], { ...options, detached: true });
};

async function main(args: string[]): Promise<void> {
  const out = option(args, "--out");
  if (out === undefined) throw new Error("engine.ts --out <results.json> [--root <cases>] [--only id,id] [--jobs n] [--parent pid] [--timed]");
  writeFileSync(`${out}.pid`, String(process.pid));
  const root = option(args, "--root") ?? CASE_ROOT;
  const only = option(args, "--only");
  const parent = Number(option(args, "--parent") ?? 0);
  const timed = args.includes("--timed");
  let cases = loadCases(root);
  if (only !== undefined) {
    const wanted = only.split(",").filter(Boolean);
    const known = new Set(cases.map((kase) => kase.id));
    const unknown = wanted.filter((id) => !known.has(id));
    if (unknown.length || !wanted.length) throw new Error(`no parity case ${unknown.join(", ") || "selected"}`);
    cases = cases.filter((kase) => wanted.includes(kase.id));
  }
  let scratch: string | undefined;
  const abandon = () => {
    if (scratch !== undefined) {
      reap(scratch);
      rmSync(scratch, { recursive: true, force: true });
    }
    process.exit(3);
  };
  process.on("SIGTERM", abandon);
  if (parent > 0) {
    setInterval(() => {
      try {
        process.kill(parent, 0);
      } catch {
        abandon();
      }
    }, 1000).unref();
  }
  const started = Date.now();
  const { outcomes, strayRoutes } = await runCases(cases, option(args, "--program") ?? programPath(), {
    jobs: Number(option(args, "--jobs") ?? process.env.ARDIA_PARITY_JOBS ?? DEFAULT_JOBS),
    ...(timed ? { spawner: timedSpawner } : {}),
    onInstall: (install) => (scratch = install.scratch),
    progress: (outcome, done) => {
      if (timed) {
        const times = `${outcome.box}.times`;
        if (existsSync(times)) {
          const cpu = cpuFromTimes(readFileSync(times, "utf8"));
          if (cpu !== undefined) outcome.cpuSeconds = cpu;
        }
      }
      if (done % 200 === 0) process.stderr.write(`${done}/${cases.length} in ${((Date.now() - started) / 1000).toFixed(0)} s\n`);
    },
  });
  const result: EngineResult = { total: cases.length, ms: Date.now() - started, strayRoutes, outcomes };
  writeFileSync(`${out}.partial`, JSON.stringify(result));
  rmSync(out, { force: true });
  renameSync(`${out}.partial`, out);
}

await main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
  process.exit(2);
});
process.exit(0);
