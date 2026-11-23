import { codePoints } from "../../pystr.ts";
import { redact } from "../../redact.ts";
import { ConnectionLost, BrowseError, OutcomeUnknown, Usage } from "../daemon-errors.ts";
import { type Action, candidateArgv, fingerprintArgv, isElementAction, pageArgv, unfilled } from "./actions.ts";
import { type Candidate, selectorOf } from "./locators.ts";

export const FATAL = new Set([
  "outcome_unknown", "policy_refused", "tab_gone", "tab_detached", "session_busy", "page_busy", "navigation_failed", "connection_lost", "fetch_interrupted",
]);
export const SNAPSHOT_LIMIT = 6000;
export const ERROR_LIMIT = 300;
const REDACTED = "<redacted>";

export type Tier = "selector" | "candidate" | "escape" | "fingerprint" | "command";
export type Attempt = { tier: Tier; argv: string[]; ok: boolean; code?: string; error?: string };
export type StepOutcome = { seq: number; intent: string; ok: boolean; tier: Tier | null; attempts: Attempt[]; skipped?: string; fatal?: string };
export type Episode = {
  kind: "fallback" | "healed";
  at: string;
  flow: string;
  site: string;
  seq: number;
  type: string;
  intent: string;
  url: string;
  tier: Tier | null;
  candidate: number | null;
  fingerprint: { role: string; name: string } | null;
  tried: Attempt[];
  fatal?: string;
  snapshot?: string;
  values?: Record<string, string>;
  matched?: Candidate | null;
};

export function scrubbed<T>(value: T, secrets: readonly string[]): T {
  if (typeof value === "string") {
    let text = redact(value);
    for (const secret of secrets) if (secret) text = text.replaceAll(secret, REDACTED);
    return text as T;
  }
  if (Array.isArray(value)) return value.map((item) => scrubbed(item, secrets)) as T;
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubbed(item, secrets)])) as T;
  return value;
}

export interface Driver {
  run(argv: string[]): Promise<void>;
  snapshot(): Promise<string>;
  url(): string;
  count(selector: string): Promise<number>;
}

export type ReplayStep = { seq: number; action: Action | null; command?: string[] | null };

function clip(text: string, limit: number): string {
  const points = codePoints(text);
  return points.length <= limit ? text : `${points.slice(0, limit - 1).join("")}…`;
}

function shown(argv: readonly string[], secrets: readonly string[]): string[] {
  return argv.map((part) => (secrets.some((secret) => secret && part.includes(secret)) ? REDACTED : redact(part)));
}

class Fatal extends Error {
  constructor(readonly reason: unknown) {
    super(reason instanceof Error ? reason.message : String(reason));
  }
}

async function attempt(driver: Driver, tier: Tier, argv: string[], secrets: readonly string[], tried: Attempt[]): Promise<boolean> {
  try {
    await driver.run(argv);
    tried.push({ tier, argv: shown(argv, secrets), ok: true });
    return true;
  } catch (error) {
    if (error instanceof ConnectionLost || error instanceof OutcomeUnknown) throw new Fatal(error);
    if (!(error instanceof BrowseError)) throw error;
    const code = error instanceof Usage ? "usage" : (error.code ?? "failed");
    tried.push({ tier, argv: shown(argv, secrets), ok: false, code, error: clip(String(error.text ?? error.message), ERROR_LIMIT) });
    if (FATAL.has(code)) throw new Fatal(error);
    return false;
  }
}

async function countOf(driver: Driver, selector: string): Promise<number> {
  try {
    return await driver.count(selector);
  } catch (error) {
    if (error instanceof ConnectionLost || error instanceof OutcomeUnknown) throw new Fatal(error);
    if (!(error instanceof BrowseError)) throw error;
    return 0;
  }
}

function same(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((part, index) => part === b[index]);
}

export async function replayStep(driver: Driver, step: ReplayStep, values: Readonly<Record<string, string>>, secrets: readonly string[] = []): Promise<StepOutcome & { candidate: number | null }> {
  const action = step.action;
  const tried: Attempt[] = [];
  const outcome = (ok: boolean, tier: Tier | null, candidate: number | null = null, extra: Partial<StepOutcome> = {}) => ({
    seq: step.seq,
    intent: action?.intent ?? (step.command ?? []).join(" "),
    ok,
    tier,
    attempts: tried,
    candidate,
    ...extra,
  });
  try {
    if (action === null || !isElementAction(action)) {
      const argv = action !== null ? pageArgv(action, values) : null;
      if (argv === null) return outcome(true, null, null, { skipped: "this step has nothing a replay can run" });
      const missing = unfilled(argv);
      if (missing.length > 0 || argv.includes(REDACTED)) return outcome(false, null, null, { fatal: `it needs ${missing.length > 0 ? missing.map((name) => `--param ${name}=…`).join(" ") : "a secret the flow never keeps"}` });
      return (await attempt(driver, "command", argv, secrets, tried)) ? outcome(true, "command") : outcome(false, null);
    }
    const ladder = action.candidates.map((candidate) => candidateArgv(action, candidate, values));
    const missing = unfilled(ladder.flat());
    if (missing.length > 0) return outcome(false, null, null, { fatal: `it needs ${missing.map((name) => `--param ${name}=…`).join(" ")}` });
    const tryCandidate = async (tier: Tier, index: number): Promise<boolean> => {
      const candidate = action.candidates[index] as Candidate;
      const argv = ladder[index] as string[];
      if (candidate.by !== "role") {
        const matches = await countOf(driver, selectorOf(candidate));
        if (matches !== 1) {
          tried.push({ tier, argv: shown(argv, secrets), ok: false, code: matches === 0 ? "not_found" : "ambiguous", error: `${matches} elements match ${clip(selectorOf(candidate), 120)}; a replay acts only on exactly one` });
          return false;
        }
      }
      return attempt(driver, tier, argv, secrets, tried);
    };
    for (const index of ladder.keys()) {
      if (await tryCandidate(index === 0 ? "selector" : "candidate", index)) return outcome(true, index === 0 ? "selector" : "candidate", index);
    }
    if (ladder.length > 0) {
      try {
        await driver.run(["press", "Escape"]);
      } catch (error) {
        if (error instanceof ConnectionLost || error instanceof OutcomeUnknown) throw new Fatal(error);
        if (!(error instanceof BrowseError)) throw error;
      }
      for (const index of ladder.keys()) {
        if (await tryCandidate("escape", index)) return outcome(true, "escape", index);
      }
    }
    const byFingerprint = fingerprintArgv(action, action.fingerprint, values);
    if (byFingerprint !== null && !ladder.some((argv) => same(argv, byFingerprint))) {
      if (await attempt(driver, "fingerprint", byFingerprint, secrets, tried)) return outcome(true, "fingerprint");
    }
    return outcome(false, null);
  } catch (error) {
    if (!(error instanceof Fatal)) throw error;
    const cause = error.reason;
    if (cause instanceof ConnectionLost) throw cause;
    return outcome(false, null, null, { fatal: clip(cause instanceof BrowseError ? String(cause.text ?? cause.message) : String(cause), ERROR_LIMIT) });
  }
}

export type ReplayReport = { ok: boolean; outcomes: StepOutcome[]; episodes: Episode[] };

export async function replay(
  driver: Driver,
  flow: { name: string; site: string },
  steps: readonly ReplayStep[],
  values: Readonly<Record<string, string>>,
  secrets: readonly string[] = [],
  now: () => string = () => `${new Date().toISOString().slice(0, 19)}Z`,
): Promise<ReplayReport> {
  const outcomes: StepOutcome[] = [];
  const episodes: Episode[] = [];
  for (const step of steps) {
    const url = driver.url();
    const result = await replayStep(driver, step, values, secrets);
    const { candidate, ...kept } = result;
    outcomes.push(kept);
    const action = step.action;
    const base = {
      at: now(),
      flow: flow.name,
      site: flow.site,
      seq: step.seq,
      type: action?.type ?? "command",
      intent: kept.intent,
      url,
      tier: kept.tier,
      candidate,
      matched: candidate !== null && action ? (action.candidates[candidate] ?? null) : null,
      fingerprint: action?.fingerprint ?? null,
      tried: kept.attempts,
    };
    if (kept.ok && kept.tier !== null && kept.tier !== "selector" && kept.tier !== "command") episodes.push({ kind: "healed", ...base });
    if (!kept.ok) {
      let snapshot = "";
      try {
        snapshot = clip(redact(await driver.snapshot()), SNAPSHOT_LIMIT);
      } catch (error) {
        if (error instanceof ConnectionLost) throw error;
        if (!(error instanceof BrowseError)) throw error;
      }
      for (const secret of secrets) if (secret) snapshot = snapshot.replaceAll(secret, REDACTED);
      episodes.push({ kind: "fallback", ...base, ...(kept.fatal ? { fatal: kept.fatal } : {}), snapshot });
      return { ok: false, outcomes: scrubbed(outcomes, secrets), episodes: scrubbed(episodes, secrets) };
    }
  }
  return { ok: true, outcomes: scrubbed(outcomes, secrets), episodes: scrubbed(episodes, secrets) };
}
