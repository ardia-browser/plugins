import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "./paths.ts";
import { toStderr } from "./printable.ts";
import { readTar, TarError } from "./tar.ts";
import { cliHome } from "./usage.ts";
import { cliVersion } from "./version.ts";

export const CUA_VERSION = "0.38.0";
const SKILLS_SHA256 = "0fe3d607e7212d6c58072a2419163342061dcf5cb89ba1243dea593d7e33be0f";
const RELEASE_URL = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${CUA_VERSION}`;
const SKILLS_ASSET = `cua-driver-rs-v${CUA_VERSION}-skills.tar.gz`;
const SKILLS_TOP = `cua-driver-rs-v${CUA_VERSION}-skills`;
const OTHER_PLATFORM_DOCS = ["LINUX.md", "WINDOWS.md"];
const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 10;

export class Refused extends Error {}

function say(line: string): void {
  toStderr(`${line}\n`);
}

export function versionHome(): string {
  return join(cliHome(), "cua-driver", CUA_VERSION);
}

export function keepsSkillFile(inner: string): boolean {
  return !inner.includes("/") && inner.endsWith(".md") && !OTHER_PLATFORM_DOCS.includes(inner);
}

async function download(url: string): Promise<Buffer> {
  if (!url.startsWith("https://")) throw new Refused(`refused a download that isn't https: ${url}`);
  const deadline = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  let current = url;
  for (let hops = 0; ; hops += 1) {
    const response = await fetch(current, { headers: { "User-Agent": `ardia/${cliVersion()}` }, redirect: "manual", signal: deadline });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location !== null) {
      await response.body?.cancel().catch(() => {});
      const next = new URL(location, current).href;
      if (!next.startsWith("https://")) throw new Error(`<urlopen error refused a redirect to ${next}>`);
      if (hops >= MAX_REDIRECTS) throw new Error(`HTTP Error ${response.status}: The HTTP server returned a redirect error that would lead to an infinite loop.`);
      current = next;
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`HTTP Error ${response.status}: ${response.statusText}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }
}

async function fetchVerified(asset: string, expected: string): Promise<Buffer> {
  say(`step download ${RELEASE_URL}/${asset}`);
  let archive: Buffer;
  try {
    archive = await download(`${RELEASE_URL}/${asset}`);
  } catch (error) {
    if (error instanceof Refused) throw error;
    throw new Refused(`couldn't download ${asset}: ${(error as Error)?.message ?? String(error)}`);
  }
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== expected) throw new Refused(`checksum mismatch for ${asset}: expected ${expected}, got ${actual}; nothing was installed`);
  say(`step verify ${asset} sha256 ${actual}`);
  return archive;
}

function extract(archive: Buffer, name: string, top: string, dest: string, keep: (inner: string) => boolean): string[] {
  let entries;
  try {
    entries = readTar(gunzipSync(archive));
  } catch (error) {
    if (error instanceof TarError || error instanceof Error) throw new Refused(`couldn't read ${name}: ${error.message}`);
    throw error;
  }
  const kept: { inner: string; entry: (typeof entries)[number] }[] = [];
  for (const entry of entries) {
    const parts = entry.name.replace(/\/+$/, "").split("/");
    if (parts[0] !== top || parts.some((part) => part === "" || part === "." || part === "..")) {
      throw new Refused(`${name} has an entry outside ${top}/: ${entry.name}`);
    }
    const inner = parts.slice(1).join("/");
    if (inner === "" || !keep(inner)) continue;
    if (entry.type === "other") throw new Refused(`${name} has a link or special file: ${entry.name}`);
    kept.push({ inner, entry });
  }
  const taken: string[] = [];
  for (const { inner, entry } of kept) {
    const target = join(dest, inner);
    if (entry.type === "dir") mkdirSync(target, { recursive: true });
    else {
      writeFileSync(target, entry.data, { mode: 0o644 });
      taken.push(inner);
    }
  }
  return taken;
}

function isRealDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export async function skillPack(): Promise<Map<string, Buffer>> {
  const home = versionHome();
  const folder = join(home, "skills");
  if (!(isRealDir(folder) && isFile(join(folder, "SKILL.md")))) {
    mkdirSync(home, { recursive: true });
    const work = mkdtempSync(join(home, ".skills-"));
    try {
      const archive = await fetchVerified(SKILLS_ASSET, SKILLS_SHA256);
      const staged = join(work, "skills");
      mkdirSync(staged);
      const names = extract(archive, SKILLS_ASSET, SKILLS_TOP, staged, keepsSkillFile);
      if (!names.includes("SKILL.md")) throw new Refused(`${SKILLS_ASSET} has no SKILL.md`);
      let existing;
      try {
        existing = lstatSync(folder);
      } catch {
        existing = undefined;
      }
      if (existing?.isSymbolicLink()) unlinkSync(folder);
      else if (existing !== undefined) rmSync(folder, { recursive: true, force: true });
      try {
        renameSync(staged, folder);
      } catch (error) {
        if (!isFile(join(folder, "SKILL.md"))) throw error;
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  const pack = new Map<string, Buffer>();
  for (const name of readdirSync(folder).sort()) {
    const path = join(folder, name);
    let info;
    try {
      info = lstatSync(path);
    } catch {
      continue;
    }
    if (info.isFile() && keepsSkillFile(name)) pack.set(name, readFileSync(path));
  }
  return pack;
}
