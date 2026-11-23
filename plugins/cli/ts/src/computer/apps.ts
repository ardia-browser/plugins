import { accessSync, chmodSync, closeSync, constants, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { rollbackOnStop, stopPoint } from "../after-update.ts";
import { dumps, type JsonObject, type Value } from "../json.ts";
import { flock } from "../libc.ts";
import { envSet, expandUser, home, join, purePath } from "../paths.ts";
import { loads } from "../pylib/jsonloads.ts";
import { calledProcessText } from "../pyerr.ts";
import { shellQuote } from "../pystrings.ts";
import { installRoot } from "../install.ts";
import { cliHome } from "../usage.ts";
import { RunTimedOut } from "../proc/group.ts";
import {
  APP_BINARY, APP_NAME, appVersion, checkApp, cuaHome, driverEnv, Inconclusive, installedApp, isDirectory, isRegular, isSymlink, lexists, Refused, removePath, runTool, tools, verifyApp, VERSION,
} from "./driver.ts";

const STAGING_NAME = `.${APP_NAME}.ardia-new`;
const RETIRED_NAME = `.${APP_NAME}.ardia-old`;
const LOCK_NAME = ".applications.lock";
const LOCK_TIMEOUT_S = 120;
const COPY_TIMEOUT = 300;
const REGISTER_TIMEOUT = 60;

export class CalledProcessError extends Error {}

function recordPath(): string {
  return join(cuaHome(), "applications.json");
}

export function readRecord(): JsonObject {
  try {
    const data = loads(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(recordPath())));
    return data instanceof Map ? data : new Map();
  } catch {
    return new Map();
  }
}

export function saveRecord(record: JsonObject): void {
  const path = recordPath();
  mkdirSync(dirname(path), { recursive: true });
  const staging = join(dirname(path), `.applications.${process.pid}.json`);
  writeFileSync(staging, `${dumps(record, "indented", true)}\n`);
  renameSync(staging, path);
}

export async function codeHash(app: string): Promise<string | null> {
  const argv = [tools.codesign, "-dvvv", app];
  let stderr: string;
  try {
    stderr = (await runTool(argv, 30)).stderr;
  } catch (error) {
    const { subprocessText } = await import("./driver.ts");
    throw new Inconclusive(`couldn't read the code hash of ${app}: ${subprocessText(argv, error, 30)}`);
  }
  const found = /^CDHash=([0-9a-f]+)$/m.exec(stderr);
  return found === null ? null : (found[1] as string);
}

function committed(record: JsonObject): boolean {
  const state = record.has("state") ? record.get("state") : "committed";
  return state === "committed";
}

function truthyText(value: Value | undefined): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "string" || Array.isArray(value)) return value.length > 0;
  if (value instanceof Map) return value.size > 0;
  return true;
}

export async function installedByArdia(app: string): Promise<boolean> {
  const record = readRecord();
  if (!committed(record) || record.get("path") !== app || !truthyText(record.get("cdhash"))) return false;
  return (await codeHash(app)) === record.get("cdhash");
}

export async function quietlyOurs(app: string): Promise<boolean> {
  try {
    return await installedByArdia(app);
  } catch (error) {
    if (error instanceof Inconclusive) return false;
    throw error;
  }
}

function forgetRecord(): void {
  try {
    unlinkSync(recordPath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function restoreRecord(previous: Value | undefined): void {
  if (previous instanceof Map && truthyText(previous.get("path"))) {
    const restored: JsonObject = new Map([...previous].filter(([key]) => key !== "previous"));
    restored.set("state", "committed");
    saveRecord(restored);
  } else forgetRecord();
}

export async function withApplicationsLock<T>(work: () => Promise<T>): Promise<T> {
  const home = cuaHome();
  mkdirSync(home, { recursive: true });
  const fd = openSync(join(home, LOCK_NAME), constants.O_RDWR | constants.O_CREAT, 0o600);
  try {
    const deadline = performance.now() + LOCK_TIMEOUT_S * 1000;
    while (!flock(fd, true, false)) {
      if (performance.now() >= deadline) throw new Refused(`another ardia computer setup or refresh is still running (waited ${LOCK_TIMEOUT_S} s)`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return await work();
  } finally {
    closeSync(fd);
  }
}

function retired(): string {
  return join(tools.applications, RETIRED_NAME);
}

function staging(): string {
  return join(tools.applications, STAGING_NAME);
}

export function needsRecovery(): boolean {
  return lexists(retired()) || lexists(staging()) || !committed(readRecord());
}

export async function signedByCua(app: string): Promise<boolean> {
  try {
    await verifyApp(app);
  } catch (error) {
    if (error instanceof Refused) return false;
    throw error;
  }
  return true;
}

async function pendingVerdict(dest: string, pending: Value | undefined): Promise<"match" | "mismatch" | "tampered"> {
  if (!isDirectory(dest) || !truthyText(pending)) return "mismatch";
  if ((await codeHash(dest)) !== pending) return "mismatch";
  try {
    await verifyApp(dest);
  } catch (error) {
    if (error instanceof Inconclusive || !(error instanceof Refused)) throw error;
    return "tampered";
  }
  return "match";
}

export async function recover(speak: (line: string) => void): Promise<boolean> {
  const dest = installedApp();
  if (!lexists(dest) && lexists(retired())) renameSync(retired(), dest);
  const record = readRecord();
  if (!committed(record)) {
    let verdict: string;
    try {
      verdict = await pendingVerdict(dest, record.get("cdhash"));
    } catch (error) {
      if (!(error instanceof Inconclusive)) throw error;
      speak(`ardia computer: recovery is pending for ${dest} (${error.message}); the next ardia computer run tries again`);
      return false;
    }
    if (verdict === "match") {
      const kept: JsonObject = new Map([...record].filter(([key]) => key !== "previous" && key !== "state"));
      kept.set("state", "committed");
      saveRecord(kept);
    } else {
      if (verdict === "tampered" && isDirectory(retired())) {
        removePath(dest);
        renameSync(retired(), dest);
      }
      restoreRecord(record.get("previous"));
    }
  }
  if (lexists(staging())) removePath(staging());
  if (lexists(retired()) && lexists(dest)) removePath(retired());
  return true;
}

async function copyApp(source: string, dest: string): Promise<void> {
  const argv = [tools.ditto, source, dest];
  let result;
  try {
    result = await runTool(argv, COPY_TIMEOUT);
  } catch (error) {
    if (error instanceof RunTimedOut) throw new Refused(`copying ${APP_NAME} to ${dest} took over ${COPY_TIMEOUT} s`);
    throw error;
  }
  if (result.code !== 0) throw new CalledProcessError(calledProcessText(argv, result.code));
}

async function registerApp(app: string): Promise<void> {
  try {
    await runTool([tools.lsregister, "-f", app], REGISTER_TIMEOUT);
  } catch (error) {
    if (!(error instanceof RunTimedOut)) throw error;
  }
}

export async function runDriverQuietly(binary: string, ...args: string[]): Promise<number> {
  try {
    return (await runTool([binary, ...args], 60, driverEnv())).code;
  } catch {
    return 1;
  }
}

export async function placeApp(source: string): Promise<string> {
  const dest = installedApp();
  const exists = lexists(dest);
  const ours = exists && (await installedByArdia(dest));
  if (exists && !ours) {
    const version = appVersion(dest) ?? "of unknown version";
    return `kept ${dest}: CuaDriver.app ${version} was put there by something other than ardia (cua's own installer?); ardia computer uses it as is`;
  }
  if (ours) {
    await verifyApp(dest);
    if (appVersion(dest) === VERSION) return `current ${dest} (${VERSION})`;
  }
  try {
    accessSync(tools.applications, constants.W_OK);
  } catch {
    throw new Refused(`can't write to ${tools.applications}; run ardia computer setup from an admin account`);
  }
  const previous: Value = ours ? readRecord() : null;
  let newHash: string | null;
  const forget = rollbackOnStop(() => {
    if (lexists(staging())) removePath(staging());
  });
  try {
    if (lexists(staging())) removePath(staging());
    await copyApp(source, staging());
    await checkApp(staging());
    newHash = await codeHash(staging());
    if (!newHash) throw new Refused(`couldn't read the code hash of ${staging()}`);
    stopPoint();
    forget();
    saveRecord(new Map<string, Value>([["path", dest], ["version", VERSION], ["cdhash", newHash], ["state", "pending"], ["previous", previous]]));
  } catch (error) {
    forget();
    if (lexists(staging())) removePath(staging());
    throw error;
  }
  const undo = () => {
    if (lexists(retired()) && !lexists(dest)) renameSync(retired(), dest);
    if (lexists(staging())) removePath(staging());
    restoreRecord(previous);
  };
  const forgetUndo = rollbackOnStop(undo);
  try {
    stopPoint();
    if (ours) {
      await runDriverQuietly(join(dest, APP_BINARY), "stop");
      stopPoint();
      renameSync(dest, retired());
    }
    renameSync(staging(), dest);
    forgetUndo();
  } catch (error) {
    forgetUndo();
    undo();
    throw error;
  }
  saveRecord(new Map<string, Value>([["path", dest], ["version", VERSION], ["cdhash", newHash], ["state", "committed"]]));
  if (lexists(retired())) removePath(retired());
  await registerApp(dest);
  return `${ours ? "updated" : "installed"} ${dest} (${VERSION})`;
}

export function binDir(): string {
  return purePath(expandUser(envSet("ARDIA_CLI_BIN_DIR") ?? join(home(), ".local", "bin")));
}

function managedCurrent(root: string): string | null {
  const current = join(dirname(root), "current");
  try {
    if (isSymlink(current) && readlinkSync(current) === root.slice(root.lastIndexOf("/") + 1) && isRegular(join(root, "bin", "ardia"))) return current;
  } catch {}
  return null;
}

function within(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder.endsWith("/") ? folder : `${folder}/`);
}

function runningFromInstall(root: string): boolean {
  try {
    return dirname(realpathSync(process.execPath)) === join(root, "libexec");
  } catch {
    return false;
  }
}

export function trustedLauncher(): string | null {
  const home = cliHome();
  const current = join(home, "current", "bin", "ardia");
  const root = installRoot();
  const managed = root === null ? null : managedCurrent(root);
  try {
    if (isRegular(current) && within(realpathSync(current), realpathSync(home))) return current;
    if (managed !== null && isSymlink(join(home, "current")) && purePath(readlinkSync(join(home, "current"))) === managed) return current;
  } catch {}
  if (managed !== null) return join(managed, "bin", "ardia");
  if (root === null) return null;
  const launcher = join(root, "bin", "ardia");
  if (runningFromInstall(root) && isRegular(launcher) && !isSymlink(launcher)) return launcher;
  return null;
}

export function ardiaCommand(): string {
  const launcher = trustedLauncher();
  if (launcher === null) {
    throw new Refused(
      "can't find the installed ardia launcher ($ARDIA_CLI_HOME/current/bin/ardia), and won't take whatever ardia is first on PATH; Ardia puts the ardia command on your PATH, so open Ardia and run this again",
    );
  }
  return launcher;
}

export function shimPath(): string {
  return join(cuaHome(), "bin", "cua-driver");
}

export function linkCommand(): string {
  const launcher = ardiaCommand();
  const shim = shimPath();
  mkdirSync(dirname(shim), { recursive: true });
  const body = `#!/bin/sh\nexec ${shellQuote(launcher)} computer "$@"\n`;
  const stagingPath = join(dirname(shim), `.cua-driver.${process.pid}`);
  writeFileSync(stagingPath, body);
  chmodSync(stagingPath, 0o755);
  renameSync(stagingPath, shim);
  const link = join(binDir(), "cua-driver");
  if (isSymlink(link) && readlinkSync(link) === shim) return `current ${link}`;
  if (lexists(link)) return `kept ${link}: it isn't ardia's; run ardia computer instead of cua-driver`;
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(shim, link);
  return `linked ${link} -> ${shim}`;
}

export function staleNotice(app: string): string | null {
  const version = appVersion(app);
  const record = readRecord();
  if (version === VERSION || record.get("path") !== app || (record.get("version") ?? null) !== (version ?? null)) return null;
  return `ardia computer: ${app} is cua-driver ${version ?? "None"}, ardia pins ${VERSION}; run ardia computer setup to update it`;
}

export { isRegular as fileExists };
