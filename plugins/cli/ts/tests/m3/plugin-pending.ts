#!/usr/bin/env bun
import fs from "node:fs";
import { pluginViolations } from "./plugin-rules.ts";
import { addDaemon, CHROME, entries, startWorld, step, stopWorld, tap, type World } from "./plugin-world.ts";

type Reply = { out: string; err: string; exit: number };
type Case = { id: string; argv: string[]; daemon: { replies: Reply[] }; intentional?: unknown; cdp_rules?: unknown };
type Outcome = { id: string; verdict: "pass" | "fail" | "ran" | "n/a"; why: string; got?: Reply & { code?: string } };

const PHASES: Record<string, Set<string>> = {
  "1": new Set(["tab", "snapshot", "click", "fill", "press", "key"]),
  "2": new Set(["tab", "snapshot", "click", "fill", "press", "key", "get", "type", "scroll", "wait", "find", "is"]),
};
const PLACEHOLDER = "✓ Done\n";
const RECORDED_TARGET = "86AFEE216CB13B62B5F557C8C255568F";
const RECORDED_LOADER = "BC8D78A4AEFDD527B1433946AF6B12C3";
const RECORDED_PORT = "63234";
const CLIENT_ONLY: Record<string, string> = {
  "review2--4-notice-before-document-changed": "the reply's reconnect notice comes from a control-server restart the harness can't stage",
  "review2--4-notice-json": "the reply's reconnect notice comes from a control-server restart the harness can't stage",
  "review2--4-quoted-message-mid-line": "a client rewording case: the reply is staged text",
  "review--5-same-words-other-code": "a client rewording case: the reply is staged text",
  "review--7-port-highest": "a client endpoint case: the reply is staged text",
};
const ENGINE_FAULTS: Record<string, [string, string]> = {
  "review--4-scope-cdp-error": ["Input.insertText", "ardia: tab_out_of_scope: the tab moved to another window"],
  "review--4-scope-text": ["Input.insertText", "ardia: tab_out_of_scope: the tab moved to another window"],
  "review--4-lease-cdp-error": ["Input.dispatchMouseEvent", "ardia: document_changed: no act lease covers this document"],
};

function option(name: string, fallback: string): string {
  const at = process.argv.indexOf(name);
  return at > 0 ? (process.argv[at + 1] ?? fallback) : fallback;
}

function split(argv: string[]): { command: string[]; json: boolean; expect: string | null } {
  const rest = argv.slice(1);
  const command: string[] = [];
  let json = false;
  let expect: string | null = null;
  let afterDash = false;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] as string;
    if (afterDash) command.push(token);
    else if (token === "--json") json = true;
    else if (token === "--session") index += 1;
    else if (token === "--expect-loader") {
      expect = rest[index + 1] ?? null;
      index += 1;
    } else {
      if (token === "--") afterDash = true;
      command.push(token);
    }
  }
  return { command, json, expect };
}

function commandOf(argv: string[]): string {
  return argv.find((token) => !token.startsWith("-")) ?? "";
}

async function newTab(world: World): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${world.chromePort}/json/new?http://127.0.0.1:${world.sitePort}/contract`, { method: "PUT" });
  const tab = (await response.json()) as { id: string };
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const list = (await (await fetch(`http://127.0.0.1:${world.chromePort}/json/list`)).json()) as { id: string; title: string }[];
    if (list.some((item) => item.id === tab.id && item.title === "Form page")) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return tab.id;
}

async function closeTab(world: World, id: string): Promise<void> {
  await fetch(`http://127.0.0.1:${world.chromePort}/json/close/${id}`).catch(() => undefined);
}

async function run(world: World, item: Case, index: number): Promise<Outcome> {
  if (Object.hasOwn(CLIENT_ONLY, item.id)) return { id: item.id, verdict: "n/a", why: CLIENT_ONLY[item.id] as string };
  const { command, json, expect } = split(item.argv);
  const target = await newTab(world);
  const { key } = await addDaemon(world, `pending-${index}`);
  try {
    const picked = await step(world, ["tab", target], { json: true }, undefined, key);
    const loader = String((JSON.parse(picked.out) as { data: { loader: string } }).data.loader);
    await step(world, ["snapshot", "-c"], {}, undefined, key);
    const live = (text: string) => text.replaceAll(RECORDED_TARGET, target).replaceAll(RECORDED_LOADER, loader).replaceAll(RECORDED_PORT, String(world.sitePort));
    const argv = command.map(live);
    const fault = ENGINE_FAULTS[item.id];
    if (fault) await tap(world, "fault", { kind: "error", method: fault[0], at: 1, message: fault[1] });
    const got = await step(world, argv, { json, expect_loader: expect === null ? null : live(expect) }, undefined, key);
    if (fault) await tap(world, "fault", {});
    const want = item.daemon.replies[0] as Reply;
    const wanted = { out: live(want.out), err: live(want.err), exit: want.exit };
    const same = got.exit === wanted.exit && got.out === wanted.out && got.err === wanted.err;
    if (same) return { id: item.id, verdict: "pass", why: "the answer equals the recorded reply", got };
    if (want.out === PLACEHOLDER && want.err === "" && want.exit === 0) {
      return { id: item.id, verdict: got.exit === 0 ? "ran" : "fail", why: `the recorded reply is the placeholder ✓ Done; the daemon answered exit ${got.exit}${got.code ? ` (${got.code})` : ""}`, got };
    }
    return { id: item.id, verdict: "fail", why: `wanted ${JSON.stringify(wanted)}`, got };
  } finally {
    await step(world, ["close"], {}, undefined, key).catch(() => undefined);
    await closeTab(world, target);
  }
}

async function main(): Promise<number> {
  const file = process.argv[2];
  if (!file || !CHROME) {
    process.stderr.write("usage: ARDIA_M3_CHROME=<chrome-headless-shell> bun tests/m3/plugin-pending.ts <f1-early.json> [--phase 1|2] [--ports <base>] [--out <file>]\n");
    return 64;
  }
  const phase = PHASES[option("--phase", "1")] as Set<string>;
  const cases = (JSON.parse(fs.readFileSync(file, "utf8")) as Case[]).filter((item) => phase.has(commandOf(split(item.argv).command)));
  const world = await startWorld(Number(option("--ports", "9670")));
  const outcomes: Outcome[] = [];
  try {
    for (const [index, item] of cases.entries()) {
      const outcome = await run(world, item, index);
      outcomes.push(outcome);
      process.stdout.write(`${outcome.verdict.padEnd(4)} ${outcome.id}: ${outcome.why}${outcome.verdict === "fail" ? `\n     got ${JSON.stringify(outcome.got)}` : ""}\n`);
    }
    const violations = pluginViolations(entries(world));
    process.stdout.write(`tap: ${violations.length} rule violations${violations.length ? ` ${JSON.stringify(violations.slice(0, 5))}` : ""}\n`);
    const out = option("--out", "");
    if (out) fs.writeFileSync(out, JSON.stringify({ outcomes, violations }, null, 1));
    const counts = Object.fromEntries(["pass", "ran", "fail", "n/a"].map((verdict) => [verdict, outcomes.filter((item) => item.verdict === verdict).length]));
    process.stdout.write(`${JSON.stringify(counts)} of ${outcomes.length}\n`);
    return counts["fail"] || violations.length ? 1 : 0;
  } finally {
    await stopWorld(world);
  }
}

process.exit(await main());
