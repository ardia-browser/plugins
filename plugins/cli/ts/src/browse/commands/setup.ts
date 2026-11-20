import fs from "node:fs";
import { PyException, reprText } from "../../pylib/str.ts";
import { BrowseError } from "../daemon-errors.ts";
import { REACT_HOOK } from "../js/index.ts";
import type { Page } from "../state/page.ts";
import type { Ctx } from "./ctx.ts";
import { unsupported } from "./index.ts";
import { addInitScript } from "./pagejs.ts";

export type ConsoleStarter = (ctx: Ctx, page: Page) => Promise<void>;
export const setupHooks: { startConsole: ConsoleStarter | null } = { startConsole: null };

const PY_ERRORS: Readonly<Record<string, [string, number]>> = {
  ENOENT: ["FileNotFoundError", 2],
  EACCES: ["PermissionError", 13],
  EPERM: ["PermissionError", 1],
  EISDIR: ["IsADirectoryError", 21],
  ENOTDIR: ["NotADirectoryError", 20],
  ELOOP: ["OSError", 62],
};

export const MAX_INIT_SCRIPT = 4 * 1024 * 1024;

function osError(error: unknown, file: string): PyException {
  const code = String((error as { code?: unknown }).code ?? "");
  const [type, errno] = PY_ERRORS[code] ?? ["OSError", Number((error as { errno?: unknown }).errno ?? 5)];
  const why = (error as Error).message.replace(/^[A-Z]+: /u, "").split(",")[0] ?? "error";
  const said = code === "ENOENT" ? "No such file or directory" : code === "EACCES" || code === "EPERM" ? "Permission denied" : code === "EISDIR" ? "Is a directory" : why;
  return new PyException(type, `[Errno ${Math.abs(errno)}] ${said}: ${reprText(file)}`);
}

export function decodeScript(bytes: Uint8Array, file: string): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new PyException("UnicodeDecodeError", `'utf-8' codec can't decode the file ${reprText(file)}: invalid UTF-8`);
  }
  return text.replace(/\r\n?/gu, "\n");
}

export async function readScript(file: string): Promise<string> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  } catch (error) {
    throw osError(error, file);
  }
  try {
    const info = await handle.stat();
    if (info.isDirectory()) throw new PyException("IsADirectoryError", `[Errno 21] Is a directory: ${reprText(file)}`);
    if (!info.isFile()) throw new BrowseError(`--init-script ${file} isn't a regular file (a pipe, socket or device can't be read as a script)`, null, "bad_init_script");
    if (info.size > MAX_INIT_SCRIPT) throw new BrowseError(`--init-script ${file} is over ${MAX_INIT_SCRIPT / (1024 * 1024)} MB`, null, "bad_init_script");
    const bytes = Buffer.alloc(Math.min(info.size, MAX_INIT_SCRIPT) + 1);
    let filled = 0;
    for (;;) {
      const { bytesRead } = await handle.read(bytes, filled, bytes.length - filled, null);
      if (bytesRead === 0) break;
      filled += bytesRead;
      if (filled >= bytes.length) throw new BrowseError(`--init-script ${file} is over ${MAX_INIT_SCRIPT / (1024 * 1024)} MB`, null, "bad_init_script");
    }
    return decodeScript(bytes.subarray(0, filled), file);
  } finally {
    await handle.close();
  }
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

export function refuseUnservedSetup(ctx: Ctx): void {
  if (ctx.options["capture_console"] && setupHooks.startConsole === null) throw unsupported("`--capture-console`");
}

export function takeOpenOptions(ctx: Ctx, options: Record<string, unknown>): void {
  const enable = list(ctx.options["enable"]);
  for (const value of list(options["enable"])) enable.push(...value.split(","));
  ctx.options["enable"] = enable;
  ctx.options["init_scripts"] = [...list(ctx.options["init_scripts"]), ...list(options["init_script"])];
  if (options["capture_console"]) ctx.options["capture_console"] = true;
}

export async function applyOpenOptions(ctx: Ctx, page: Page): Promise<void> {
  for (const feature of list(ctx.options["enable"])) {
    if (feature !== "react-devtools") throw new BrowseError(`Unknown --enable feature: ${feature} (react-devtools)`);
    if (![...page.initScripts.values()].includes("react")) await addInitScript(ctx.state, page, REACT_HOOK, "react");
  }
  for (const file of list(ctx.options["init_scripts"])) await addInitScript(ctx.state, page, await readScript(ctx.path(file)), null);
  if (ctx.options["capture_console"]) {
    const start = setupHooks.startConsole;
    if (start === null) throw unsupported("`--capture-console`");
    await start(ctx, page);
  }
}
