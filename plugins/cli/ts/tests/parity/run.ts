import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { type Case, TS_ROOT, UnsafeCase } from "./cases.ts";
import { compare, comparable, decodeExpected, expectedFor, Marks, type Field } from "./compare.ts";
import { Install, runSide, SideDidNotStart, type Spawner } from "./observe.ts";

export const DEFAULT_JOBS = 6;

export type Outcome = {
  id: string;
  source: string;
  argv: string[];
  problems: string[];
  mismatches: [Field, string][];
  ms: number;
  box: string;
  timedOut: boolean;
  cpuSeconds?: number;
};

export function programPath(): string {
  return process.env.ARDIA_TS_CLI || join(TS_ROOT, "dist", "ardia-ts");
}

export function passed(outcome: Outcome): boolean {
  return !outcome.problems.length && !outcome.mismatches.length;
}

export function report(outcome: Outcome): string {
  const lines = [`✗ ${outcome.id} (${outcome.source}): ardia ${outcome.argv.join(" ")}`];
  for (const problem of outcome.problems) lines.push(`  ${problem}`);
  for (const [field, diff] of outcome.mismatches) {
    lines.push(`  ${field} differs:`);
    lines.push(...diff.split("\n").map((line) => `    ${line}`));
  }
  return lines.join("\n");
}

let localeNames: Set<string> | undefined;

function localeKey(name: string): string {
  return name.toLowerCase().replace("utf-8", "utf8");
}

function missingLocale(kase: Case): string | undefined {
  if (process.platform !== "linux") return undefined;
  if (localeNames === undefined) {
    const listed = spawnSync("locale", ["-a"], { encoding: "utf8" }).stdout ?? "";
    localeNames = new Set(listed.split(/\s+/).filter(Boolean).map(localeKey));
  }
  for (const key of ["LC_ALL", "LC_CTYPE", "LANG"]) {
    const name = kase.env.get(key);
    if (name && name !== "C" && name !== "POSIX" && !localeNames.has(localeKey(name))) return name;
  }
  return undefined;
}

export async function checkCase(install: Install, kase: Case, spawner?: Spawner): Promise<Outcome> {
  const outcome: Outcome = { id: kase.id, source: kase.source, argv: kase.argv, problems: [], mismatches: [], ms: 0, box: "", timedOut: false };
  const lacking = missingLocale(kase);
  if (lacking) {
    outcome.problems.push(`the case runs under the ${lacking} locale, which this system lacks (locale-gen ${lacking})`);
    return outcome;
  }
  const row = expectedFor(kase);
  if (row === undefined) {
    outcome.problems.push("the case has no expected outcome; capture it (see capture.json)");
    return outcome;
  }
  const box = install.box();
  outcome.box = box;
  const started = Date.now();
  try {
    const observed = await runSide(install, kase, box, spawner);
    outcome.timedOut = observed.timed_out;
    if (observed.route !== "ts") outcome.problems.push(`expected ts to serve it, but ${observed.route} did`);
    const lastServed = observed.served_by[observed.served_by.length - 1];
    if (observed.served_by.length && lastServed !== observed.route) outcome.problems.push(`telemetry says ${String(lastServed)} served it, but ${observed.route} did`);
    if (!observed.transcript_complete) outcome.problems.push("the ts side left a control connection open past the drain deadline, so its transcript may be cut short");
    outcome.mismatches = compare(comparable(observed, new Marks(box, install.scratch)), decodeExpected(row), kase.fallback);
  } catch (error) {
    if (error instanceof SideDidNotStart || error instanceof UnsafeCase) outcome.problems.push(error.message);
    else outcome.problems.push(`the runner failed: ${(error as Error).stack ?? String(error)}`);
  } finally {
    outcome.ms = Date.now() - started;
    rmSync(box, { recursive: true, force: true });
  }
  return outcome;
}

export type RunOptions = { jobs?: number; spawner?: Spawner; onInstall?: (install: Install) => void; progress?: (outcome: Outcome, done: number) => void };

export async function runCases(cases: Case[], program = programPath(), options: RunOptions = {}): Promise<{ outcomes: Outcome[]; strayRoutes: string[] }> {
  const install = new Install(program);
  options.onInstall?.(install);
  try {
    const outcomes: Outcome[] = new Array(cases.length);
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < cases.length) {
        const index = next;
        next += 1;
        outcomes[index] = await checkCase(install, cases[index]!, options.spawner);
        done += 1;
        options.progress?.(outcomes[index]!, done);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, options.jobs ?? DEFAULT_JOBS) }, worker));
    return { outcomes, strayRoutes: install.strayRoutes() };
  } finally {
    install.close();
  }
}
