import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync, closeSync, constants, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync,
  rmSync, symlinkSync, writeFileSync, writeSync, readSync,
} from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { withoutGroupWrite } from "./modes.ts";
import { decodeBlob, expand, expandText, fileBytes, type Places } from "./blobs.ts";
import { type Case, containedPath, checkCaseIsContained, FIXTURES, PATH_ENV, SERVED_TABLE, UnsafeCase } from "./cases.ts";
import { DEFAULT_HELLO, FakeArdia, FakeDaemon, PARITY_BUILD, stampedSessionKey } from "./fakes.ts";
import { openpty, pipe, READABLE, readiness, WRITABLE } from "./ffi.ts";
import { dumps, isObject, loads, PyFloat, type Py, type PyObject } from "./pyjson.ts";

export const INSTALL_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
export const TIMEOUT_MS = 60_000;
export const DRAIN_MS = 5_000;
export const TIME_SLACK = 120;
export const NOW_SLACK = 2;
export const SCRATCH_LENGTH = 24;
export const BOX_DIGITS = 5;
export const PINNED_ENV: [string, string][] = [["PATH", "/usr/bin:/bin:/usr/sbin:/sbin"], ["LANG", "C.UTF-8"], ["TZ", "UTC"], ["USER", "parity"],
  ["LOGNAME", "parity"], ["SHELL", "/bin/sh"]];
const HARNESS_FILES = ["helpers.log", "stubs"];
export const FLUSH_FILE = "data/Telemetry/cli-flush.json";
const CONTENT_APART = ["data/Telemetry/local", "data/Telemetry/cli-queue.jsonl", FLUSH_FILE, "cli-home/Usage/usage.json"];
const ROOT_FOLDERS = ["home", "cli-home", "data", "cwd", "tmp", "outside"];
export const STUBBED_HELPERS = ["open", "xdg-open", "osascript", "security", "esbuild", "cua-driver", "git", "node", "pbcopy", "pbpaste", "screencapture",
  "ffmpeg", "defaults", "launchctl", "say", "afplay", "codesign", "ditto", "systemctl", "gh", "curl", "wget"];
const OUTSIDE_WORLD = ["gh", "curl", "wget", "python3", "python"];
const DENIED_PROGRAMS = ["/bin/launchctl", "/usr/bin/security", "/usr/bin/codesign", "/usr/bin/ditto", "/usr/bin/osascript", "/usr/bin/open",
  "/usr/bin/pbcopy", "/usr/bin/pbpaste", "/usr/sbin/screencapture", "/usr/bin/say", "/usr/bin/afplay", "/usr/bin/defaults", "/usr/bin/curl", "/usr/bin/ssh",
  "/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/opt/homebrew/bin/wget", "/usr/local/bin/wget", "/usr/bin/python3", "/usr/bin/python",
  "/opt/homebrew/bin/python3", "/usr/local/bin/python3"];
const SANDBOX_PROFILE = `(version 1)
(allow default)
(deny network-outbound (remote ip))
(deny network-inbound (local ip))
(deny network-outbound (remote unix-socket))
(allow network-outbound (remote unix-socket (subpath (param "BOX"))))
(deny file-write* (require-not (require-any (subpath (param "BOX")) (subpath (param "ROUTES")) (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/fd/"))))
(deny process-exec {denied})
`;
const TEST_ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>com.apple.security.cs.disable-library-validation</key><true/></dict></plist>
`;
export const TS_LIBC = "ardia-libc.so";
const DEFAULT_DATA_DIRS: Record<string, string> = { darwin: "home/Library/Application Support/Ardia", linux: "home/.config/ardia" };
const QUEUED: Py = new Map<string, Py>([["uuid", "0190a1b2-c3d4-7e5f-8a9b-000000000001"], ["event", "cli_command"], ["distinct_id", INSTALL_ID],
  ["timestamp", "2026-01-01T00:00:00.000Z"], ["properties", new Map([["command", "earlier"]])]]);
const VOLATILE = ["uuid"];
const VOLATILE_PROPERTIES = ["$session_id", "total_ms", "startup_ms", "served_by"];
const TRACEBACK = /Traceback \(most recent call last\):\n(?:  [^\n]*\n)*/g;
const TIME_KEYS = /(_at|At|_ms|time|Time)$/;
const UTC_STAMP = /"at": "(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})Z"/g;
const STAMPED_FILES = ["cli-home/Usage/feedback.jsonl"];
const PORT_SESSION_KEY = /\{port_session_key:(\d{1,5})\}/g;
const CREDENTIAL_KINDS = ["pipe", "file", "terminal", "write-end"];
const FEEDBACK_SERVICE_ENV = "ARDIA_FEEDBACK_URL";
const POLL_MS = 4;
const ATOMIC_PIPE_WRITE = 512;

export class SideDidNotStart extends Error {}

export type Change =
  | ["removed"]
  | ["written", "dir", number]
  | ["written", "link", string]
  | ["written", "socket"]
  | ["written", "other"]
  | ["written", "file", number, Buffer];

type Entry = ["dir", number] | ["link", string] | ["socket"] | ["other"] | ["file", number, Buffer];

export type Observed = {
  stdout: Buffer;
  stderr: Buffer;
  status: number;
  requests: Py[][];
  daemon_requests: Py[];
  telemetry: Py[];
  queued: Py[];
  served_by: Py[];
  usage: Py;
  flush: Py;
  files: Map<string, Change>;
  helpers: string[];
  timed_out: boolean;
  transcript_complete: boolean;
  route: string;
  window: [number, number];
};

function shellQuote(text: string): string {
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.split("'").join("'\"'\"'")}'`;
}

function which(name: string): string | undefined {
  for (const folder of (process.env.PATH ?? "").split(":")) {
    if (!folder) continue;
    const path = join(folder, name);
    try {
      if (lstatSync(path) && existsSync(path)) return path;
    } catch {}
  }
  return undefined;
}

function deniedPrograms(): string[] {
  const found = new Set(DENIED_PROGRAMS);
  for (const name of OUTSIDE_WORLD) {
    const where = which(name);
    if (where) {
      found.add(where);
      try {
        found.add(realpathSync(where));
      } catch {}
    }
  }
  return [...found].sort();
}

export function sandboxMode(): "sandbox-exec" | "none" {
  if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) return "sandbox-exec";
  if (process.env.CI === "true" || process.env.ARDIA_PARITY_UNSANDBOXED === "1") return "none";
  throw new Error("the parity runner runs the program under sandbox-exec, which this system lacks; on a throwaway machine (CI sets CI=true) or with ARDIA_PARITY_UNSANDBOXED=1 it runs it unconfined");
}

function fixedScratch(): string {
  const base = `${realpathSync("/tmp")}/arp`;
  const room = SCRATCH_LENGTH - base.length;
  if (room < 6) throw new Error(`/tmp resolves to a path too long for a ${SCRATCH_LENGTH}-character scratch folder`);
  const letters = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const path = base + Array.from({ length: room }, () => letters[Math.floor(Math.random() * letters.length)]).join("");
    try {
      mkdirSync(path, { mode: 0o700 });
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("no free scratch folder");
}

function signForTests(folder: string, program: string): void {
  if (process.platform !== "darwin") return;
  const entitlements = join(folder, "..", `${program}.entitlements`);
  writeFileSync(entitlements, TEST_ENTITLEMENTS);
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--options", "runtime", join(folder, TS_LIBC)], { stdio: "pipe" });
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--options", "runtime", "--entitlements", entitlements, join(folder, program)], { stdio: "pipe" });
  rmSync(entitlements, { force: true });
}

export class Install {
  readonly sandbox = sandboxMode();
  readonly scratch: string;
  readonly root: string;
  readonly routes: string;
  readonly profile: string;
  private counter = 0;
  private devBuild: boolean | undefined;

  constructor(readonly program: string) {
    const addon = join(dirname(program), TS_LIBC);
    if (!existsSync(program)) throw new Error(`no ardia-ts at ${program}: build it (sh plugins/cli/ts/scripts/build.sh) or set ARDIA_TS_CLI`);
    if (!existsSync(addon)) throw new Error(`the program loads the addon beside it, and there is no ${addon}: build plugins/cli/ts (it puts ${TS_LIBC} beside ardia-ts)`);
    this.scratch = fixedScratch();
    this.root = join(this.scratch, "cli");
    this.routes = join(this.scratch, "routes");
    this.profile = join(this.scratch, "sandbox.sb");
    try {
      for (const folder of [this.routes, join(this.root, "bin"), join(this.root, "libexec")]) mkdirSync(folder, { recursive: true });
      const bin = join(this.root, "bin");
      const libexec = join(this.root, "libexec");
      copyFileSync(program, join(bin, "ardia.bin"));
      copyFileSync(addon, join(bin, TS_LIBC));
      signForTests(bin, "ardia.bin");
      writeFileSync(join(bin, "ardia"), `#!/bin/sh\nprintf 'ts\\n' >>${shellQuote(this.routes)}/$$\nexec "$(dirname "$0")/ardia.bin" "$@"\n`, { mode: 0o755 });
      copyFileSync(program, join(libexec, "ardia-ts.bin"));
      copyFileSync(addon, join(libexec, TS_LIBC));
      signForTests(libexec, "ardia-ts.bin");
      writeFileSync(join(libexec, "ardia-ts"), `#!/bin/sh\nprintf 'ts\\n' >>${shellQuote(this.routes)}/$PPID\nexec "$(dirname "$0")/ardia-ts.bin" "$@"\n`, { mode: 0o755 });
      writeFileSync(join(libexec, "esbuild"), "#!/bin/sh\nexec esbuild \"$@\"\n", { mode: 0o755 });
      if (existsSync(SERVED_TABLE)) {
        const rows = readFileSync(SERVED_TABLE, "utf8").split("\n").map((line) => line.trim().split(/\s+/)).filter((words) => words.length >= 2);
        writeFileSync(join(this.root, "served.txt"), rows.map((words) => `${words.slice(0, -1).join(" ")} ts\n`).join(""));
      }
      cpSync(FIXTURES, join(this.scratch, "src", "tests", "fixtures"), { recursive: true });
      withoutGroupWrite(join(this.scratch, "src", "tests", "fixtures"));
      writeFileSync(this.profile, SANDBOX_PROFILE.replace("{denied}", deniedPrograms().map((path) => `(literal "${path}")`).join(" ")));
    } catch (error) {
      rmSync(this.scratch, { recursive: true, force: true });
      throw error;
    }
  }

  box(): string {
    this.counter += 1;
    return join(this.scratch, `c${String(this.counter).padStart(BOX_DIGITS, "0")}`);
  }

  command(): string[] {
    return [join(this.root, "bin", "ardia")];
  }

  confined(argv: string[], box: string): string[] {
    if (this.sandbox === "sandbox-exec") return ["/usr/bin/sandbox-exec", "-f", this.profile, "-D", `BOX=${box}`, "-D", `ROUTES=${this.routes}`, ...argv];
    return argv;
  }

  routeOf(pid: number): string[] {
    const path = join(this.routes, String(pid));
    try {
      const lines = readFileSync(path, "utf8").split(/\s+/).filter(Boolean);
      rmSync(path, { force: true });
      return lines;
    } catch {
      return [];
    }
  }

  strayRoutes(): string[] {
    return readdirSync(this.routes).sort();
  }

  isDevBuild(): boolean {
    if (this.devBuild === undefined) {
      const said = spawnSync(join(this.root, "bin", "ardia.bin"), ["--version"], { env: { PATH: "/usr/bin:/bin", ARDIA_TELEMETRY: "0" }, timeout: 30_000 }).stdout?.toString() ?? "";
      this.devBuild = said.includes(".dev") || said.includes(" 0.0.0");
    }
    return this.devBuild;
  }

  close(): void {
    reap(this.scratch);
    rmSync(this.scratch, { recursive: true, force: true });
  }
}

export function marked(marker: string): number[] {
  let listing = "";
  if (process.platform === "darwin") {
    listing = spawnSync("/bin/ps", ["-x", "-E", "-ww", "-o", "pid=,command="], { maxBuffer: 256 * 1024 * 1024 }).stdout?.toString("utf8") ?? "";
  } else {
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      let exe = "";
      try {
        exe = readlinkSync(`/proc/${name}/exe`);
      } catch {}
      try {
        const words = Buffer.concat([readFileSync(`/proc/${name}/cmdline`), Buffer.from(" "), readFileSync(`/proc/${name}/environ`)]);
        listing += `${name} ${exe} ${words.toString("utf8").split("\0").join(" ")}\n`;
      } catch {}
    }
  }
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(ARDIA_PARITY_BOX=)?${escaped}(/|\\s|$)`);
  const found: number[] = [];
  for (const line of listing.split("\n")) {
    const trimmed = line.trim();
    const space = trimmed.indexOf(" ");
    const pid = trimmed.slice(0, space < 0 ? undefined : space);
    if (/^\d+$/.test(pid) && Number(pid) !== process.pid && pattern.test(trimmed.slice(space + 1))) found.push(Number(pid));
  }
  return found;
}

export function reap(marker: string): void {
  for (const pid of marked(marker)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

function writeStub(directory: string, name: string, spec: Py | undefined, log: string): void {
  const stdout = decodeBlob(isObject(spec) ? spec.get("stdout") : undefined).toString("base64");
  const status = Number(isObject(spec) ? spec.get("exit") ?? 0n : 0n);
  const script = "#!/bin/sh\n" +
    `line='${name}'\n` +
    "for a in \"$@\"; do line=\"$line =$(printf '%s' \"$a\" | /usr/bin/base64 | /usr/bin/tr -d '\\n')\"; done\n" +
    `printf '%s\\n' "$line" >> '${log}'\n` +
    `printf '%s' '${stdout}' | /usr/bin/base64 -d 2>/dev/null || printf '%s' '${stdout}' | /usr/bin/base64 -D\n` +
    `exit ${status}\n`;
  writeFileSync(join(directory, name), script);
  chmodSync(join(directory, name), 0o755);
}

export function writeStubForTest(directory: string, name: string, log: string): void {
  writeStub(directory, name, undefined, log);
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function relParts(box: string, path: string): string[] {
  return path.slice(box.length + 1).split("/").filter(Boolean);
}

export function noLinksBelow(box: string, path: string): boolean {
  let current = box;
  for (const part of relParts(box, path)) {
    current = join(current, part);
    if (isLink(current)) return false;
  }
  return true;
}

function makeParents(box: string, path: string): void {
  let current = box;
  for (const part of relParts(box, path).slice(0, -1)) {
    current = join(current, part);
    if (isLink(current)) throw new UnsafeCase(`${path.slice(box.length + 1)} would be written through a link`);
    if (!existsSync(current)) mkdirSync(current);
  }
}

export function realpathLoose(path: string, depth = 0): string {
  if (depth > 40) return path;
  let current = "/";
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      current = dirname(current);
      continue;
    }
    const next = join(current, part);
    let link: string | undefined;
    try {
      if (lstatSync(next).isSymbolicLink()) link = readlinkSync(next);
    } catch {}
    current = link === undefined ? next : realpathLoose(isAbsolute(link) ? link : join(current, link), depth + 1);
  }
  return current;
}

function inside(box: string, path: string): boolean {
  const root = realpathLoose(box);
  const resolved = realpathLoose(path);
  return resolved === root || resolved.startsWith(`${root}/`);
}

export function placesOf(box: string): Places {
  return new Map([["box", box], ["home", join(box, "home")], ["cli_home", join(box, "cli-home")], ["data", join(box, "data")], ["cwd", join(box, "cwd")],
    ["tmp", join(box, "tmp")], ["outside", join(box, "outside")], ["cli", join(dirname(box), "src")], ["harness_pid", String(process.pid)]]);
}

function sideFileName(rel: string, build: string): string {
  return rel.replace(PORT_SESSION_KEY, (_, port: string) => stampedSessionKey("", `port:${port}`, "default", false, build));
}

export function materialize(box: string, kase: Case, build: string): Places {
  checkCaseIsContained(kase);
  mkdirSync(box, { recursive: true });
  for (const name of ROOT_FOLDERS) mkdirSync(join(box, name), { recursive: true });
  const data = join(box, "data");
  const consent = kase.consent;
  if (consent !== null && consent.get("absent") !== true) {
    const doc: PyObject = new Map<string, Py>([["sharing", true], ["installId", INSTALL_ID]]);
    for (const [key, value] of consent) doc.set(key, value);
    writeFileSync(join(data, "telemetry.json"), dumps(doc));
  }
  const telemetry = join(data, "Telemetry");
  if (!existsSync(telemetry)) mkdirSync(telemetry, { mode: 0o700 });
  if (consent !== null && (consent.has("sharing") ? consent.get("sharing") : true) === true) writeFileSync(join(telemetry, "cli-queue.jsonl"), `${dumps(QUEUED)}\n`);
  const places = placesOf(box);
  for (const [rel, spec] of kase.files) {
    const path = join(box, sideFileName(rel, build));
    try {
      makeParents(box, path);
    } catch (error) {
      if (error instanceof UnsafeCase) throw new UnsafeCase(`case ${JSON.stringify(kase.id)}: ${error.message}`);
      throw error;
    }
    if (isLink(path)) throw new UnsafeCase(`case ${JSON.stringify(kase.id)}: ${rel} would be written through a link`);
    if (isObject(spec) && spec.get("dir")) {
      if (!existsSync(path)) mkdirSync(path);
      continue;
    }
    if (isObject(spec) && spec.has("link")) {
      symlinkSync(expandText(String(spec.get("link")), places), path);
      continue;
    }
    writeFileSync(path, fileBytes(spec, places));
    if (isObject(spec) && spec.has("mode")) chmodSync(path, Number(spec.get("mode")));
  }
  const flush = join(telemetry, "cli-flush.json");
  if (!noLinksBelow(box, flush)) throw new UnsafeCase(`case ${JSON.stringify(kase.id)}: its Telemetry folder leaves the sandbox`);
  if (!kase.files.some(([rel]) => rel === FLUSH_FILE)) writeFileSync(flush, dumps(new Map<string, Py>([["failures", 0n], ["next_at", new PyFloat(9e12)]])));
  const stubs = join(box, "stubs");
  if (!existsSync(stubs)) mkdirSync(stubs);
  const log = join(box, "helpers.log");
  for (const name of STUBBED_HELPERS) writeStub(stubs, name, kase.helpers.get(name), log);
  for (const [name, spec] of kase.helpers) if (!STUBBED_HELPERS.includes(name)) writeStub(stubs, name, spec, log);
  return places;
}

export function environment(box: string, places: Places, kase: Case): Map<string, string> {
  const env = new Map(PINNED_ENV);
  env.set("PATH", `${join(box, "stubs")}:${env.get("PATH")}`);
  for (const [key, value] of [["HOME", places.get("home")!], ["ARDIA_CLI_HOME", places.get("cli_home")!], ["ARDIA_DATA_DIR", places.get("data")!],
    ["TMPDIR", places.get("tmp")!], ["ARDIA_TELEMETRY_URL", "http://127.0.0.1:9/v1/logs"], ["http_proxy", "http://127.0.0.1:9"], ["https_proxy", "http://127.0.0.1:9"],
    ["HTTP_PROXY", "http://127.0.0.1:9"], ["HTTPS_PROXY", "http://127.0.0.1:9"], ["no_proxy", ""], ["NO_PROXY", ""], ["COLUMNS", "100"], ["LINES", "40"],
    ["PYTHONDONTWRITEBYTECODE", "1"], ["ARDIA_PARITY_BOX", box]] as const) {
    env.set(key, value);
  }
  for (const [key, value] of kase.env) {
    if (value === null) env.delete(key);
    else env.set(key, expandText(value, places));
  }
  return env;
}

function checkEffectivePaths(box: string, kase: Case, env: Map<string, string>, argv: string[], cwd: string): void {
  const values = [...PATH_ENV].map((key) => env.get(key)).filter((value): value is string => !!value);
  for (const [key, value] of env) if (!PATH_ENV.has(key) && value.startsWith("/") && key !== "PATH" && key !== "SHELL") values.push(value);
  argv.forEach((token, index) => {
    if (token === "--data-dir" && index + 1 < argv.length) values.push(argv[index + 1]!);
    else if (token.startsWith("--data-dir=")) values.push(token.slice("--data-dir=".length));
  });
  for (const value of values) {
    const path = isAbsolute(value) ? value : join(cwd, value);
    if (!inside(box, path)) throw new UnsafeCase(`case ${JSON.stringify(kase.id)}: ${value} leaves the sandbox once its links are followed`);
  }
}

export function asDataTelemetry(rel: string, dataRel: string): string {
  const prefix = `${dataRel}/Telemetry`;
  if (dataRel !== "data" && (rel === prefix || rel.startsWith(`${prefix}/`))) return `data/Telemetry${rel.slice(prefix.length)}`;
  return rel;
}

export function tree(root: string, dataRel = "data"): Map<string, Entry> {
  const found = new Map<string, Entry>();
  if (!existsSync(root)) return found;
  const visit = (folder: string, prefix: string): void => {
    let names: string[];
    try {
      names = readdirSync(folder).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(folder, name);
      const raw = prefix ? `${prefix}/${name}` : name;
      const rel = asDataTelemetry(raw, dataRel);
      let info;
      try {
        info = lstatSync(path);
      } catch {
        continue;
      }
      const own = HARNESS_FILES.some((harness) => rel === harness || rel.startsWith(`${harness}/`));
      if (!own) {
        const apart = CONTENT_APART.some((name) => rel === name || rel.startsWith(`${name}/`));
        const mode = info.mode & 0o7777;
        if (info.isDirectory()) found.set(rel, ["dir", mode]);
        else if (info.isSymbolicLink()) found.set(rel, ["link", readlinkSync(path)]);
        else if (info.isSocket()) found.set(rel, ["socket"]);
        else if (info.isFile()) found.set(rel, ["file", mode, apart ? Buffer.from("<compared apart>") : readFileSync(path)]);
        else found.set(rel, ["other"]);
      }
      if (info.isDirectory() && !info.isSymbolicLink()) visit(path, raw);
    }
  };
  visit(root, "");
  return found;
}

function sameEntry(left: Entry | undefined, right: Entry | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.length !== right.length || left[0] !== right[0]) return false;
  return left.every((part, index) => (Buffer.isBuffer(part) ? part.equals(right[index] as Buffer) : part === right[index]));
}

export function fileChanges(before: Map<string, Entry>, after: Map<string, Entry>): Map<string, Change> {
  const changes = new Map<string, Change>();
  for (const rel of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const old = before.get(rel);
    const now = after.get(rel);
    if (sameEntry(old, now)) continue;
    changes.set(rel, now === undefined ? ["removed"] : (["written", ...now] as Change));
  }
  return changes;
}

function scrubStamps(found: Map<string, Entry>, window: [number, number]): Map<string, Entry> {
  const out = new Map(found);
  for (const rel of STAMPED_FILES) {
    const entry = out.get(rel);
    if (entry && entry[0] === "file") {
      const body = entry[2].toString("latin1").replace(UTC_STAMP, (whole, stamp: string) => {
        const at = Date.parse(`${stamp}Z`) / 1000;
        return window[0] - NOW_SLACK - 1 <= at && at <= window[1] + NOW_SLACK ? '"at": "<now utc>"' : whole;
      });
      out.set(rel, ["file", entry[1], Buffer.from(body, "latin1")]);
    }
  }
  return out;
}

export function pythonRound(value: number): number {
  const floor = Math.floor(value);
  const difference = value - floor;
  if (difference < 0.5) return floor;
  if (difference > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

export function timeMarker(value: Py, window: [number, number]): Py {
  if (typeof value !== "bigint" && !(value instanceof PyFloat)) return scrubTimes(value, window);
  const number = typeof value === "bigint" ? Number(value) : value.value;
  const kind = typeof value === "bigint" ? "int" : "float";
  const [start, end] = window;
  for (const [scale, unit] of [[1, "s"], [1000, "ms"]] as const) {
    if ((start - TIME_SLACK) * scale <= number && number <= (end + TIME_SLACK) * scale) {
      if (start * scale - NOW_SLACK * scale <= number && number <= end * scale + NOW_SLACK * scale) return `<now ${kind} ${unit}>`;
      const offset = pythonRound(number / scale - (number / scale > end ? end : start));
      return `<now${offset >= 0 ? "+" : ""}${offset}s ${kind} ${unit}>`;
    }
  }
  return value;
}

export function scrubTimes(value: Py, window: [number, number]): Py {
  if (isObject(value)) return new Map([...value].map(([key, child]) => [key, TIME_KEYS.test(key) ? timeMarker(child, window) : scrubTimes(child, window)]));
  if (Array.isArray(value)) return value.map((child) => scrubTimes(child, window));
  return value;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d{1,9}))?)?)?)?(Z|[+-]\d{2}(?::?\d{2}(?::?\d{2})?)?)?$/;

export function isoTime(text: Py | undefined): number | undefined {
  if (typeof text !== "string") return undefined;
  const match = ISO.exec(text);
  if (!match) return undefined;
  const [, year, month, day, hour = "0", minute = "0", second = "0", fraction = "", zone] = match;
  let moment = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)) / 1000;
  if (Number.isNaN(moment)) return undefined;
  moment += Number(`0.${fraction.slice(0, 6) || "0"}`);
  if (zone === undefined) moment += new Date(moment * 1000).getTimezoneOffset() * 60;
  else if (zone !== "Z") {
    const digits = zone.slice(1).replace(/:/g, "");
    const offset = Number(digits.slice(0, 2)) * 3600 + Number(digits.slice(2, 4) || "0") * 60 + Number(digits.slice(4, 6) || "0");
    moment -= (zone[0] === "+" ? 1 : -1) * offset;
  }
  return moment;
}

function scrubTimestamp(record: PyObject, window: [number, number]): void {
  const moment = isoTime(record.get("timestamp"));
  if (moment === undefined) return;
  const marker = timeMarker(new PyFloat(moment), window);
  if (typeof marker === "string") record.set("timestamp", marker);
}

function readInside(box: string, path: string): string | undefined {
  if (!existsSync(path) || !noLinksBelow(box, path)) return undefined;
  return readFileSync(path, "utf8").replace(/\r\n?/g, "\n");
}

export function pythonLines(text: string): string[] {
  const lines = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function readTelemetry(box: string, data: string, window: [number, number]): { records: Py[]; queued: Py[]; served: Py[] } {
  const local = join(data, "Telemetry", "local");
  const records: Py[] = [];
  if (existsSync(local) && noLinksBelow(box, local)) {
    for (const name of readdirSync(local).filter((name) => name.startsWith("cli-") && name.endsWith(".jsonl")).sort()) {
      for (const line of pythonLines(readInside(box, join(local, name)) ?? "")) records.push(loads(line));
    }
  }
  const spool = readInside(box, join(data, "Telemetry", "cli-queue.jsonl"));
  const queued = spool ? pythonLines(spool).map((line) => loads(line)) : [];
  const commands = records.filter((record) => isObject(record) && record.get("event") === "cli_command");
  const served = commands.map((record) => {
    const properties = (record as PyObject).get("properties");
    return isObject(properties) ? properties.get("served_by") ?? null : null;
  });
  for (const record of [...records, ...queued]) {
    if (!isObject(record)) continue;
    for (const key of VOLATILE) record.delete(key);
    scrubTimestamp(record, window);
    const properties = record.get("properties");
    if (!isObject(properties)) continue;
    for (const key of VOLATILE_PROPERTIES) properties.delete(key);
    const exceptions = properties.get("$exception_list");
    if (Array.isArray(exceptions)) {
      for (const exception of exceptions) {
        const stack = isObject(exception) ? exception.get("stacktrace") : undefined;
        if (isObject(stack)) stack.delete("frames");
      }
    }
  }
  return { records, queued, served };
}

export function dataDirOf(kase: Case): string {
  if (kase.env.has("ARDIA_DATA_DIR") && kase.env.get("ARDIA_DATA_DIR") === null && !kase.env.get("XDG_CONFIG_HOME")) {
    return DEFAULT_DATA_DIRS[process.platform] ?? "data";
  }
  return "data";
}

type Credential = { given: number; held: number[]; later: number[]; target: number };

function credentialFd(spec: PyObject, box: string): Credential {
  const kind = String(spec.get("kind") ?? "pipe");
  if (!CREDENTIAL_KINDS.includes(kind)) throw new UnsafeCase(`a credential kind is one of ${CREDENTIAL_KINDS.join(", ")}, not ${JSON.stringify(kind)}`);
  const target = Number(spec.get("fd") ?? 4n);
  if (!(target >= 3 && target <= 9)) throw new UnsafeCase("a credential fd is 3 to 9");
  const data = decodeBlob(spec.get("bytes"));
  if (kind === "file") {
    const path = join(box, "tmp", "credential");
    writeFileSync(path, data);
    const fd = openSync(path, constants.O_RDONLY);
    return { given: fd, held: [fd], later: [], target };
  }
  if (kind === "terminal") {
    const [leader, follower] = openpty();
    return { given: follower, held: [follower], later: [leader], target };
  }
  const channel = pipe();
  if (kind === "write-end") {
    closeSync(channel.read);
    return { given: channel.write, held: [channel.write], later: [], target };
  }
  if (data.length) writeSync(channel.write, data);
  if (spec.get("keep_open")) return { given: channel.read, held: [channel.read], later: [channel.write], target };
  closeSync(channel.write);
  return { given: channel.read, held: [channel.read], later: [], target };
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

class Drain {
  chunks: Buffer[] = [];
  open = true;
  private buffer = Buffer.alloc(65536);
  constructor(readonly fd: number) {}

  poll(): boolean {
    let moved = false;
    while (this.open) {
      if (!readiness(this.fd, READABLE)) return moved;
      let count: number;
      try {
        count = readSync(this.fd, this.buffer, 0, this.buffer.length, null);
      } catch (error) {
        if (errorCode(error) === "EAGAIN" || errorCode(error) === "EWOULDBLOCK") return moved;
        if (errorCode(error) === "EINTR") continue;
        count = 0;
      }
      moved = true;
      if (count === 0) {
        this.finish();
        return moved;
      }
      this.chunks.push(Buffer.from(this.buffer.subarray(0, count)));
    }
    return moved;
  }

  finish(): void {
    if (!this.open) return;
    this.open = false;
    closeSync(this.fd);
  }

  data(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

class Feed {
  open = true;
  private offset = 0;
  constructor(readonly fd: number, readonly data: Buffer) {
    if (!data.length) this.finish();
  }

  poll(): boolean {
    let moved = false;
    while (this.open && this.offset < this.data.length) {
      if (!readiness(this.fd, WRITABLE)) return moved;
      try {
        this.offset += writeSync(this.fd, this.data, this.offset, Math.min(ATOMIC_PIPE_WRITE, this.data.length - this.offset));
        moved = true;
      } catch (error) {
        if (errorCode(error) === "EAGAIN" || errorCode(error) === "EWOULDBLOCK") return moved;
        if (errorCode(error) === "EINTR") continue;
        this.finish();
        return true;
      }
    }
    if (this.open && this.offset >= this.data.length) this.finish();
    return moved;
  }

  finish(): void {
    if (!this.open) return;
    this.open = false;
    closeSync(this.fd);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function signalNumber(name: string | null): number {
  if (name === null) return 0;
  return (osConstants.signals as Record<string, number>)[name] ?? 0;
}

const ESCAPED_BYTE = /[\udc80-\udcff]/;

export function fsEncode(text: string): Buffer {
  const parts: Buffer[] = [];
  let plain = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (char.length === 1 && code >= 0xdc80 && code <= 0xdcff) {
      parts.push(Buffer.from(plain, "utf8"), Buffer.from([code - 0xdc00]));
      plain = "";
    } else plain += char;
  }
  parts.push(Buffer.from(plain, "utf8"));
  return Buffer.concat(parts);
}

function ansiQuoted(word: string): string {
  return `$'${[...fsEncode(word)].map((byte) => (byte >= 0x20 && byte < 0x7f && byte !== 0x27 && byte !== 0x5c ? String.fromCharCode(byte) : `\\x${byte.toString(16).padStart(2, "0")}`)).join("")}'`;
}

type Ran = { stdout: Buffer; stderr: Buffer; status: number; timedOut: boolean; pid: number };

export type Spawner = (argv: string[], options: { cwd: string; env: Record<string, string>; stdio: number[] }) => ReturnType<typeof spawn>;

const defaultSpawner: Spawner = (argv, options) => spawn(argv[0]!, argv.slice(1), { ...options, detached: true });

async function execute(install: Install, box: string, argv: string[], env: Map<string, string>, cwd: string, stdin: Buffer, credentialSpec: PyObject | null,
  spawner: Spawner): Promise<Ran> {
  const input = pipe();
  const output = pipe();
  const errors = pipe();
  const childEnds = [input.read, output.write, errors.write];
  let credential: Credential | undefined;
  try {
    credential = credentialSpec === null ? undefined : credentialFd(credentialSpec, box);
  } catch (error) {
    for (const fd of [...childEnds, input.write, output.read, errors.read]) closeSync(fd);
    throw error;
  }
  let command = [...install.command(), ...argv];
  const stdio = [...childEnds];
  if (credential) {
    stdio.push(credential.given);
    if (credential.target !== 3) command = ["/bin/bash", "-c", `exec ${credential.target}<&3 3<&-; exec "$@"`, "bash", ...command];
  }
  if (command.some((word) => ESCAPED_BYTE.test(word))) command = ["/bin/bash", "-c", `exec ${command.map(ansiQuoted).join(" ")}`];
  let child: ReturnType<typeof spawn>;
  let exit: { code: number | null; signal: string | null } | undefined;
  let failed: Error | undefined;
  try {
    child = spawner(install.confined(command, box), { cwd, env: Object.fromEntries(env), stdio });
    child.on("error", (error) => (failed ??= error));
    child.on("exit", (code, signal) => (exit = { code, signal }));
  } catch (error) {
    failed = error as Error;
  } finally {
    for (const fd of [...childEnds, ...(credential?.held ?? [])]) closeSync(fd);
  }
  const out = new Drain(output.read);
  const err = new Drain(errors.read);
  const feed = new Feed(input.write, stdin);
  const pid = failed ? undefined : child!.pid;
  if (failed || pid === undefined) {
    await sleep(0);
    out.finish();
    err.finish();
    feed.finish();
    for (const fd of credential?.later ?? []) closeSync(fd);
    throw new SideDidNotStart(`the TypeScript side didn't start: ${failed?.message ?? "no pid"}`);
  }
  const pump = () => [feed.poll(), out.poll(), err.poll()].some(Boolean);
  const settled = () => exit !== undefined && !out.open && !err.open;
  const waitUntil = async (deadline: number) => {
    for (;;) {
      const moved = pump();
      if (settled()) return true;
      if (Date.now() >= deadline) return false;
      await (moved ? new Promise((resolve) => setImmediate(resolve)) : sleep(POLL_MS));
    }
  };
  let timedOut = false;
  let stdout: Buffer;
  let stderr: Buffer;
  if (await waitUntil(Date.now() + TIMEOUT_MS)) {
    stdout = out.data();
    stderr = err.data();
  } else {
    timedOut = true;
    killGroup(pid);
    reap(box);
    if (await waitUntil(Date.now() + DRAIN_MS)) {
      stdout = out.data();
      stderr = err.data();
    } else {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
      stdout = Buffer.alloc(0);
      stderr = Buffer.alloc(0);
      for (let tries = 0; tries < 250 && exit === undefined; tries += 1) await sleep(POLL_MS);
    }
  }
  killGroup(pid);
  feed.finish();
  out.finish();
  err.finish();
  for (const fd of credential?.later ?? []) closeSync(fd);
  const finished = exit as { code: number | null; signal: string | null } | undefined;
  const status = finished === undefined ? -9 : finished.code ?? -signalNumber(finished.signal);
  return { stdout, stderr, status, timedOut, pid };
}

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
}

export function routeFrom(lines: string[]): string {
  if (lines.includes("python")) return "python";
  return lines.includes("ts") ? "ts" : "rust";
}

export async function runSide(install: Install, kase: Case, box: string, spawner: Spawner = defaultSpawner): Promise<Observed> {
  if (kase.argv.includes("feedback") && !kase.env.has(FEEDBACK_SERVICE_ENV) && !install.isDevBuild()) {
    throw new UnsafeCase(`case ${kase.id}: ardia feedback with a release build would post to ardia.dev; run the runner on a checkout build`);
  }
  const build = PARITY_BUILD;
  const places = materialize(box, kase, build);
  const control = kase.control;
  let fake: FakeArdia | undefined;
  let daemon: FakeDaemon | undefined;
  const closeFakes = async () => {
    await fake?.close();
    await daemon?.close();
  };
  if (control !== null) {
    const events = expand(control.get("events") ?? [], places);
    const replies = expand(control.get("replies") ?? new Map(), places);
    fake = new FakeArdia(join(box, "data", "ArdiaControl.sock"), expand(control.get("hello") ?? DEFAULT_HELLO, places), isObject(replies) ? replies : new Map(),
      Array.isArray(events) ? events : []);
  }
  if (kase.daemon === null && (kase.argv.includes("browse") || kase.argv.includes("notes"))) {
    await closeFakes();
    throw new UnsafeCase(`case ${kase.id}: a browse or notes case needs a daemon, or the client starts a real one`);
  }
  if (kase.daemon !== null) {
    const spec = expand(kase.daemon, places);
    daemon = new FakeDaemon(join(box, "data"), isObject(spec) ? spec : new Map(), build);
  }
  const dataRel = dataDirOf(kase);
  const before = tree(box, dataRel);
  const started = Date.now() / 1000;
  const stdin = decodeBlob(typeof kase.stdin === "string" ? expandText(kase.stdin, places) : kase.stdin);
  const env = environment(box, places, kase);
  env.set("ARDIA_BROWSE_BUILD", build);
  const argv = kase.argv.map((token) => expandText(token, places));
  let ran: Ran;
  try {
    checkEffectivePaths(box, kase, env, argv, places.get("cwd")!);
    ran = await execute(install, box, argv, env, places.get("cwd")!, stdin, kase.credential, spawner);
  } finally {
    reap(box);
    await closeFakes();
  }
  const window: [number, number] = [started, Date.now() / 1000];
  const after = scrubStamps(tree(box, dataRel), window);
  const { records, queued, served } = readTelemetry(box, join(box, dataRel), window);
  const usageText = readInside(box, join(box, "cli-home", "Usage", "usage.json"));
  const usage = usageText !== undefined ? scrubTimes(loads(usageText), window) : null;
  const flushText = readInside(box, join(box, dataRel, "Telemetry", "cli-flush.json"));
  const flush = flushText === undefined ? null : flushText ? scrubTimes(loads(flushText), window) : flushText;
  const logText = readInside(box, join(box, "helpers.log"));
  const helpers = logText ? pythonLines(logText) : [];
  const route = routeFrom(install.routeOf(ran.pid));
  return applyNormalizers({
    stdout: ran.stdout,
    stderr: Buffer.from(ran.stderr.toString("latin1").replace(TRACEBACK, ""), "latin1"),
    status: ran.status,
    requests: fake ? fake.transcript() : [],
    daemon_requests: daemon ? daemon.requests : [],
    telemetry: records,
    queued,
    served_by: served,
    usage,
    flush,
    files: fileChanges(before, after),
    helpers,
    timed_out: ran.timedOut,
    transcript_complete: fake ? fake.complete : true,
    route,
    window,
  }, kase, places);
}

export function translatePattern(pattern: string): string {
  let out = "";
  let inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "\\") {
      const next = pattern[index + 1] ?? "";
      index += 1;
      if (next === "d") out += inClass ? "0-9" : "[0-9]";
      else if (next === "D") out += "[^0-9]";
      else if (next === "s") out += inClass ? " \\t\\n\\r\\f\\v" : "[ \\t\\n\\r\\f\\v]";
      else if (next === "S") out += "[^ \\t\\n\\r\\f\\v]";
      else if (next === "w") out += inClass ? "A-Za-z0-9_" : "[A-Za-z0-9_]";
      else if (next === "W") out += "[^A-Za-z0-9_]";
      else if (next === "A") out += "^";
      else if (next === "Z") out += "$";
      else out += `\\${next}`;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      out += char;
      continue;
    }
    if (char === "[") {
      inClass = true;
      out += char;
      if (pattern[index + 1] === "^") out += pattern[++index];
      if (pattern[index + 1] === "]") out += `\\${pattern[++index]}`;
      continue;
    }
    if (char === ".") out += "[^\\n]";
    else if (char === "$") out += "(?=\\n?$)";
    else if (char === "(" && pattern.startsWith("?P<", index + 1)) {
      out += "(?<";
      index += 3;
    } else if (char === "(" && pattern.startsWith("?P=", index + 1)) {
      const close = pattern.indexOf(")", index);
      out += `\\k<${pattern.slice(index + 4, close)}>`;
      index = close;
    } else if (char === "(" && /^\?[aiLmsux]/.test(pattern.slice(index + 1, index + 3)) && !pattern.startsWith("?:", index + 1)) {
      throw new Error(`the parity runner doesn't translate Python's inline flags in ${JSON.stringify(pattern)}`);
    } else out += char;
  }
  return out;
}

export function translateReplacement(replacement: string): string {
  let out = "";
  for (let index = 0; index < replacement.length; index += 1) {
    const char = replacement[index]!;
    if (char === "$") out += "$$";
    else if (char === "\\") {
      const rest = replacement.slice(index + 1);
      const group = /^(\d{1,2})/.exec(rest) ?? /^g<(\w+)>/.exec(rest);
      if (group) {
        out += /^\d+$/.test(group[1]!) ? `$${group[1]}` : `$<${group[1]}>`;
        index += group[0].length;
        continue;
      }
      const escaped: Record<string, string> = { n: "\n", t: "\t", r: "\r", f: "\f", v: "\v", a: "\x07", b: "\b", "\\": "\\" };
      const next = rest[0] ?? "";
      out += escaped[next] ?? `\\${next}`;
      index += 1;
    } else out += char;
  }
  return out;
}

const RE_SPECIAL = new Set("()[]{}?*+-|^$\\.&~# \t\n\r\v\f");

export function reEscape(text: string): string {
  return [...text].map((char) => (RE_SPECIAL.has(char) ? `\\${char}` : char)).join("");
}

export function applyNormalizers(observed: Observed, kase: Case, places: Places): Observed {
  if (!kase.normalize.length) return observed;
  const escaped: Places = new Map([...places].map(([name, place]) => [name, reEscape(place)]));
  const rules = kase.normalize.map(([pattern, replacement]) => {
    const latin = Buffer.from(expandText(pattern, escaped), "utf8").toString("latin1");
    return [new RegExp(translatePattern(latin), "g"), translateReplacement(Buffer.from(replacement, "utf8").toString("latin1"))] as const;
  });
  const scrub = (blob: Buffer) => {
    let text = blob.toString("latin1");
    for (const [pattern, replacement] of rules) text = text.replace(pattern, replacement);
    return Buffer.from(text, "latin1");
  };
  observed.stdout = scrub(observed.stdout);
  observed.stderr = scrub(observed.stderr);
  observed.files = new Map([...observed.files].map(([rel, change]) => [rel, change[0] === "written" && change[1] === "file" ? ["written", "file", change[2], scrub(change[3])] : change]));
  observed.helpers = observed.helpers.map((line) => {
    const [name, ...args] = line.split(" =");
    return [name, ...args.map((arg) => scrub(Buffer.from(arg, "base64")).toString("base64"))].join(" =");
  });
  return observed;
}
