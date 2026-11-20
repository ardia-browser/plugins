import { formatG } from "../../pylib/format.ts";
import { PY_SPACE_CLASS } from "../../pylib/re.ts";
import { isWordCode } from "../../pylib/unicode.ts";
import { isSpace, strip } from "../../py.ts";
import { codePoints } from "../../pystr.ts";
import type { CdpResult } from "../cdp/browser.ts";
import { BrowseError, CdpError, Gated, OutcomeUnknown, Usage } from "../daemon-errors.ts";
import { Result } from "../daemon/render.ts";
import { flag } from "../metrics.ts";
import { renderJson } from "../script/render.ts";
import { MAX_TIMEOUT, parseTimeout } from "../script/timeout.ts";
import { DOCUMENT_CHANGED, type Page } from "../state/page.ts";
import { record } from "../state/records.ts";
import type { State } from "../state/state.ts";
import { hintOnce, refuseOnBorrowed } from "./borrowed.ts";
import type { Ctx } from "./ctx.ts";
import { register } from "./index.ts";
import { need, parse } from "./parse.ts";

export const EVAL_TIMEOUT = 60.0;
export const ISOLATED_EVAL = "function (source) { return (0, eval)(source); }";
const S = `[${PY_SPACE_CLASS}]`;
const UNQUOTED_ATTRIBUTE = /\[[^\]"'=]+=[^\]"']*[\t\n\v\f\r\x1c-\x1f \x85\xa0  -     　/:.,;][^\]"']*\]/u;
const SELECTOR_CALL = new RegExp(`\\b(querySelectorAll|querySelector|closest|matches)\\(${S}*(['"])((?:\\\\.|(?!\\2).)*)\\2`, "gu");
const UNQUOTED_VALUE = new RegExp(
  `\\[${S}*([^${PY_SPACE_CLASS}~|^$*!=\\]"']+)${S}*([~|^$*]?=)${S}*([^"'\\\\\\]${PY_SPACE_CLASS}][^\\]]*?)(${S}+[iIsS])?${S}*\\]`,
  "gu",
);
const FETCHING = new RegExp(`\\bfetch${S}*\\(|\\bXMLHttpRequest\\b|\\bnew${S}+DOMParser\\b|\\bwindow\\.open${S}*\\(`, "u");
const PAGE_GLOBAL_MISSING = /ReferenceError: ([A-Za-z_$][\w$]*) is not defined/u;
const STALE_CONTEXT = ["Cannot find context", "Execution context was destroyed", "Cannot find default execution context", "Inspected target navigated", "Could not find object with given id"];
const WRAPPER_FRAME = /eval \(eval at [^\n]*?\), (<anonymous>:\d+:\d+)\)/gu;
export const FETCH_HINT =
  "→ tip: to read other pages, `ardia browse read <url> <url>…` (or `read --links <pattern>` for this page's links) reads " +
  "them in one call, through your logins and after their scripts run; `ardia browse script` loops over pages with clicks and fills";
export const MAIN_WORLD_HINT =
  "eval runs in an isolated world that shares the page's DOM but not its JavaScript, so the page's own globals ({name}) aren't there. " +
  "`ardia browse eval --main-world …` runs it in the page's own world, where the page can see it";

function plainValue(text: string): boolean {
  const points = codePoints(text);
  let index = 0;
  if (points[0] === "-") index += 1;
  const first = points[index];
  if (first === undefined || !/^[A-Za-z_]$/u.test(first)) return false;
  for (const point of points.slice(index + 1)) if (point !== "-" && !isWordCode(point.codePointAt(0) as number)) return false;
  return true;
}

export function quoteSelectorLiterals(script: string): [string, string[]] {
  const quoted: string[] = [];
  const fixed = script.replace(SELECTOR_CALL, (whole: string, name: string, quote: string, selector: string) => {
    const inner = quote === '"' ? "'" : '"';
    const repaired = selector.replace(UNQUOTED_VALUE, (part: string, attribute: string, op: string, value: string, mode: string | undefined) => {
      const bare = strip(value, isSpace);
      if (plainValue(bare)) return part;
      return `[${attribute}${op}${inner}${bare}${inner}${mode ?? ""}]`;
    });
    if (repaired === selector) return whole;
    quoted.push(repaired);
    return `${name}(${quote}${repaired}${quote}`;
  });
  return [fixed, quoted];
}

function exceptionText(result: CdpResult): string {
  const details = record(result["exceptionDetails"]);
  return String(record(details["exception"])["description"] || details["text"] || "error");
}

function remoteValue(result: CdpResult): unknown {
  const remote = record(result["result"]);
  if (remote["type"] === "undefined") return null;
  if (Object.hasOwn(remote, "value")) return remote["value"];
  return remote["unserializableValue"] || remote["description"] || null;
}

function evaluationError(description: string, isolated: boolean): BrowseError {
  let text = isolated ? description.replace(WRAPPER_FRAME, "$1").replace(/\n {4}at <anonymous>:1:\d+$/u, "") : description;
  if (text.includes("is not a valid selector") && UNQUOTED_ATTRIBUTE.test(text)) {
    text +=
      '\n  An attribute value with spaces or punctuation needs quotes in CSS: a[href*="/path/"], ' +
      "[aria-label=\"Two words\"]. ardia browse's own selectors (click, find, get) quote it for you";
  }
  const missing = isolated ? PAGE_GLOBAL_MISSING.exec(text) : null;
  if (missing) {
    flag("eval_isolated_reference_error", true);
    text += `\n  ${MAIN_WORLD_HINT.replace("{name}", missing[1] as string)}`;
  }
  return new BrowseError(`Evaluation error: ${text}`, null, "page_script_error");
}

export async function evaluateMain(page: Page, expression: string, timeout = EVAL_TIMEOUT): Promise<unknown> {
  const result = await page.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true, userGesture: false },
    { timeout, mutation: true },
  );
  if (Object.hasOwn(result, "exceptionDetails")) throw evaluationError(exceptionText(result), false);
  return remoteValue(result);
}

export async function evaluateIsolated(page: Page, expression: string, timeout = EVAL_TIMEOUT): Promise<unknown> {
  const world = await page.worldOf(page.mainFrame);
  let result: CdpResult;
  try {
    result = await page.send(
      "Runtime.callFunctionOn",
      { functionDeclaration: ISOLATED_EVAL, objectId: world.handle, arguments: [{ value: expression }], returnByValue: true, awaitPromise: true, userGesture: false },
      {
        timeout,
        mutation: true,
        guard: () => {
          if (!page.frames.has(world.frame) || page.loader(world.frame) !== world.loader) throw new BrowseError(DOCUMENT_CHANGED, null, "document_changed");
        },
      },
    );
  } catch (error) {
    if (!(error instanceof CdpError) || !STALE_CONTEXT.some((marker) => error.cdpMessage.includes(marker))) throw error;
    page.worlds.delete(world.frame);
    if (error.cdpMessage.includes("destroyed")) throw new OutcomeUnknown("the page script", "the page changed document while it ran");
    throw new BrowseError(DOCUMENT_CHANGED, null, "document_changed");
  }
  if (Object.hasOwn(result, "exceptionDetails")) throw evaluationError(exceptionText(result), true);
  return remoteValue(result);
}

export function originOf(page: Page): string {
  const origin = (page.mainFrame === null ? undefined : page.frames.get(page.mainFrame)?.origin) || "";
  return origin && !origin.endsWith("/") ? `${origin}/` : origin;
}

export async function cmdEval(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, { "--base64": "bool", "--stdin": "bool", "--timeout": "value", "--main-world": "bool" }, { "-b": "--base64" });
  const limit = options["timeout"] ? parseTimeout(options["timeout"] as string) : EVAL_TIMEOUT;
  let script: string;
  if (options["stdin"] || (args.length === 0 && ctx.stdin)) script = ctx.stdin || "";
  else {
    need(args, 1, "eval <js> | -b <base64> | --stdin [--timeout 2m] [--main-world]");
    script = args.join(" ");
    if (options["base64"]) script = decodeBase64(script);
  }
  const page = await ctx.state.page();
  if (FETCHING.test(script)) hintOnce(ctx.state, "fetch", FETCH_HINT);
  const [fixed, quoted] = quoteSelectorLiterals(script);
  const mainWorld = Boolean(options["main_world"]);
  flag("eval_main_world", mainWorld);
  let value: unknown;
  try {
    value = mainWorld ? await evaluateMain(page, fixed, limit) : await evaluateIsolated(page, fixed, limit);
  } catch (error) {
    if (!(error instanceof OutcomeUnknown) || !/didn't answer Runtime\.(evaluate|callFunctionOn)/u.test(error.text)) throw error;
    flag("eval_timed_out", true);
    throw new OutcomeUnknown(
      "`eval`",
      `The page's code didn't finish within ${formatG(limit)} s (eval waits for the promise it returns) and may still ` +
        `be running in the page. Give it longer with \`eval --timeout 5m\` (up to ${formatG(MAX_TIMEOUT / 60)}m), ` +
        "or split the work into smaller batches",
    );
  }
  let text = renderJson(value);
  if (quoted.length > 0) {
    flag("eval_selectors_quoted", true);
    text += `\n(quoted the attribute values in ${quoted.join(", ")}, which CSS needs for values with spaces or punctuation)`;
  }
  return new Result({ origin: originOf(page), result: value }, text, true);
}

function decodeBase64(text: string): string {
  const clean = text.replace(/[^A-Za-z0-9+/=]/gu, "");
  if (clean.replace(/=+$/u, "").length % 4 === 1) throw new BrowseError("Invalid base64-encoded string: number of data characters cannot be 1 more than a multiple of 4");
  if (/=[^=]/u.test(clean) || (clean.length % 4 !== 0 && clean.includes("="))) throw new BrowseError("Incorrect padding");
  if (clean.length % 4 !== 0) throw new BrowseError("Incorrect padding");
  const bytes = Buffer.from(clean, "base64");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new BrowseError("'utf-8' codec can't decode the script: it isn't UTF-8");
  }
}

export async function addInitScript(state: State, page: Page, source: string, tag: string | null): Promise<string> {
  const result = await page.send("Page.addScriptToEvaluateOnNewDocument", { source });
  const identifier = String(result["identifier"]);
  page.initScripts.set(identifier, tag || source);
  page.scriptSources.set(identifier, source);
  state.initSources.set(identifier, source);
  state.leases.add("init");
  return identifier;
}

export async function cmdAddInitScript(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, { "--stdin": "bool" });
  const source = options["stdin"] ? ctx.stdin : args.join(" ");
  if (!source) throw new Usage("Usage: ardia browse addinitscript <js> | --stdin");
  const page = await ctx.state.page();
  refuseOnBorrowed(ctx, page, "add a script to");
  const identifier = await addInitScript(ctx.state, page, source, null);
  return new Result({ identifier }, identifier);
}

export async function cmdRemoveInitScript(ctx: Ctx, argv: string[]): Promise<Result> {
  const [, args] = parse(argv);
  need(args, 1, "removeinitscript <id>");
  const page = await ctx.state.page();
  const wanted = args[0] as string;
  if (!page.initScripts.has(wanted)) throw new BrowseError(`No init script ${wanted} in this tab`);
  await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: page.scriptIds.get(wanted) ?? wanted });
  page.initScripts.delete(wanted);
  page.scriptSources.delete(wanted);
  page.scriptIds.delete(wanted);
  ctx.state.initSources.delete(wanted);
  if (![...ctx.state.pages.values()].some((other) => other.initScripts.size > 0)) ctx.state.leases.delete("init");
  return new Result({ removed: wanted });
}

export const CLIPBOARD_PERMISSIONS = ["clipboardReadWrite", "clipboardSanitizedWrite"];

export async function cmdClipboard(ctx: Ctx, argv: string[]): Promise<Result> {
  const [, args] = parse(argv);
  need(args, 1, "clipboard read|write <text>|copy|paste");
  const page = await ctx.state.page();
  const action = args[0] as string;
  try {
    if (action === "copy" || action === "paste") {
      await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91, modifiers: 4 });
      try {
        await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: action === "copy" ? "c" : "v", modifiers: 4, commands: [action] });
      } finally {
        await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91 });
      }
      return new Result({ [action]: true });
    }
    const origin = (page.mainFrame === null ? undefined : page.frames.get(page.mainFrame)?.origin) ?? null;
    await ctx.state.browser?.send("Browser.grantPermissions", { origin, permissions: CLIPBOARD_PERMISSIONS });
    if (action === "read") {
      const text = await page.call("() => navigator.clipboard.readText()", [], { frame: page.mainFrame, timeout: EVAL_TIMEOUT });
      return new Result({ text }, String(text ?? ""), true);
    }
    if (action === "write") {
      need(args, 2, "clipboard write <text>");
      await page.call("(t) => navigator.clipboard.writeText(t)", [args.slice(1).join(" ")], { frame: page.mainFrame });
      return new Result({ written: true });
    }
  } catch (error) {
    if (error instanceof Gated) throw error.during(`clipboard ${action}`, action === "copy" || action === "paste" ? `the ${action} editing command` : null);
    throw error;
  }
  throw new Usage(`Unknown clipboard operation: ${action}`);
}

register("eval", cmdEval);
register("addinitscript", cmdAddInitScript);
register("removeinitscript", cmdRemoveInitScript);
register("clipboard", cmdClipboard);
