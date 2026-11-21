import fs from "node:fs";
import path from "node:path";
import { dumps, type Value } from "../../json.ts";
import { formatG } from "../../pylib/format.ts";
import { codePoints } from "../../pystr.ts";
import { pyLoads, plainParams } from "../cdp/params.ts";
import { BrowseError, Usage } from "../daemon-errors.ts";
import { pyValue } from "../daemon/render.ts";
import { browseDir, checkName, closeFd, DIR_NAME, openPrivateDirAt, readPrivateJson, writePrivateJson } from "../paths.ts";
import { run, RunTimedOut, SpawnFailed } from "./run.ts";
import { originOf } from "./origin.ts";

export const PROTOCOL = "agent-browser.plugin.v1";
export const REGISTRY = "registry.json";
export const RUN_TIMEOUT = 60;
export const MAX_REPLY = 1024 * 1024;
const NPM_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const GITHUB = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)(?:#([A-Za-z0-9._/-]+))?$/u;
const LINE_BREAKS = new RegExp("\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85\\u2028\\u2029]", "u");
const SHA = /^[0-9a-f]{40}$/u;
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/u;

export type Plugin = Record<string, any>;

export function pluginDir(root: string): number {
  const browse = browseDir(root);
  try {
    return openPrivateDirAt(browse, "plugins");
  } finally {
    closeFd(browse);
  }
}

export function registry(root: string): Plugin[] {
  const folder = pluginDir(root);
  try {
    const found = readPrivateJson(REGISTRY, folder);
    const plain = (found === undefined ? {} : plainParams(found)) as Record<string, unknown> | null;
    const plugins = plain && typeof plain === "object" ? plain["plugins"] : undefined;
    return Array.isArray(plugins) ? (plugins as Plugin[]) : [];
  } finally {
    closeFd(folder);
  }
}

export function saveRegistry(root: string, plugins: Plugin[]): void {
  const folder = pluginDir(root);
  try {
    writePrivateJson(REGISTRY, folder, pyValue({ plugins }));
  } finally {
    closeFd(folder);
  }
}

export function find(root: string, name: string): Plugin {
  for (const plugin of registry(root)) if (plugin["name"] === name) return plugin;
  throw new BrowseError(`No plugin named ${name}; add one with \`ardia browse plugin add <ref>\``);
}

function decode(bytes: Buffer): string {
  return new TextDecoder("utf-8").decode(bytes);
}

export async function runTool(argv: readonly string[], timeout = 300): Promise<string> {
  let ran;
  try {
    ran = await run(argv, { timeout });
  } catch (error) {
    if (error instanceof SpawnFailed && error.code === "ENOENT") throw new BrowseError(`${argv[0]} isn't installed`);
    if (error instanceof RunTimedOut) throw new BrowseError(`${argv[0]} took longer than ${formatG(timeout)}s`);
    throw error;
  }
  if (ran.code) {
    const said = codePoints(decode(ran.stderr).trim());
    throw new BrowseError(`${argv.slice(0, 3).join(" ")} failed: ${said.slice(-400).join("")}`);
  }
  return decode(ran.stdout);
}

export async function resolveSpec(ref: string): Promise<[string, string, string]> {
  const github = GITHUB.exec(ref);
  if (github && !ref.startsWith("@")) {
    const [, owner, repo, branch] = github as unknown as [string, string, string, string | undefined];
    const out = await runTool(["git", "ls-remote", `https://github.com/${owner}/${repo}`, branch || "HEAD"], 60);
    const line = out.split(/\r\n|\r|\n/u).find((row) => row.trim()) ?? "";
    const sha = line ? (line.trim().split(/\s+/u)[0] ?? "") : "";
    if (!SHA.test(sha)) throw new BrowseError(`Couldn't resolve ${ref} to a commit`);
    return [`github:${owner}/${repo}#${sha}`, repo, sha];
  }
  const ats = [...ref].filter((char) => char === "@").length;
  let name = ref;
  let version = "";
  if (ats > (ref.startsWith("@") ? 1 : 0)) {
    const cut = ref.lastIndexOf("@");
    name = ref.slice(0, cut);
    version = ref.slice(cut + 1);
  }
  if (!NPM_NAME.test(name)) throw new Usage(`${ref} isn't an npm package (name or name@version) or a GitHub owner/repo`);
  if (!version || !VERSION.test(version)) {
    let found: unknown = plainParams(pyLoads(await runTool(["npm", "view", `${name}@${version || "latest"}`, "version", "--json"], 60)));
    if (Array.isArray(found)) found = found.at(-1);
    version = String(found);
  }
  return [`${name}@${version}`, name, version];
}

export async function add(root: string, ref: string, given: string | null, capabilities: string[] | null): Promise<Plugin> {
  const [spec, packageName, version] = await resolveSpec(ref);
  const fallback = (packageName.split("/").at(-1) as string).replace(/^agent-browser-plugin-/u, "");
  const name = checkName("A plugin name", given || fallback);
  const plugins = registry(root).filter((plugin) => plugin["name"] !== name);
  closeFd(pluginDir(root));
  const base = path.join(root, DIR_NAME, "plugins", name);
  if (fs.existsSync(base)) fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(base, { mode: 0o700 });
  await runTool(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-save", "--prefix", base, spec], 600);
  let manifestDir = path.join(base, "node_modules", spec.startsWith("github:") ? "" : packageName);
  if (spec.startsWith("github:")) {
    const modules = path.join(base, "node_modules");
    const installed = fs
      .readdirSync(modules)
      .map((entry) => path.join(modules, entry))
      .filter((entry) => !path.basename(entry).startsWith(".") && fs.existsSync(path.join(entry, "package.json")) && fs.statSync(path.join(entry, "package.json")).isFile());
    if (installed.length > 0) manifestDir = installed[0] as string;
  }
  const manifest = plainParams(pyLoads(fs.readFileSync(path.join(manifestDir, "package.json"), "utf8"))) as Record<string, any>;
  let bins = manifest["bin"] || {};
  if (typeof bins === "string") bins = { [(String(manifest["name"] ?? packageName).split("/").at(-1) as string)]: bins };
  const first = Object.values(bins)[0];
  if (first === undefined) throw new BrowseError(`${spec} has no bin entry to run`);
  const target = path.resolve(manifestDir, String(first));
  let command: string;
  try {
    command = fs.realpathSync.native(target);
  } catch {
    command = target;
  }
  const realBase = fs.realpathSync.native(base);
  if (!command.startsWith(`${realBase}${path.sep}`)) throw new BrowseError(`${spec}'s bin points outside its install folder`);
  const declared = (manifest["agent-browser"] || manifest["agentBrowser"] || {})["capabilities"] || [];
  const plugin: Plugin = {
    name,
    package: manifest["name"] ?? packageName,
    version: manifest["version"] ?? version,
    spec,
    command,
    capabilities: [...new Set<string>(capabilities?.length ? capabilities : declared.length ? declared : ["command.run"])].sort(),
  };
  plugins.push(plugin);
  saveRegistry(root, plugins);
  return plugin;
}

export function remove(root: string, name: string): void {
  find(root, name);
  saveRegistry(
    root,
    registry(root).filter((plugin) => plugin["name"] !== name),
  );
  const base = path.join(root, DIR_NAME, "plugins", name);
  let info: fs.Stats | null = null;
  try {
    info = fs.lstatSync(base);
  } catch {
    info = null;
  }
  if (info !== null && info.isDirectory() && !info.isSymbolicLink()) fs.rmSync(base, { recursive: true, force: true });
}

export const PLUGIN_ENV = ["PATH", "HOME", "LANG", "TMPDIR", "USER", "LOGNAME", "SHELL"];
export const CREDENTIAL_TEXT_FIELDS = ["url", "username", "usernameSelector", "passwordSelector", "submitSelector"];

export function pluginEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (PLUGIN_ENV.includes(key) || key.startsWith("LC_")) env[key] = value;
  }
  return env;
}

type Reply = ({ kind: "ok"; data: Value; success: Value } | { kind: "invalid" } | { kind: "protocol"; said: Value } | { kind: "failed"; error: Value; success: Value }) & {
  exit: number;
};

async function ask(root: string, name: string, capability: string, request: unknown, timeout: number): Promise<Reply> {
  const plugin = find(root, name);
  const declared = (plugin["capabilities"] ?? []) as string[];
  if (!declared.includes(capability) && capability !== "command.run") {
    throw new BrowseError(`Plugin ${name} doesn't declare ${capability} (it declares ${declared.join(", ")})`);
  }
  const payload = dumps(pyValue({ protocol: PROTOCOL, capability, type: capability, request }), "spaced", true);
  let ran;
  try {
    ran = await run([String(plugin["command"])], {
      input: Buffer.from(payload, "utf8"),
      timeout,
      env: pluginEnv(),
      cwd: path.dirname(String(plugin["command"])),
      limit: MAX_REPLY,
    });
  } catch (error) {
    if (error instanceof RunTimedOut) throw new BrowseError(`Plugin ${name} didn't answer in ${formatG(timeout)}s`);
    if (error instanceof SpawnFailed) throw new BrowseError(`Couldn't run plugin ${name}: ${error.strerror}`);
    throw error;
  }
  const raw = decode(ran.stdout.subarray(0, MAX_REPLY)).trim();
  let reply: Value;
  try {
    const lines = raw.split(LINE_BREAKS);
    reply = pyLoads(raw ? (lines.at(-1) as string) : "");
  } catch {
    return { kind: "invalid", exit: ran.code };
  }
  if (!(reply instanceof Map) || reply.get("protocol") !== PROTOCOL) return { kind: "protocol", said: reply instanceof Map ? (reply.get("protocol") ?? "") : "", exit: ran.code };
  const success = reply.get("success") ?? null;
  if (!success || success === 0n) return { kind: "failed", error: reply.get("error") ?? null, success, exit: ran.code };
  return { kind: "ok", data: reply.get("data") ?? null, success, exit: ran.code };
}

export async function call(root: string, name: string, capability: string, request: unknown, timeout = RUN_TIMEOUT): Promise<unknown> {
  const reply = await ask(root, name, capability, request, timeout);
  if (reply.kind === "invalid") throw new BrowseError(`Plugin '${name}' returned invalid JSON`);
  if (reply.kind === "protocol") throw new BrowseError(`Plugin '${name}' used unsupported protocol '${typeof reply.said === "string" ? reply.said : dumps(reply.said, "spaced")}'`);
  if (reply.kind === "failed") {
    const error = reply.error;
    throw new BrowseError(`Plugin '${name}' failed: ${error && typeof error === "string" ? error : error ? dumps(error, "spaced") : "no detail"}`);
  }
  return plainParams(reply.data);
}

function malformed(name: string): BrowseError {
  return new BrowseError(`Credential provider ${name} sent a malformed reply`, null, "credential_provider_failed");
}

const MAX_FIELD = 1000;
const UNPRINTABLE = /[\p{Cc}\p{Cf}]/u;

function usableText(value: string, empty: boolean): boolean {
  if (UNPRINTABLE.test(value) || codePoints(value).length > MAX_FIELD) return false;
  return empty || value.trim() !== "";
}

function usableUrl(value: string): boolean {
  if (!usableText(value, false) || /\s/u.test(value)) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.hostname === "" || parsed.username !== "" || parsed.password !== "") return false;
  try {
    originOf(value);
    return true;
  } catch {
    return false;
  }
}

export async function credential(root: string, name: string, item: string, url: string | null, timeout = RUN_TIMEOUT): Promise<Record<string, string>> {
  const reply = await ask(root, name, "credential.read", { item, ...(url ? { url } : {}) }, timeout);
  if (reply.kind === "failed" && reply.success === false) throw new BrowseError(`Credential provider ${name} returned an error`, null, "credential_provider_failed");
  if (reply.kind === "ok" && reply.exit !== 0) throw new BrowseError(`Credential provider ${name} returned an error`, null, "credential_provider_failed");
  if (reply.kind !== "ok" || reply.success !== true) throw malformed(name);
  const data = reply.data;
  if (!(data instanceof Map)) throw malformed(name);
  const password = data.get("password");
  if (typeof password !== "string" || password === "" || codePoints(password).length > MAX_FIELD) throw malformed(name);
  const creds: Record<string, string> = Object.create(null);
  creds["password"] = password;
  for (const field of CREDENTIAL_TEXT_FIELDS) {
    if (!data.has(field)) continue;
    const value = data.get(field);
    if (typeof value !== "string") throw malformed(name);
    const usable = field === "url" ? usableUrl(value) : usableText(value, field === "username");
    if (!usable) throw malformed(name);
    creds[field] = value;
  }
  return creds;
}

