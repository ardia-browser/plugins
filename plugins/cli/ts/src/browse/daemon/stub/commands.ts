import path from "node:path";
import { formatG } from "../../../pylib/format.ts";
import { reprStr } from "../../../py.ts";
import { urlsplit, hostnameOf } from "../../../pylib/urllib.ts";
import { type Browser } from "../../cdp/browser.ts";
import { sleep } from "../../cdp/cancel.ts";
import { BrowseError, Gated, OutcomeUnknown, Usage } from "../../daemon-errors.ts";
import { DEFAULT_TIMEOUT_MS } from "../../limits.ts";
import { flag } from "../../metrics.ts";
import { Result, type Options } from "../render.ts";
import { type StubPage } from "./page.ts";
import { type StubState } from "./state.ts";

export const KNOWN_SCHEMES = ["http", "https", "about", "data", "file", "blob", "chrome", "view-source"];
const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?(\/|$)/u;
const DROPPED_CONNECTION = /ERR_(EMPTY_RESPONSE|CONNECTION_(RESET|CLOSED|REFUSED|TIMED_OUT)|TIMED_OUT|HTTP2_PROTOCOL_ERROR|SSL_PROTOCOL_ERROR|QUIC_PROTOCOL_ERROR)/u;
const FAILED_HOSTS_KEPT = 50;
const HTTPS_ONLY_NOTE =
  "Ardia loads http:// addresses over https and blocks the page when the site has no working https, which is what this " +
  "error usually means for an http:// address. Try the https:// address; if that fails too, say the site couldn't be reached";
export const LATER_SLICE = "isn't served by the TypeScript daemon yet (it arrives with a later slice of the port)";

export class Ctx {
  constructor(
    readonly state: StubState,
    readonly options: Options,
    readonly cwd: string,
    readonly env: Record<string, unknown>,
    readonly stdin: string | null,
    readonly command = "",
  ) {}

  get timeout(): number {
    return Number(this.options["timeout_ms"] || DEFAULT_TIMEOUT_MS) / 1000;
  }

  path(value: string): string {
    return path.resolve(this.cwd, value);
  }
}

export type Handler = (ctx: Ctx, argv: string[]) => Promise<Result>;
type Kind = "bool" | "value" | "multi";

export function parse(argv: string[], flags: Record<string, Kind> = {}, aliases: Record<string, string> = {}): [Record<string, unknown>, string[]] {
  const options: Record<string, unknown> = {};
  const positionals: string[] = [];
  let index = 0;
  while (index < argv.length) {
    const token = argv[index] as string;
    index += 1;
    if (token === "--") {
      positionals.push(...argv.slice(index));
      break;
    }
    const split = token.startsWith("--") && token.includes("=");
    let name = split ? token.slice(0, token.indexOf("=")) : token;
    let inline: string | null = split ? token.slice(token.indexOf("=") + 1) : null;
    name = Object.hasOwn(aliases, name) ? (aliases[name] as string) : name;
    if (Object.hasOwn(flags, name)) {
      const kind = flags[name] as Kind;
      const key = name.replace(/^-+/u, "").replaceAll("-", "_");
      if (kind === "bool") options[key] = true;
      else {
        if (inline === null) {
          if (index >= argv.length) throw new Usage(`${name} needs a value`);
          inline = argv[index] as string;
          index += 1;
        }
        if (kind === "multi") options[key] = [...((options[key] as string[] | undefined) ?? []), inline];
        else options[key] = inline;
      }
      continue;
    }
    if (token.startsWith("-") && token.length > 1 && !/^-\d/u.test(token)) throw new Usage(`Unknown flag: ${token}`);
    positionals.push(token);
  }
  return [options, positionals];
}

export function need(positionals: string[], count: number, usage: string): void {
  if (positionals.length < count) throw new Usage(`Usage: ardia browse ${usage}`);
}

export function normalizeUrl(given: string): string {
  const url = given.trim();
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/u.exec(url);
  if (match && KNOWN_SCHEMES.includes((match[1] as string).toLowerCase())) return url;
  if (LOOPBACK.test(url)) return `http://${url}`;
  return `https://${url}`;
}

export async function waitUntil<T>(check: () => Promise<T>, timeout: number, interval: number, what: string): Promise<T> {
  const deadline = performance.now() / 1000 + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (performance.now() / 1000 >= deadline) throw new BrowseError(`Timed out after ${formatG(timeout * 1000)}ms waiting for ${what}`, null, "timeout");
    await sleep(interval);
  }
}

export async function pageTitle(page: StubPage): Promise<string> {
  try {
    const title = await page.call("() => document.title", [], { frame: page.mainFrame, read: true });
    return typeof title === "string" ? title : title ? String(title) : "";
  } catch (error) {
    if (error instanceof BrowseError) return "";
    throw error;
  }
}

async function showsContent(page: StubPage, loader: string): Promise<boolean> {
  let ready: unknown;
  try {
    ready = await page.call("() => [document.readyState, (document.body && document.body.innerText || '').trim().length]", [], { frame: page.mainFrame, read: true });
  } catch (error) {
    if (error instanceof BrowseError) return false;
    throw error;
  }
  return page.loader(page.mainFrame) === loader && Array.isArray(ready) && ["interactive", "complete"].includes(ready[0]) && Number(ready[1]) > 0;
}

export async function waitForLoad(page: StubPage, loader: string | null, timeout: number, until = "load"): Promise<void> {
  const event = ({ load: "load", domcontentloaded: "DOMContentLoaded", networkidle: "networkIdle" } as Record<string, string>)[until] ?? until;
  const ready = async () => {
    const main = page.mainFrame;
    const current = main === null ? undefined : page.lifecycle.get(main);
    if (current && (loader === null || current.loader === loader) && current.names.has(event)) return true;
    if (event === "load" || event === "DOMContentLoaded") {
      let state: unknown;
      try {
        state = await page.call("() => document.readyState", [], { frame: main, read: true });
      } catch (error) {
        if (!(error instanceof BrowseError)) throw error;
        if (error.code === "tab_detached") await page.state.reattach(page);
        return false;
      }
      if (loader !== null && page.loader(main) !== loader) return false;
      return state === "complete" || (event === "DOMContentLoaded" && state === "interactive");
    }
    return false;
  };
  await waitUntil(ready, timeout, 0.05, `the page to reach ${until}`);
}

function failedNavigation(state: StubState, url: string, errorText: string): BrowseError {
  const host = hostnameOf(urlsplit(url).netloc) || url;
  let message = `Navigation to ${url} failed: ${errorText}`;
  if (DROPPED_CONNECTION.test(errorText)) {
    const failures = state.failedNavigations;
    const seen = (failures.get(host) ?? 0) + 1;
    failures.delete(host);
    failures.set(host, seen);
    while (failures.size > FAILED_HOSTS_KEPT) failures.delete(failures.keys().next().value as string);
    flag("navigation_dropped_hint", true);
    const again = seen > 1 ? ` (${seen} failures on ${host} in this session)` : "";
    message +=
      `. The site dropped the connection${again}; sites often do this to automated or foreign traffic, and the same URL ` +
      "rarely loads on a retry. Its other pages, `read --http <url>` or its public API may still answer; " +
      "if nothing does, say what couldn't be reached";
  } else if (errorText.includes("ERR_NAME_NOT_RESOLVED")) {
    message += `. ${host} has no address: check the spelling, or search for the site's current address`;
  } else if (errorText.includes("ERR_BLOCKED_BY_CLIENT") && url.toLowerCase().startsWith("http://")) {
    flag("navigation_https_only_hint", true);
    message += `. ${HTTPS_ONLY_NOTE}`;
  }
  return new BrowseError(message, null, "navigation_failed");
}

function siteSilent(url: string, timeout: number, error: OutcomeUnknown): BrowseError {
  if (!error.text.includes("didn't answer Page.navigate")) return error;
  flag("navigation_site_silent", true);
  const host = hostnameOf(urlsplit(url).netloc) || url;
  let advice = "Trying the same address again rarely helps; say the site couldn't be reached, or use another source";
  if (url.startsWith("https://")) advice += ", and if you changed the address from http:// to https://, use it as the site gave it";
  return new BrowseError(
    `${host} sent nothing back within ${formatG(timeout)} s, so ${url} never started loading: the site may be down, very slow, ` +
      `or not answering automated traffic. ${advice}`,
    null,
    "timeout",
  );
}

function sameDocument(page: StubPage, url: string): boolean {
  const current = page.url || "";
  return url.includes("#") && !current.startsWith("about:") && current.split("#")[0] === url.split("#")[0];
}

async function sendNavigate(ctx: Ctx, page: StubPage, url: string): Promise<Record<string, unknown>> {
  let result: Record<string, unknown>;
  try {
    result = await page.send("Page.navigate", { url }, { timeout: ctx.timeout });
  } catch (error) {
    if (error instanceof Gated) {
      throw new BrowseError(`Ardia's policy only lets the ardia command open web pages (http, https, data, about:blank); ${url} isn't one`, null, "policy_refused");
    }
    if (error instanceof OutcomeUnknown) throw siteSilent(url, ctx.timeout, error);
    throw error;
  }
  if (result["errorText"]) throw failedNavigation(ctx.state, url, String(result["errorText"]));
  return result;
}

export async function navigate(ctx: Ctx, page: StubPage, url: string, until = "load"): Promise<void> {
  if (page.crashed) throw new BrowseError(`Reloading a crashed tab ${LATER_SLICE}`, null, "unsupported");
  if (sameDocument(page, url)) throw new BrowseError(`A same-document navigation ${LATER_SLICE}`, null, "unsupported");
  const result = await sendNavigate(ctx, page, url);
  const loader = typeof result["loaderId"] === "string" && result["loaderId"] ? result["loaderId"] : null;
  ctx.state.loadNote = null;
  if (loader === null) throw new BrowseError(`A same-document navigation ${LATER_SLICE}`, null, "unsupported");
  try {
    await waitForLoad(page, loader, ctx.timeout, until);
  } catch (error) {
    if (!(error instanceof BrowseError) || error.code !== "timeout" || until !== "load" || !(await showsContent(page, loader))) throw error;
    flag("open_still_loading", true);
    ctx.state.loadNote =
      `The page hadn't finished loading after ${formatG(ctx.timeout)} s (something on it is still loading); ` +
      "its content so far is here, and `wait --load load` waits for the rest";
  }
  await ctx.state.reattach(page);
  await page.refreshFrames();
}

function refuseLater(what: string): never {
  throw new BrowseError(`${what} ${LATER_SLICE}`, null, "unsupported");
}

async function newTab(ctx: Ctx, url: string | null, label: string | null): Promise<StubPage> {
  const state = ctx.state;
  await state.connect();
  let result: Record<string, unknown>;
  try {
    result = await (state.browser as Browser).send("Target.createTarget", { url: "about:blank", background: true });
  } catch (error) {
    if (error instanceof Gated) throw new BrowseError(`Ardia's policy refused to open a tab for the ardia command (${error.refusal})`, null, "policy_refused");
    throw error;
  }
  const targetId = String(result["targetId"]);
  state.opened.add(targetId);
  state.registry.noteOpened(state.instance, targetId);
  if (!state.targetInfos.has(targetId)) state.targetInfos.set(targetId, { targetId, url: "about:blank", title: "", type: "page" });
  state.tabId(targetId);
  if (label) {
    if (state.labels.has(label)) throw new BrowseError(`The label ${label} is already used by another tab`);
    state.labels.set(label, targetId);
  }
  state.current = targetId;
  if (state.pinTab) state.pinnedTarget = targetId;
  const page = await state.page(targetId);
  if (url) await navigate(ctx, page, normalizeUrl(url));
  return page;
}

export async function cmdOpen(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, {
    "--enable": "multi",
    "--init-script": "multi",
    "--capture-console": "bool",
    "--headers": "value",
    "--label": "value",
    "--show": "bool",
    "--read": "bool",
  });
  if (options["headers"]) throw new Usage("ardia browse can't scope headers to an origin at launch; run `ardia browse set headers <json>` before `open`");
  if (options["enable"] || options["init_script"] || options["capture_console"] || (ctx.options["enable"] as unknown[] | undefined)?.length) refuseLater("`open` with page setup");
  if (options["show"] || ctx.options["show"] || ["1", "true", "yes", "on"].includes(String(ctx.env["AGENT_BROWSER_SHOW_TAB"] ?? "").toLowerCase())) refuseLater("`open --show`");
  if (options["read"]) refuseLater("`open --read`");
  const state = ctx.state;
  await state.connect();
  const url = args.length > 0 ? normalizeUrl(args[0] as string) : null;
  const freshTab = !(state.current && state.targetInfos.has(state.current));
  let page: StubPage;
  if (freshTab) page = await newTab(ctx, url, (options["label"] as string | undefined) ?? null);
  else {
    page = await state.page();
    if (url) await navigate(ctx, page, url);
  }
  page = await state.reattach(page);
  const background = freshTab ? await page.takesInput() : null;
  await page.refreshFrames();
  const title = await pageTitle(page);
  const data: Record<string, unknown> = { url: page.url, title };
  let text = `✓ ${title}\n  ${page.url}`;
  const stillLoading = state.loadNote;
  state.loadNote = null;
  if (stillLoading) {
    data["stillLoading"] = true;
    text += `\n${stillLoading}`;
  }
  if (background !== null) {
    const tab = state.tabId(page.targetId);
    Object.assign(data, { tabId: tab, background: true, takesInput: background });
    if (!background) {
      text += `\n→ Opened in its own background tab [${tab}]; this Ardia doesn't deliver input there. use: ardia browse tab ${tab} --show (or open <url> --show)`;
    }
  }
  return new Result(data, text);
}

export async function cmdGet(ctx: Ctx, argv: string[]): Promise<Result> {
  const [, args] = parse(argv);
  need(args, 1, "get text|html|value|attr|title|url|count|box|styles|cdp-url [selector]");
  const what = args[0] as string;
  if (what !== "title" && what !== "url") refuseLater(`\`get ${what}\``);
  const page = await ctx.state.page();
  if (what === "title") {
    const title = await pageTitle(page);
    return new Result({ title }, title, true);
  }
  await page.refreshFrames();
  return new Result({ url: page.url }, page.url);
}

function globMatch(pattern: string, url: string): boolean {
  if (pattern === url || (url.includes(pattern) && !pattern.includes("*"))) return true;
  let regex = "";
  for (let index = 0; index < pattern.length; ) {
    if (pattern.startsWith("**", index)) {
      regex += ".*";
      index += 2;
      continue;
    }
    const char = pattern[index] as string;
    regex += char === "*" ? "[^/]*" : char === "?" ? "." : char.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
    index += 1;
  }
  return new RegExp(`^(?:${regex})$`, "u").test(url);
}

export async function cmdWait(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(
    argv,
    { "--text": "value", "--url": "value", "--load": "value", "--fn": "value", "--state": "value", "--timeout": "value", "--download": "bool" },
    { "-t": "--text", "-u": "--url", "-l": "--load", "-f": "--fn" },
  );
  const timeout = options["timeout"] ? Number(options["timeout"]) / 1000 : ctx.timeout;
  if (options["download"]) refuseLater("`wait --download`");
  if (Object.keys(options).length === 0 && args.length > 0 && /^\d+(\.\d+)?$/u.test(args[0] as string)) {
    const ms = Number(args[0]);
    await sleep(ms / 1000);
    return new Result({ ms: Math.trunc(ms), waited: "timeout" });
  }
  if (options["fn"] !== undefined) refuseLater("`wait --fn`");
  const page = await ctx.state.page();
  if (options["text"] !== undefined) {
    const wanted = options["text"] as string;
    await waitUntil(
      () => page.call("(t) => !!document.body && document.body.innerText.includes(t)", [wanted], { frame: page.mainFrame, read: true }),
      timeout,
      0.1,
      `text ${reprStr(wanted)}`,
    );
    return new Result({ text: wanted, waited: "text" }, wanted);
  }
  if (options["url"] !== undefined) {
    const pattern = options["url"] as string;
    await waitUntil(
      async () => {
        await page.refreshFrames();
        return globMatch(pattern, page.url);
      },
      timeout,
      0.1,
      `the URL to match ${pattern}`,
    );
    return new Result({ url: page.url, waited: "url" }, page.url);
  }
  if (options["load"] !== undefined) {
    const until = options["load"] as string;
    if (!["load", "domcontentloaded", "networkidle"].includes(until)) throw new Usage("--load takes load, domcontentloaded or networkidle");
    await page.refreshFrames();
    await waitForLoad(page, page.loader(page.mainFrame), timeout, until);
    return new Result({ state: until });
  }
  need(args, 1, "wait <selector|ms> | --text | --url | --load | --fn");
  refuseLater("`wait <selector>`");
}

export async function cmdSession(ctx: Ctx, argv: string[]): Promise<Result> {
  const [, args] = parse(argv, { "--json": "bool" });
  const state = ctx.state;
  if (args[0] === "info") {
    return new Result({
      session: state.session,
      connected: state.connected,
      tabs: state.opened.size,
      current: state.current ? state.tabId(state.current) : null,
      refs: 0,
      captures: [...state.leases].sort(),
    });
  }
  return new Result({ session: state.session }, state.session);
}

export const COMMANDS: Readonly<Record<string, Handler>> = { open: cmdOpen, get: cmdGet, wait: cmdWait, session: cmdSession };
