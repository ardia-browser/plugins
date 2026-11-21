import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { constants } from "node:os";
import { type Args, type Io } from "./cli-command.ts";
import * as files from "./config-files.ts";
import { ConfigError } from "./config-files.ts";
import { call as callControl, ControlFailure, errorCode, type Failure, Unsendable } from "./control.ts";
import { dumps, type JsonObject, type Value } from "./json.ts";
import { renamePaths } from "./libc.ts";
import { expandUser, join, NeedsPython, purePath } from "./paths.ts";
import { strOf, truthy, Unsupported } from "./py.ts";
import { JsonDecodeError, JsonValueError } from "./pyjson.ts";
import { effects, EEXIST, ENOENT, exists, fromErrno, isDir, isFile, isSymlink, mkdirs, osError, PyOSError } from "./pyos.ts";
import { isDict, isList, isStr } from "./pyvalue.ts";
import { shown } from "./printable.ts";
import { isPluginName, MANIFEST, manifestProblems } from "./plugin-rules.ts";

const MAX_MANIFEST = 1 << 20;
const MAX_COPY = 200 << 20;
const CALL_TIMEOUT = 320;
const ERRNO = constants.errno as Record<string, number>;
const ENOSYS = ERRNO["ENOSYS"] as number;
const ENOTSUP_CODES = new Set(["ENOTSUP", "EINVAL", "ENOSYS"].map((name) => ERRNO[name] ?? -1));

type Reply = { ok: true; result: Value } | { ok: false; failure: Failure };

function pluginsFolder(args: Args): string {
  return join(files.places(args["data_dir"] as string | undefined).folder, "plugins");
}

async function ask(args: Args, method: string, params: Value | undefined, timeout = 30): Promise<Reply> {
  try {
    return { ok: true, result: await callControl(args["data_dir"] as string | undefined, method, params, timeout) };
  } catch (error) {
    if (error instanceof Unsendable) throw error;
    if (!(error instanceof ControlFailure)) throw error;
    const failure = error.failure;
    if (failure.kind === "interrupted" || failure.kind === "unported") throw new NeedsPython(`a control call that ended ${failure.kind}`);
    return { ok: false, failure };
  }
}

function text(value: Value): string {
  try {
    return strOf(value);
  } catch (error) {
    if (error instanceof Unsupported) throw new NeedsPython("formatting a value as Python would");
    throw error;
  }
}

function errorText(error: unknown): string {
  if (error instanceof ConfigError) return error.message;
  if (error instanceof PyOSError) return error.text();
  throw error;
}

function readManifest(given: string): JsonObject {
  const path = isDir(given) ? join(given, MANIFEST) : given;
  if (isSymlink(path)) throw new ConfigError(`${path} is a link; a plugin's ${MANIFEST} must be a file in its folder`);
  if (!isFile(path)) throw new ConfigError(`${path} isn't a plugin: it has no ${MANIFEST}`);
  let size: number;
  try {
    size = fs.statSync(path).size;
  } catch (error) {
    throw osError(error, path);
  }
  if (size > MAX_MANIFEST) throw new ConfigError(`${path} is over 1 MB`);
  return files.readObject(path, path);
}

function entries(folder: string): string[] {
  try {
    return files.sortPy(fs.readdirSync(folder));
  } catch {
    throw new NeedsPython("a plugins folder that can't be listed");
  }
}

function filesListing(args: Args): JsonObject[] {
  const folder = pluginsFolder(args);
  const out: JsonObject[] = [];
  for (const name of isDir(folder) ? entries(folder) : []) {
    if (!isPluginName(name)) continue;
    const entry = join(folder, name);
    try {
      const manifest = readManifest(entry);
      const problems = manifestProblems(args, manifest);
      if (manifest.get("name") !== name) problems.push(`name is ${text(manifest.get("name") ?? null)}, but its folder is ${name}`);
      const title = manifest.get("title");
      out.push(
        new Map<string, Value>([
          ["name", name],
          ["title", truthy(title) ? (title as Value) : name],
          ["version", manifest.get("version") ?? null],
          ["enabled", null],
          ["problems", problems],
        ]),
      );
    } catch (error) {
      out.push(
        new Map<string, Value>([
          ["name", name],
          ["title", name],
          ["version", null],
          ["enabled", null],
          ["problems", [errorText(error)]],
        ]),
      );
    }
  }
  return out;
}

function stateOf(plugin: JsonObject): string {
  if (truthy(plugin.get("active"))) return "on";
  if (truthy(plugin.get("needsReview"))) return "changed, review it in Ardia";
  const enabled = plugin.get("enabled");
  return enabled !== undefined && enabled !== null ? "off" : "installed (Ardia isn't reachable, so on or off is unknown)";
}

function pluginLine(plugin: Value): [string, Value[]] {
  if (!isDict(plugin) || !plugin.has("name")) throw new NeedsPython("a plugin row this port can't show");
  const process = plugin.get("process");
  const contributes = plugin.get("contributes");
  const version = plugin.get("version");
  const running = truthy(process) ? `, program ${text(process as Value)}` : "";
  let adds = "";
  if (truthy(contributes)) {
    if (!isList(contributes) || !contributes.every(isStr)) throw new NeedsPython("contributions that aren't a list of strings");
    adds = `  adds ${contributes.join(", ")}`;
  }
  const versionText = truthy(version) ? ` ${text(version as Value)}` : "";
  const problems = plugin.get("problems");
  let listed: Value[] = [];
  if (truthy(problems)) {
    if (!isList(problems)) throw new NeedsPython("problems that aren't a list");
    listed = problems;
  }
  return [`${text(plugin.get("name") as Value)}${versionText}  ${stateOf(plugin)}${running}${adds}`, listed];
}

async function cmdList(args: Args, io: Io): Promise<number> {
  const reply = await ask(args, "plugins", undefined);
  const plugins: Value = reply.ok ? reply.result : filesListing(args);
  if (args["json"]) {
    io.say(dumps(plugins, "indented"));
    return 0;
  }
  const rows = truthy(plugins) ? plugins : [];
  if (!isList(rows)) throw new NeedsPython("a plugins reply that isn't a list");
  const lines = rows.map(pluginLine);
  const problemLines = lines.map(([, problems]) => problems.map((problem) => text(problem)));
  if (!truthy(plugins)) io.say(`No plugins in ${pluginsFolder(args)}`);
  lines.forEach(([line], index) => {
    io.say(shown(line));
    for (const problem of problemLines[index] as string[]) io.say(shown(`  problem: ${problem}`));
  });
  return 0;
}

function walk(source: string, visit: (path: string, info: fs.Stats) => void): void {
  for (const name of fs.readdirSync(source)) {
    const path = join(source, name);
    const info = fs.lstatSync(path);
    visit(path, info);
    if (info.isDirectory()) walk(path, visit);
  }
}

function copyStat(source: string, target: string): void {
  const info = fs.statSync(source);
  fs.chmodSync(target, info.mode & 0o7777);
  fs.utimesSync(target, info.atime, info.mtime);
}

function copyFile(source: string, target: string): void {
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  copyStat(source, target);
}

function copyDir(source: string, target: string): void {
  fs.mkdirSync(target);
  for (const name of fs.readdirSync(source)) {
    const from = join(source, name);
    const to = join(target, name);
    const info = fs.lstatSync(from);
    if (info.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
    else if (info.isDirectory()) copyDir(from, to);
    else copyFile(from, to);
  }
  copyStat(source, target);
}

function copyTree(source: string, target: string): void {
  let total = 0;
  walk(source, (path, info) => {
    if (info.isSymbolicLink()) throw new ConfigError(`${path} is a link; a plugin's files must be real files`);
    if (info.isFile()) total += info.size;
  });
  if (total > MAX_COPY) throw new ConfigError(`${source} is over 200 MB`);
  copyDir(source, target);
}

class NotImplemented extends Error {}

class KeptAside extends Error {}

function renameExchange(first: string, second: string): void {
  const errno = renamePaths(first, second, true);
  if (errno === 0) return;
  if (ENOTSUP_CODES.has(errno)) throw new NotImplemented();
  throw fromErrno(errno, second);
}

function renameNoReplace(source: string, target: string): void {
  const errno = renamePaths(source, target, false);
  if (errno === 0) return;
  if (errno === ENOSYS) {
    fs.mkdirSync(target);
    fs.renameSync(source, target);
    return;
  }
  throw fromErrno(errno, target);
}

function replaceThroughAside(staged: string, target: string, aside: string): boolean {
  try {
    fs.renameSync(target, aside);
  } catch (error) {
    const wrapped = osError(error, target, aside);
    if (wrapped instanceof PyOSError && wrapped.notFound) {
      renameNoReplace(staged, target);
      return false;
    }
    throw wrapped;
  }
  try {
    renameNoReplace(staged, target);
  } catch (error) {
    try {
      renameNoReplace(aside, target);
    } catch {
      throw new KeptAside(`${errorText(error)}; the plugin that was installed before couldn't be put back and is kept in ${aside}`);
    }
    throw error;
  }
  return true;
}

function present(path: string): boolean {
  return exists(path) || isSymlink(path);
}

function publish(staged: string, target: string, aside: string, force: boolean): boolean {
  if (force && present(target)) {
    try {
      renameExchange(staged, target);
      return true;
    } catch (error) {
      if (error instanceof PyOSError && error.errno === ENOENT) {
        renameNoReplace(staged, target);
        return false;
      }
      if (!(error instanceof NotImplemented)) throw error;
    }
    return replaceThroughAside(staged, target, aside);
  }
  renameNoReplace(staged, target);
  return false;
}

function makeStaging(folder: string, name: string): string {
  const letters = "abcdefghijklmnopqrstuvwxyz0123456789_";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = [...randomBytes(8)].map((byte) => letters[byte % letters.length]).join("");
    const path = join(folder, `.${name}.${suffix}`);
    try {
      fs.mkdirSync(path, { mode: 0o700 });
      return path;
    } catch (error) {
      const wrapped = osError(error, path);
      if (wrapped instanceof PyOSError && wrapped.errno === EEXIST) continue;
      throw wrapped;
    }
  }
  throw fromErrno(EEXIST);
}

function removeQuietly(path: string): void {
  try {
    fs.rmSync(path, { recursive: true, force: true });
  } catch {}
}

async function cmdInstall(args: Args, io: Io): Promise<number> {
  const source = purePath(expandUser(args["source"] as string));
  let manifest: JsonObject;
  try {
    manifest = readManifest(source);
  } catch (error) {
    io.complain(`ardia plugins install: ${errorText(osError(error))}`);
    return 1;
  }
  const problems = manifestProblems(args, manifest);
  if (problems.length > 0) {
    for (const problem of problems) io.complain(`ardia plugins install: ${problem}`);
    return 1;
  }
  const name = manifest.get("name") as string;
  const folder = pluginsFolder(args);
  const target = join(folder, name);
  const force = Boolean(args["force"]);
  if (present(target) && !force) {
    io.complain(`ardia plugins install: ${name} is already installed (--force replaces it)`);
    return 1;
  }
  mkdirs(folder, true, true);
  const staging = makeStaging(folder, name);
  effects.done = true;
  let replacing = false;
  try {
    const staged = join(staging, name);
    try {
      if (isDir(source)) copyTree(source, staged);
      else {
        fs.mkdirSync(staged);
        copyFile(source, join(staged, MANIFEST));
      }
    } catch (error) {
      throw osError(error);
    }
    const copied = readManifest(staged);
    const again = [...manifestProblems(args, copied), ...(copied.get("name") === name ? [] : [`its name changed to ${text(copied.get("name") ?? null)} while it was copied`])];
    if (again.length > 0) throw new ConfigError(again.join("; "));
    if (force && present(target)) await ask(args, "plugins.disable", new Map<string, Value>([["name", name]]));
    replacing = publish(staged, target, join(staging, "previous"), force);
  } catch (error) {
    if (error instanceof KeptAside) {
      io.complain(`ardia plugins install: ${error.message}`);
      return 1;
    }
    if (error instanceof PyOSError && error.errno === EEXIST) {
      removeQuietly(staging);
      io.complain(`ardia plugins install: ${name} is already installed (--force replaces it)`);
      return 1;
    }
    const wrapped = osError(error);
    if (wrapped instanceof ConfigError || wrapped instanceof PyOSError) {
      removeQuietly(staging);
      io.complain(`ardia plugins install: ${errorText(wrapped)}`);
      return 1;
    }
    throw error;
  }
  removeQuietly(staging);
  io.say(`${replacing ? "Replaced" : "Installed"} ${name} in ${target}. It's off: turn it on in Ardia's Settings › Plugins, or with ardia plugins enable ${name}.`);
  return 0;
}

function cmdCheck(args: Args, io: Io): number {
  const given = args["target"] as string | undefined;
  const installed = !(given && (given.includes("/") || given.endsWith(".json")));
  let targets: string[];
  if (!installed) targets = [purePath(expandUser(given as string))];
  else if (given) targets = [purePath(join(pluginsFolder(args), given))];
  else {
    const folder = pluginsFolder(args);
    targets = isDir(folder) ? entries(folder).filter(isPluginName).map((name) => join(folder, name)) : [];
  }
  const report: JsonObject[] = [];
  for (const target of targets) {
    let problems: string[];
    try {
      const manifest = readManifest(target);
      problems = manifestProblems(args, manifest);
      const folderName = target.slice(target.lastIndexOf("/") + 1);
      if (installed && manifest.get("name") !== folderName) problems.push(`name is ${text(manifest.get("name") ?? null)}, but its folder is ${folderName}`);
    } catch (error) {
      problems = [errorText(osError(error))];
    }
    report.push(
      new Map<string, Value>([
        ["file", target],
        ["problems", problems],
      ]),
    );
  }
  const ok = report.every((entry) => (entry.get("problems") as Value[]).length === 0);
  if (args["json"]) {
    io.say(
      dumps(
        new Map<string, Value>([
          ["ok", ok],
          ["plugins", report],
        ]),
        "indented",
      ),
    );
  } else {
    for (const entry of report) {
      const problems = entry.get("problems") as string[];
      io.say(shown(`${entry.get("file") as string}: ${problems.length === 0 ? "ok" : ""}`));
      for (const problem of problems) io.say(shown(`  ${problem}`));
    }
  }
  return ok ? 0 : 1;
}

function unreachableExit(failure: Failure, io: Io): number {
  io.noteError(errorCode(failure) ?? "unreachable");
  io.complain(`ardia: ${(failure as { message: string }).message}`);
  return 2;
}

async function cmdRemove(args: Args, io: Io): Promise<number> {
  const name = args["name"] as string;
  const reply = await ask(args, "plugins.remove", new Map<string, Value>([["name", name]]));
  if (reply.ok) {
    io.say(`Removed ${name}.`);
    return 0;
  }
  const failure = reply.failure;
  if (failure.kind === "method") {
    io.complain(`ardia plugins remove: ${failure.message}`);
    return 1;
  }
  if (failure.kind === "unreachable" && failure.sent) {
    io.complain(`ardia plugins remove: Ardia got the request but didn't answer, so ${name} is left as it is. Run this again.`);
    return unreachableExit(failure, io);
  }
  const target = join(pluginsFolder(args), name);
  if (!isPluginName(name) || !present(target)) {
    io.complain(`ardia plugins remove: there's no plugin ${name}`);
    return 1;
  }
  if (isSymlink(target)) fs.unlinkSync(target);
  else {
    if (!isDir(target)) throw new NeedsPython("removing a plugin that isn't a folder");
    effects.done = true;
    fs.rmSync(target, { recursive: true });
  }
  io.say(`Removed ${name}.`);
  return 0;
}

async function cmdToggle(verb: string, args: Args, io: Io): Promise<number> {
  const name = args["name"] as string;
  const reply = await ask(args, verb === "enable" ? "plugins.enable" : "plugins.disable", new Map<string, Value>([["name", name]]));
  if (!reply.ok) {
    if (reply.failure.kind === "method") {
      io.complain(`ardia plugins ${verb}: ${reply.failure.message}`);
      return 1;
    }
    return unreachableExit(reply.failure, io);
  }
  if (isDict(reply.result) && truthy(reply.result.get("waiting"))) io.say(`Ardia is showing what ${name} gets; turn it on there.`);
  else io.say(`${name} is ${verb === "enable" ? "on" : "off"}.`);
  return 0;
}

async function cmdCall(args: Args, io: Io): Promise<number> {
  let payload: Value = new Map();
  const input = args["input"] as string | undefined;
  if (input !== undefined) {
    try {
      payload = files.parseJson(input);
    } catch (error) {
      if (!(error instanceof JsonDecodeError || error instanceof JsonValueError)) throw error;
      io.complain(`ardia plugins call: the input isn't JSON (${error.message})`);
      return 1;
    }
  }
  const params = new Map<string, Value>([
    ["plugin", args["name"] as string],
    ["tool", args["tool"] as string],
    ["input", payload],
  ]);
  let reply: Reply;
  try {
    reply = await ask(args, "plugins.call", params, CALL_TIMEOUT);
  } catch (error) {
    if (!(error instanceof Unsendable)) throw error;
    io.complain("ardia plugins call: the input has text that can't be sent as UTF-8 (surrogates not allowed)");
    return 1;
  }
  if (!reply.ok) {
    if (reply.failure.kind === "method") {
      io.complain(`ardia plugins call: ${reply.failure.message}`);
      return 1;
    }
    return unreachableExit(reply.failure, io);
  }
  io.say(dumps(reply.result, "indented"));
  return 0;
}

export async function runPlugins(verb: string, args: Args, io: Io): Promise<number> {
  switch (verb) {
    case "path":
      io.say(pluginsFolder(args));
      return 0;
    case "list":
      return cmdList(args, io);
    case "install":
      return cmdInstall(args, io);
    case "check":
      return cmdCheck(args, io);
    case "remove":
      return cmdRemove(args, io);
    case "enable":
    case "disable":
      return cmdToggle(verb, args, io);
    default:
      return cmdCall(args, io);
  }
}
