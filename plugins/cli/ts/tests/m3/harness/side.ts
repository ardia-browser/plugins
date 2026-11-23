import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { daemonOf } from "./divergences.ts";
import type { ChildProcess } from "node:child_process";
import { alive, bun, exited, firstLine, launchChrome, type Pair, RECORDED_FIXTURE, sleep, spawnGroup, stop } from "./infra.ts";
import type { RunResult, Step } from "./normalize.ts";
import { CLIENT_MAIN, CLIENT_PRELOAD, FIXTURES, TAP, tsProgram } from "./paths.ts";
import { isRecord, type Json, type JsonRecord, pyLoads } from "./pyvalues.ts";

export const STEP_TIMEOUT_MS = 150_000;
const TEARDOWN_TIMEOUT_MS = 60_000;
const DAEMON_EXIT_MS = 15_000;
const TAP_START_MS = 30_000;
const TAP_CALL_MS = 10_000;
export const DEFAULT_WINDOW: [number, number] = [1200, 900];
const KEPT_ENV = ["PATH", "LANG", "LC_ALL", "TZ"];
const HARNESS_ENV = ["ARDIA_M3_SEED", "ARDIA_M3_ANSWERS", "ARDIA_M3_TS_PROGRAM"];

export type ScenarioStep = { argv: string[]; session?: string; stdin?: string | null; main_world?: boolean };
export type Scenario = {
  name: string;
  steps: ScenarioStep[];
  env?: Record<string, string>;
  pace?: string;
  settle?: number;
  window?: [number, number];
  seed?: number;
  live_only?: string;
  designed?: unknown;
  divergences?: string[];
  racy_steps?: { steps?: number[]; reason?: string };
  unstable_steps?: { steps?: number[] };
  [key: string]: unknown;
};

export type ReplayRun = RunResult & { tap: JsonRecord; answerLines?: string[][] };

export async function tapCall(port: number, route: string, body?: unknown): Promise<JsonRecord> {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: body === undefined ? "GET" : "POST",
    body: body === undefined ? null : JSON.stringify(body),
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(TAP_CALL_MS),
  });
  return (await response.json()) as JsonRecord;
}

export function mainWorld(argv: string[]): string[] {
  if (argv[0] === "eval") return ["eval", "--main-world", ...argv.slice(1)];
  if (argv[0] === "batch") return argv.map((item) => (item.startsWith("eval ") ? `eval --main-world ${item.slice(5)}` : item));
  return argv;
}

export function recordedFixture(replay: string): number {
  const expected = path.join(path.dirname(replay), `${path.basename(replay).replace(/\.jsonl\.gz$/, "")}.result.json.gz`);
  try {
    const raw = pyLoads(gunzipSync(readFileSync(expected)).toString("utf8"));
    const fixture = isRecord(raw) && isRecord(raw["subs"]) ? raw["subs"]["fixture"] : undefined;
    const port = typeof fixture === "number" ? fixture : typeof fixture === "string" && /^\s*-?\d+\s*$/.test(fixture) ? Number(fixture) : NaN;
    return Number.isInteger(port) ? port : RECORDED_FIXTURE;
  } catch {
    return RECORDED_FIXTURE;
  }
}

export function substitute(text: string, fixture: string, home: string): string {
  return text.split("{fixture_dir}").join(FIXTURES).split("{fixture}").join(fixture).split("{home}").join(home);
}

function mode(info: { mode: number }): string {
  return `0o${(info.mode & 0o7777).toString(8)}`;
}

function walk(folder: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const name of readdirSync(folder).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    found.push(relative);
    const full = path.join(folder, name);
    if (lstatSync(full).isDirectory()) found.push(...walk(full, relative));
  }
  return found;
}

export function browseFiles(data: string): JsonRecord {
  const folder = path.join(data, "Browse");
  const found: JsonRecord = {};
  let isFolder = false;
  try {
    isFolder = statSync(folder).isDirectory();
  } catch {}
  if (!isFolder) return found;
  for (const relative of walk(folder).sort()) {
    const full = path.join(folder, relative);
    const info = lstatSync(full);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {}
    const entry: JsonRecord = { mode: mode(info), kind: isDir ? "dir" : info.isSocket() ? "sock" : "file" };
    if (entry["kind"] === "file" && relative.endsWith(".json")) {
      try {
        entry["json"] = pyLoads(readFileSync(full, "utf8"));
      } catch {
        entry["json"] = null;
      }
    }
    found[relative] = entry;
  }
  return found;
}

export function daemonPids(data: string): number[] {
  const folder = path.join(data, "Browse");
  const pids: number[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(folder).filter((name) => name.endsWith(".json"));
  } catch {
    return pids;
  }
  for (const name of names) {
    try {
      const value = JSON.parse(readFileSync(path.join(folder, name), "utf8")) as unknown;
      const pid = isRecord(value) ? value["pid"] : undefined;
      if (typeof pid === "number" && Number.isInteger(pid)) pids.push(pid);
    } catch {}
  }
  return pids;
}

export function isolatedEnv(home: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [...KEPT_ENV, ...HARNESS_ENV]) if (process.env[name] !== undefined) env[name] = process.env[name];
  const tmp = path.join(home, "tmp");
  for (const folder of [home, tmp, path.join(home, "config"), path.join(home, "cli"), path.join(home, "xdg-config"), path.join(home, "xdg-data"), path.join(home, "xdg-cache")]) {
    mkdirSync(folder, { recursive: true });
  }
  Object.assign(env, {
    HOME: home,
    TMPDIR: `${tmp}/`,
    ARDIA_CONFIG_HOME: path.join(home, "config"),
    ARDIA_CLI_HOME: path.join(home, "cli"),
    XDG_CONFIG_HOME: path.join(home, "xdg-config"),
    XDG_DATA_HOME: path.join(home, "xdg-data"),
    XDG_CACHE_HOME: path.join(home, "xdg-cache"),
    LANG: "en_US.UTF-8",
    TZ: "UTC",
  });
  Object.assign(env, extra);
  return env;
}

type Ran = { exit: number | null; out: string; err: string; timedOut: boolean };

function runClient(argv: string[], env: NodeJS.ProcessEnv, cwd: string, stdin: string | null, timeoutMs: number): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(argv[0] as string, argv.slice(1), { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.stdin.on("error", () => {});
    child.stdin.end(stdin ?? undefined);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ exit: code ?? (signal ? -constants.signals[signal] : null), out: Buffer.concat(out).toString("utf8"), err: Buffer.concat(err).toString("utf8"), timedOut });
    });
  });
}

export class Side {
  private tap: ReturnType<typeof spawnGroup> | null = null;
  private chrome: ChildProcess | null = null;
  private readonly tapPort: number;
  private readonly chromePort: number;
  private readonly fixturePort: number;

  constructor(private readonly scenario: Scenario, private readonly root: string, private readonly impl: string, ports: Pair, private readonly fixture: string,
              private readonly seed: number, private readonly replay: string | null) {
    [this.chromePort, this.tapPort] = ports;
    this.fixturePort = Number(new URL(fixture).port);
  }

  private home(): string {
    return path.join(this.root, "home");
  }

  private async start(): Promise<void> {
    rmSync(this.root, { recursive: true, force: true });
    mkdirSync(path.join(this.root, "data"), { recursive: true });
    const argv = [bun(), TAP, "--listen", String(this.tapPort), "--out", path.join(this.root, "transcript.jsonl"), "--scratch", this.root];
    if (this.replay !== null) {
      argv.push("--replay", this.replay, "--pace", this.scenario.pace ?? "asap", "--fixture-from", String(recordedFixture(this.replay)), "--fixture-to", String(this.fixturePort));
    } else {
      this.chrome = await launchChrome(this.chromePort, path.join(this.root, "profile"), this.scenario.window ?? DEFAULT_WINDOW);
      argv.push("--upstream", String(this.chromePort), "--chrome-pid", String(this.chrome.pid), "--recorder", "ts");
    }
    this.tap = spawnGroup(argv, { log: path.join(this.root, "tap.log") });
    const line = await firstLine(this.tap, TAP_START_MS);
    if (!line.startsWith("{")) {
      const log = existsSync(path.join(this.root, "tap.log")) ? readFileSync(path.join(this.root, "tap.log"), "utf8").slice(-2000) : "";
      throw new Error(`the tap didn't start: ${log}`);
    }
  }

  private client(step: ScenarioStep): string[] {
    let argv = step.argv.map((arg) => substitute(arg, this.fixture, this.home()));
    if (step.main_world && daemonOf(this.impl) === "ts") argv = mainWorld(argv);
    return [bun(), "--preload", CLIENT_PRELOAD, CLIENT_MAIN, "browse", "--port", String(this.tapPort), "--data-dir", path.join(this.root, "data"),
      "--session", step.session ?? "harness", ...argv];
  }

  private env(): NodeJS.ProcessEnv {
    return isolatedEnv(this.home(), {
      ARDIA_M3_SEED: String(this.seed),
      ARDIA_M3_ANSWERS: path.join(this.root, "answers.jsonl"),
      ARDIA_M3_TS_PROGRAM: tsProgram(),
      ARDIA_BROWSE_CONTENT_BOUNDARIES: "0",
      ...(this.scenario.env ?? {}),
    });
  }

  private answerLinesSince(count: number): string[] {
    const file = path.join(this.root, "answers.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").split(/\r\n|\r|\n/).filter((line) => line.length > 0).slice(count);
  }

  private answersSince(count: number): Json[] {
    return this.answerLinesSince(count).map((line) => pyLoads(line));
  }

  readonly answerLines: string[][] = [];

  private async runStep(index: number, step: ScenarioStep, env: NodeJS.ProcessEnv): Promise<Step> {
    await tapCall(this.tapPort, "/tap/mark", { step: index });
    const before = this.answersSince(0).length;
    const stdin = step.stdin !== undefined && step.stdin !== null ? substitute(step.stdin, this.fixture, this.home()) : null;
    const started = performance.now();
    const ran = await runClient(this.client(step), env, this.home(), stdin, STEP_TIMEOUT_MS);
    this.answerLines.push(this.answerLinesSince(before));
    return { exit: ran.exit, out: ran.out, err: ran.timedOut ? `${ran.err}\n[harness: the step timed out]` : ran.err, answers: this.answersSince(before), interrupted: false,
      fault_fired: null, seconds: Math.round(performance.now() - started) / 1000 };
  }

  private async teardown(env: NodeJS.ProcessEnv): Promise<Step> {
    await tapCall(this.tapPort, "/tap/mark", { step: "teardown" });
    const done = await runClient(this.client({ argv: ["close", "--all"], session: "harness" }), env, this.home(), null, TEARDOWN_TIMEOUT_MS);
    const data = path.join(this.root, "data");
    const deadline = performance.now() + DAEMON_EXIT_MS;
    while (performance.now() < deadline && daemonPids(data).some(alive)) await sleep(50);
    for (const pid of daemonPids(data)) {
      if (alive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
    return { exit: done.exit, out: done.out, err: done.err };
  }

  async run(): Promise<ReplayRun> {
    const result: ReplayRun = { root: this.root, transcript: path.join(this.root, "transcript.jsonl"), steps: [], files: {}, tap: {},
      subs: { root: this.root, tap: this.tapPort, chrome: this.chromePort, fixture: this.fixturePort, fixture_dir: FIXTURES } };
    try {
      await this.start();
      const env = this.env();
      for (const [index, step] of this.scenario.steps.entries()) result.steps.push(await this.runStep(index, step, env));
      await sleep(Number(this.scenario.settle ?? 0) * 1000);
      result.files = browseFiles(path.join(this.root, "data"));
      result.steps.push({ ...(await this.teardown(env)), answers: [], teardown: true });
      await sleep(300);
      result.tap = await tapCall(this.tapPort, "/tap/state");
    } finally {
      await this.close();
    }
    writeFileSync(path.join(this.root, "result.json"), JSON.stringify({ steps: result.steps, files: result.files, tap: result.tap, subs: result.subs }, null, 1));
    result.answerLines = this.answerLines;
    return result;
  }

  private async close(): Promise<void> {
    const tap = this.tap;
    if (tap !== null) {
      tap.stdout?.destroy();
      if (tap.exitCode === null && tap.signalCode === null) {
        try {
          await tapCall(this.tapPort, "/tap/quit", {});
          if (!(await exited(tap, 5000))) await stop(tap);
        } catch {
          await stop(tap);
        }
      }
    }
    await stop(this.chrome);
    this.chrome = null;
    rmSync(path.join(this.root, "profile"), { recursive: true, force: true });
  }
}
