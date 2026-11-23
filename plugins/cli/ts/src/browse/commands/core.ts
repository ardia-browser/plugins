import { formatG } from "../../pylib/format.ts";
import { reprStr } from "../../py.ts";
import { hostnameOf, urlsplit } from "../../pylib/urllib.ts";
import { type Browser } from "../cdp/browser.ts";
import { Cancelled, shield, sleep, untilCancelled } from "../cdp/cancel.ts";
import * as temptabs from "../state/temptabs.ts";
import { BrowseError, CdpError, ConnectionLost, Gated, OutcomeUnknown, Usage } from "../daemon-errors.ts";
import { envelopeGone } from "../cdp/raw.ts";
import { Result } from "../daemon/render.ts";
import { flag } from "../metrics.ts";
import { detachedError, type Page, quiet } from "../state/page.ts";
import { type State } from "../state/state.ts";
import { monotonic, waitUntil } from "../state/wait.ts";
import { afterSameDocument, beforeNavigating } from "../read/settle.ts";
import { arrival, attach, settled } from "../changes/observe.ts";
import { type Ctx } from "./ctx.ts";
import { register } from "./index.ts";
import { cmdRead } from "./read-page.ts";
import { type Flags, need, normalizeUrl, type Parsed, parse } from "./parse.ts";
import { applyOpenOptions, takeOpenOptions } from "./setup.ts";

const DROPPED_CONNECTION = /ERR_(EMPTY_RESPONSE|CONNECTION_(RESET|CLOSED|REFUSED|TIMED_OUT)|TIMED_OUT|HTTP2_PROTOCOL_ERROR|SSL_PROTOCOL_ERROR|QUIC_PROTOCOL_ERROR)/u;
const FAILED_HOSTS_KEPT = 50;
const SHOWN_HOLD = 0.3;
export const HTTPS_ONLY_NOTE =
  "Ardia loads http:// addresses over https and blocks the page when the site has no working https, which is what this " +
  "error usually means for an http:// address. Try the https:// address; if that fails too, say the site couldn't be reached";

export async function pageTitle(page: Page): Promise<string> {
  try {
    const title = await page.call("() => document.title", [], { frame: page.mainFrame, read: true });
    return typeof title === "string" ? title : title ? String(title) : "";
  } catch (error) {
    if (quiet(error)) return "";
    throw error;
  }
}

export async function waitForLoad(page: Page, loader: string | null, timeout: number, until = "load"): Promise<void> {
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
        if (!quiet(error)) throw error;
        if ((error as BrowseError).code === "tab_detached") await page.state.reattach(page);
        return false;
      }
      if (loader !== null && page.loader(main) !== loader) return false;
      return state === "complete" || (event === "DOMContentLoaded" && state === "interactive");
    }
    return false;
  };
  await waitUntil(ready, timeout, 0.05, `the page to reach ${until}`);
}

async function showsContent(page: Page, loader: string): Promise<boolean> {
  let ready: unknown;
  try {
    ready = await page.call("() => [document.readyState, (document.body && document.body.innerText || '').trim().length]", [], { frame: page.mainFrame, read: true });
  } catch (error) {
    if (quiet(error)) return false;
    throw error;
  }
  return page.loader(page.mainFrame) === loader && Array.isArray(ready) && ["interactive", "complete"].includes(ready[0]) && Number(ready[1]) > 0;
}

export const AD_BLOCKER_NOTE =
  'If Ardia\'s ad blocker stopped it (the tab shows uBlock Origin\'s "Page blocked" page, which names the blocked ' +
  "host), `ardia call sites.allowAds -p site=<that host>` trusts the site, where Ardia offers that method " +
  "(`ardia methods` lists it); then open the page again";

function failedNavigation(state: State, url: string, errorText: string): BrowseError {
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
  } else if (errorText.includes("ERR_BLOCKED_BY_CLIENT") || errorText.includes("ERR_ABORTED")) {
    message += `. ${AD_BLOCKER_NOTE}`;
  }
  return new BrowseError(message, null, "navigation_failed");
}

export function siteSilent(url: string, timeout: number, error: OutcomeUnknown): BrowseError {
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

function sessionGone(error: unknown): boolean {
  if (error instanceof BrowseError && error.code === "tab_detached") return true;
  return error instanceof CdpError && envelopeGone(error);
}

export class NavigationRefused extends BrowseError {
  constructor(readonly refusal: Gated) {
    super(refusal.text, refusal.data, refusal.code);
  }
}

function canonical(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

async function ownNavigation(page: Page, url: string, seen: string | null): Promise<string | null> {
  await page.refreshFrames();
  const loader = page.loader(page.mainFrame);
  if (loader === null || loader === seen) return null;
  const landed = canonical(page.url);
  if (landed === canonical(url)) return loader;
  let history: Record<string, unknown>;
  try {
    history = await page.send("Page.getNavigationHistory");
  } catch (error) {
    if (!(error instanceof CdpError)) throw error;
    return null;
  }
  const entries = Array.isArray(history["entries"]) ? (history["entries"] as Record<string, unknown>[]) : [];
  const current = entries[Number(history["currentIndex"])];
  if (current === undefined || current["transitionType"] !== "typed") return null;
  if (canonical(String(current["url"] || "")) !== landed || canonical(String(current["userTypedURL"] || "")) !== canonical(url)) return null;
  await page.refreshFrames();
  return page.loader(page.mainFrame) === loader && canonical(page.url) === landed ? loader : null;
}

export function navigationUnchecked(url: string): string {
  return `Ardia detached the tab before it answered Page.navigate for ${url}, and the tab couldn't be checked afterwards to see whether the page loaded`;
}

export async function startNavigation(page: Page, url: string, timeout: number): Promise<Record<string, unknown>> {
  for (let resent = false; ; resent = true) {
    await page.state.reattach(page, url);
    const session = page.session;
    const seen = page.loader(page.mainFrame);
    try {
      const result = await page.send("Page.navigate", { url }, { timeout });
      page.navigationsSent += 1;
      return result;
    } catch (error) {
      if (sessionGone(error)) {
        if (session !== null) page.endSession(session);
        if (!resent) continue;
        throw detachedError(url);
      }
      page.navigationsSent += 1;
      if (error instanceof Gated) throw new NavigationRefused(error);
      if (!(error instanceof OutcomeUnknown) || page.session !== null) throw error;
      let loader: string | null;
      try {
        await page.state.reattach(page, url);
        loader = await ownNavigation(page, url, seen);
      } catch (failure) {
        if (!(failure instanceof BrowseError) || failure instanceof ConnectionLost || failure instanceof OutcomeUnknown) throw failure;
        throw new OutcomeUnknown("`Page.navigate`", navigationUnchecked(url));
      }
      if (loader === null) throw error;
      return { loaderId: loader };
    }
  }
}

async function sendNavigate(ctx: Ctx, page: Page, url: string): Promise<Record<string, unknown>> {
  let result: Record<string, unknown>;
  try {
    result = await startNavigation(page, url, ctx.timeout);
  } catch (error) {
    if (error instanceof NavigationRefused) {
      throw new BrowseError(`Ardia's policy only lets the ardia command open web pages (http, https, data, about:blank); ${url} isn't one`, null, "policy_refused");
    }
    if (error instanceof OutcomeUnknown) throw siteSilent(url, ctx.timeout, error);
    throw error;
  }
  if (result["errorText"]) throw failedNavigation(ctx.state, url, String(result["errorText"]));
  return result;
}

export async function navigate(ctx: Ctx, page: Page, url: string, until = "load"): Promise<void> {
  await ctx.state.reattach(page, url);
  if (page.crashed) {
    await sendNavigate(ctx, page, url);
    await page.recovered(ctx.timeout);
    return;
  }
  const before = await beforeNavigating(page, url);
  const result = await sendNavigate(ctx, page, url);
  const loader = typeof result["loaderId"] === "string" && result["loaderId"] ? result["loaderId"] : null;
  ctx.state.loadNote = null;
  if (loader === null) await afterSameDocument(page, before, monotonic() + ctx.timeout);
  else {
    try {
      await waitForLoad(page, loader, ctx.timeout, until);
    } catch (error) {
      if (!(error instanceof BrowseError) || error.code !== "timeout" || until !== "load" || !(await showsContent(page, loader))) throw error;
      flag("open_still_loading", true);
      ctx.state.loadNote =
        `The page hadn't finished loading after ${formatG(ctx.timeout)} s (something on it is still loading); ` +
        "its content so far is here, and `wait --load load` waits for the rest";
    }
  }
  await ctx.state.reattach(page, url);
  await page.refreshFrames();
}

export function wantsShow(ctx: Ctx, options: Record<string, unknown>): boolean {
  return Boolean(options["show"] || ctx.options["show"] || ["1", "true", "yes", "on"].includes(String(ctx.env["AGENT_BROWSER_SHOW_TAB"] || "").toLowerCase()));
}

export async function newTab(
  ctx: Ctx,
  url: string | null,
  label: string | null = null,
  window = false,
  show = false,
  abandoned: ((targetId: string) => void) | null = null,
): Promise<Page> {
  const state = ctx.state;
  await state.connect();
  const params: Record<string, unknown> = { url: "about:blank", background: true };
  if (window) params["newWindow"] = true;
  let result: Record<string, unknown>;
  try {
    if (abandoned === null) result = await (state.browser as Browser).send("Target.createTarget", params);
    else {
      const creating = (state.browser as Browser).send("Target.createTarget", params, { signal: null });
      try {
        result = await untilCancelled(creating);
      } catch (error) {
        if (error instanceof Cancelled) {
          creating.then(
            (late) => {
              if (typeof late["targetId"] === "string") abandoned(late["targetId"]);
            },
            () => {},
          );
        }
        throw error;
      }
    }
  } catch (error) {
    if (error instanceof Gated) throw new BrowseError(`Ardia's policy refused to open a tab for the ardia command (${error.refusal})`, null, "policy_refused");
    throw error;
  }
  const targetId = String(result["targetId"]);
  state.opened.add(targetId);
  state.registry.noteOpened(state.instance, targetId);
  if (!state.targetInfos.has(targetId)) state.targetInfos.set(targetId, { targetId, url: "about:blank", title: "", type: "page" });
  state.pairOpenedLater(targetId);
  state.tabId(targetId);
  if (label) {
    if (state.labels.has(label)) throw new BrowseError(`The label ${label} is already used by another tab`);
    state.labels.set(label, targetId);
  }
  state.current = targetId;
  if (state.pinTab) state.pinnedTarget = targetId;
  let page = await state.page(targetId);
  await applyOpenOptions(ctx, page);
  if (url) await navigate(ctx, page, normalizeUrl(url));
  if (show) page = await showTab(ctx, page);
  return page;
}

export async function engineOffscreen(state: State, targetId: string): Promise<boolean> {
  if (state.offscreen.has(targetId)) return true;
  if (state.endpoint === null || state.endpoint.explicit || state.browser === null) return false;
  let info: Record<string, unknown>;
  try {
    info = (await state.browser.send("Target.getTargetInfo", { targetId }))["targetInfo"] as Record<string, unknown>;
  } catch (error) {
    if (quiet(error)) return false;
    throw error;
  }
  if (info && typeof info === "object" && info["ardiaOffscreen"] === true) {
    state.setOffscreen(targetId, true);
    return true;
  }
  return false;
}

export async function leaveOffscreen(ctx: Ctx, page: Page): Promise<Page> {
  const state = ctx.state;
  const old = page.targetId;
  const known = page.url || String(state.targetInfos.get(old)?.["url"] ?? "");
  const url = known && !known.startsWith("about:") ? known : null;
  const label = [...state.labels].find(([, owner]) => owner === old)?.[0] ?? null;
  if (label) state.labels.delete(label);
  const openedBefore = new Set(state.opened);
  const pinned = state.pinnedTarget;
  let fresh: Page;
  try {
    fresh = await newTab(ctx, null, label, false, false, (late) => temptabs.mustClose(state, late, true));
    if (url) await navigate(ctx, fresh, normalizeUrl(url));
  } catch (error) {
    try {
      await shield(() => putBack(state, old, label, pinned, [...state.opened].filter((target) => !openedBefore.has(target))));
    } catch (closing) {
      if (error instanceof Error && error.cause === undefined) Object.defineProperty(error, "cause", { value: closing, configurable: true, writable: true });
    }
    throw error;
  }
  state.setOffscreen(old, false);
  if (state.registry.reserveClose(state.instance, old)) {
    try {
      await (state.browser as Browser).send("Target.closeTarget", { targetId: old });
      state.closedOpenedTab(old);
    } catch (error) {
      if (!quiet(error)) throw error;
    } finally {
      state.registry.finishClose(state.instance, old);
    }
  }
  state.forgetTarget(old);
  state.leftOffscreen = state.tabId(fresh.targetId);
  return fresh;
}

async function putBack(state: State, old: string, label: string | null, pinned: string | null, made: string[]): Promise<void> {
  state.current = old;
  if (state.pinTab) state.pinnedTarget = pinned;
  if (label) state.labels.set(label, old);
  let closedAll = true;
  let failure: unknown = null;
  for (const target of made) {
    const outcome = await temptabs.closeReserved(state, target);
    if (outcome.closed) {
      state.forgetTarget(target);
      continue;
    }
    closedAll = false;
    if (outcome.error !== null) failure ??= outcome.error;
    temptabs.mustClose(state, target, true);
  }
  if (closedAll) flag("offscreen_handoff_rolled_back", true);
  if (failure !== null) throw failure;
}

export function offscreenNote(state: State): string {
  const tab = state.leftOffscreen;
  state.leftOffscreen = null;
  return tab ? `\n→ The viewport ended and the page was reloaded in a new tab [${tab}]: Ardia never shows an emulated page` : "";
}

async function tabShown(state: State, page: Page): Promise<boolean | null> {
  let infos: unknown;
  try {
    infos = (await (state.browser as Browser).send("Target.getTargets", { filter: [{ type: "tab" }] }))["targetInfos"];
  } catch (error) {
    if (quiet(error)) return null;
    throw error;
  }
  await page.refreshFrames();
  const same = (Array.isArray(infos) ? infos : []).filter(
    (info) => info?.["type"] === "tab" && info?.["url"] === page.url && info?.["embedderData"] !== null && typeof info?.["embedderData"] === "object" && !Array.isArray(info["embedderData"]),
  );
  return same.length === 1 ? Boolean(same[0]["embedderData"]["tabActive"]) : null;
}

export async function showTab(ctx: Ctx, given: Page, handOff = true): Promise<Page> {
  let page = given;
  if (await engineOffscreen(ctx.state, page.targetId)) {
    if (!handOff) throw new Usage(OPEN_HERE_OFFSCREEN);
    page = await leaveOffscreen(ctx, page);
  }
  const now = () => performance.now() / 1000;
  const deadline = now() + 5;
  let nudge = 0;
  let shownSince: number | null = null;
  for (;;) {
    if (now() >= nudge) {
      await (ctx.state.browser as Browser).send("Target.activateTarget", { targetId: page.targetId });
      nudge = now() + 1;
    }
    if (!(await page.hidden()) && (await tabShown(ctx.state, page)) !== false) {
      shownSince = shownSince ?? now();
      if (now() - shownSince >= SHOWN_HOLD) return page;
    } else {
      shownSince = null;
      nudge = Math.min(nudge, now() + 0.2);
    }
    if (now() >= deadline) throw new BrowseError("Ardia didn't show the tab; switch to it in Ardia, or try `ardia browse tab <id> --show` again");
    await sleep(0.1);
  }
}

export const OPEN_HERE_WITHOUT_TAB = "open --here navigates the tab you picked with `tab active`, and this session hasn't picked one: run `ardia browse tab active` first, or drop --here to open a tab of its own";

function knownTitle(state: Ctx["state"], page: Page): string {
  const view = state.views.get(page.targetId) as { title?: unknown; url?: unknown; loader?: unknown } | undefined;
  if (typeof view?.title === "string" && view.title && view.url === page.url && view.loader === page.loader(page.mainFrame)) return view.title;
  const info = state.targetInfos.get(page.targetId) as { title?: unknown; url?: unknown } | undefined;
  return typeof info?.title === "string" && info.url === page.url ? info.title : "";
}

export const OPEN_HERE_WITHOUT_URL = "open --here takes the URL to load in the tab you picked with `tab active`";
export const OPEN_HERE_SETUP = "open --here doesn't add init scripts or devtools to the tab you picked with `tab active`; drop --enable and --init-script";
export const OPEN_HERE_OFFSCREEN = "open --here --show would take the tab you picked out of its off-screen viewport; drop --show";
const OPEN_FLAGS: Flags = {
  "--enable": "multi",
  "--init-script": "multi",
  "--capture-console": "bool",
  "--headers": "value",
  "--label": "value",
  "--show": "bool",
  "--read": "bool",
  "--here": "bool",
};

export async function cmdOpen(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, OPEN_FLAGS);
  if (!options["here"]) return openTab(ctx, options, args, null);
  const setup = [options["enable"], options["init_script"], ctx.options["enable"], ctx.options["init_script"], ctx.options["init_scripts"]];
  if (setup.some((value) => (Array.isArray(value) ? value.length > 0 : Boolean(value)))) throw new Usage(OPEN_HERE_SETUP);
  if (args.length === 0) throw new Usage(OPEN_HERE_WITHOUT_URL);
  const state = ctx.state;
  await state.connect();
  const target = state.attached;
  if (target === null || !state.targetInfos.has(target)) throw new Usage(OPEN_HERE_WITHOUT_TAB);
  if (wantsShow(ctx, options) && (await engineOffscreen(state, target))) throw new Usage(OPEN_HERE_OFFSCREEN);
  return openTab(ctx, options, args, target);
}

async function openTab(ctx: Ctx, options: Parsed, args: string[], here: string | null): Promise<Result> {
  if (options["headers"]) throw new Usage("ardia browse can't scope headers to an origin at launch; run `ardia browse set headers <json>` before `open`");
  takeOpenOptions(ctx, options);
  const state = ctx.state;
  await state.connect();
  const url = args.length > 0 ? normalizeUrl(args[0] as string) : null;
  const show = wantsShow(ctx, options);
  const reporting = Boolean(url) && !ctx.options["no_changes"] && state.topCommand !== "script" && !options["read"];
  if (here !== null) {
    if (!state.targetInfos.has(here)) throw new Usage(OPEN_HERE_WITHOUT_TAB);
    flag("open_here", true);
  }
  const borrowed = here === null && state.current && state.current === state.attached ? state.attached : null;
  const freshTab = here === null && !(state.current && state.targetInfos.has(state.current) && !borrowed);
  let cameFrom = "about:blank";
  let replacedFrom: [Set<string>, string] | null = null;
  let page: Page;
  if (freshTab) page = await newTab(ctx, reporting ? null : url, (options["label"] as string | undefined) ?? null, false, show && !reporting);
  else {
    page = here !== null ? await state.page(here) : await state.page();
    cameFrom = page.url;
    if (url) replacedFrom = [state.documentsOf(page), knownTitle(state, page) || page.url];
    if (page.crashed && url) {
      await navigate(ctx, page, "about:blank");
      cameFrom = "about:blank";
    }
    await applyOpenOptions(ctx, page);
  }
  const target = page;
  if (reporting) await settled(target, () => navigate(ctx, target, url as string));
  else if (url && !freshTab) await navigate(ctx, page, url);
  page = await state.reattach(page);
  if (here !== null) {
    state.current = here;
    if (state.pinTab) state.pinnedTarget = here;
  }
  if (show && (reporting || !freshTab)) page = await showTab(ctx, page, here === null);
  const background = freshTab && !show ? await page.takesInput() : null;
  await page.refreshFrames();
  const title = await pageTitle(page);
  if (replacedFrom !== null) state.noteOpenReplaced(page, replacedFrom[0], replacedFrom[1], title || page.url);
  const data: Record<string, unknown> = { url: page.url, title };
  let text = `✓ ${title}\n  ${page.url}${offscreenNote(state)}`;
  const stillLoading = state.loadNote;
  state.loadNote = null;
  if (stillLoading) {
    data["stillLoading"] = true;
    text += `\n${stillLoading}`;
  }
  if (background !== null) {
    const tab = state.tabId(page.targetId);
    Object.assign(data, { tabId: tab, background: true, takesInput: background });
    if (borrowed) {
      const left = state.tabId(borrowed);
      data["left"] = left;
      flag("open_moved_tab", true);
      text =
        `→ Opened in a new background tab [${tab}]; the tab you picked with \`tab active\` [${left}] is unchanged ` +
        `(\`open --here <url>\` navigates it, \`tab ${left}\` goes back)\n${text}`;
    }
    if (!background) {
      text += `\n→ Opened in its own background tab [${tab}]; this Ardia doesn't deliver input there. use: ardia browse tab ${tab} --show (or open <url> --show)`;
    }
  }
  if (options["read"]) {
    flag("open_read", true);
    if (here !== null && (state.current !== here || !state.targetInfos.has(here))) throw new BrowseError("The tab you picked closed before it could be read", { targetId: here }, "tab_gone");
    const read = await cmdRead(ctx, []);
    data["read"] = read.data;
    return new Result(data, `${text}\n\n${read.text}`, true);
  }
  const result = new Result(data, text);
  if (reporting) {
    const report = await arrival(ctx, page, cameFrom);
    if (report !== null) return attach(result, report);
  }
  return result;
}

export function globMatch(pattern: string, url: string): boolean {
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

export async function cmdSession(ctx: Ctx, argv: string[]): Promise<Result> {
  const [, args] = parse(argv, { "--json": "bool" });
  const state = ctx.state;
  if (args[0] === "info") {
    return new Result({
      session: state.session,
      connected: state.connected,
      tabs: state.opened.size,
      current: state.current ? state.tabId(state.current) : null,
      refs: state.refs.size,
      captures: [...state.leases].sort(),
    });
  }
  return new Result({ session: state.session }, state.session);
}

register("open", cmdOpen);
register("session", cmdSession);
