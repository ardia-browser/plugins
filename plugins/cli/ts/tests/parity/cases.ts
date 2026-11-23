import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { isObject, loads, type Py, type PyObject } from "./pyjson.ts";

export const PARITY = import.meta.dirname;
export const CASE_ROOT = join(PARITY, "cases");
export const BLOBS = join(PARITY, "blobs.json");
export const EXPECTED_BLOBS = join(PARITY, "expected-blobs.json");
export const FIXTURES = join(PARITY, "fixtures");
export const TS_ROOT = join(PARITY, "..", "..");
export const SERVED_TABLE = join(TS_ROOT, "..", "served.txt");

export const ROOTS = ["home", "cli-home", "data", "cwd", "tmp", "outside"];
export const PROTECTED_ENV = new Set(["HOME", "ARDIA_CLI_HOME", "TMPDIR", "PATH", "ARDIA_TELEMETRY_URL", "http_proxy", "https_proxy", "HTTP_PROXY",
  "HTTPS_PROXY", "no_proxy", "NO_PROXY", "ALL_PROXY", "all_proxy", "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "PYTHONDONTWRITEBYTECODE",
  "ARDIA_PARITY_BOX", "DYLD_INSERT_LIBRARIES", "LD_PRELOAD"]);
export const PATH_ENV = new Set(["ARDIA_DATA_DIR", "ARDIA_CONFIG_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR"]);
export const HELPER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const LINUX_MAX_ARG_STRLEN = 128 * 1024;
export const PLACEHOLDER_ROOM = 4096;
export const CASE_EXEC_BUDGET = 1024 * 1024;
const CASE_KEYS = new Set(["id", "command", "argv", "stdin", "env", "control", "daemon", "credential", "intentional", "cdp_rules", "consent", "files",
  "helpers", "fallback", "normalize", "error_codes", "note", "expected", "expected_linux"]);
const CDP_RULE_KEYS = new Set(["never_params", "only_values", "why"]);
const CDP_METHOD = /^[A-Z][A-Za-z]+\.[a-z][A-Za-z]+$/;

export class UnsafeCase extends Error {}

export type Case = {
  id: string;
  command: string;
  argv: string[];
  stdin: Py;
  env: Map<string, string | null>;
  control: PyObject | null;
  daemon: PyObject | null;
  credential: PyObject | null;
  consent: PyObject | null;
  files: [string, Py][];
  helpers: Map<string, PyObject>;
  fallback: boolean;
  normalize: [string, string][];
  expected: PyObject | undefined;
  expectedLinux: PyObject | undefined;
  source: string;
  row: PyObject;
};

function fail(where: string, message: string): never {
  throw new UnsafeCase(`${where}: ${message}`);
}

function objectOr(value: Py | undefined, fallback: PyObject | null, what: string, where: string): PyObject | null {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (!isObject(value)) fail(where, `${what} is an object`);
  return value;
}

export function caseFromRow(row: Py, source: string): Case {
  if (!isObject(row)) throw new Error(`${source}: a case is an object`);
  const id = row.get("id");
  const unknown = [...row.keys()].filter((key) => !CASE_KEYS.has(key)).sort();
  if (unknown.length) throw new Error(`${source}: case ${JSON.stringify(id)} has unknown keys ${JSON.stringify(unknown)}`);
  const where = `case ${JSON.stringify(id)}`;
  const command = row.get("command");
  const argv = row.get("argv");
  if (typeof id !== "string" || typeof command !== "string" || !Array.isArray(argv)) throw new Error(`${source}: ${where} needs id, command and argv`);
  const env = objectOr(row.get("env"), new Map(), "env", where)!;
  const files = objectOr(row.get("files"), new Map(), "files", where)!;
  const helpers = objectOr(row.get("helpers"), new Map(), "helpers", where)!;
  const normalize = row.get("normalize") ?? [];
  if (!Array.isArray(normalize) || !normalize.every((rule) => Array.isArray(rule) && rule.length === 2 && rule.every((part) => typeof part === "string"))) {
    fail(where, "normalize lists [pattern, replacement] pairs");
  }
  for (const value of env.values()) if (value !== null && typeof value !== "string") fail(`${where}`, "env values are text or null");
  for (const value of helpers.values()) if (!isObject(value)) fail(where, "a helper is an object");
  const expected = row.get("expected");
  const expectedLinux = row.get("expected_linux");
  const kase: Case = {
    id,
    command,
    argv: argv as string[],
    stdin: row.get("stdin") ?? null,
    env: env as Map<string, string | null>,
    control: objectOr(row.get("control"), new Map(), "control", where),
    daemon: objectOr(row.get("daemon"), null, "daemon", where),
    credential: objectOr(row.get("credential"), null, "credential", where),
    consent: objectOr(row.get("consent"), new Map(), "consent", where),
    files: [...files],
    helpers: helpers as Map<string, PyObject>,
    fallback: row.get("fallback") === true,
    normalize: normalize as [string, string][],
    expected: isObject(expected) ? expected : undefined,
    expectedLinux: isObject(expectedLinux) ? expectedLinux : undefined,
    source,
    row,
  };
  checkCaseIsContained(kase);
  return kase;
}

const SKETCH: [string, string][] = [["box", "/BOX"], ["home", "/BOX/home"], ["cli_home", "/BOX/cli-home"], ["data", "/BOX/data"], ["cwd", "/BOX/cwd"],
  ["tmp", "/BOX/tmp"], ["outside", "/BOX/outside"], ["cli", "/CLI"]];

export function normpath(path: string): string {
  if (path === "") return ".";
  const initial = path.startsWith("//") && !path.startsWith("///") ? 2 : path.startsWith("/") ? 1 : 0;
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part !== ".." || (!initial && !parts.length) || (parts.length && parts[parts.length - 1] === "..")) parts.push(part);
    else if (parts.length) parts.pop();
  }
  const joined = "/".repeat(initial) + parts.join("/");
  return joined || ".";
}

export function containedPath(text: string, writable = false): boolean {
  for (const [name, sketch] of SKETCH) {
    const mark = `{${name}}`;
    if (writable && name === "cli" && (text === mark || text.startsWith(`${mark}/`))) return false;
    if (text === mark || text.startsWith(`${mark}/`)) {
      const root = name === "cli" ? "/CLI" : "/BOX";
      const resolved = normpath(sketch + text.slice(mark.length));
      return resolved === root || resolved.startsWith(`${root}/`);
    }
  }
  if (text.startsWith("/")) return false;
  return normpath(`/BOX/cwd/${text}`).startsWith("/BOX/");
}

function pathParts(rel: string): string[] {
  return rel.split("/").filter((part) => part !== "" && part !== ".");
}

function checkCdpRules(row: PyObject, where: string): void {
  const rules = row.get("cdp_rules");
  if (rules === undefined || rules === null) return;
  if (!isObject(rules)) fail(where, "cdp_rules maps a CDP method to never_params, only_values and why");
  for (const [method, rule] of rules) {
    if (!CDP_METHOD.test(method) || !isObject(rule) || [...rule.keys()].some((key) => !CDP_RULE_KEYS.has(key)) || !rule.has("why")) {
      fail(where, "cdp_rules maps a CDP method to never_params, only_values and why");
    }
    const never = rule.get("never_params") ?? [];
    if (!Array.isArray(never) || !never.every((name) => typeof name === "string")) fail(where, "never_params lists parameter names");
    const only = rule.get("only_values") ?? new Map();
    if (!isObject(only)) fail(where, "only_values maps names to the values they may hold");
    for (const [name, values] of only) {
      if (!Array.isArray(values) || !values.every((value) => typeof value === "string")) fail(where, `only_values maps ${JSON.stringify(name)} to the values it may hold`);
    }
  }
}

export function checkCaseIsContained(kase: Case): void {
  const where = `case ${JSON.stringify(kase.id)}`;
  checkCdpRules(kase.row, where);
  for (const [rel] of kase.files) {
    const parts = pathParts(rel);
    if (!parts.length || rel.startsWith("/") || parts.includes("..") || !ROOTS.includes(parts[0]!)) {
      fail(where, `file ${JSON.stringify(rel)} must be a plain path under one of ${ROOTS.join(", ")}`);
    }
  }
  for (const name of kase.helpers.keys()) if (!HELPER_NAME.test(name)) fail(where, `helper name ${JSON.stringify(name)} isn't a plain program name`);
  for (const [key, value] of kase.env) {
    if (PROTECTED_ENV.has(key)) fail(where, `$${key} belongs to the sandbox and can't be set or removed by a case`);
    const pathlike = PATH_ENV.has(key) || ["/", "~", ".", "{"].some((start) => (value ?? "").startsWith(start));
    if (value && pathlike && !containedPath(value, true)) fail(where, `$${key} must be a path inside the sandbox, not ${JSON.stringify(value)}`);
  }
  checkCaseFitsExec(kase);
  kase.argv.forEach((token, index) => {
    const next = kase.argv[index + 1];
    if ((token === "--data-dir" && next !== undefined && !containedPath(String(next), true)) ||
        (typeof token === "string" && token.startsWith("--data-dir=") && !containedPath(token.split("=").slice(1).join("="), true))) {
      fail(where, "--data-dir must be a {box} path");
    }
    if (typeof token !== "string") fail(where, `argv holds ${JSON.stringify(token)}, not text`);
    const candidates = [token, ...(token.startsWith("--") && token.includes("=") ? [token.slice(token.indexOf("=") + 1)] : [])];
    for (const candidate of candidates) {
      if ((candidate.includes("/") || candidate === "..") && !containedPath(candidate)) {
        fail(where, `argv path ${JSON.stringify(candidate)} is outside the sandbox (use {data}, {home}, {outside} …)`);
      }
      if (candidate.startsWith("~")) fail(where, `argv path ${JSON.stringify(candidate)} would expand outside the sandbox`);
    }
  });
}

export function checkCaseFitsExec(kase: Case): void {
  const strings = [...kase.argv.filter((token) => typeof token === "string").map((token) => Buffer.byteLength(token)),
    ...[...kase.env].filter(([, value]) => typeof value === "string").map(([key, value]) => Buffer.byteLength(`${key}=${value}`))];
  const longest = Math.max(0, ...strings);
  if (longest + 1 + PLACEHOLDER_ROOM > LINUX_MAX_ARG_STRLEN) {
    fail(`case ${JSON.stringify(kase.id)}`, `an argument or environment entry of ${longest} bytes is too close to Linux's ${LINUX_MAX_ARG_STRLEN}-byte limit for one exec string (MAX_ARG_STRLEN), so it can't start there; make it shorter`);
  }
  const total = strings.reduce((sum, size) => sum + size + 1, 0);
  if (total > CASE_EXEC_BUDGET) {
    fail(`case ${JSON.stringify(kase.id)}`, `its arguments and environment come to ${total} bytes, more than the ${CASE_EXEC_BUDGET} a case may use of the exec limit (ARG_MAX)`);
  }
}

function walk(root: string, suffix: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) found.push(...walk(path, suffix));
    else if (name.endsWith(suffix)) found.push(path);
  }
  return found;
}

export function caseFiles(root = CASE_ROOT): string[] {
  return [...walk(root, ".json").sort(), ...walk(root, ".jsonl").sort()];
}

export function readRows(path: string): Py[] {
  const text = readFileSync(path, "utf8");
  if (path.endsWith(".jsonl")) return text.split("\n").filter((line) => line.trim()).map((line) => loads(line));
  const rows = loads(text);
  if (!Array.isArray(rows)) throw new Error(`${path} holds a list of cases`);
  return rows;
}

export function loadCases(root = CASE_ROOT): Case[] {
  const cases: Case[] = [];
  const seen = new Map<string, string>();
  for (const path of caseFiles(root)) {
    const source = relative(root, path);
    for (const row of readRows(path)) {
      const kase = caseFromRow(row, source);
      const earlier = seen.get(kase.id);
      if (earlier !== undefined) throw new Error(`case id ${JSON.stringify(kase.id)} is in both ${earlier} and ${source}`);
      seen.set(kase.id, source);
      cases.push(kase);
    }
  }
  return cases;
}
