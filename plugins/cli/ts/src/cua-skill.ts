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
const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 256;
const CACHED_SHA256: Readonly<Record<string, string>> = {
  "BROWSER.md": "b008c6bfef08beaf030304adee72a297ddc0df436af32ee8fa643c0dff77efbf",
  "EMBEDDING.md": "c015a13bfbd6a5102a4984091824215e5e84a868c6f99e504fee794d0a5a3a17",
  "MACOS.md": "a02c45ab38daeb72e39ba504db2a43f8243146bcde2b957e38139cb4a525d2d4",
  "README.md": "7b561c189ec2f2c38eed3bc7981935ba45c0a3ae03db4788565e3528efc19e3b",
  "RECORDING.md": "6d1d5f8ff192f37bd9c67efcda59154f3242b0fae72e86ba7e2ba5a4899fd248",
  "RUNTIME.md": "b62dd42b3628792bc30e17b8052ece4b8442160d4e71893e927d0d3d996c6509",
  "SKILL.md": "f771345ea9656ce7e2ace7a5940ef325e8eea3e4eada316cbeeea62747d540fd",
  "VISUAL.md": "66aa0fadd643ee4cd0deda751af1f3ebc2cec0b77607eec61c9b2a4ee7d4a256",
  "WORKFLOW.md": "1e3d2ed4751af6983ce0858d176db0acb977fe0cf02f3e38bcad5a3568b91be8",
};
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
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = response.body?.getReader();
    while (reader !== undefined) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_ARCHIVE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error(`the download is over ${MAX_ARCHIVE_BYTES} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
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
    entries = readTar(gunzipSync(archive, { maxOutputLength: MAX_EXPANDED_BYTES }));
    if (entries.length > MAX_ENTRIES) throw new TarError(`more than ${MAX_ENTRIES} entries`);
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

function cacheIsIntact(folder: string): boolean {
  const kept = readdirSync(folder).filter((name) => keepsSkillFile(name));
  if (kept.length !== Object.keys(CACHED_SHA256).length) return false;
  return kept.every((name) => {
    try {
      const info = lstatSync(join(folder, name));
      return info.isFile() && createHash("sha256").update(readFileSync(join(folder, name))).digest("hex") === CACHED_SHA256[name];
    } catch {
      return false;
    }
  });
}

export async function skillPack(): Promise<Map<string, Buffer>> {
  const home = versionHome();
  const folder = join(home, "skills");
  if (!(isRealDir(folder) && cacheIsIntact(folder))) {
    mkdirSync(home, { recursive: true });
    const work = mkdtempSync(join(home, ".skills-"));
    try {
      const archive = await fetchVerified(SKILLS_ASSET, SKILLS_SHA256);
      const staged = join(work, "skills");
      mkdirSync(staged);
      const names = extract(archive, SKILLS_ASSET, SKILLS_TOP, staged, keepsSkillFile);
      if (!names.includes("SKILL.md")) throw new Refused(`${SKILLS_ASSET} has no SKILL.md`);
      if (!cacheIsIntact(staged)) throw new Refused(`${SKILLS_ASSET} doesn't hold the files this ardia pins`);
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
