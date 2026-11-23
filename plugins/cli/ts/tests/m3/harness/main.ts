#!/usr/bin/env bun
import { PENDING } from "./pending.ts";
import { LinkHarness, linkReplayable, load as loadLink, names as linkNames } from "./linkrun.ts";
import { Harness, load, type Outcome, scenarioPaths } from "./runner.ts";

const USAGE = `The browse daemon's differential harness in Bun (docs/m3-harness.md), no Python.

  bun tests/m3/harness/main.ts replay [scenario ...] [--keep] [--scratch DIR] [--json] [--pace asap|recorded] [--serial]
  bun tests/m3/harness/main.ts record <scenario ...> [--verify N] [--tries N] [--keep] [--scratch DIR] [--json]
  bun tests/m3/harness/main.ts live [scenario ...] [--keep] [--scratch DIR] [--json]
  bun tests/m3/harness/main.ts list [scenario ...]
  bun tests/m3/harness/main.ts link-replay [scenario ...] [--keep] [--scratch DIR] [--json]
  bun tests/m3/harness/main.ts link-record <scenario ...> [--verify N] [--tries N] [--keep] [--scratch DIR] [--json]
  bun tests/m3/harness/main.ts link-live [scenario ...] [--keep] [--scratch DIR] [--json]
  bun tests/m3/harness/main.ts link-list

Scenarios are names under the data root's scenarios/ (globs allowed). The client is the TypeScript CLI from source
with a seeded daemon spawn; the daemon is ARDIA_M3_TS_PROGRAM (default ts/dist/ardia-ts). Ports come from
ARDIA_M3_PORT_BASE (a block of 20, default 9600).

record and live run headless Chromium from ARDIA_M3_CHROME behind the tap. record keeps a recording only when it
then replays --verify times in a row (default 3), recording again up to --tries times (default 3); a recording that
never steadies is not written, and the old one stays. live runs the scenario twice and compares the two runs.
`;

function describe(result: Outcome): string {
  const status = result.skipped ? "skip" : result.ok ? "ok  " : "FAIL";
  const extra = result.skipped ? ` (${result.skipped})`
    : result.mode.startsWith("record") && result.ok ? ` (${result.requests !== undefined ? `${result.requests} requests, ` : ""}${result.bytes} bytes, attempt ${result.attempts})` : "";
  const lines = [`${status} ${result.mode}: ${result.name}${extra}`];
  for (const line of (result.differences ?? []).slice(0, 20)) lines.push(`       ${line}`);
  return lines.join("\n");
}

function report(results: Outcome[], asJson: boolean, each = true): number {
  const ran = results.filter((result) => !result.skipped);
  const failed = ran.filter((result) => !result.ok);
  if (asJson) process.stdout.write(`${JSON.stringify(results, null, 1)}\n`);
  else {
    if (each) for (const result of results) process.stdout.write(`${describe(result)}\n`);
    process.stdout.write(`${ran.length - failed.length} of ${ran.length} ${each ? "replayed " : ""}passed, ${results.length - ran.length} skipped\n`);
  }
  if (ran.length === 0) {
    process.stderr.write("nothing was replayed: every selected scenario is live-only\n");
    return 2;
  }
  return failed.length > 0 ? 1 : 0;
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  const rest: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token === "--scratch" || token === "--pace" || token === "--verify" || token === "--tries") {
      flags.set(token, argv[index + 1] ?? "");
      index += 1;
    } else if (token.startsWith("--")) flags.set(token, true);
    else rest.push(token);
  }
  const scratch = typeof flags.get("--scratch") === "string" ? (flags.get("--scratch") as string) : null;
  const keep = flags.has("--keep");
  const asJson = flags.has("--json");
  if (command === "list") {
    for (const file of scenarioPaths(rest)) {
      const scenario = load(file);
      process.stdout.write(`${scenario.name}  ${scenario.steps.length} steps${scenario.live_only ? "  live-only" : ""}${scenario.name in PENDING ? "  pending" : ""}\n`);
    }
    return 0;
  }
  if (command === "link-list") {
    for (const name of linkNames(rest)) {
      const scenario = loadLink(name);
      process.stdout.write(`${name}${scenario.live_only ? `  (live only: ${scenario.live_only})` : ""}\n`);
    }
    return 0;
  }
  if (command === "replay") {
    const paths = scenarioPaths(rest);
    if (paths.length === 0) {
      process.stderr.write("no scenarios matched\n");
      return 2;
    }
    const named = new Set(rest);
    const loaded = paths.map(load);
    const skipped = loaded.filter((scenario) => scenario.name in PENDING && !named.has(scenario.name));
    const scenarios = loaded.filter((scenario) => !skipped.includes(scenario));
    for (const scenario of skipped) process.stderr.write(`skipped ${scenario.name}: pending (${PENDING[scenario.name]})\n`);
    if (scenarios.length === 0) {
      process.stderr.write("every matched scenario is pending; name one exactly to replay it anyway\n");
      return 2;
    }
    const pace = flags.get("--pace");
    if (typeof pace === "string") for (const scenario of scenarios) scenario.pace = pace;
    const harness = await new Harness(scratch, keep).open();
    try {
      return report(await harness.replayAll(scenarios, "ts", flags.has("--serial") ? 1 : harness.workers), asJson);
    } finally {
      harness.close();
    }
  }
  const counted = (flag: string): number | undefined => {
    const text = flags.get(flag);
    if (typeof text !== "string") return undefined;
    if (!/^[0-9]+$/.test(text)) throw new Error(`${flag} takes a whole number, not ${JSON.stringify(text)}`);
    return Number(text);
  };
  const options = { verify: counted("--verify"), tries: counted("--tries") };
  if (command === "record" || command === "live") {
    if (command === "record" && rest.length === 0) {
      process.stderr.write("record needs the scenarios to record: it rewrites their transcripts\n");
      return 2;
    }
    const paths = scenarioPaths(rest);
    if (paths.length === 0) {
      process.stderr.write("no scenarios matched\n");
      return 2;
    }
    const harness = await new Harness(scratch, keep).open();
    try {
      const results: Outcome[] = [];
      for (const file of paths) {
        const scenario = load(file);
        results.push(await (command === "record" ? harness.record(scenario, options) : harness.live(scenario)).catch((error: unknown) => ({
          name: scenario.name, mode: command, ok: false, differences: [`harness: ${error instanceof Error ? error.message : String(error)}`] })));
        if (!asJson) process.stdout.write(`${describe(results[results.length - 1] as Outcome)}\n`);
      }
      return report(results, asJson, false);
    } finally {
      harness.close();
    }
  }
  if (command === "link-record" || command === "link-live") {
    if (command === "link-record" && rest.length === 0) {
      process.stderr.write("link-record needs the link scenarios to record: it rewrites their transcripts\n");
      return 2;
    }
    const chosen = linkNames(rest);
    if (chosen.length === 0) {
      process.stderr.write("no link scenarios matched\n");
      return 2;
    }
    const harness = await new LinkHarness(scratch, keep).open();
    try {
      const results: Outcome[] = [];
      for (const name of chosen) {
        const scenario = loadLink(name);
        results.push(await (command === "link-record" ? harness.record(scenario, options) : harness.live(scenario)).catch((error: unknown) => ({
          name, mode: command, ok: false, differences: [`harness: ${error instanceof Error ? error.message : String(error)}`] })));
        if (!asJson) process.stdout.write(`${describe(results[results.length - 1] as Outcome)}\n`);
      }
      return report(results, asJson, false);
    } finally {
      harness.close();
    }
  }
  if (command === "link-replay") {
    const chosen = rest.length > 0 ? linkNames(rest) : linkReplayable();
    if (chosen.length === 0) {
      process.stderr.write("no link scenarios matched\n");
      return 2;
    }
    const harness = await new LinkHarness(scratch, keep).open();
    try {
      const results: Outcome[] = [];
      for (const name of chosen) results.push(await harness.replay(loadLink(name)));
      return report(results, asJson);
    } finally {
      harness.close();
    }
  }
  process.stdout.write(USAGE);
  return command === "--help" || command === "-h" ? 0 : 2;
}

process.exitCode = await main(process.argv.slice(2));
