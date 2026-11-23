import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { compared } from "./compare.ts";
import { bun, exited, firstLine, Ports, spawnGroup, stop } from "./infra.ts";
import { load as loadTranscript, Subs, transcript } from "./normalize.ts";
import { LINK_DRIVER, LINK_SCENARIOS, LINK_TRANSCRIPTS, TAP } from "./paths.ts";
import { isRecord, type Json, type JsonRecord, pyLoads } from "./pyvalues.ts";
import { tapCall } from "./side.ts";
import type { Outcome } from "./runner.ts";

const DRIVER_TIMEOUT_MS = 600_000;
const TAP_START_MS = 30_000;
const LINK_PARTS = ["outcomes", "requests", "sources"];

export type LinkScenario = { name: string; ops: Json[]; pace?: string; type_only?: number[]; live_only?: string; [key: string]: unknown };
type LinkRun = { outcomes: Json | null; status: number | null; stderr: string; tap: JsonRecord; subs: JsonRecord; transcript: string };

export function names(patterns: string[] = []): string[] {
  const found: string[] = [];
  for (const pattern of patterns.length > 0 ? patterns : ["*"]) {
    found.push(...[...new Bun.Glob(`${pattern}.json`).scanSync({ cwd: LINK_SCENARIOS, onlyFiles: true })].sort().map((file) => path.basename(file, ".json")));
  }
  return [...new Set(found)];
}

export function load(name: string): LinkScenario {
  const scenario = JSON.parse(readFileSync(path.join(LINK_SCENARIOS, `${name}.json`), "utf8")) as LinkScenario;
  scenario.name = name;
  return scenario;
}

export function recording(name: string): string {
  return path.join(LINK_TRANSCRIPTS, `${name}.jsonl.gz`);
}

export function outcomeFile(name: string): string {
  return path.join(LINK_TRANSCRIPTS, `${name}.result.json.gz`);
}

function runDriver(argv: string[], cwd: string): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(argv[0] as string, argv.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, DRIVER_TIMEOUT_MS);
    child.once("close", (code) => {
      clearTimeout(timer);
      const stderr = Buffer.concat(err).toString("utf8");
      resolve({ stdout: timedOut ? "" : Buffer.concat(out).toString("utf8"), stderr: timedOut ? `${stderr}\n[harness: the driver timed out]` : stderr, status: timedOut ? null : code });
    });
  });
}

async function runSide(scenario: LinkScenario, root: string, ports: [number, number], replay: string): Promise<LinkRun> {
  const [chromePort, tapPort] = ports;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const script = path.join(root, "script.json");
  writeFileSync(script, JSON.stringify({ ops: scenario.ops }));
  const tap = spawnGroup([bun(), TAP, "--listen", String(tapPort), "--out", path.join(root, "transcript.jsonl"), "--scratch", root, "--replay", replay, "--pace", scenario.pace ?? "asap"],
    { log: path.join(root, "tap.log") });
  try {
    if (!(await firstLine(tap, TAP_START_MS)).startsWith("{")) throw new Error(`the tap didn't start: ${readFileSync(path.join(root, "tap.log"), "utf8").slice(-2000)}`);
    const url = `ws://127.0.0.1:${tapPort}/devtools/browser/tap`;
    const done = await runDriver([bun(), LINK_DRIVER, url, script, String(tapPort)], root);
    const lines = done.stdout.split("\n").filter((line) => line.startsWith("["));
    const outcomes = lines.length > 0 ? (pyLoads(lines[lines.length - 1] as string) as Json) : null;
    writeFileSync(path.join(root, "outcomes.json"), JSON.stringify(outcomes, null, 1));
    const state = await tapCall(tapPort, "/tap/state");
    return { outcomes, status: done.status, stderr: done.stderr.slice(-4000), tap: state, subs: { root, tap: tapPort, chrome: chromePort }, transcript: path.join(root, "transcript.jsonl") };
  } finally {
    tap.stdout?.destroy();
    if (tap.exitCode === null && tap.signalCode === null) {
      try {
        await tapCall(tapPort, "/tap/quit", {});
        if (!(await exited(tap, 5000))) await stop(tap);
      } catch {
        await stop(tap);
      }
    }
  }
}

export function onlyTypes(outcomes: Json[], indexes: number[]): Json[] {
  const shaped = [...outcomes];
  for (const index of indexes) {
    const found = shaped[index];
    if (isRecord(found) && "error" in found) {
      const error = found["error"];
      shaped[index] = { error: { type: isRecord(error) ? (error["type"] ?? null) : null } };
    }
  }
  return shaped;
}

export function normalizedLink(run: { outcomes: Json | null; subs: JsonRecord }, transcriptFile: string, scenario: LinkScenario): Record<string, unknown> {
  const subs = new Subs(run.subs);
  const { shaped, ids } = transcript(loadTranscript(transcriptFile), subs);
  let outcomes: Json | null = run.outcomes;
  if (outcomes !== null) {
    outcomes = JSON.parse(ids.inText(subs.text(JSON.stringify(ids.walk(outcomes))))) as Json;
    outcomes = onlyTypes(outcomes as Json[], scenario.type_only ?? []);
  }
  return { outcomes, ...shaped };
}

export class LinkHarness {
  readonly scratch: string;
  private ports: Ports | null = null;

  constructor(scratch: string | null = null, private readonly keep = false) {
    this.scratch = scratch ?? mkdtempSync(path.join(tmpdir(), "ardia-m3-link-"));
  }

  async open(): Promise<this> {
    this.ports = await Ports.claim();
    return this;
  }

  expected(scenario: LinkScenario): Record<string, unknown> {
    const raw = pyLoads(gunzipSync(readFileSync(outcomeFile(scenario.name))).toString("utf8")) as JsonRecord;
    return normalizedLink({ outcomes: raw["outcomes"] ?? null, subs: raw["subs"] as JsonRecord }, recording(scenario.name), scenario);
  }

  async replay(scenario: LinkScenario): Promise<Outcome> {
    if (this.ports === null) throw new Error("open the link harness first");
    const name = scenario.name;
    if (scenario.live_only) return { name, mode: "replay ts", ok: true, skipped: scenario.live_only };
    if (!existsSync(recording(name))) return { name, mode: "replay ts", ok: false, differences: ["no recording"] };
    const pair = await this.ports.take();
    let run: LinkRun;
    try {
      run = await runSide(scenario, path.join(this.scratch, name, "replay-ts"), pair, recording(name));
    } finally {
      this.ports.give(pair);
    }
    const found: string[] = [];
    if (run.status !== 0 || run.outcomes === null) found.push(`ts driver exited ${run.status}: ${run.stderr.slice(-800)}`);
    found.push(...(Array.isArray(run.tap["failures"]) ? run.tap["failures"] : []).map((failure) => `tap: ${failure}`));
    if (run.tap["remaining"]) found.push(`tap: ${run.tap["remaining"]} recorded requests never sent, first ${JSON.stringify(run.tap["remainingForms"] ?? null)}`);
    if (run.outcomes !== null) found.push(...compared(this.expected(scenario), normalizedLink(run, run.transcript, scenario), LINK_PARTS));
    if (!this.keep) rmSync(path.join(this.scratch, name), { recursive: true, force: true });
    return { name, mode: "replay ts", ok: found.length === 0, differences: found };
  }

  close(): void {
    if (!this.keep) rmSync(this.scratch, { recursive: true, force: true });
  }
}

export function linkReplayable(): string[] {
  return names([]).filter((name) => existsSync(recording(name)) && !load(name).live_only);
}
