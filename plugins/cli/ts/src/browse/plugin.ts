import { createHash } from "node:crypto";
import { closeSync, fstatSync, read } from "node:fs";
import { field, type JsonObject, type Value } from "../json.ts";
import { BrowseError } from "./errors.ts";

import { PLUGIN_MODE } from "./route.ts";

export { pluginMode } from "./route.ts";

export function pluginModeValueOk(): boolean {
  return process.env[PLUGIN_MODE] === "1";
}
export const CREDENTIAL_FD = "ARDIA_PLUGIN_CREDENTIAL_FD";
export const REFUSED = 77;
const CREDENTIAL = /^[A-Za-z0-9._~+/=-]{16,1024}$/;
const MAX_CREDENTIAL = 1025;
const READ_DEADLINE_MS = 2000;
const FIRST_FREE_FD = 3;
const MAX_FD = 65535;
const ENDPOINT_FLAGS = ["ws", "port", "cdp"];
const ENDPOINT_ENV = ["ARDIA_WS", "ARDIA_PORT", "ARDIA_CDP_URL", "AGENT_BROWSER_CDP"];
const EXPECT_LOADER = "--expect-loader";
const LOADER = /^[A-Za-z0-9._:-]{1,128}$/;
const CHANGED_BEFORE = "The page changed document before this could run, so it wasn't applied; snapshot again";
const CHANGED_DURING = "The page changed document while this ran, so its result belongs to another page; snapshot again";
const UNCHECKED = "The browse daemon didn't report the page's document, so --expect-loader couldn't be checked and the result was dropped; update ardia";

export class PluginRefusal extends Error {}

export function refusal(why: string): string {
  return `✗ ardia browse for a plugin (${PLUGIN_MODE}=1) ${why}; nothing was sent\n`;
}

function readSome(fd: number, buffer: Buffer, offset: number): Promise<number | NodeJS.ErrnoException> {
  return new Promise((resolve) => read(fd, buffer, offset, buffer.length - offset, null, (error, count) => resolve(error ?? count)));
}

async function readAll(fd: number): Promise<Buffer> {
  const buffer = Buffer.alloc(MAX_CREDENTIAL + 1);
  let size = 0;
  const deadline = performance.now() + READ_DEADLINE_MS;
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), Math.max(1, deadline - performance.now()));
    });
    const got = await Promise.race([readSome(fd, buffer, size), late]);
    clearTimeout(timer);
    if (got === "late") throw new PluginRefusal(`got no credential on fd ${fd} within ${READ_DEADLINE_MS / 1000} s (Ardia closes its end after writing it)`);
    if (typeof got !== "number") {
      if (got.code === "EINTR" || got.code === "EAGAIN") continue;
      throw new PluginRefusal(`couldn't read the credential on fd ${fd} (${got.code ?? "error"})`);
    }
    if (got === 0) return buffer.subarray(0, size);
    size += got;
    if (size > MAX_CREDENTIAL) throw new PluginRefusal(`got a credential on fd ${fd} longer than ${MAX_CREDENTIAL - 1} bytes`);
    const end = buffer.subarray(0, size).indexOf(0x0a);
    if (end >= 0) {
      if (end !== size - 1) throw new PluginRefusal(`got more than one line on fd ${fd}; Ardia writes the credential alone`);
      return buffer.subarray(0, size);
    }
  }
}

export async function takeCredential(): Promise<string> {
  const named = process.env[CREDENTIAL_FD];
  if (named === undefined || named === "") throw new PluginRefusal(`needs ${CREDENTIAL_FD}, the descriptor Ardia passes the activity's credential on, and it isn't set`);
  if (!/^[0-9]{1,5}$/.test(named) || Number(named) < FIRST_FREE_FD || Number(named) > MAX_FD) {
    throw new PluginRefusal(`needs ${CREDENTIAL_FD} to name an inherited descriptor (3 or above), not ${JSON.stringify(named)}`);
  }
  const fd = Number(named);
  try {
    let kind;
    try {
      kind = fstatSync(fd);
    } catch {
      throw new PluginRefusal(`was given fd ${fd} for its credential, and that descriptor isn't open`);
    }
    if (!kind.isFIFO() && !kind.isSocket()) throw new PluginRefusal(`was given fd ${fd} for its credential, and it isn't a pipe or a socket`);
    const raw = (await readAll(fd)).toString("latin1");
    const text = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    if (!CREDENTIAL.test(text)) throw new PluginRefusal(`got a credential on fd ${fd} that isn't one Ardia issues`);
    return text;
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }
}

export function dropCredential(): void {
  const named = process.env[CREDENTIAL_FD] ?? "";
  if (!/^[0-9]{1,5}$/.test(named) || Number(named) < FIRST_FREE_FD) return;
  try {
    closeSync(Number(named));
  } catch {}
}

export function checkEndpointFree(values: Map<string, string>): void {
  const flag = ENDPOINT_FLAGS.find((key) => values.has(key));
  if (flag !== undefined) throw new PluginRefusal(`reaches the browser only through the activity's credential, so it doesn't take --${flag}`);
  const variable = ENDPOINT_ENV.find((name) => process.env[name]);
  if (variable !== undefined) throw new PluginRefusal(`reaches the browser only through the activity's credential, so ${variable} must be unset`);
}

export function pluginEndpointKey(credential: string): string {
  return `plugin:${createHash("sha256").update(credential, "utf8").digest("hex").slice(0, 32)}`;
}

export function takeExpectLoader(rest: string[]): { argv: string[]; loader: string | undefined } {
  const argv: string[] = [];
  let loader: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] as string;
    if (token === "--") {
      argv.push(...rest.slice(index));
      break;
    }
    if (token === EXPECT_LOADER || token.startsWith(`${EXPECT_LOADER}=`)) {
      const value = token === EXPECT_LOADER ? rest[(index += 1)] : token.slice(EXPECT_LOADER.length + 1);
      if (value === undefined || !LOADER.test(value)) throw new PluginRefusal(`takes ${EXPECT_LOADER} <loaderId>, the main frame's loader id from snapshot`);
      loader = value;
      continue;
    }
    argv.push(token);
  }
  return { argv, loader };
}

export function loaderRefusal(answer: JsonObject, expected: string): BrowseError | undefined {
  const seen: Value | undefined = answer.get("main_loader");
  const before = field(seen, "before");
  const after = field(seen, "after");
  if (typeof before !== "string" || typeof after !== "string") return new BrowseError(UNCHECKED, 1, "document_changed");
  if (before !== expected) return new BrowseError(CHANGED_BEFORE, 1, "document_changed");
  if (after !== expected) return new BrowseError(CHANGED_DURING, 1, "document_changed");
  return undefined;
}
