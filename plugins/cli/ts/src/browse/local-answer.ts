import { resolve as resolvePath } from "node:path";
import { type JsonObject, type Value } from "../json.ts";
import { expandUser } from "../paths.ts";
import { redact } from "../redact.ts";
import { ParamsError, readParamsStdin as decodeParamsStdin } from "./cdp/params.ts";
import { CDP_FLAGS, cdpParams, cdpTarget } from "./commands/cdp.ts";
import { parse } from "./commands/parse.ts";
import { BrowseError, Usage } from "./daemon-errors.ts";
import { renderPlain, type Result } from "./daemon/render.ts";
import { readStdin } from "./local.ts";
import { ALIASES as READ_ALIASES, flags as readFlags, readsStdin, relative } from "./read/pages.ts";
import { parseTimeout } from "./script/timeout.ts";

export const MAX_CDP_STDIN = 1024 * 1024;

const CLIENT_SIDE = new WeakSet<JsonObject>();

export function answeredHere(answer: JsonObject): boolean {
  return CLIENT_SIDE.has(answer);
}

export function answerOf(options: Record<string, unknown>, result: Result | null, error: BrowseError | null): JsonObject {
  const [code, out, err] = renderPlain(options, result, error);
  const answer: JsonObject = new Map<string, Value>([
    ["exit", BigInt(code)],
    ["out", redact(out)],
    ["err", redact(err)],
  ]);
  if (error !== null && error.code) answer.set("code", error.code);
  if (result?.body) {
    answer.set("body", Buffer.from(result.body).toString("base64"));
    answer.set("body_bytes", BigInt(result.body.length));
  }
  CLIENT_SIDE.add(answer);
  return answer;
}

export async function localAnswer(run: () => Promise<Result | null>, options: Record<string, unknown>): Promise<JsonObject | undefined> {
  try {
    const result = await run();
    return result === null ? undefined : answerOf(options, result, null);
  } catch (error) {
    if (error instanceof BrowseError) return answerOf(options, null, error);
    throw error;
  }
}

export async function daemonErrors<T>(run: () => T | Promise<T>, options: Record<string, unknown>): Promise<T | JsonObject> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof BrowseError) return answerOf(options, null, error);
    throw error;
  }
}

export function checkCdpFlags(args: string[]): Record<string, unknown> {
  const [options] = parse(args, CDP_FLAGS);
  cdpTarget(options);
  if (options["timeout"] !== undefined && options["timeout"] !== null) parseTimeout(options["timeout"] as string);
  return options;
}

export function checkCdpParams(options: Record<string, unknown>, stdin: string | null): void {
  cdpParams(options["params"] as string | undefined, (options["param"] as string[] | undefined) ?? [], stdin);
}

export function readCdpStdin(): string {
  try {
    return decodeParamsStdin(readStdin(MAX_CDP_STDIN + 1));
  } catch (error) {
    if (error instanceof ParamsError) throw new Usage(error.message);
    throw error;
  }
}

export function readsNamedUrls(args: string[]): boolean {
  let parsed: [Record<string, unknown>, string[]];
  try {
    parsed = parse(args, readFlags(), READ_ALIASES) as [Record<string, unknown>, string[]];
  } catch (error) {
    if (error instanceof Usage) return false;
    throw error;
  }
  const [options, positional] = parsed;
  const named = positional.filter((url) => url !== "-");
  return (
    options["links"] === undefined &&
    !options["scroll"] &&
    !options["list"] &&
    (named.length > 0 || readsStdin(options as never, positional)) &&
    !named.some(relative)
  );
}

export function expandScriptPath(path: string): string {
  return resolvePath(process.cwd(), expandUser(path));
}
