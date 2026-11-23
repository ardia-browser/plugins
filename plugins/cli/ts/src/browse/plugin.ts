import { closeSync, fstatSync, read } from "node:fs";
import { isatty } from "node:tty";
import { PLUGIN_MODE } from "./route.ts";
import { raceInterrupt } from "./stdio.ts";
import type { Found } from "./args.ts";
import { pluginVerdict } from "./plugin-grammar.ts";
import { VALUE_FLAGS } from "./tables.ts";

export { pluginMode } from "./route.ts";

export const CREDENTIAL_FD = "ARDIA_PLUGIN_CREDENTIAL_FD";
export const ENDPOINT = "ARDIA_PLUGIN_ENDPOINT";
export const REFUSED = 77;
export const CODE = "plugin_refused";
export const NESTED_CODE = "nested_commands_refused";
export const UNAVAILABLE = "plugin_daemon_unavailable";
export const UNAVAILABLE_WHY = "has no plugin daemon yet: plugin steps will run on a TypeScript daemon that reads pages through DOM, accessibility and input only (M3 F1)";
const CREDENTIAL = /^p\.[A-Za-z0-9_-]{43}$/;
const TOKEN_SERVER = /^ws:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/devtools\/browser\/[A-Za-z0-9._-]{1,128}$/;
const MAX_PORT = 65535;
const FD_NUMBER = /^[0-9]{1,5}$/;
const MAX_READ = 256;
const READ_DEADLINE_MS = 2000;
const FIRST_FREE_FD = 3;
const MAX_FD = 65535;
const ENDPOINT_FLAGS = ["ws", "port", "cdp"];
const ENDPOINT_ENV = ["ARDIA_WS", "ARDIA_PORT", "ARDIA_CDP_URL", "AGENT_BROWSER_CDP"];
const SESSION_FLAGS = [
  "--session", "--namespace", "--data-dir", "--port", "--ws", "--cdp", "--screenshot-dir", "--screenshot-format",
  "--screenshot-quality", "--idle-timeout", "--init-script", "--enable", "--headers", "--color-scheme", "--download-path",
  "--annotate", "--no-auto-dialog", "--pin-tab", "--no-pin-tab", "--debug", "--capture-console", "--show",
  "--content-boundaries", "--no-content-boundaries", "--out", "--stdin",
];
const LOCAL_COMMANDS = ["auth", "notes", "flow", "plugin", "read", "session", "script", "cdp", "clipboard"];

export class PluginRefusal extends Error {
  constructor(
    why: string,
    readonly code: string = CODE,
  ) {
    super(why);
  }
}

export type Access = { credential: string; endpoint: string };

export function message(why: string): string {
  return `ardia browse for a plugin (${PLUGIN_MODE}=1) ${why}; nothing was sent`;
}

function pyJson(text: string | undefined): string {
  return text === undefined ? "null" : JSON.stringify(text);
}

function readSome(fd: number, buffer: Buffer, offset: number): Promise<number | NodeJS.ErrnoException> {
  return new Promise((resolve) => read(fd, buffer, offset, buffer.length - offset, null, (error, count) => resolve(error ?? count)));
}

async function readAll(fd: number): Promise<Buffer> {
  const buffer = Buffer.alloc(MAX_READ + 1);
  let size = 0;
  const deadline = performance.now() + READ_DEADLINE_MS;
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), Math.max(1, deadline - performance.now()));
    });
    const got = await raceInterrupt(Promise.race([readSome(fd, buffer, size), late]));
    clearTimeout(timer);
    if (got === "late") throw new PluginRefusal(`got no credential on fd ${fd} within ${READ_DEADLINE_MS / 1000} s (Ardia closes its end after writing it)`);
    if (typeof got !== "number") {
      if (got.code === "EINTR" || got.code === "EAGAIN") continue;
      throw new PluginRefusal(`couldn't read the credential on fd ${fd} (${got.code ?? "error"})`);
    }
    if (got === 0) return buffer.subarray(0, size);
    size += got;
    if (size > MAX_READ) throw new PluginRefusal(`got more than ${MAX_READ} bytes on fd ${fd}, which no credential is`);
  }
}

async function takeCredential(): Promise<string> {
  const named = process.env[CREDENTIAL_FD];
  if (!named) throw new PluginRefusal(`needs ${CREDENTIAL_FD}, the descriptor Ardia passes the activity's credential on, and it isn't set`);
  if (!FD_NUMBER.test(named) || Number(named) < FIRST_FREE_FD || Number(named) > MAX_FD) {
    throw new PluginRefusal(`needs ${CREDENTIAL_FD} to name an inherited descriptor (3 or above), not ${pyJson(named)}`);
  }
  const fd = Number(named);
  try {
    let kind;
    try {
      kind = fstatSync(fd);
    } catch {
      throw new PluginRefusal(`was given fd ${fd} for its credential, and that descriptor isn't open`);
    }
    if (isatty(fd)) throw new PluginRefusal(`was given fd ${fd} for its credential, and it's a terminal`);
    if (!kind.isFIFO() && !kind.isSocket() && !kind.isFile()) throw new PluginRefusal(`was given fd ${fd} for its credential, and it isn't a pipe, socket or file`);
    const text = (await readAll(fd)).toString("latin1");
    if (!CREDENTIAL.test(text)) {
      throw new PluginRefusal(`got ${text.length} bytes on fd ${fd} that aren't a credential (exactly p. and 43 base64url characters, no newline)`);
    }
    return text;
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }
}

function tokenServer(): string {
  const endpoint = process.env[ENDPOINT];
  if (endpoint === undefined) throw new PluginRefusal(`needs ${ENDPOINT}, the token server Ardia gives with the credential, and it isn't set`);
  if (endpoint === "") throw new PluginRefusal(`was given an empty ${ENDPOINT}: Ardia's token server is off, so turn on browser control and start the activity again`);
  const port = TOKEN_SERVER.exec(endpoint)?.[1];
  if (port === undefined || Number(port) > MAX_PORT) throw new PluginRefusal(`needs ${ENDPOINT} to be ws://127.0.0.1:<port>/devtools/browser/<id>, not ${pyJson(endpoint)}`);
  return endpoint;
}

export function dropCredential(): void {
  const named = process.env[CREDENTIAL_FD] ?? "";
  if (!FD_NUMBER.test(named) || Number(named) < FIRST_FREE_FD) return;
  try {
    closeSync(Number(named));
  } catch {}
}

export async function takeAccess(): Promise<Access> {
  if (process.env[PLUGIN_MODE] !== "1") {
    dropCredential();
    throw new PluginRefusal(`takes ${PLUGIN_MODE}=1 only, not ${pyJson(process.env[PLUGIN_MODE])}`);
  }
  const credential = await takeCredential();
  return { credential, endpoint: tokenServer() };
}

function afterCommand(argv: readonly string[]): string[] {
  for (let index = 0; index < argv.length; ) {
    const token = argv[index] as string;
    if (token === "--") return [];
    if (token.startsWith("-")) {
      index += VALUE_FLAGS.includes(token) ? 2 : 1;
      continue;
    }
    const tail = argv.slice(index + 1);
    const end = tail.indexOf("--");
    return end < 0 ? tail : tail.slice(0, end);
  }
  return [];
}

const GLOBAL_VALUES = ["session", "expect_loader", "max_output"];
const GLOBAL_FLAGS = ["json", "humanize", "no_humanize", "full", "no_changes", "no_text"];

function globalRefusal(found: Found): string | undefined {
  const value = [...found.values.keys()].find((key) => !GLOBAL_VALUES.includes(key));
  if (value !== undefined) return `--${value.replaceAll("_", "-")}`;
  const flag = [...found.flags.keys()].find((key) => !GLOBAL_FLAGS.includes(key));
  if (flag !== undefined) return `--${flag.replaceAll("_", "-")}`;
  if (found.enable !== undefined) return "--enable";
  if (found.initScript !== undefined) return "--init-script";
  return undefined;
}

export function checkRequest(argv: readonly string[], found: Found, rest: readonly string[]): void {
  const command = rest[0] ?? "";
  if (LOCAL_COMMANDS.includes(command) || (command === "close" && rest.slice(1).includes("--all"))) {
    throw new PluginRefusal(`can't run \`${command}\` for a plugin, only page steps`);
  }
  for (const token of afterCommand(argv)) {
    const name = token.split("=")[0] as string;
    if (SESSION_FLAGS.includes(name)) throw new PluginRefusal(`doesn't take ${name} after the command`);
  }
  const flag = ENDPOINT_FLAGS.find((key) => found.values.has(key));
  if (flag !== undefined) throw new PluginRefusal(`reaches the browser only through the activity's credential, so it doesn't take --${flag}`);
  const variable = ENDPOINT_ENV.find((name) => process.env[name]);
  if (variable !== undefined) throw new PluginRefusal(`reaches the browser only through the activity's credential, so ${variable} must be unset`);
  const global = globalRefusal(found);
  if (global !== undefined) throw new PluginRefusal(`takes its data folder and session settings only from Ardia, so it doesn't take ${global}`);
  const verdict = pluginVerdict(rest);
  if (!verdict.allowed && verdict.nested) {
    throw new PluginRefusal(`can't run ${verdict.why}: it runs other commands inside the daemon, which doesn't check the plugin rules on them yet, so send each step on its own`, NESTED_CODE);
  }
  if (!verdict.allowed) throw new PluginRefusal(`can't run ${verdict.why} for a plugin, only page steps`);
}
