import bundled from "../assets/triage-playbook.md" with { type: "text" };
import { envSet } from "./paths.ts";
import { loopbackUrl } from "./telemetry.ts";
import { isDevBuild } from "./version.ts";

const REPOSITORY = "ardia-browser/ardia";
const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";
const PLAYBOOK_PATH = ".github/triage/PLAYBOOK.md";
const TEST_URL_ENV = "ARDIA_TRIAGE_PLAYBOOK_URL";
const DEADLINE_MS = 5000;
const MAX_TAGS_BYTES = 4 * 1024 * 1024;
const MAX_PLAYBOOK_BYTES = 256 * 1024;
const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)(?:-nightly\.(\d+))?$/;

export type Playbook = { text: string; source: string };

export function bundledPlaybook(): string {
  return bundled;
}

function versionKey(tag: string): number[] | undefined {
  const found = RELEASE_TAG.exec(tag);
  if (found === null) return undefined;
  const [major, minor, patch] = [found[1], found[2], found[3]].map(Number) as [number, number, number];
  const nightly = found[4];
  return [major, minor, patch, nightly === undefined ? 1 : 0, nightly === undefined ? 0 : Number(nightly)];
}

function newer(left: number[], right: number[]): boolean {
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] as number;
    const b = right[index] as number;
    if (a !== b) return a > b;
  }
  return false;
}

export function newestReleaseTag(refs: unknown): string | undefined {
  if (!Array.isArray(refs)) return undefined;
  let best: [string, number[]] | undefined;
  for (const entry of refs) {
    const ref = (entry as { ref?: unknown } | null)?.ref;
    if (typeof ref !== "string" || !ref.startsWith("refs/tags/")) continue;
    const tag = ref.slice("refs/tags/".length);
    const key = versionKey(tag);
    if (key !== undefined && (best === undefined || newer(key, best[1]))) best = [tag, key];
  }
  return best?.[0];
}

function bases(): { api: string; raw: string } | undefined {
  const override = envSet(TEST_URL_ENV);
  if (override !== undefined) {
    const base = override.replace(/\/+$/, "");
    return loopbackUrl(`${base}/`) ? { api: base, raw: base } : undefined;
  }
  if (isDevBuild()) return undefined;
  return { api: API, raw: RAW };
}

async function limited(response: Response, limit: number): Promise<Buffer | undefined> {
  const reader = response.body?.getReader();
  if (reader === undefined) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function get(url: string, limit: number, signal: AbortSignal): Promise<Buffer | undefined> {
  const response = await fetch(url, { signal, redirect: "follow", headers: { Accept: "application/vnd.github+json", "User-Agent": "ardia-triage" } });
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    return undefined;
  }
  return limited(response, limit);
}

export async function fetchPlaybook(): Promise<Playbook> {
  const fallback = { text: bundled, source: "the copy built into this ardia" };
  const where = bases();
  if (where === undefined) return { ...fallback, source: `${fallback.source} (a checkout build doesn't fetch it)` };
  const signal = AbortSignal.timeout(DEADLINE_MS);
  try {
    const refs = await get(`${where.api}/repos/${REPOSITORY}/git/matching-refs/tags/v`, MAX_TAGS_BYTES, signal);
    if (refs === undefined) return fallback;
    const tag = newestReleaseTag(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(refs)));
    if (tag === undefined) return fallback;
    const raw = await get(`${where.raw}/${REPOSITORY}/${tag}/${PLAYBOOK_PATH}`, MAX_PLAYBOOK_BYTES, signal);
    if (raw === undefined || raw.length === 0) return fallback;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    return { text, source: `${PLAYBOOK_PATH} at ${tag} of ${REPOSITORY}` };
  } catch {
    return fallback;
  }
}
