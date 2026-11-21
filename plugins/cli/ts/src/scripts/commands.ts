import fs from "node:fs";
import { interrupted } from "../control.ts";
import { dumps, type JsonObject, type Value } from "../json.ts";
import { errnoOf } from "../paths.ts";
import { pyStrip, reprText } from "../pylib/str.ts";
import { isWordCode } from "../pylib/unicode.ts";
import { utf8 } from "../pystr.ts";
import type { ScriptsArgs } from "./args.ts";
import { build, type Build } from "./build.ts";
import { dataRoot, EndpointError, explicitDataRoot, requireControl } from "../control-file.ts";
import { describe, profileLines, pyStr } from "./describe.ts";
import { BrokenPipe, Interrupted, type Say } from "./output.ts";
import { pyEqual } from "./pyvalue.ts";
import { recordId } from "./records.ts";
import { OsError, Store } from "./store.ts";
import { repairIfPresent, truthy, waitStatus } from "./store-repair.ts";
import { StoreError } from "./store-fs.ts";
import { checkMatch, ScriptError, slug } from "./userscript.ts";

export const UNKNOWN_EXIT = 3;
const EEXIST = 17;
const NEW_MATCH = "https://example.com/*";

export type Ending = { status: number; exitFlushFails?: boolean };

function newTemplate(name: string, patterns: string[]): string {
  const matches = patterns.map((pattern) => `// @match       ${pattern}\n`).join("");
  return `// ==UserScript==\n// @name        ${name}\n// @namespace   ardia\n// @version     0.1.0\n// @description ${name}\n${matches}// @run-at      document-end\n// @grant       none\n// ==/UserScript==\n\nconsole.log(${dumps(name, "compact", true)}, "ran on", location.href);\n`;
}

function isAlnum(point: number): boolean {
  return point !== 0x5f && isWordCode(point);
}

export function runNew(args: ScriptsArgs, out: Say): number {
  const name = pyStrip(args.name as string);
  if (!name || name.includes("\n")) {
    out.complain("ardia scripts new: give the script a name");
    return 1;
  }
  const plain = [...name].every((char) => isAlnum(char.codePointAt(0) as number) || "-_.".includes(char));
  const path = `${process.cwd()}/${plain ? name : slug(name)}.user.ts`;
  const patterns = args.match ?? [NEW_MATCH];
  try {
    for (const pattern of patterns) checkMatch(pattern, "match");
  } catch (error) {
    if (!(error instanceof ScriptError)) throw error;
    out.complain(`ardia scripts new: ${error.message}`);
    return 1;
  }
  let fd: number;
  try {
    fd = fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o666);
  } catch (error) {
    const errno = errnoOf(error);
    if (errno === 0) throw error;
    out.complain(errno === EEXIST ? `ardia scripts new: ${path} already exists` : `ardia scripts new: ${new OsError(errno, path).message}`);
    return 1;
  }
  try {
    const bytes = utf8(newTemplate(name, patterns));
    let offset = 0;
    while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
  } catch (error) {
    const errno = errnoOf(error);
    if (errno === 0) throw error;
    out.complain(`ardia scripts new: ${new OsError(errno).message}`);
    return 1;
  } finally {
    fs.closeSync(fd);
  }
  out.say(path);
  return 0;
}

function alive(root: string): () => boolean {
  return () => {
    try {
      requireControl(root);
      return true;
    } catch (error) {
      if (error instanceof EndpointError) return false;
      throw error;
    }
  };
}

function failure(error: unknown): string | undefined {
  if (error instanceof StoreError || error instanceof OsError) return error.message;
  return undefined;
}

export async function runChange(args: ScriptsArgs, out: Say): Promise<Ending> {
  const root = dataRoot(args.dataDir);
  let built: Build | undefined;
  if (args.sub === "install") {
    try {
      built = await build(args.file as string, false, [root], interrupted);
    } catch (error) {
      if (!(error instanceof ScriptError)) throw error;
      out.complain(`ardia scripts: ${error.message}`);
      return { status: 1 };
    }
    for (const warning of [...built.meta.warnings, ...built.warnings]) out.say(`warning: ${warning}`);
    if (built.meta.matches.length === 0 && built.meta.includes.length === 0) {
      out.complain("ardia scripts: add an @match or @include line so the script runs somewhere");
      return { status: 1 };
    }
  }
  try {
    requireControl(root);
  } catch (error) {
    if (!(error instanceof EndpointError)) throw error;
    out.complain(`ardia: ${error.message}`);
    return { status: 2 };
  }
  const store = new Store(root);
  let generation: bigint;
  let removedAll: boolean;
  let outcome: string;
  let status: JsonObject | null;
  try {
    store.open(true);
    await store.lock(interrupted);
    let summary: string;
    try {
      if (built !== undefined) {
        const [record, made] = store.apply(built);
        generation = made;
        summary = `${truthy((record as JsonObject).get("updated")) ? "updated" : "installed"} ${describe(record as JsonObject)}`;
      } else {
        const found = store.find(args.name as string);
        if (found === undefined) {
          const names = store.installed().map((meta) => pyStr(meta.has("name") ? meta.get("name") : recordId(meta))).join(", ") || "none";
          out.complain(`ardia scripts: no installed script is named ${reprText(args.name as string)} (installed: ${names})`);
          return { status: 1 };
        }
        const [record, made] = store.apply(undefined, recordId(found));
        generation = made;
        summary = `uninstalled ${pyStr((record as JsonObject).get("name"))} (${recordId(record as JsonObject)})`;
      }
      removedAll = !store.extensionPresent();
    } finally {
      store.unlock();
    }
    out.say(summary);
    out.say(`generation ${generation}`);
    [outcome, status] = await waitStatus(store, generation, alive(root), interrupted);
  } catch (error) {
    if (error instanceof BrokenPipe) {
      out.complain("ardia scripts: [Errno 32] Broken pipe");
      return { status: 1, exitFlushFails: true };
    }
    const message = failure(error);
    if (message === undefined) throw error;
    out.complain(`ardia scripts: ${message}`);
    return { status: 1 };
  } finally {
    store.close();
  }
  if (outcome === "interrupted") throw new Interrupted();
  if (outcome === "quit") {
    out.say("Ardia quit (or control was turned off) before applying it; it applies the change on its next launch");
    return { status: 0 };
  }
  if (outcome === "timeout") {
    out.say(`Ardia hasn't reported generation ${generation} after 10 s: the outcome is unknown, it may still be applying it (see ardia scripts list)`);
    return { status: UNKNOWN_EXIT };
  }
  if (outcome === "superseded") {
    out.say(`a newer change (generation ${pyStr(status?.get("generation"))}) replaced this one; Ardia reported that one:`);
    removedAll = false;
  }
  return { status: printProfiles(out, status, removedAll) };
}

function printProfiles(out: Say, status: JsonObject | null, removed: boolean): number {
  const [lines, failed] = profileLines(status, removed);
  for (const line of lines) out.say(line);
  return failed ? 1 : 0;
}

export async function runList(args: ScriptsArgs, out: Say): Promise<number> {
  const root = dataRoot(args.dataDir);
  let trusted = explicitDataRoot(args.dataDir) !== null;
  if (!trusted) {
    try {
      requireControl(root);
      trusted = true;
    } catch (error) {
      if (!(error instanceof EndpointError)) throw error;
    }
  }
  let note: string | null = null;
  if (trusted) {
    try {
      note = await repairIfPresent(root, interrupted);
    } catch (error) {
      const message = failure(error);
      if (message === undefined) throw error;
      out.complain(`ardia scripts: can't check the installed scripts (${message})`);
      return 1;
    }
    if (note && !args.json) out.say(`repaired: ${note}`);
  }
  const store = new Store(dataRoot(args.dataDir));
  let scripts: JsonObject[];
  let generation: bigint;
  let status: JsonObject | null;
  let removed: boolean;
  try {
    store.open(false);
    scripts = store.installed();
    generation = store.generation();
    status = store.status();
    removed = generation > 0n && !store.extensionPresent();
    if (!args.json) scripts.forEach(describe);
  } catch (error) {
    const message = failure(error);
    if (message === undefined) throw error;
    out.complain(`ardia scripts: ${message}`);
    return 1;
  } finally {
    store.close();
  }
  if (args.json) {
    const shown = new Map<string, Value>([["scripts", scripts], ["generation", generation], ["status", status], ["repaired", note]]);
    out.say(dumps(shown, "indented", false));
    return 0;
  }
  if (scripts.length === 0) out.say("no scripts installed");
  for (const record of scripts) {
    out.say(describe(record));
    out.say(`  source: ${pyStr(record.get("source_file"))}`);
  }
  if (generation) {
    const reported = (status ? status.get("generation") : null) ?? null;
    if (pyEqual(reported, generation)) {
      const [lines] = profileLines(status, removed);
      out.say(`generation ${generation}, reported by Ardia:`);
      for (const line of lines) out.say(`  ${line}`);
    } else {
      const shown = truthy(reported) ? ` (it last reported ${pyStr(reported)})` : "";
      out.say(`generation ${generation}, not reported by Ardia yet${shown}`);
    }
  }
  return 0;
}
