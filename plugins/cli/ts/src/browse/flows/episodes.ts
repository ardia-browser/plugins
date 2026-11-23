import { dumps, type Value } from "../../json.ts";
import { codeOf } from "../../paths.ts";
import { renameAt } from "../../libc.ts";
import { plainParams } from "../cdp/params.ts";
import { BrowseError, Usage } from "../daemon-errors.ts";
import { pyValue } from "../daemon/render.ts";
import { closeFd, O_CREAT, O_TRUNC, O_WRONLY, openPrivate, openPrivateFile, PathError, readPrivateJson, writeAllFd } from "../paths.ts";
import { type Action, candidatesFromSelector, ELEMENT_ACTIONS, paramsIn } from "./actions.ts";
import { type Candidate, CANDIDATE_KINDS, candidateProblem, type Fingerprint, MAX_CANDIDATES, selectorOf, sortCandidates } from "./locators.ts";
import type { Episode } from "./replay.ts";

export const EPISODE_LIMIT = 20;
export const EPISODE_BYTES = 512 * 1024;
const DIR_NAME = "Flows";

type Json = Record<string, any>;

export function episodesFile(name: string): string {
  return `${name}.episodes.json`;
}

function folder(root: string, site: string, create: boolean): number | null {
  try {
    return openPrivate(root, [DIR_NAME, site], create);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    if (error instanceof PathError) {
      if (!create && error.message.includes("doesn't exist")) return null;
      throw new BrowseError(error.message);
    }
    throw error;
  }
}

export function loadEpisodes(root: string, site: string, name: string): Episode[] {
  const dir = folder(root, site, false);
  if (dir === null) return [];
  let value: Value | undefined;
  try {
    value = readPrivateJson(episodesFile(name), dir, EPISODE_BYTES);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return [];
    if (error instanceof PathError) return [];
    throw error;
  } finally {
    closeFd(dir);
  }
  const plain = value === undefined ? null : plainParams(value);
  return Array.isArray(plain) ? (plain.filter((item) => item !== null && typeof item === "object" && typeof item.seq === "number") as Episode[]) : [];
}

export function writeEpisodes(root: string, site: string, name: string, episodes: readonly Episode[]): void {
  const dir = folder(root, site, true) as number;
  const file = episodesFile(name);
  let kept = episodes.slice(-EPISODE_LIMIT);
  let data = Buffer.from(dumps(pyValue(kept), "indented", false, false, 1), "utf8");
  while (data.length > EPISODE_BYTES && kept.length > 1) {
    kept = kept.slice(1);
    data = Buffer.from(dumps(pyValue(kept), "indented", false, false, 1), "utf8");
  }
  const temp = `.${file}.${process.pid}.tmp`;
  try {
    const fd = openPrivateFile(temp, dir, O_WRONLY | O_CREAT | O_TRUNC);
    try {
      writeAllFd(fd, data);
    } finally {
      closeFd(fd);
    }
    renameAt(dir, temp, file);
  } finally {
    closeFd(dir);
  }
}

export function addEpisodes(root: string, site: string, name: string, fresh: readonly Episode[]): void {
  if (fresh.length === 0) return;
  writeEpisodes(root, site, name, [...loadEpisodes(root, site, name), ...fresh]);
}

export type Change = { seq: number; candidates: Candidate[]; fingerprint?: Fingerprint | null; intent?: string; why: string };
export type Rejection = { seq: number; what: string; why: string };

function stepAt(flow: Json, seq: number): Json | null {
  for (const step of flow["steps"] ?? []) if (step && step["seq"] === seq) return step;
  return null;
}

function same(a: Candidate, b: Candidate): boolean {
  return a.by === b.by && a.value === b.value && (a.name ?? "") === (b.name ?? "") && (a.tag ?? "") === (b.tag ?? "");
}

export function proposals(flow: Json, episodes: readonly Episode[]): Change[] {
  const changes = new Map<number, Change>();
  for (const episode of episodes) {
    if (episode.kind !== "healed" || episode.flow !== flow["name"]) continue;
    const step = stepAt(flow, episode.seq);
    const action = step?.["action"] as Action | undefined;
    if (!action) continue;
    const current = changes.get(episode.seq)?.candidates ?? action.candidates;
    if (episode.tier === "fingerprint") {
      const fingerprint = episode.fingerprint;
      if (!fingerprint || !action.fingerprint || fingerprint.role !== action.fingerprint.role || fingerprint.name !== action.fingerprint.name) continue;
      const role: Candidate = { by: "role", value: fingerprint.role, name: fingerprint.name };
      if (current[0] && same(current[0], role)) continue;
      changes.set(episode.seq, {
        seq: episode.seq,
        candidates: [role, ...current.filter((candidate) => !same(candidate, role))].slice(0, MAX_CANDIDATES),
        why: `its selectors stopped matching and the ${fingerprint.role} named "${fingerprint.name}" was found by role and name`,
      });
    } else if ((episode.tier === "candidate" || episode.tier === "escape") && episode.matched) {
      const winner = current.find((candidate) => same(candidate, episode.matched as Candidate));
      if (!winner || same(current[0] as Candidate, winner)) continue;
      changes.set(episode.seq, {
        seq: episode.seq,
        candidates: [winner, ...current.filter((candidate) => !same(candidate, winner))],
        why: `${selectorOf(winner)} matched where the first locator no longer did`,
      });
    }
  }
  return [...changes.values()];
}

export function runValues(flow: Json, episodes: readonly Episode[] = []): string[] {
  const values = new Set<string>();
  for (const episode of episodes) for (const value of Object.values(episode.values ?? {})) if (typeof value === "string" && value) values.add(value);
  for (const param of flow["params"] ?? []) if (typeof param?.["example"] === "string" && param["example"]) values.add(param["example"]);
  for (const step of flow["steps"] ?? []) {
    const value = step?.["action"]?.["value"];
    if (step?.["action"]?.["type"] !== "open" && typeof value === "string" && value && paramsIn(value).length === 0 && !["Enter", "Tab", "Escape"].includes(value)) values.add(value);
  }
  return [...values];
}

export type Patch = { steps: { seq: number; candidates?: Candidate[]; selector?: string; fingerprint?: Fingerprint | null; intent?: string }[] };

const PATCH_STEP_FIELDS = new Set(["seq", "candidates", "selector", "fingerprint", "intent"]);
const PATCH_SHAPE = 'A heal patch is {"steps": [{"seq": n, "candidates": [{"by": "aria-label", "value": "…"}], "fingerprint": {"role": "…", "name": "…"}, "intent": "…"}]}';

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parsePatch(raw: unknown): Patch {
  if (!plainObject(raw) || !Array.isArray(raw["steps"]) || raw["steps"].length === 0 || Object.keys(raw).some((key) => key !== "steps")) throw new Usage(PATCH_SHAPE);
  const seen = new Set<number>();
  for (const [index, step] of raw["steps"].entries()) {
    const where = `heal patch step ${index + 1}`;
    if (!plainObject(step)) throw new Usage(`${where} isn't an object. ${PATCH_SHAPE}`);
    const unknown = Object.keys(step).filter((key) => !PATCH_STEP_FIELDS.has(key));
    if (unknown.length > 0) throw new Usage(`${where} has fields a patch doesn't have: ${unknown.join(", ")}`);
    if (!Number.isInteger(step["seq"]) || (step["seq"] as number) < 1) throw new Usage(`${where} needs "seq", a step number from \`flow show\``);
    if (seen.has(step["seq"] as number)) throw new Usage(`${where} repeats step ${step["seq"]}`);
    seen.add(step["seq"] as number);
    if (step["selector"] !== undefined && (typeof step["selector"] !== "string" || !step["selector"].trim())) throw new Usage(`${where} has a "selector" that isn't text`);
    if (step["candidates"] !== undefined) {
      if (!Array.isArray(step["candidates"]) || step["candidates"].length > MAX_CANDIDATES) throw new Usage(`${where} has "candidates" that aren't a list of up to ${MAX_CANDIDATES}`);
      for (const candidate of step["candidates"]) {
        if (!plainObject(candidate) || typeof candidate["by"] !== "string" || typeof candidate["value"] !== "string" || Object.keys(candidate).some((key) => !["by", "value", "tag", "name"].includes(key))) {
          throw new Usage(`${where} has a candidate that isn't {"by": kind, "value": text}`);
        }
        if (!(CANDIDATE_KINDS as readonly string[]).includes(candidate["by"])) throw new Usage(`${where} has a candidate of kind ${candidate["by"]}; kinds are ${CANDIDATE_KINDS.join(", ")}`);
        if ((candidate["tag"] !== undefined && typeof candidate["tag"] !== "string") || (candidate["name"] !== undefined && typeof candidate["name"] !== "string")) throw new Usage(`${where} has a candidate whose tag or name isn't text`);
      }
    }
    const fingerprint = step["fingerprint"];
    if (fingerprint !== undefined && fingerprint !== null && (!plainObject(fingerprint) || typeof fingerprint["role"] !== "string" || typeof fingerprint["name"] !== "string")) {
      throw new Usage(`${where} has a "fingerprint" that isn't {"role": text, "name": text}`);
    }
    if (step["intent"] !== undefined && typeof step["intent"] !== "string") throw new Usage(`${where} has an "intent" that isn't text`);
    if (step["selector"] === undefined && step["candidates"] === undefined && fingerprint === undefined && step["intent"] === undefined) throw new Usage(`${where} changes nothing`);
  }
  return raw as Patch;
}

export function applyPatch(flow: Json, patch: Patch, episodes: readonly Episode[] = []): { flow: Json; changes: Change[]; rejected: Rejection[] } {
  const next = structuredClone(flow);
  const values = runValues(flow, episodes);
  const changes: Change[] = [];
  const rejected: Rejection[] = [];
  for (const item of patch.steps) {
    const step = stepAt(next, item.seq);
    const action = step?.["action"] as Action | undefined;
    if (!step || !action || !(ELEMENT_ACTIONS as readonly string[]).includes(action.type)) {
      rejected.push({ seq: item.seq, what: "the step", why: "it has no recorded element action to heal" });
      continue;
    }
    const offered = [...(item.selector ? candidatesFromSelector(item.selector) : []), ...(item.candidates ?? [])];
    const good: Candidate[] = [];
    let refused = false;
    for (const candidate of offered) {
      const problem = candidateProblem(candidate, values);
      if (problem) {
        rejected.push({ seq: item.seq, what: `${candidate.by} ${JSON.stringify(candidate.value)}`, why: problem });
        refused = true;
      } else good.push(candidate);
    }
    let fingerprint: Fingerprint | null | undefined;
    if (item.fingerprint !== undefined) {
      if (item.fingerprint === null) fingerprint = null;
      else {
        const role: Candidate = { by: "role", value: String(item.fingerprint.role ?? ""), name: String(item.fingerprint.name ?? "") };
        const problem = candidateProblem(role, values);
        if (problem) {
          rejected.push({ seq: item.seq, what: `fingerprint ${role.value} "${role.name}"`, why: problem });
          refused = true;
        } else fingerprint = { role: role.value, name: role.name as string };
      }
    }
    let intent: string | undefined;
    if (item.intent !== undefined) {
      const problem = typeof item.intent !== "string" || item.intent.length > 120 || item.intent.includes("\n") ? "an intent is one short line" : null;
      if (problem) {
        rejected.push({ seq: item.seq, what: "intent", why: problem });
        refused = true;
      } else intent = item.intent;
    }
    if (refused) continue;
    const merged = sortCandidates([...good, ...action.candidates.filter((candidate) => !good.some((given) => same(given, candidate)))]);
    const promoted = [...good, ...merged.filter((candidate) => !good.some((given) => same(given, candidate)))].slice(0, MAX_CANDIDATES);
    action.candidates = promoted;
    if (fingerprint !== undefined) action.fingerprint = fingerprint;
    if (intent !== undefined) action.intent = intent;
    changes.push({ seq: item.seq, candidates: promoted, ...(fingerprint !== undefined ? { fingerprint } : {}), ...(intent !== undefined ? { intent } : {}), why: "a patch" });
  }
  return { flow: next, changes, rejected };
}

export function applyProposals(flow: Json, changes: readonly Change[]): Json {
  const next = structuredClone(flow);
  for (const change of changes) {
    const action = stepAt(next, change.seq)?.["action"] as Action | undefined;
    if (!action) continue;
    action.candidates = change.candidates.filter((candidate) => candidateProblem(candidate) === null).slice(0, MAX_CANDIDATES);
  }
  return next;
}
