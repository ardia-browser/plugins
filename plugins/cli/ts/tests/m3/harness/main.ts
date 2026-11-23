#!/usr/bin/env bun
import { PENDING } from "./pending.ts";
import { LinkHarness, linkReplayable, load as loadLink, names as linkNames } from "./linkrun.ts";
import { Harness, load, type Outcome, scenarioPaths } from "./runner.ts";

const USAGE = `The browse daemon's replay harness in Bun (docs/m3-harness.md), no browser and no Python.

  bun tests/m3/harness/main.ts replay [scenario ...] [--keep] [--scratch DIR] [--json] [--pace asap|recorded] [--serial]
  bun tests/m3/harness/main.ts list [scenario ...]
  bun tests/m3/harness/main.ts link-replay [scenario ...] [--keep] [--scratch DIR] [--json]
  bun tests/m3/harness/main.ts link-list

Scenarios are names under the data root's scenarios/ (globs allowed). The client is the TypeScript CLI from source
with a seeded daemon spawn; the daemon is ARDIA_M3_TS_PROGRAM (default ts/dist/ardia-ts). Ports come from
ARDIA_M3_PORT_BASE (a block of 20, default 9600).
`;

function report(results: Outcome[], asJson: boolean): number {
  const ran = results.filter((result) => !result.skipped);
  const failed = ran.filter((result) => !result.ok);
  if (asJson) process.stdout.write(`${JSON.stringify(results, null, 1)}\n`);
  else {
    for (const result of results) {
      const status = result.skipped ? "skip" : result.ok ? "ok  " : "FAIL";
      process.stdout.write(`${status} ${result.mode}: ${result.name}${result.skipped ? ` (${result.skipped})` : ""}\n`);
      for (const line of (result.differences ?? []).slice(0, 20)) process.stdout.write(`       ${line}\n`);
    }
    process.stdout.write(`${ran.length - failed.length} of ${ran.length} replayed passed, ${results.length - ran.length} skipped\n`);
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
    if (token === "--scratch" || token === "--pace") {
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
