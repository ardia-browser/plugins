import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { BLOCK, RECORDED_FIXTURE } from "./harness/infra.ts";
import { LinkHarness, linkReplayable, load as loadLink } from "./harness/linkrun.ts";
import { PROGRAM_ENV, TRANSCRIPTS, tsProgram } from "./harness/paths.ts";
import { check } from "./harness/protocol.ts";
import { isRecord, pyLoads } from "./harness/pyvalues.ts";
import { dataPaths, Harness, load, loadNamed, nameOf, type Outcome, recording, replayable } from "./harness/runner.ts";
import { PENDING } from "./harness/pending.ts";
import { recordedFixture, type Scenario } from "./harness/side.ts";

const REPLAY_MS = 900_000;
const MINIMUM_CORPUS = 82;
const MINIMUM_LINK = 4;
const MINIMUM_ANSWERS = 50;
const RETRIES = 2;


const program = tsProgram();
const missing = !existsSync(program);

function needsProgram(): void {
  if (missing) throw new Error(`${program} is missing: build it with \`sh scripts/build.sh\` in plugins/cli/ts, or point ${PROGRAM_ENV} at a built ardia-ts`);
}

function failures(results: Outcome[]): string {
  return results.filter((result) => !result.ok).map((result) => `${result.name}: ${(result.differences ?? []).slice(0, 3).join("\n    ")}`).join("\n");
}

async function settled(harness: Harness, scenarios: Scenario[], results: Outcome[]): Promise<Outcome[]> {
  const byName = new Map(scenarios.map((scenario) => [scenario.name, scenario]));
  const flaky: string[] = [];
  const final: Outcome[] = [];
  for (const result of results) {
    let outcome = result;
    const raced = (result.differences ?? []).some((line) => line.startsWith("tap: "));
    for (let round = 0; raced && !outcome.ok && round < RETRIES; round += 1) {
      outcome = await harness.replay(byName.get(result.name) as Scenario, "ts");
      if (outcome.ok) flaky.push(`${result.name} (passed on retry ${round + 1}; first run: ${(result.differences ?? [])[0]?.slice(0, 160) ?? ""})`);
    }
    final.push(outcome);
  }
  if (flaky.length > 0) process.stderr.write(`m3 corpus: ${flaky.length} recording(s) needed a retry:\n  ${flaky.join("\n  ")}\n`);
  return final;
}

function corpus(): Scenario[] {
  return replayable().map(load).filter((scenario) => !(scenario.name in PENDING));
}

describe.skipIf(process.platform !== "darwin")("the m3 recordings replay against the TS daemon", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await new Harness().open();
  });

  afterAll(() => {
    harness?.close();
  });

  test("every corpus recording replays identically", async () => {
    needsProgram();
    const scenarios = corpus();
    expect(scenarios.length).toBeGreaterThanOrEqual(MINIMUM_CORPUS);
    const results = await settled(harness, scenarios, await harness.replayAll(scenarios, "ts"));
    expect(results.filter((result) => !result.ok).map((result) => result.name), failures(results)).toEqual([]);
  }, REPLAY_MS);

  test("replay catches a changed scenario", async () => {
    needsProgram();
    const scenario = loadNamed("daemon/close_reopen");
    const changed = structuredClone(scenario);
    (changed.steps[3] as { argv: string[] }).argv = ["get", "url"];
    const result = await harness.replay(changed, "ts");
    expect(result.ok).toBe(false);
    expect((result.differences ?? []).some((line) => line.includes("tap: unexpected request") || line.includes("answers"))).toBe(true);
  }, REPLAY_MS);

  test("every pending recording is a replayable one with a reason", () => {
    const names = new Set(replayable().map(nameOf));
    for (const [name, reason] of Object.entries(PENDING)) {
      expect(names.has(name), `${name} is pending but isn't a replayable recording`).toBe(true);
      expect(reason.length).toBeGreaterThan(20);
    }
  });
});

describe.skipIf(process.platform !== "darwin")("a recording made in another port block", () => {
  const RECORDED_BASE = 9620;
  const MOVED = "nav/history";
  const REPLAY_BASE = 9980;
  const saved = { base: process.env["ARDIA_M3_PORT_BASE"], transcripts: dataPaths.transcripts };
  let folder = "";

  beforeAll(() => {
    folder = mkdtempSync(path.join(tmpdir(), "ardia-m3-blocks-"));
  });

  afterAll(() => {
    dataPaths.transcripts = saved.transcripts;
    if (saved.base === undefined) delete process.env["ARDIA_M3_PORT_BASE"];
    else process.env["ARDIA_M3_PORT_BASE"] = saved.base;
    rmSync(folder, { recursive: true, force: true });
  });

  function moved(name: string, fixture: number): string {
    const target = path.join(folder, "transcripts");
    const original = recordedFixture(recording(name));
    const port = new RegExp(`(?<=(127\\.0\\.0\\.1|localhost):)${original}\\b`, "g");
    for (const suffix of [".jsonl.gz", ".result.json.gz"]) {
      let text = gunzipSync(readFileSync(path.join(saved.transcripts, `${name}${suffix}`))).toString("utf8").replace(port, String(fixture));
      if (suffix === ".result.json.gz") {
        const raw = JSON.parse(text) as { subs: Record<string, unknown> };
        raw.subs["fixture"] = fixture;
        text = JSON.stringify(raw);
      }
      const file = path.join(target, `${name}${suffix}`);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, gzipSync(text, { level: 9 }));
    }
    return target;
  }

  test("replays in a third block", async () => {
    needsProgram();
    const fixture = RECORDED_BASE + BLOCK - 1;
    const original = recordedFixture(recording(MOVED));
    expect([original, REPLAY_BASE + BLOCK - 1]).not.toContain(fixture);
    dataPaths.transcripts = moved(MOVED, fixture);
    expect(recordedFixture(recording(MOVED))).toBe(fixture);
    process.env["ARDIA_M3_PORT_BASE"] = String(REPLAY_BASE);
    const harness = await new Harness(path.join(folder, "run")).open();
    try {
      const result = await harness.replay(loadNamed(MOVED), "ts");
      expect(result.skipped, `${MOVED} must replay, not skip`).toBeUndefined();
      expect(result.ok, (result.differences ?? []).join("\n")).toBe(true);
    } finally {
      harness.close();
    }
  }, REPLAY_MS);

  test("a recording without a stored fixture port is read as 9419", () => {
    expect(recordedFixture(path.join(folder, "nothing.jsonl.gz"))).toBe(RECORDED_FIXTURE);
  });
});

describe.skipIf(process.platform !== "darwin")("the CDP link recordings replay against the TS link driver", () => {
  let harness: LinkHarness;

  beforeAll(async () => {
    harness = await new LinkHarness().open();
  });

  afterAll(() => {
    harness?.close();
  });

  test("every link recording replays identically", async () => {
    const names = linkReplayable();
    expect(names.length).toBeGreaterThanOrEqual(MINIMUM_LINK);
    const results: Outcome[] = [];
    for (const name of names) results.push(await harness.replay(loadLink(name)));
    expect(results.filter((result) => !result.ok).map((result) => result.name), failures(results)).toEqual([]);
  }, REPLAY_MS);

  test("link replay catches a changed request", async () => {
    const scenario = structuredClone(loadLink("round_trips"));
    ((scenario.ops[4] as { params: { expression: string } }).params).expression = "1+2";
    const result = await harness.replay(scenario);
    expect(result.ok).toBe(false);
    expect((result.differences ?? []).some((line) => line.startsWith("tap: "))).toBe(true);
  }, REPLAY_MS);
});

describe("the recorded protocol", () => {
  test("every recorded request and answer fits the schema", () => {
    let checked = 0;
    let files = 0;
    for (const relative of [...new Bun.Glob("**/*.result.json.gz").scanSync({ cwd: TRANSCRIPTS })].sort()) {
      files += 1;
      const raw = pyLoads(gunzipSync(readFileSync(path.join(TRANSCRIPTS, relative))).toString("utf8"));
      expect(isRecord(raw) && Array.isArray(raw["steps"]), `${relative}: the result has no steps list`).toBe(true);
      const steps = (isRecord(raw) ? raw["steps"] : []) as unknown[];
      steps.forEach((step, index) => {
        expect(isRecord(step) && Array.isArray(step["answers"]), `${relative}: step ${index} has no answers list`).toBe(true);
        const answers = (isRecord(step) ? step["answers"] : []) as unknown[];
        answers.forEach((item, position) => {
          expect(isRecord(item) && "answer" in item, `${relative}: step ${index} answer ${position} isn't an object with an answer`).toBe(true);
          if (!isRecord(item)) return;
          const found = [...check("answer", item["answer"]), ...("wire" in item ? check("request", item["wire"]) : [])];
          expect(found, `${relative}: step ${index} answer ${position}: ${found.join("; ")}`).toEqual([]);
          checked += 1;
        });
      });
    }
    expect(files).toBeGreaterThanOrEqual(70);
    expect(checked).toBeGreaterThan(MINIMUM_ANSWERS);
  });

  test("the schema catches a bad message", () => {
    expect(check("answer", { exit: 0, out: "", err: "", daemon: "ts/0.4.0" })).toEqual([]);
    expect(check("answer", { exit: "0", out: "", err: "" })).not.toEqual([]);
    expect(check("answer", { exit: 0, out: "", err: "", code: "Not A Code" })).not.toEqual([]);
    expect(check("request", { argv: ["open", 3] })).not.toEqual([]);
    expect(check("config", { session: "s", key: "../x", data_root: "/tmp" })).not.toEqual([]);
    expect(check("config", { session: "s", key: "0".repeat(24), data_root: "/tmp", port: 9222, harness_seed: 5 })).toEqual([]);
    expect(check("answer", pyLoads('{"exit": 0.0, "out": "", "err": ""}'))).not.toEqual([]);
  });
});
