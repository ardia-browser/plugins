import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { compared, LIVE } from "./compare.ts";
import { capturesConsole, checks, daemonOf, namesFor, rewriter } from "./divergences.ts";
import { FixtureServer, Ports } from "./infra.ts";
import { run as normalized, type RunResult, type Shaped, type Step } from "./normalize.ts";
import { SCENARIOS, TRANSCRIPTS } from "./paths.ts";
import { violations } from "./protocol.ts";
import { isRecord, type JsonRecord, pyLoads } from "./pyvalues.ts";
import { type ReplayRun, type Scenario, Side } from "./side.ts";

export type Outcome = { name: string; mode: string; ok: boolean; differences?: string[]; skipped?: string };

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

export function readExpectation(name: string): JsonRecord {
  const raw = pyLoads(gunzipSync(readFileSync(expectation(name))).toString("utf8"));
  if (!isRecord(raw)) throw new Error(`${expectation(name)} isn't a JSON object`);
  return raw;
}

function racyOf(scenario: Scenario): number[] | null {
  return scenario.racy_steps?.steps ?? null;
}

export function expectedOf(name: string, scenario: Scenario): Shaped {
  const raw = readExpectation(name);
  const subs = raw["subs"] as JsonRecord;
  const result: RunResult = { root: String(subs["root"]), transcript: recording(name), steps: raw["steps"] as Step[], files: raw["files"] as JsonRecord, subs };
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

  async side(scenario: Scenario, label: string, impl: string, replay: string): Promise<ReplayRun> {
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
    const result = await this.side(scenario, `replay-${impl}`, impl, recording(name));
    const differences = tapDifferences(result.tap);
    differences.push(...compared(expectedOf(name, scenario) as unknown as Record<string, unknown>, shapedOf(result, scenario) as unknown as Record<string, unknown>, LIVE));
    differences.push(...checkedProtocol(result, impl));
    differences.push(...checkedRows(result, impl, impl, scenario));
    return { name, mode, ok: differences.length === 0, differences };
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
