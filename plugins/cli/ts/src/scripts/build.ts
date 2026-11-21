import fs from "node:fs";
import os from "node:os";
import { installedDataDir } from "../control.ts";
import { installRoot } from "../install.ts";
import { parseText, type Value } from "../json.ts";
import { codeOf, envSet, errnoOf, expandUser, home, purePath, realpath, strerror } from "../paths.ts";
import { pyStrip, splitlines } from "../pylib/str.ts";
import { Interrupted } from "./output.ts";
import { runCaptured, Timeout } from "./run.ts";
import { displayPath, type RawSourceMap } from "./sourcemap.ts";
import { type Meta, fileName, parseMeta, ScriptError } from "./userscript.ts";

export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".css"];
const CHROME_TARGET = "chrome130";
const ESBUILD_PACKAGE = process.platform === "linux" ? "linux-x64" : "darwin-arm64";
const ESBUILD_TIMEOUT_MS = 60_000;

export type Build = { meta: Meta; source: string; path: string; js: string; sourcemap: RawSourceMap | null; warnings: string[] };
type Identity = string;

function executable(path: string): boolean {
  try {
    fs.accessSync(path, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isSymlink(path: string): boolean {
  try {
    return fs.lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

const TEST_ESBUILD = "ARDIA_TEST_ESBUILD";

export function bundledEsbuild(root: string | null): string | null {
  return root === null ? null : `${root}/libexec/esbuild`;
}

function parentsOf(path: string): string[] {
  const found: string[] = [];
  let current = path;
  for (;;) {
    const parent = current.slice(0, current.lastIndexOf("/")) || "/";
    found.push(parent);
    if (parent === current || parent === "/") return found;
    current = parent;
  }
}

function pnpmCandidates(modules: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(`${modules}/.pnpm`).filter((name) => name.startsWith(`@esbuild+${ESBUILD_PACKAGE}@`));
  } catch {
    return [];
  }
  return names
    .map((name) => `${modules}/.pnpm/${name}/node_modules/@esbuild/${ESBUILD_PACKAGE}/bin/esbuild`)
    .filter((path) => fs.existsSync(path))
    .sort()
    .reverse();
}

export function which(name: string): string | null {
  const search = process.env.PATH ?? (process.platform === "darwin" ? "/usr/bin:/bin:/usr/sbin:/sbin" : "/bin:/usr/bin");
  if (!search) return null;
  for (const dir of search.split(":")) {
    const candidate = `${dir || "."}/${name}`;
    try {
      if (fs.statSync(candidate).isDirectory()) continue;
    } catch {
      continue;
    }
    if (executable(candidate)) return dir ? candidate : name;
  }
  return null;
}

export function findEsbuild(root: string | null = installRoot()): string | null {
  const override = envSet(TEST_ESBUILD);
  if (override !== undefined) return override;
  const bundled = bundledEsbuild(root);
  if (bundled !== null && fs.existsSync(bundled)) return executable(bundled) && !isSymlink(bundled) ? bundled : null;
  for (const parent of root === null ? [] : [root, ...parentsOf(root)]) {
    const modules = `${parent}/node_modules`;
    const native = `${modules}/@esbuild/${ESBUILD_PACKAGE}/bin/esbuild`;
    if (executable(native)) return native;
    const pnpm = pnpmCandidates(modules).find(executable);
    if (pnpm !== undefined) return pnpm;
  }
  return which("esbuild");
}

export function installed(root: string | null = installRoot()): boolean {
  const bundled = bundledEsbuild(root);
  return bundled !== null && fs.existsSync(bundled);
}

function identity(path: string): Identity | null {
  try {
    const info = fs.statSync(path, { bigint: true });
    return `${info.dev}:${info.ino}`;
  } catch {
    return null;
  }
}

function lineage(path: string): (Identity | null)[] {
  let current = realpath(path);
  const found: (Identity | null)[] = [];
  for (;;) {
    found.push(identity(current));
    const parent = current.slice(0, current.lastIndexOf("/")) || "/";
    if (parent === current) return found;
    current = parent;
  }
}

export function forbiddenRoots(dataDirs: readonly string[]): string[] {
  const roots = [installedDataDir(), ...dataDirs];
  const dataDir = envSet("ARDIA_DATA_DIR");
  if (dataDir !== undefined) roots.push(purePath(expandUser(dataDir)));
  return roots;
}

function forbiddenSet(dataDirs: readonly string[]): Set<Identity> {
  return new Set(forbiddenRoots(dataDirs).map(identity).filter((item): item is Identity => item !== null));
}

export function checkFile(real: string, forbidden: Set<Identity>, label: string): (Identity | null)[] {
  const chain = lineage(real);
  if (chain.some((item) => item !== null && forbidden.has(item))) throw new ScriptError(`refusing to bundle ${real}: it's in Ardia's data folder`);
  let info: fs.Stats;
  try {
    info = fs.statSync(real);
  } catch (error) {
    throw new ScriptError(`refusing to bundle ${real}: ${strerror(errnoOf(error))}`);
  }
  if (!info.isFile()) throw new ScriptError(`refusing to bundle ${real}: not a regular file`);
  if (info.nlink > 1) throw new ScriptError(`refusing to bundle ${real}: it has other hard links`);
  if (!SOURCE_EXTENSIONS.some((suffix) => fileName(real).toLowerCase().endsWith(suffix))) {
    throw new ScriptError(`refusing to bundle ${real}: ${label} must be ${SOURCE_EXTENSIONS.join(", ")} source`);
  }
  return chain;
}

function parentDir(path: string): string {
  const at = path.lastIndexOf("/");
  return at <= 0 ? (path.startsWith("/") ? "/" : ".") : path.slice(0, at);
}

export function checkInputs(inputs: string[], base: string, entry: string, dataDirs: readonly string[]): void {
  const forbidden = forbiddenSet(dataDirs);
  const folder = parentDir(entry);
  const tree = identity(folder);
  const shallow = tree === identity(home() || ".") || tree === identity("/");
  for (const name of inputs) {
    if (name.startsWith("<data:")) continue;
    if (name.startsWith("<")) throw new ScriptError(`refusing to bundle ${name}: only files in the script's folder can be imported`);
    const real = realpath(name.startsWith("/") ? name : `${base}/${name}`);
    const chain = checkFile(real, forbidden, "imports");
    if (identity(real) === identity(entry)) continue;
    if (shallow) throw new ScriptError(`refusing to bundle ${real}: a script in ${folder} may only import files in a folder of its own; move it into one`);
    if (!chain.slice(1).includes(tree)) throw new ScriptError(`refusing to bundle ${real}: imports must stay inside ${folder} (symlinks resolved)`);
  }
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function universalNewlines(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

export function readText(path: string): string {
  return universalNewlines(STRICT_UTF8.decode(fs.readFileSync(path)));
}

function readSource(path: string): string {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(path);
  } catch (error) {
    const code = errnoOf(error);
    throw new ScriptError(`${path}: ${code ? strerror(code) : String(error)}`);
  }
  try {
    return universalNewlines(STRICT_UTF8.decode(bytes));
  } catch {
    throw new ScriptError(`${path}: isn't UTF-8 text`);
  }
}

function inputNames(text: string): string[] {
  const parsed = parseText(text);
  if (!(parsed instanceof Map)) throw new ScriptError("esbuild didn't say which files it bundled");
  const inputs: Value | undefined = parsed.get("inputs");
  return inputs instanceof Map ? [...inputs.keys()] : [];
}

export async function build(given: string, sourcemap = false, dataDirs: readonly string[] = [], stopped: () => boolean = () => false): Promise<Build> {
  const path = purePath(given);
  const source = readSource(path);
  const meta = parseMeta(source, fileName(path));
  const esbuild = findEsbuild();
  if (!esbuild) throw new ScriptError(`esbuild isn't available: ${installed() ? "reinstall the ardia command" : "run pnpm install, or put esbuild on PATH"}`);
  const entry = realpath(path);
  checkFile(entry, forbiddenSet(dataDirs), "a script");
  const work = fs.mkdtempSync(`${os.tmpdir().replace(/\/+$/, "")}/ardia-script-`);
  try {
    const out = `${work}/script.js`;
    const metafile = `${work}/meta.json`;
    const command = [
      esbuild, entry, "--bundle", "--format=iife", "--platform=browser", `--target=${CHROME_TARGET}`, "--charset=utf8", "--legal-comments=none",
      "--log-level=warning", "--color=false", "--tsconfig-raw={}", `--metafile=${metafile}`, `--outfile=${out}`,
    ];
    if (sourcemap) command.push("--sourcemap=external");
    let done: Awaited<ReturnType<typeof runCaptured>>;
    try {
      done = await runCaptured(command, { cwd: parentDir(entry), timeoutMs: ESBUILD_TIMEOUT_MS, stopped });
    } catch (error) {
      if (error instanceof Interrupted) throw error;
      if (error instanceof Timeout) throw new ScriptError("esbuild took over 60 s");
      const code = errnoOf(error);
      throw new ScriptError(`can't run esbuild (${code ? strerror(code) : (codeOf(error) ?? String(error))})`);
    }
    const messages = pyStrip(done.stderr);
    if (done.status !== 0) throw new ScriptError(messages ? `esbuild couldn't build ${path}:\n${messages}` : `esbuild couldn't build ${path}`);
    let inputs: string[];
    try {
      inputs = inputNames(readText(metafile));
    } catch {
      throw new ScriptError("esbuild didn't say which files it bundled");
    }
    checkInputs(inputs, parentDir(entry), entry, dataDirs);
    const js = readText(out);
    let mapping: RawSourceMap | null = null;
    if (sourcemap && fs.existsSync(`${out}.map`)) {
      const data = JSON.parse(readText(`${out}.map`)) as Record<string, unknown>;
      data.sources = (Array.isArray(data.sources) ? data.sources : []).map((name) => displayPath(work, String(name)));
      mapping = data;
    }
    const warnings = messages ? splitlines(messages).filter((line) => pyStrip(line)) : [];
    return { meta, source, path, js, sourcemap: mapping, warnings };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
