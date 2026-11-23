import fs from "node:fs";
import { dumps, type JsonObject, parse, type Value } from "../json.ts";
import { errnoOf, realpath, strerror } from "../paths.ts";
import { compareText } from "../pylib/str.ts";
import { utf8 } from "../pystr.ts";
import type { Build } from "./build.ts";
import { Interrupted } from "./output.ts";
import { getOr, pyCompare, pyEqual, Uncomparable } from "./pyvalue.ts";
import { entriesFor, entryValue, isGeneration, MAX_MANIFEST, manifestValue, metaValue, now, readIntText, recordId, validateManifest } from "./records.ts";
import {
  closeFd, exists, isDir, isLink, listNames, lstatAt, makeDir, openDir, openLock, readFile, removeTree, renameIn, StoreError, stagingDir, swap, tokenHex, tryLock, writeAtomic, writeFile,
} from "./store-fs.ts";
import { fileName } from "./userscript.ts";

export { StoreError } from "./store-fs.ts";
export { OsError } from "./store-fs.ts";

const LOCK_TIMEOUT_MS = 30_000;
const LOCK_POLL_MS = 50;
export const STATUS_TIMEOUT_MS = 10_000;
export const EXTENSION = "extension";
export const GENERATION = "generation";
const STATUS = "status.json";
const SOURCE_SUFFIXES = [".ts", ".mts", ".js", ".mjs"];
const ENOENT = 2;

export type Outcome = "superseded" | "reported" | "quit" | "timeout";

export function loads(data: Buffer | null): Value | undefined {
  return parse(data !== null && data.length > 0 ? data : Buffer.from("null"), Number.POSITIVE_INFINITY);
}

function jsonFile(value: Value): Buffer {
  return utf8(`${dumps(value, "indented", false)}\n`);
}

export function generationText(generation: bigint): Buffer {
  return Buffer.from(`${generation}\n`);
}

function readInt(dir: number | null, name: string): bigint {
  if (dir === null) return 0n;
  let data: Buffer | null;
  try {
    data = readFile(dir, name);
  } catch {
    return 0n;
  }
  return readIntText(data);
}

function byInstall(left: JsonObject, right: JsonObject): number {
  try {
    return pyCompare(getOr(left, "installed_at", 0n), getOr(right, "installed_at", 0n)) || pyCompare(recordId(left), recordId(right));
  } catch (error) {
    if (error instanceof Uncomparable) throw new StoreError("an installed script's meta.json has an installed_at that isn't a number; reinstall it");
    throw error;
  }
}

type Committed = { id: string; aside: string | null; kind: "added" | "replaced" | "removed" };

export class Store {
  readonly path: string;
  rootFd: number | null = null;
  recordsFd: number | null = null;
  lockFd: number | null = null;

  constructor(readonly dataRoot: string) {
    this.path = dataRoot === "/" ? "/Scripts" : dataRoot === "." ? "Scripts" : `${dataRoot}/Scripts`;
  }

  open(create: boolean): boolean {
    let base: number;
    try {
      base = fs.openSync(this.dataRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    } catch (error) {
      const errno = errnoOf(error);
      if (errno === ENOENT) {
        if (!create) return false;
        throw new StoreError(`${this.dataRoot} doesn't exist`);
      }
      if (errno === 0) throw error;
      throw new StoreError(`can't open ${this.dataRoot} (${strerror(errno)})`);
    }
    try {
      if (!create && !exists(base, "Scripts")) return false;
      this.rootFd = openDir(base, "Scripts", create);
    } finally {
      closeFd(base);
    }
    if (create || exists(this.rootFd, "scripts")) this.recordsFd = openDir(this.rootFd, "scripts", create);
    return true;
  }

  async lock(stopped: () => boolean): Promise<void> {
    const fd = openLock(this.rootFd as number);
    const deadline = performance.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      if (tryLock(fd)) break;
      if (performance.now() >= deadline) {
        closeFd(fd);
        throw new StoreError(`another ardia scripts command or Ardia has held ${this.path}/.lock for ${LOCK_TIMEOUT_MS / 1000}s`);
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
      if (stopped()) {
        closeFd(fd);
        throw new Interrupted();
      }
    }
    this.lockFd = fd;
  }

  unlock(): void {
    closeFd(this.lockFd);
    this.lockFd = null;
  }

  close(): void {
    this.unlock();
    closeFd(this.recordsFd);
    closeFd(this.rootFd);
    this.recordsFd = null;
    this.rootFd = null;
  }

  readRecord(name: string): JsonObject | null {
    const fd = openDir(this.recordsFd as number, name, false);
    let meta: Value | undefined;
    try {
      meta = loads(readFile(fd, "meta.json"));
    } finally {
      closeFd(fd);
    }
    return meta instanceof Map && pyEqual(meta.get("id"), name) ? meta : null;
  }

  installed(): JsonObject[] {
    if (this.recordsFd === null) return [];
    const found: JsonObject[] = [];
    for (const name of listNames(this.recordsFd).sort(compareText)) {
      if (name.startsWith(".")) continue;
      const info = lstatAt(this.recordsFd, name);
      if (isLink(info.mode)) throw new StoreError(`${this.path}/scripts/${name} is a symbolic link; remove it`);
      if (!isDir(info.mode)) continue;
      const meta = this.readRecord(name);
      if (meta && meta.size > 0) found.push(meta);
    }
    return found.sort(byInstall);
  }

  find(name: string): JsonObject | undefined {
    const scripts = this.installed();
    return scripts.find((meta) => pyEqual(meta.get("name"), name)) ?? scripts.find((meta) => recordId(meta) === name);
  }

  status(): JsonObject | null {
    if (this.rootFd === null) return null;
    let data: Value | undefined;
    try {
      data = loads(readFile(this.rootFd, STATUS));
    } catch {
      return null;
    }
    return data instanceof Map ? data : null;
  }

  generation(): bigint {
    return readInt(this.rootFd, GENERATION);
  }

  extensionGeneration(): bigint {
    if (this.rootFd === null || !exists(this.rootFd, EXTENSION)) return 0n;
    let fd: number;
    try {
      fd = openDir(this.rootFd, EXTENSION, false);
    } catch {
      return 0n;
    }
    try {
      return readInt(fd, GENERATION);
    } finally {
      closeFd(fd);
    }
  }

  extensionPresent(): boolean {
    return this.rootFd !== null && exists(this.rootFd, EXTENSION);
  }

  nextGeneration(): bigint {
    const reported = (this.status() ?? new Map()).get("generation");
    const values = [this.generation(), this.extensionGeneration(), isGeneration(reported) ? reported : 0n];
    return values.reduce((a, b) => (a > b ? a : b)) + 1n;
  }

  stageRecord(build: Build): [string, JsonObject] {
    const records = this.recordsFd as number;
    const meta = build.meta;
    const id = metaValue(meta).get("id") as string;
    const previous = exists(records, id) ? this.readRecord(id) : null;
    const stamp = now();
    const record = metaValue(meta);
    record.set("source_file", realpath(build.path));
    const name = fileName(build.path);
    record.set("source", `source${SOURCE_SUFFIXES.find((suffix) => name.endsWith(suffix)) ?? ".js"}`);
    record.set("installed_at", previous ? getOr(previous, "installed_at", stamp) : stamp);
    record.set("updated_at", stamp);
    record.set("updated", previous !== null);
    const [staged, fd] = stagingDir(records, `stage-${id}`);
    try {
      writeFile(fd, record.get("source") as string, utf8(build.source));
      writeFile(fd, "script.js", utf8(build.js));
      writeFile(fd, "meta.json", jsonFile(record));
    } catch (error) {
      closeFd(fd);
      removeTree(records, staged);
      throw error;
    }
    closeFd(fd);
    return [staged, record];
  }

  buildExtension(plan: [JsonObject, string][], generation: bigint): string {
    const root = this.rootFd as number;
    const [name, fd] = stagingDir(root, "extension");
    try {
      makeDir(fd, "js", 0o755);
      const jsFd = openDir(fd, "js", false);
      const entries = [];
      try {
        for (const [meta, folder] of plan) {
          const recordFd = openDir(this.recordsFd as number, folder, false);
          let script: Buffer | null;
          try {
            script = readFile(recordFd, "script.js");
          } finally {
            closeFd(recordFd);
          }
          if (script === null) throw new StoreError(`${recordId(meta)} has no script.js; reinstall it`);
          writeFile(jsFd, `${recordId(meta)}.js`, script);
          entries.push(...entriesFor(meta));
        }
      } finally {
        closeFd(jsFd);
      }
      validateManifest(entries, new Set(plan.map(([meta]) => `js/${recordId(meta)}.js`)));
      const text = jsonFile(manifestValue(entries, generation));
      if (text.length > MAX_MANIFEST) throw new StoreError(`the generated manifest would be ${text.length} bytes, over the ${MAX_MANIFEST} limit; uninstall some scripts`);
      writeFile(fd, "manifest.json", text);
      writeFile(fd, GENERATION, generationText(generation));
    } catch (error) {
      closeFd(fd);
      removeTree(root, name);
      throw error;
    }
    closeFd(fd);
    return name;
  }

  publishExtension(staged: string | null): string | null {
    const root = this.rootFd as number;
    const present = exists(root, EXTENSION);
    if (present && !isDir(lstatAt(root, EXTENSION).mode)) throw new StoreError(`${this.path}/${EXTENSION} isn't a folder the ardia command made; move it away first`);
    if (staged === null) {
      if (!present) return null;
      const old = `.extension-old-${tokenHex()}`;
      renameIn(root, EXTENSION, old);
      return old;
    }
    if (present) {
      swap(root, staged, EXTENSION);
      return staged;
    }
    renameIn(root, staged, EXTENSION);
    return null;
  }

  restoreExtension(staged: string | null, old: string | null): void {
    const root = this.rootFd as number;
    if (old !== null && staged !== null && old === staged) swap(root, staged, EXTENSION);
    else if (old !== null) renameIn(root, old, EXTENSION);
    else if (staged !== null && exists(root, EXTENSION)) removeTree(root, EXTENSION);
  }

  apply(add?: Build, remove?: string): [JsonObject | null, bigint] {
    const root = this.rootFd as number;
    const current = this.installed();
    const generation = this.nextGeneration();
    let stagedRecord: string | null = null;
    let record: JsonObject | null = null;
    let plan: [JsonObject, string][];
    if (add !== undefined) {
      [stagedRecord, record] = this.stageRecord(add);
      const id = recordId(record);
      const kept = current.filter((meta) => recordId(meta) !== id).map((meta): [JsonObject, string] => [meta, recordId(meta)]);
      plan = [...kept, [record, stagedRecord] as [JsonObject, string]].sort(([a], [b]) => byInstall(a, b));
    } else if (remove !== undefined) {
      record = current.find((meta) => recordId(meta) === remove) ?? null;
      plan = current.filter((meta) => recordId(meta) !== remove).map((meta) => [meta, recordId(meta)]);
    } else plan = current.map((meta) => [meta, recordId(meta)]);
    let stagedExtension: string | null = null;
    let oldExtension: string | null = null;
    let committed: Committed | null = null;
    try {
      stagedExtension = plan.length > 0 ? this.buildExtension(plan, generation) : null;
      if (record !== null) committed = this.commitRecord(stagedRecord, recordId(record), add === undefined);
      stagedRecord = null;
      if (plan.length === 0 && this.extensionPresent()) writeAtomic(root, GENERATION, generationText(generation));
      oldExtension = this.publishExtension(stagedExtension);
    } catch (error) {
      if (committed !== null) {
        try {
          this.undoRecord(committed);
        } catch {}
      }
      if (stagedRecord) removeTree(this.recordsFd as number, stagedRecord);
      if (stagedExtension && exists(root, stagedExtension)) removeTree(root, stagedExtension);
      throw error;
    }
    if (committed?.aside) removeTree(this.recordsFd as number, committed.aside);
    for (const leftover of [oldExtension, stagedExtension]) {
      if (leftover && exists(root, leftover)) removeTree(root, leftover);
    }
    writeAtomic(root, GENERATION, generationText(generation));
    return [record, generation];
  }

  commitRecord(staged: string | null, id: string, removing: boolean): Committed {
    const records = this.recordsFd as number;
    if (removing) {
      const aside = `.old-${id}-${tokenHex()}`;
      renameIn(records, id, aside);
      return { id, aside, kind: "removed" };
    }
    if (exists(records, id)) {
      if (!isDir(lstatAt(records, id).mode)) throw new StoreError(`${this.path}/scripts/${id} isn't a folder the ardia command made`);
      swap(records, staged as string, id);
      return { id, aside: staged as string, kind: "replaced" };
    }
    renameIn(records, staged as string, id);
    return { id, aside: null, kind: "added" };
  }

  undoRecord(committed: Committed): void {
    const records = this.recordsFd as number;
    if (committed.kind === "removed") renameIn(records, committed.aside as string, committed.id);
    else if (committed.kind === "replaced") {
      swap(records, committed.aside as string, committed.id);
      removeTree(records, committed.aside as string);
    } else removeTree(records, committed.id);
  }

}
