import type { JsonObject, Value } from "../json.ts";
import { pyEqual } from "./pyvalue.ts";
import { entriesFor, entryValue, isGeneration, recordId } from "./records.ts";
import { EXTENSION, GENERATION, generationText, loads, type Outcome, STATUS_TIMEOUT_MS, Store } from "./store.ts";
import { closeFd, listNames, openDir, readFile, StoreError, writeAtomic } from "./store-fs.ts";

export { StoreError };

const STATUS_POLL_MS = 100;

export function consistent(store: Store, records: JsonObject[]): boolean {
  if (records.length === 0) return !store.extensionPresent();
  if (!store.extensionPresent()) return false;
  const root = store.rootFd as number;
  const fd = openDir(root, EXTENSION, false);
  try {
    const manifest = loads(readFile(fd, "manifest.json"));
    const expected = records.flatMap((meta) => entriesFor(meta)).map(entryValue);
    if (!(manifest instanceof Map) || !pyEqual(manifest.get("content_scripts") ?? null, expected)) return false;
    const jsFd = openDir(fd, "js", false);
    try {
      const names = listNames(jsFd).sort();
      const wanted = records.map((meta) => `${recordId(meta)}.js`).sort();
      if (names.length !== wanted.length || names.some((name, index) => name !== wanted[index])) return false;
      for (const meta of records) {
        const recordFd = openDir(store.recordsFd as number, recordId(meta), false);
        try {
          const left = readFile(recordFd, "script.js");
          const right = readFile(jsFd, `${recordId(meta)}.js`);
          if (left === null || right === null ? left !== right : !left.equals(right)) return false;
        } finally {
          closeFd(recordFd);
        }
      }
    } finally {
      closeFd(jsFd);
    }
  } catch (error) {
    if (error instanceof StoreError && /wrong type|isn't a number/.test(error.message)) throw error;
    return false;
  } finally {
    closeFd(fd);
  }
  return true;
}

export function repair(store: Store): string | null {
  const records = store.installed();
  if (!consistent(store, records)) {
    const [, generation] = store.apply();
    return `the installed scripts and the extension disagreed; rebuilt it as generation ${generation}`;
  }
  const current = store.generation();
  if (store.extensionPresent()) {
    const published = store.extensionGeneration();
    if (published > current) {
      writeAtomic(store.rootFd as number, GENERATION, generationText(published));
      return `a run stopped before publishing generation ${published}; published it`;
    }
    if (published < current) {
      const [, generation] = store.apply();
      return `the extension was older than generation ${current}; rebuilt it as generation ${generation}`;
    }
    return null;
  }
  const status = store.status() ?? new Map<string, Value>();
  const reported = status.get("generation");
  const profiles = status.get("profiles");
  const stillLoaded = profiles instanceof Map && [...profiles.values()].some((result) => result instanceof Map && truthy(result.get("ok")));
  if (isGeneration(reported) && reported >= current && stillLoaded) {
    const [, generation] = store.apply();
    return `the last uninstall stopped before telling Ardia; published generation ${generation}`;
  }
  return null;
}

export async function waitStatus(store: Store, generation: bigint, alive: () => boolean, stopped: () => boolean): Promise<[Outcome | "interrupted", JsonObject | null]> {
  const deadline = performance.now() + STATUS_TIMEOUT_MS;
  for (;;) {
    if (stopped()) return ["interrupted", null];
    const status = store.status();
    const reported = status?.get("generation");
    if (isGeneration(reported) && reported >= generation) return [reported > generation ? "superseded" : "reported", status];
    if (!alive()) return ["quit", null];
    if (performance.now() >= deadline) return ["timeout", null];
    await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_MS));
  }
}

export function truthy(value: Value | undefined): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "bigint") return value !== 0n;
  if (typeof value === "string" || Array.isArray(value)) return value.length > 0;
  if (value instanceof Map) return value.size > 0;
  if (value === true) return true;
  return value.value !== 0;
}

export async function repairIfPresent(dataRoot: string, stopped: () => boolean): Promise<string | null> {
  const store = new Store(dataRoot);
  try {
    if (!store.open(false) || (store.recordsFd === null && !store.extensionPresent() && !store.generation())) return null;
    await store.lock(stopped);
    if (store.recordsFd === null) store.recordsFd = openDir(store.rootFd as number, "scripts", true);
    return repair(store);
  } finally {
    store.close();
  }
}
