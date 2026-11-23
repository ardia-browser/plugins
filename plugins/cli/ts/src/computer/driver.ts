import { createHash } from "node:crypto";
import { rollbackOnStop, stopPoint } from "../after-update.ts";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import { cliHome } from "../usage.ts";
import { join } from "../paths.ts";
import { loadPlist } from "../plist.ts";
import { pySplitlines, pyStrip } from "../pystrings.ts";
import { run, RunTimedOut, SpawnFailed } from "../proc/group.ts";
import { calledProcessText, osErrorText, spawnErrorText, timeoutText } from "../pyerr.ts";
import { isDir, isFile, type Member, readTarGz, TarError, extractMembers } from "../tar.ts";
import { cliVersion } from "../version.ts";

export const VERSION = "0.38.0";
export const DRIVER_SHA256 = "5f71191c082ca07c9dfc13b7c9a6eec60a82818c245a93534cc0eb7911471d72";
export const SKILLS_SHA256 = "0fe3d607e7212d6c58072a2419163342061dcf5cb89ba1243dea593d7e33be0f";
export const RELEASE_URL = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${VERSION}`;
export const DRIVER_ASSET = `cua-driver-rs-${VERSION}-darwin-arm64.tar.gz`;
const DRIVER_TOP = `cua-driver-rs-${VERSION}-darwin-arm64`;
export const SKILLS_ASSET = `cua-driver-rs-v${VERSION}-skills.tar.gz`;
const SKILLS_TOP = `cua-driver-rs-v${VERSION}-skills`;
export const BUNDLE_ID = "com.trycua.driver";
const TEAM_ID = "YCK386LBJ7";
export const REQUIREMENT = `identifier "${BUNDLE_ID}" and anchor apple generic and certificate leaf[subject.OU] = "${TEAM_ID}"`;
export const APP_NAME = "CuaDriver.app";
export const APP_BINARY = "Contents/MacOS/cua-driver";
const DRIVER_NOTICES = ["LICENSE", "THIRD_PARTY_NOTICES.md"];
const OTHER_PLATFORM_DOCS = ["LINUX.md", "WINDOWS.md"];
const VERSION_DIR = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const DOWNLOAD_TIMEOUT_S = 60;
const MAX_REDIRECTS = 10;
export const QUIET_ENV: Record<string, string> = { CUA_DRIVER_RS_TELEMETRY_ENABLED: "0", CUA_DRIVER_RS_UPDATE_CHECK: "0" };

export const tools: {
  codesign: string;
  ditto: string;
  open: string;
  lsregister: string;
  applications: string;
  releaseUrl: string;
  socket: string | undefined;
} = {
  codesign: "/usr/bin/codesign",
  ditto: "/usr/bin/ditto",
  open: "/usr/bin/open",
  lsregister: "/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister",
  applications: "/Applications",
  releaseUrl: RELEASE_URL,
  socket: undefined,
};

export class Refused extends Error {
  constructor(
    message: string,
    readonly code: string = "driver_install_failed",
  ) {
    super(message);
  }
}

export class Inconclusive extends Refused {
  constructor(message: string) {
    super(message, "driver_check_failed");
  }
}

export function say(line: string, sink: (text: string) => void): void {
  sink(line);
}

export type Speaker = (line: string) => void;

export function cuaHome(): string {
  return join(cliHome(), "cua-driver");
}

export function versionHome(): string {
  return join(cuaHome(), VERSION);
}

export function bundledApp(): string {
  return join(versionHome(), APP_NAME.replace(/\.app$/, ""));
}

export function installedApp(): string {
  return join(tools.applications, APP_NAME);
}

export function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function isRegular(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function driverEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
  for (const [name, value] of Object.entries(QUIET_ENV)) if (!(name in env)) env[name] = value;
  return env;
}

class DownloadFailed extends Error {}

async function download(url: string, dest: string): Promise<void> {
  if (!url.startsWith("https://")) throw new Refused(`refused a download that isn't https: ${url}`, "download_failed");
  let current = url;
  let response: Response | undefined;
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_S * 1000);
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_S * 1000);
  };
  try {
    for (let hop = 0; ; hop += 1) {
      try {
        response = await fetch(current, { redirect: "manual", headers: { "User-Agent": `ardia/${cliVersion()}` }, signal: controller.signal });
      } catch (error) {
        throw new DownloadFailed(controller.signal.aborted ? "<urlopen error timed out>" : `<urlopen error ${error instanceof Error ? error.message : String(error)}>`);
      }
      touch();
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (location === null) break;
        const next = new URL(location, current).toString();
        if (!next.startsWith("https://")) throw new DownloadFailed(`<urlopen error refused a redirect to ${next}>`);
        if (hop >= MAX_REDIRECTS) throw new DownloadFailed(`HTTP Error ${response.status}: The HTTP server returned a redirect error that would lead to an infinite loop.\nThe last 30x error message was:\n${response.statusText}`);
        current = next;
        continue;
      }
      break;
    }
    if (response === undefined || response.status >= 400 || response.body === null) {
      throw new DownloadFailed(`HTTP Error ${response?.status ?? 0}: ${response?.statusText ?? ""}`);
    }
    const fd = openSync(dest, "w");
    try {
      const reader = response.body.getReader();
      for (;;) {
        let chunk: { done: boolean; value?: Uint8Array };
        try {
          chunk = await reader.read();
        } catch {
          throw new DownloadFailed(controller.signal.aborted ? "timed out" : "the connection broke");
        }
        if (chunk.done) break;
        touch();
        const bytes = chunk.value ?? new Uint8Array();
        let at = 0;
        while (at < bytes.length) at += writeSync(fd, bytes, at);
      }
    } finally {
      closeSync(fd);
    }
  } finally {
    clearTimeout(timer);
  }
}

export function sha256Of(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function fetchVerified(asset: string, expected: string, work: string, speak: Speaker): Promise<string> {
  const path = join(work, asset);
  speak(`step download ${tools.releaseUrl}/${asset}`);
  try {
    await download(`${tools.releaseUrl}/${asset}`, path);
  } catch (error) {
    if (error instanceof Refused) throw error;
    const detail = error instanceof DownloadFailed ? error.message : osErrorText(error);
    throw new Refused(`couldn't download ${asset}: ${detail}`, "download_failed");
  }
  const actual = sha256Of(path);
  if (actual !== expected) {
    try {
      unlinkSync(path);
    } catch {}
    throw new Refused(`checksum mismatch for ${asset}: expected ${expected}, got ${actual}; nothing was installed`, "driver_unverified");
  }
  speak(`step verify ${asset} sha256 ${actual}`);
  return path;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function extract(archive: string, top: string, dest: string, keep: (inner: string) => boolean): string[] {
  let members: Member[];
  try {
    members = readTarGz(readFileSync(archive));
  } catch (error) {
    if (error instanceof TarError) throw new Refused(`couldn't read ${baseName(archive)}: ${error.message}`);
    throw error;
  }
  const taken: string[] = [];
  const chosen: Member[] = [];
  for (const member of members) {
    if (member.type === "\0" || member.type === "0") {
      if (member.name.endsWith("/")) member.type = "5";
    }
    if (isDir(member)) member.name = member.name.replace(/\/+$/, "");
    const parts = member.name.replace(/\/+$/, "").split("/");
    if (parts[0] !== top || parts.some((part) => part === "" || part === "." || part === "..")) {
      throw new Refused(`${baseName(archive)} has an entry outside ${top}/: ${member.name}`);
    }
    const inner = parts.slice(1).join("/");
    if (inner === "" || !keep(inner)) continue;
    if (!(isFile(member) || isDir(member))) throw new Refused(`${baseName(archive)} has a link or special file: ${member.name}`);
    member.name = inner;
    chosen.push(member);
    if (isFile(member)) taken.push(inner);
  }
  extractMembers(dest, chosen);
  return taken;
}

export function keepsDriverFile(inner: string): boolean {
  return inner === APP_NAME || inner.startsWith(`${APP_NAME}/`) || DRIVER_NOTICES.includes(inner);
}

export function keepsSkillFile(inner: string): boolean {
  return !inner.includes("/") && inner.endsWith(".md") && !OTHER_PLATFORM_DOCS.includes(inner);
}

function infoValue(app: string, key: string): string | null {
  try {
    const info = loadPlist(readFileSync(join(app, "Contents", "Info.plist")));
    const value = info instanceof Map ? info.get(key) : undefined;
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

export function appVersion(app: string): string | null {
  return infoValue(app, "CFBundleShortVersionString");
}

export function appBundleId(app: string): string | null {
  return infoValue(app, "CFBundleIdentifier");
}

function pyStr(value: string | null): string {
  return value === null ? "None" : value;
}

export type Tool = { code: number; stdout: string; stderr: string };

export async function runTool(argv: readonly string[], timeout: number, env?: Record<string, string>, signal?: AbortSignal): Promise<Tool> {
  const ran = await run(argv, { timeout, ...(env === undefined ? {} : { env }), ...(signal === undefined ? {} : { signal }) });
  return { code: ran.code, stdout: ran.stdout.toString("utf8"), stderr: ran.stderr.toString("utf8") };
}

export function subprocessText(argv: readonly string[], error: unknown, timeout: number): string {
  if (error instanceof RunTimedOut) return timeoutText(argv, timeout);
  if (error instanceof SpawnFailed) return spawnErrorText(argv, error.errno);
  return osErrorText(error);
}

export async function verifyApp(app: string): Promise<void> {
  const argv = [tools.codesign, "--verify", "--deep", "--strict", "-R", `=${REQUIREMENT}`, app];
  let result: Tool;
  try {
    result = await runTool(argv, 120);
  } catch (error) {
    throw new Inconclusive(`couldn't check the signature of ${app}: ${subprocessText(argv, error, 120)}`);
  }
  if (result.code !== 0) {
    const detail = pySplitlines(pyStrip(result.stderr || result.stdout));
    throw new Refused(`${app} isn't Cua AI's signed ${APP_NAME} (${detail.length > 0 ? detail[0] : `codesign exit ${result.code}`})`, "driver_unverified");
  }
}

export async function checkApp(app: string): Promise<void> {
  if (appBundleId(app) !== BUNDLE_ID) throw new Refused(`${app} has bundle id ${pyStr(appBundleId(app))}, not ${BUNDLE_ID}`, "driver_unverified");
  if (appVersion(app) !== VERSION) throw new Refused(`${app} is version ${pyStr(appVersion(app))}, not the pinned ${VERSION}`, "driver_unverified");
  await verifyApp(app);
}

export function pruneVersions(home: string): void {
  if (!isDirectory(home)) return;
  const others: { path: string; mtime: number }[] = [];
  for (const name of readdirSync(home)) {
    const path = join(home, name);
    if (VERSION_DIR.test(name) && name !== VERSION && isDirectory(path) && !isSymlink(path)) others.push({ path, mtime: statSync(path).mtimeMs });
  }
  others.sort((a, b) => b.mtime - a.mtime);
  for (const entry of others.slice(1)) rmSync(entry.path, { recursive: true, force: true });
}

export function removePath(path: string): void {
  if (isSymlink(path) || isRegular(path)) unlinkSync(path);
  else if (existsSync(path)) rmSync(path, { recursive: true });
}

export async function ensureDriver(speak: Speaker): Promise<string> {
  const app = bundledApp();
  if (lexists(app)) {
    try {
      if (isSymlink(app)) throw new Refused(`${app} is a link`);
      await checkApp(app);
      return app;
    } catch (error) {
      if (error instanceof Inconclusive || !(error instanceof Refused)) throw error;
      speak(`ardia computer: the cached cua-driver failed verification (${error.message}); fetching it again`);
      removePath(app);
    }
  }
  const home = versionHome();
  mkdirSync(home, { recursive: true });
  const work = mkdtempSync(join(home, ".driver-"));
  const forget = rollbackOnStop(() => rmSync(work, { recursive: true, force: true }));
  try {
    const archive = await fetchVerified(DRIVER_ASSET, DRIVER_SHA256, work, speak);
    const staged = join(work, "tree");
    mkdirSync(staged);
    extract(archive, DRIVER_TOP, staged, keepsDriverFile);
    unlinkSync(archive);
    if (!isRegular(join(staged, APP_NAME, APP_BINARY))) throw new Refused(`${DRIVER_ASSET} has no ${APP_NAME}/${APP_BINARY}`);
    await checkApp(join(staged, APP_NAME));
    stopPoint();
    for (const name of DRIVER_NOTICES) if (isRegular(join(staged, name))) renameSync(join(staged, name), join(home, name));
    try {
      renameSync(join(staged, APP_NAME), app);
    } catch (error) {
      if (!isRegular(join(app, APP_BINARY))) throw error;
      await checkApp(app);
    }
  } finally {
    forget();
    rmSync(work, { recursive: true, force: true });
  }
  speak(`step installed ${app}`);
  pruneVersions(cuaHome());
  return app;
}

export async function skillPack(speak: Speaker): Promise<Map<string, Buffer>> {
  const folder = join(versionHome(), "skills");
  if (!(isDirectory(folder) && !isSymlink(folder) && isRegular(join(folder, "SKILL.md")))) {
    const home = versionHome();
    mkdirSync(home, { recursive: true });
    const work = mkdtempSync(join(home, ".skills-"));
    try {
      const archive = await fetchVerified(SKILLS_ASSET, SKILLS_SHA256, work, speak);
      const staged = join(work, "skills");
      mkdirSync(staged);
      const names = extract(archive, SKILLS_TOP, staged, keepsSkillFile);
      if (!names.includes("SKILL.md")) throw new Refused(`${SKILLS_ASSET} has no SKILL.md`);
      if (isSymlink(folder)) unlinkSync(folder);
      else if (existsSync(folder)) rmSync(folder, { recursive: true });
      try {
        renameSync(staged, folder);
      } catch (error) {
        if (!isRegular(join(folder, "SKILL.md"))) throw error;
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  const pack = new Map<string, Buffer>();
  for (const name of readdirSync(folder).sort()) {
    const path = join(folder, name);
    if (isRegular(path) && !isSymlink(path) && keepsSkillFile(name)) pack.set(name, readFileSync(path));
  }
  return pack;
}

export { calledProcessText };
