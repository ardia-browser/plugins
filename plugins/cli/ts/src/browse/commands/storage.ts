import type { Value } from "../../json.ts";
import { pyStrip } from "../../pylib/str.ts";
import { BrowseError, Gated, Usage } from "../daemon-errors.ts";
import { Result } from "../daemon/render.ts";
import { pyError, pyFloat } from "../pyerror.ts";
import { record } from "../state/records.ts";
import type { Ctx } from "./ctx.ts";
import { register } from "./index.ts";
import { need, parse } from "./parse.ts";
import { loadsPy, readTextPy, writePrivateJson } from "./pyfile.ts";
import { frameOrMain, refuseOnBorrowed } from "./shared.ts";

const STORAGE_OPS = ["get", "set", "clear", "remove"];
const CURL_COOKIE = /(?:-b|--cookie)\s+(['"])([\s\S]*?)\1/u;
const HEADER_COOKIE = /-H\s+(['"])cookie:\s*([\s\S]*?)\1/iu;

function shownValue(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export async function cmdStorage(ctx: Ctx, argv: string[]): Promise<Result> {
  const [, args] = parse(argv);
  need(args, 1, "storage local|session [get [key] | set <key> <value> | clear | remove <key>]");
  const kind = args[0] as string;
  if (kind !== "local" && kind !== "session") throw new Usage("storage takes local or session");
  let rest = args.slice(1);
  const op = rest.length && STORAGE_OPS.includes(rest[0] as string) ? (rest[0] as string) : "get";
  if (rest.length && STORAGE_OPS.includes(rest[0] as string)) rest = rest.slice(1);
  const page = await ctx.state.page();
  if (op !== "get") refuseOnBorrowed(ctx, page, `${op} the ${kind} storage of`);
  const frame = frameOrMain(ctx, page);
  if (op === "set") {
    need(rest, 2, `storage ${kind} set <key> <value>`);
    await page.call("(k, o, key, v) => ardiaBrowse.storage(k, o, key, v)", [kind, "set", rest[0], rest.slice(1).join(" ")], { frame });
    return new Result({ set: rest[0] });
  }
  if (op === "clear" || op === "remove") {
    await page.call("(k, o, key) => ardiaBrowse.storage(k, o, key)", [kind, op, rest[0] ?? null], { frame });
    return new Result({ [op]: true }, op === "clear" ? "✓ Storage cleared" : "✓ Done");
  }
  const data = record(await page.call("(k, o, key) => ardiaBrowse.storage(k, o, key)", [kind, "get", rest[0] ?? null], { frame, read: true }));
  const text = Object.entries(data).map(([key, value]) => `${key}: ${shownValue(value)}`).join("\n") || "(empty)";
  return new Result({ data }, text, true);
}

export function parseCookieFile(given: string): [string, string][] {
  const text = pyStrip(given);
  if (text.startsWith("[")) {
    const items = loadsPy(text);
    if (!Array.isArray(items)) throw pyError("TypeError", "list indices must be integers or slices, not str");
    return items.map((item) => {
      if (!(item instanceof Map)) throw pyError("TypeError", "string indices must be integers, not 'str'");
      if (!item.has("name")) throw pyError("KeyError", "'name'");
      if (!item.has("value")) throw pyError("KeyError", "'value'");
      return [String(item.get("name")), pyText(item.get("value") as Value)];
    });
  }
  const match = CURL_COOKIE.exec(text) ?? HEADER_COOKIE.exec(text);
  const header = match ? (match[2] as string) : text.replace(/^cookie:\s*/iu, "");
  const pairs: [string, string][] = [];
  for (const part of header.split(";")) {
    if (!part.includes("=")) continue;
    const trimmed = pyStrip(part);
    const at = trimmed.indexOf("=");
    pairs.push([pyStrip(trimmed.slice(0, at)), pyStrip(trimmed.slice(at + 1))]);
  }
  if (pairs.length === 0) throw new BrowseError("No cookies found in that file (JSON array, cURL command or Cookie header)");
  return pairs;
}

function pyText(value: Value): string {
  if (value === null) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "bigint" || typeof value === "string") return String(value);
  if (typeof value === "object" && "value" in value) return String((value as { value: number }).value);
  return String(value);
}

function capitalize(text: string): string {
  return text ? text.slice(0, 1).toUpperCase() + text.slice(1).toLowerCase() : text;
}

export async function cmdCookies(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, {
    "--url": "value",
    "--domain": "value",
    "--path": "value",
    "--httpOnly": "bool",
    "--secure": "bool",
    "--sameSite": "value",
    "--expires": "value",
    "--curl": "value",
  });
  const action = args[0] ?? "get";
  const page = await ctx.state.page();
  if (action !== "get") refuseOnBorrowed(ctx, page, `${action} cookies through`);
  try {
    if (action === "get") {
      const result = await page.send("Network.getCookies", page.url.startsWith("http") ? { urls: [page.url] } : {});
      const cookies = Array.isArray(result["cookies"]) ? result["cookies"].map(record) : [];
      return new Result({ cookies }, cookies.map((cookie) => `${cookie["name"]}=${cookie["value"]}`).join("\n") || "(no cookies)", true);
    }
    if (action === "clear") {
      await page.send("Network.clearBrowserCookies");
      return new Result({ cleared: true }, "✓ Cookies cleared");
    }
    if (action === "set") {
      if (options["curl"]) {
        const cookies = parseCookieFile(readTextPy(ctx.path(options["curl"] as string)));
        const domain = options["domain"] as string | undefined;
        for (const [name, value] of cookies) {
          await page.send("Network.setCookie", { name, value, ...(domain ? { domain } : { url: page.url }) });
        }
        return new Result({ set: cookies.length }, `✓ Set ${cookies.length} cookies`);
      }
      need(args, 3, "cookies set <name> <value> [--url|--domain|--path|--httpOnly|--secure|--sameSite|--expires]");
      const params: Record<string, unknown> = { name: args[1], value: args[2] };
      for (const key of ["url", "domain", "path"]) if (options[key]) params[key] = options[key];
      if (!("url" in params) && !("domain" in params)) params["url"] = page.url;
      if (options["httpOnly"]) params["httpOnly"] = true;
      if (options["secure"]) params["secure"] = true;
      if (options["sameSite"]) params["sameSite"] = capitalize(options["sameSite"] as string);
      if (options["expires"]) {
        const expires = Number(pyStrip(options["expires"] as string));
        if (Number.isNaN(expires) && !/^[+-]?nan$/iu.test(pyStrip(options["expires"] as string))) {
          throw pyError("ValueError", `could not convert string to float: '${options["expires"]}'`);
        }
        params["expires"] = pyFloat(expires);
      }
      const result = await page.send("Network.setCookie", params);
      if (result["success"] === false) throw new BrowseError("The browser refused that cookie");
      return new Result({ set: args[1] });
    }
  } catch (error) {
    if (error instanceof Gated) throw error.during(`cookies ${action}`);
    throw error;
  }
  throw new Usage(`Unknown cookies operation: ${action} (get, set, clear)`);
}

export async function cmdState(ctx: Ctx, argv: string[]): Promise<Result> {
  const [, args] = parse(argv);
  need(args, 2, "state save|load <path>");
  const page = await ctx.state.page();
  if (args[0] !== "save") refuseOnBorrowed(ctx, page, "load cookies and storage into");
  const file = ctx.path(args[1] as string);
  try {
    if (args[0] === "save") {
      const result = await page.send("Network.getAllCookies");
      const cookies = Array.isArray(result["cookies"]) ? result["cookies"] : [];
      const local = record(await page.call("() => ardiaBrowse.storage('local', 'get')", [], { frame: page.mainFrame, read: true }));
      const origin = page.frames.get(page.mainFrame as string)?.origin ?? null;
      writePrivateJson(file, { cookies, origins: [{ origin, localStorage: Object.entries(local).map(([name, value]) => ({ name, value })) }] });
      return new Result({ path: args[1] }, `✓ State saved to ${args[1]}`);
    }
    if (args[0] === "load") {
      const saved = loadsPy(readTextPy(file));
      const field = (value: Value, key: string): Value | undefined => (value instanceof Map ? value.get(key) : undefined);
      const cookies = field(saved, "cookies");
      if (cookies && (!Array.isArray(cookies) || cookies.length)) await page.send("Network.setCookies", { cookies: plainOf(cookies) });
      const origin = page.frames.get(page.mainFrame as string)?.origin ?? null;
      const entries = field(saved, "origins");
      for (const entry of Array.isArray(entries) ? entries : []) {
        if (field(entry, "origin") !== origin) continue;
        const items = field(entry, "localStorage");
        for (const item of Array.isArray(items) ? items : []) {
          await page.call("(k, v) => ardiaBrowse.storage('local', 'set', k, v)", [plainOf(field(item, "name") ?? null), plainOf(field(item, "value") ?? null)], { frame: page.mainFrame });
        }
      }
      return new Result({ path: args[1] }, `✓ State loaded from ${args[1]}`);
    }
  } catch (error) {
    if (error instanceof Gated) throw error.during(`state ${args[0]}`);
    throw error;
  }
  throw new Usage("Usage: ardia browse state save|load <path>");
}

function plainOf(value: Value): unknown {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Map) return Object.fromEntries([...value].map(([key, item]) => [key, plainOf(item)]));
  if (Array.isArray(value)) return value.map(plainOf);
  if (value !== null && typeof value === "object") return (value as { value: number }).value;
  return value;
}

register("storage", cmdStorage);
register("cookies", cmdCookies);
register("state", cmdState);
