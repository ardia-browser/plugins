import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { dumps, Float, type Value } from "../../../src/json.ts";
import { loads } from "../../../src/pyjson.ts";
import { compared, LIVE } from "./compare.ts";
import { capturesConsole, checks, daemonOf, namesFor, rewriter } from "./divergences.ts";
import { FixtureServer, Ports } from "./infra.ts";
import { run as normalized, type RunResult, type Shaped, type Step } from "./normalize.ts";
import { SCENARIOS, TRANSCRIPTS } from "./paths.ts";
import { violations } from "./protocol.ts";
import { isRecord, type Json, type JsonRecord, PyFloat, pyLoads } from "./pyvalues.ts";
import { type ReplayRun, type Scenario, Side } from "./side.ts";

export type Outcome = { name: string; mode: string; ok: boolean; differences?: string[]; skipped?: string; requests?: number; bytes?: number; attempts?: number };
export type Source = { transcript: string; result: string };
export type RecordOptions = { verify?: number | undefined; tries?: number | undefined };

export const RECORDER = "ts";
const DEFAULT_VERIFY = 3;
const DEFAULT_TRIES = 3;

export const dataPaths = { scenarios: SCENARIOS, transcripts: TRANSCRIPTS };

export function scenarioPaths(patterns: string[] = []): string[] {
  const found: string[] = [];
  for (const pattern of patterns.length > 0 ? patterns : ["**/*"]) {
    if (pattern.endsWith(".json") && existsSync(pattern)) {
      found.push(path.resolve(pattern));
      continue;
    }
    const glob = new Bun.Glob(pattern.endsWith(".json") ? pattern : `${pattern}.json`);
    found.push(...[...glob.scanSync({ cwd: dataPaths.scenarios, onlyFiles: true })].map((relative) => path.join(dataPaths.scenarios, relative)).sort());
  }
  return [...new Set(found)];
}

export function nameOf(file: string): string {
  return path.relative(dataPaths.scenarios, path.resolve(file)).replace(/\.json$/, "");
}

export function load(file: string): Scenario {
  const scenario = JSON.parse(readFileSync(file, "utf8")) as Scenario;
  scenario.name = nameOf(file);
  return scenario;
}

export function loadNamed(name: string): Scenario {
  return load(path.join(dataPaths.scenarios, `${name}.json`));
}

export function seedOf(scenario: Scenario): number {
  return Number(scenario.seed || Number.parseInt(createHash("sha256").update(scenario.name, "utf8").digest("hex").slice(0, 8), 16));
}

export function recording(name: string): string {
  return path.join(dataPaths.transcripts, `${name}.jsonl.gz`);
}

export function expectation(name: string): string {
  return path.join(dataPaths.transcripts, `${name}.result.json.gz`);
}

export function readExpectation(name: string, file = expectation(name)): JsonRecord {
  const raw = pyLoads(gunzipSync(readFileSync(file)).toString("utf8"));
  if (!isRecord(raw)) throw new Error(`${file} isn't a JSON object`);
  return raw;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function sourceOf(name: string): Source {
  return { transcript: recording(name), result: expectation(name) };
}

function pyValue(value: unknown, sorted = true): Value {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "bigint") return value;
  if (value instanceof PyFloat) return new Float(value.value);
  if (typeof value === "number") return Number.isSafeInteger(value) ? BigInt(value) : new Float(value);
  if (Array.isArray(value)) return value.map((item) => pyValue(item, sorted));
  if (typeof value === "object") {
    const keys = sorted ? Object.keys(value).sort() : Object.keys(value);
    return new Map(keys.map((key): [string, Value] => [key, pyValue((value as Record<string, unknown>)[key], sorted)]));
  }
  throw new Error(`can't write ${typeof value} as JSON`);
}

export function pythonResultText(value: Json | Record<string, unknown>): string {
  return `${dumps(pyValue(value), "indented", false, false, 1)}\n`;
}

function sortedValue(value: Value): Value {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value instanceof Map) return new Map([...value.keys()].sort().map((key): [string, Value] => [key, sortedValue(value.get(key) as Value)]));
  return value;
}

export function recordedResultText(result: ReplayRun): string {
  const steps = result.steps.map((step, index): Value => {
    const shaped = pyValue(step) as Map<string, Value>;
    const lines = result.answerLines?.[index];
    if (lines !== undefined && !step["teardown"]) shaped.set("answers", lines.map((line) => sortedValue(loads(line))));
    return shaped;
  });
  const top = new Map<string, Value>([["files", pyValue(result.files)], ["recorder", RECORDER], ["steps", steps], ["subs", pyValue(result.subs)]]);
  return `${dumps(top, "indented", false, false, 1)}\n`;
}

export function linkResultText(outcomeLine: string | null, subs: JsonRecord): string {
  const outcomes = outcomeLine === null ? null : loads(outcomeLine);
  return dumps(new Map<string, Value>([["outcomes", outcomes], ["subs", pyValue(subs, false)]]), "spaced", true);
}

export function pythonLinkText(value: Json | Record<string, unknown>): string {
  return dumps(pyValue(value, false), "spaced", true);
}

export function gzipped(text: string | Buffer): Buffer {
  return gzipSync(text, { level: 9 });
}

function racyOf(scenario: Scenario): number[] | null {
  return scenario.racy_steps?.steps ?? null;
}

export function expectedOf(name: string, scenario: Scenario, source: Source = sourceOf(name)): Shaped {
  const raw = readExpectation(name, source.result);
  const subs = raw["subs"] as JsonRecord;
  const result: RunResult = { root: String(subs["root"]), transcript: source.transcript, steps: raw["steps"] as Step[], files: raw["files"] as JsonRecord, subs };
  return normalized(result, null, racyOf(scenario), rewriter(namesFor(scenario)));
}

export function shapedOf(result: RunResult, scenario: Scenario, unstable: number[] | null = null): Shaped {
  return normalized(result, unstable, racyOf(scenario), rewriter(namesFor(scenario)));
}

export function checkedProtocol(result: RunResult, label: string): string[] {
  return violations(result).map((line) => `protocol ${label}: ${line}`);
}

export function checkedRows(result: RunResult, impl: string, label: string, scenario: Scenario | null = null): string[] {
  if (daemonOf(impl) !== "ts") return [];
  return checks(result.transcript, capturesConsole(scenario?.steps)).map((line) => `transcript ${label}: ${line}`);
}

export function tapDifferences(tap: JsonRecord): string[] {
  const found = (Array.isArray(tap["failures"]) ? tap["failures"] : []).map((failure) => `tap: ${failure}`);
  if (tap["remaining"]) {
    const forms = Array.isArray(tap["remainingForms"]) ? tap["remainingForms"].slice(0, 2) : [];
    found.push(`tap: ${tap["remaining"]} recorded request(s) never sent, first: ${JSON.stringify(forms)}`);
  }
  return found;
}

export class Harness {
  readonly scratch: string;
  private ports: Ports | null = null;
  private fixtures: FixtureServer | null = null;

  constructor(scratch: string | null = null, private readonly keep = false) {
    this.scratch = scratch ?? mkdtempSync(path.join(tmpdir(), "ardia-m3-"));
  }

  get workers(): number {
    return Math.max(1, this.ports?.size ?? 1);
  }

  async open(): Promise<this> {
    mkdirSync(this.scratch, { recursive: true });
    this.ports = await Ports.claim();
    this.fixtures = new FixtureServer(this.ports.fixture);
    return this;
  }

  close(): void {
    this.fixtures?.stop();
    if (!this.keep) rmSync(this.scratch, { recursive: true, force: true });
  }

  async side(scenario: Scenario, label: string, impl: string, replay: string | null): Promise<ReplayRun> {
    if (this.ports === null || this.fixtures === null) throw new Error("open the harness first");
    const pair = await this.ports.take();
    try {
      const root = path.join(this.scratch, scenario.name.replaceAll("/", "__"), label);
      return await new Side(scenario, root, impl, pair, this.fixtures.base, seedOf(scenario), replay).run();
    } finally {
      this.ports.give(pair);
    }
  }

  async replay(scenario: Scenario, impl = "ts"): Promise<Outcome> {
    const name = scenario.name;
    const mode = `replay ${impl}`;
    if (scenario.live_only) return { name, mode, ok: true, skipped: scenario.live_only };
    if (!existsSync(recording(name))) return { name, mode, ok: false, differences: ["no recording; record it first"] };
    return this.replayFrom(scenario, sourceOf(name), impl, `replay-${impl}`);
  }

  async replayFrom(scenario: Scenario, source: Source, impl = "ts", label = `replay-${impl}`): Promise<Outcome> {
    const mode = `replay ${impl}`;
    const result = await this.side(scenario, label, impl, source.transcript);
    const differences = tapDifferences(result.tap);
    differences.push(...compared(expectedOf(scenario.name, scenario, source) as unknown as Record<string, unknown>, shapedOf(result, scenario) as unknown as Record<string, unknown>, LIVE));
    differences.push(...checkedProtocol(result, impl));
    differences.push(...checkedRows(result, impl, impl, scenario));
    return { name: scenario.name, mode, ok: differences.length === 0, differences };
  }

  async live(scenario: Scenario, a = "ts", b = "ts"): Promise<Outcome> {
    const settled = await Promise.allSettled([this.side(scenario, "live-A", a, null), this.side(scenario, "live-B", b, null)]);
    const broken = settled.flatMap((side, index) => (side.status === "rejected" ? [`side ${"AB"[index]} failed: ${messageOf(side.reason)}`] : []));
    if (broken.length > 0) return { name: scenario.name, mode: `live ${a}/${b}`, ok: false, differences: broken };
    const [first, second] = settled.map((side) => (side as PromiseFulfilledResult<ReplayRun>).value) as [ReplayRun, ReplayRun];
    const unstable = scenario.unstable_steps?.steps ?? null;
    const differences = compared(shapedOf(first, scenario, unstable) as unknown as Record<string, unknown>, shapedOf(second, scenario, unstable) as unknown as Record<string, unknown>, LIVE);
    differences.push(...checkedProtocol(first, "A"), ...checkedProtocol(second, "B"));
    differences.push(...checkedRows(first, a, "A", scenario), ...checkedRows(second, b, "B", scenario));
    return { name: scenario.name, mode: `live ${a}/${b}`, ok: differences.length === 0, differences };
  }

  async record(scenario: Scenario, options: RecordOptions = {}): Promise<Outcome> {
    const name = scenario.name;
    const verify = Math.max(0, options.verify ?? DEFAULT_VERIFY);
    const tries = Math.max(1, options.tries ?? DEFAULT_TRIES);
    const candidates = path.join(this.scratch, name.replaceAll("/", "__"), "candidate");
    let last: string[] = [];
    for (let attempt = 1; attempt <= tries; attempt += 1) {
      let result: ReplayRun;
      try {
        result = await this.side(scenario, "record", "ts", null);
      } catch (error) {
        last = [`attempt ${attempt}: the recording run failed: ${messageOf(error)}`];
        continue;
      }
      const failed = result.steps.filter((step) => String(step.err ?? "").includes("[harness: the step timed out]"));
      if (failed.length > 0) {
        last = [`attempt ${attempt}: a step timed out while recording`];
        continue;
      }
      rmSync(candidates, { recursive: true, force: true });
      mkdirSync(candidates, { recursive: true });
      const source: Source = { transcript: path.join(candidates, "transcript.jsonl.gz"), result: path.join(candidates, "result.json.gz") };
      writeFileSync(source.transcript, gzipped(readFileSync(result.transcript)));
      writeFileSync(source.result, gzipped(recordedResultText(result)));
      last = [];
      for (let round = 1; round <= verify && last.length === 0; round += 1) {
        const replayed = await this.replayFrom(scenario, source, "ts", `verify-${round}`).catch((error: unknown): Outcome =>
          ({ name, mode: "replay ts", ok: false, differences: [`the replay failed: ${messageOf(error)}`] }));
        if (!replayed.ok) last = [`attempt ${attempt}, replay ${round} of ${verify}:`, ...(replayed.differences ?? []).slice(0, 10)];
      }
      if (last.length > 0) continue;
      publish([[source.transcript, recording(name)], [source.result, expectation(name)]]);
      const shaped = shapedOf(result, scenario);
      const requests = Object.values(shaped.requests as Record<string, Record<string, unknown[][]>>).flatMap((sessions) => Object.values(sessions))
        .reduce((total, groups) => total + groups.reduce((sum, group) => sum + (Array.isArray(group) ? group.length : 1), 0), 0);
      return { name, mode: "record ts", ok: true, requests, bytes: readFileSync(recording(name)).length, attempts: attempt };
    }
    return { name, mode: "record ts", ok: false, differences: [`no recording kept: none of ${tries} attempt(s) replayed ${verify} time(s) in a row`, ...last], attempts: tries };
  }

  async replayAll(scenarios: Scenario[], impl = "ts", width = this.workers): Promise<Outcome[]> {
    const results: Outcome[] = new Array(scenarios.length);
    let next = 0;
    const worker = async () => {
      while (next < scenarios.length) {
        const index = next;
        next += 1;
        results[index] = await this.replay(scenarios[index] as Scenario, impl).catch((error: unknown) => ({ name: (scenarios[index] as Scenario).name, mode: `replay ${impl}`, ok: false,
          differences: [`harness: ${error instanceof Error ? error.message : String(error)}`] }));
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(width, scenarios.length)) }, worker));
    return results;
  }
}

export function replayable(): string[] {
  return scenarioPaths([]).filter((file) => existsSync(recording(nameOf(file))) && !load(file).live_only);
}

const LOCK_MS = 60_000;

function locked(lock: string): void {
  const deadline = performance.now() + LOCK_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (performance.now() > deadline) throw new Error(`${lock} has been held for ${LOCK_MS / 1000} s: another record is writing this recording`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

export function publish(pairs: [string, string][], rename: (from: string, to: string) => void = renameSync): void {
  const first = pairs[0];
  if (first === undefined) return;
  mkdirSync(path.dirname(first[1]), { recursive: true });
  const lock = `${first[1]}.lock`;
  locked(lock);
  const stamp = `${process.pid}.${randomUUID()}`;
  const staged: [string, string, string | null][] = [];
  const done: [string, string, string | null][] = [];
  try {
    for (const [from, to] of pairs) {
      mkdirSync(path.dirname(to), { recursive: true });
      const entry: [string, string, string | null] = [`${to}.${stamp}.partial`, to, existsSync(to) ? `${to}.${stamp}.old` : null];
      staged.push(entry);
      copyFileSync(from, entry[0]);
      if (entry[2] !== null) copyFileSync(to, entry[2]);
    }
    try {
      for (const entry of staged) {
        rename(entry[0], entry[1]);
        done.push(entry);
      }
    } catch (error) {
      for (const [, to, old] of done.reverse()) {
        if (old !== null) renameSync(old, to);
        else rmSync(to, { force: true });
      }
      throw error;
    }
  } finally {
    for (const [partial, , old] of staged) {
      rmSync(partial, { force: true, recursive: true });
      if (old !== null) rmSync(old, { force: true, recursive: true });
    }
    rmdirSync(lock);
  }
}
