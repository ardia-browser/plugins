import { type Value } from "../../json.ts";
import { plainParams, pyLoads } from "../cdp/params.ts";
import { borrowedTab } from "../commands/borrowed.ts";
import { waitForLoad } from "../commands/core.ts";
import type { Ctx } from "../commands/ctx.ts";
import { BrowseError, Gated, OutcomeUnknown, Usage } from "../daemon-errors.ts";
import { Result } from "../daemon/render.ts";
import * as flowurl from "../flowurl.ts";
import { FLOWRUN_FETCH } from "../js/index.ts";
import { secondsOf } from "../limits.ts";
import { count, flag } from "../metrics.ts";
import { renderJson } from "../script/render.ts";
import * as shaping from "../shape.ts";
import { Page } from "../state/page.ts";
import * as temptabs from "../state/temptabs.ts";
import { monotonic } from "../state/wait.ts";
import { extractEmbedded, type Spec } from "./flowlog.ts";
import { drift, fillUrl, headerOk, type Json, listGone, outputRequest, parseParams, save } from "./flows.ts";
import { Ctx as CommandCtx } from "../commands/ctx.ts";
import { handlerOf, hooks } from "../commands/index.ts";
import { addEpisodes } from "./episodes.ts";
import { fixtureFiles, lostFields, shapeDrift, writeFixture } from "./fixture.ts";
import { type Driver, replay, type ReplayStep } from "./replay.ts";

export const RUN_TIMEOUT = 60.0;
export const BODY_LIMIT = 8 * 1024 * 1024;
export const CHALLENGE_SCAN = 20000;
export const CHALLENGE =
  /just a moment|attention required|verify (that )?you are (a )?human|are you a robot|press (&|and) hold|captcha|human verification|security check|access denied|unusual traffic|request blocked|bot detection/iu;
const DRIVE = "Drive the page yourself (open, click, read) for this task";
const LOAD_GRACE = 2.0;

type Outcome = { kind: "ok"; value: Value } | { kind: "stop"; error: BrowseError; drift?: string };
type Answer = Record<string, unknown>;

export type Reader = {
  open: (ctx: Ctx, opened: string[]) => Promise<Page>;
  goto: (ctx: Ctx, page: Page, url: string, timeout: number) => Promise<unknown>;
};

async function openReader(ctx: Ctx, opened: string[]): Promise<Page> {
  const state = ctx.state;
  const targetId = await temptabs.create(state, opened);
  if (!state.targetInfos.has(targetId)) state.targetInfos.set(targetId, { targetId, url: "about:blank", title: "", type: "page" });
  const page = new Page(state, targetId);
  state.pages.set(targetId, page);
  await page.attach(state.browser as NonNullable<typeof state.browser>);
  await page.keepAwake();
  await page.enableNetwork();
  return page;
}

async function gotoPage(ctx: Ctx, page: Page, url: string, timeout: number): Promise<void> {
  const deadline = monotonic() + timeout;
  let result: Record<string, unknown>;
  try {
    result = await page.send("Page.navigate", { url }, { timeout });
  } catch (error) {
    if (error instanceof Gated) throw new BrowseError(`Ardia's policy only lets the ardia command open web pages; ${url} isn't one`, null, "policy_refused");
    throw error;
  }
  if (result["errorText"]) throw new BrowseError(`couldn't load it: ${String(result["errorText"])}`, null, "navigation_failed");
  const loader = typeof result["loaderId"] === "string" && result["loaderId"] ? result["loaderId"] : null;
  if (loader !== null) {
    await waitForLoad(page, loader, Math.max(deadline - monotonic(), 0.1), "domcontentloaded");
    try {
      await waitForLoad(page, loader, Math.min(LOAD_GRACE, Math.max(deadline - monotonic(), 0.1)), "load");
    } catch (error) {
      if (!(error instanceof BrowseError)) throw error;
    }
  }
  await page.refreshFrames();
}

export const reader: Reader = { open: openReader, goto: gotoPage };

function resolveParams(flow: Json, given: Record<string, string>, replaying = true): Record<string, string> {
  const known = new Map<string, Json>(flow["params"].map((param: Json) => [param["name"], param]));
  const unknown = Object.keys(given).filter((name) => !known.has(name));
  if (unknown.length > 0) throw new Usage(`${flow["name"]} has no param ${unknown.join(", ")}; its params are: ${[...known.keys()].join(", ") || "none"}`);
  const values: Record<string, string> = Object.create(null);
  for (const [name, param] of known) if (param["example"] !== null && param["example"] !== undefined) values[name] = param["example"];
  Object.assign(values, given);
  const missing = [...known.keys()].filter((name) => !Object.hasOwn(values, name) && (replaying || known.get(name)?.["source"] !== "secret"));
  if (missing.length > 0) {
    throw new Usage(`${flow["name"]} needs ${missing.map((name) => `--param ${name}=…`).join(" ")} (no recorded value is kept for typed text)`);
  }
  return values;
}

function challenge(text: unknown): boolean {
  return typeof text === "string" && text !== "" && CHALLENGE.test([...text].slice(0, CHALLENGE_SCAN).join(""));
}

function parsed(request: Json, text: unknown): Value | null {
  if (typeof text !== "string") return null;
  if (request["kind"] === "document") {
    const spec = request["expect"]["extract"] as Spec | undefined;
    return spec && Object.keys(spec).length > 0 ? extractEmbedded(text, spec) : null;
  }
  let value: Value;
  try {
    value = pyLoads(text);
  } catch {
    return null;
  }
  return value instanceof Map || Array.isArray(value) ? value : null;
}

function failed(message: string, code: string, data: Record<string, unknown> | null = null): Outcome {
  return { kind: "stop", error: new BrowseError(`${message}. ${DRIVE}`, data, code) };
}

function classify(flow: Json, request: Json, answer: Answer): Outcome {
  const status = typeof answer["status"] === "number" ? answer["status"] : null;
  if (answer["error"]) return failed(`The flow's request failed in the page (${String(answer["error"])})`, "fetch_failed");
  if (answer["type"] === "opaqueredirect" || (status && status >= 300 && status < 400)) {
    return failed("The flow's request was redirected (the site may want a sign-in, or the endpoint moved), and a flow never follows a redirect", "redirected");
  }
  if (status === 401 || status === 403) {
    if (request["strippedAuth"]) return failed(`HTTP ${status}: the recording sent a credential header a flow never keeps`, "credential_not_sendable", { httpStatus: status });
    return failed(`HTTP ${status}: the session is signed out of ${flow["site"]} or lacks access. Sign in again in Ardia and rerun`, "auth_expired", { httpStatus: status });
  }
  if (status === 429) {
    return failed(`HTTP 429: ${flow["site"]} is rate limiting this session; wait before running it again`, "rate_limited", { httpStatus: 429, retryAfter: answer["retryAfter"] ?? null });
  }
  const html = String(answer["mime"] || "").toLowerCase().includes("html");
  if (html && challenge(answer["text"])) return failed(`${flow["site"]} answered with a bot check instead of data; let the user clear it`, "blocked", { httpStatus: status });
  if (!status || !(status >= 200 && status < 300)) return failed(`HTTP ${status === null ? "None" : status} for GET ${flowurl.mask(request["url"])}`, "http_error", { httpStatus: status });
  if (answer["text"] === null || answer["text"] === undefined) return failed("The flow's answer was too large to read", "answer_too_large");
  const value = parsed(request, answer["text"]);
  let changed = value === null ? "the answer isn't the recorded JSON any more" : drift(request["expect"]["signature"], value);
  if (changed === null && listGone(request["expect"]["list"], value as Value)) changed = `the list ${request["expect"]["list"]} is gone`;
  if (changed) {
    const drifts = value === null ? [changed] : shapeDrift(request["expect"], value);
    const outcome = failed(`${flow["name"]} drifted: ${changed}. Save the flow again after doing the task in the page`, "drifted", { drift: changed, drifts });
    return { ...(outcome as { kind: "stop"; error: BrowseError }), drift: changed };
  }
  return { kind: "ok", value: value as Value };
}

function originOf(url: string): string | null {
  try {
    return flowurl.parse(url).origin;
  } catch (error) {
    if (error instanceof flowurl.Unsafe) return null;
    throw error;
  }
}

async function pageTier(ctx: Ctx, flow: Json, values: Record<string, string>, url: string, headers: Json, deadline: number): Promise<Answer> {
  const state = ctx.state;
  await state.connect();
  const target = flowurl.parse(url).origin;
  const start = fillUrl(flow["startUrl"], values);
  const home = flowurl.parse(start).origin;
  const current = state.current ? (state.pages.get(state.current) ?? null) : null;
  const opened: string[] = [];
  try {
    const own = current !== null && state.opened.has(current.targetId) && borrowedTab(state) !== current.targetId;
    let page: Page;
    if (own && current.sessionId && [target, home].includes(originOf(current.url) as string)) page = current;
    else {
      await temptabs.sweep(state);
      page = await reader.open(ctx, opened);
      await reader.goto(ctx, page, start, Math.max(deadline - monotonic(), 1.0));
      if (!flow["hosts"].includes(originOf(page.url))) return { landed: flowurl.hostLabel(page.url) };
    }
    const remaining = Math.max(deadline - monotonic(), 1.0);
    const sent: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) if (key === "accept" && headerOk(key, value)) sent[key] = value as string;
    let answer: unknown;
    try {
      answer = await page.call(FLOWRUN_FETCH, [url, sent, Math.trunc(remaining * 1000), BODY_LIMIT], { frame: page.mainFrame, read: false, timeout: remaining + 5 });
    } catch (error) {
      if (error instanceof OutcomeUnknown) return { interrupted: true };
      if (error instanceof BrowseError && ["document_changed", "page_navigated", "tab_detached"].includes(error.code ?? "")) return { interrupted: true };
      throw error;
    }
    return (answer as Answer | null) || { error: "no answer from the page" };
  } finally {
    if (opened.length > 0) await temptabs.release(state, opened);
  }
}

function mark(root: string, flow: Json, verified: boolean): void {
  if (Boolean(flow["verified"] ?? true) === verified) return;
  flow["verified"] = verified;
  try {
    save(root, flow);
  } catch (error) {
    if (!(error instanceof BrowseError)) throw error;
  }
}

function runText(flow: Json, shaped: Value): string {
  const map = shaped as Map<string, Value>;
  const items = map.get("items");
  if (items === null || items === undefined) return `✓ ${flow["name"]}\n${renderJson(map.get("value"))}`;
  const list = map.get("list");
  const where = list ? ` in ${String(list)}` : "";
  const total = map.get("total");
  const matched = map.get("matched");
  const shown = (items as Value[]).length;
  const counted = matched !== total ? `${shown} of ${String(matched)} matching` : `${shown} of ${String(total)}`;
  return `✓ ${flow["name"]}: ${counted} items${where}\n` + (shown > 0 ? renderJson(items) : "(no items)");
}

function liveDriver(ctx: Ctx): Driver {
  const quiet = (name: string) => new CommandCtx(ctx.state, { ...ctx.options, settle_only: true }, ctx.cwd, ctx.env, ctx.stdin, name);
  return {
    run: async (argv) => {
      const [name, ...rest] = argv as [string, ...string[]];
      const handler = handlerOf(name);
      if (handler === undefined) throw new Usage(`A flow step ran ${name}, which ardia browse doesn't have`);
      const stepCtx = quiet(name);
      if (hooks.before) await hooks.before(stepCtx, name, rest);
      await handler(stepCtx, rest);
    },
    snapshot: async () => {
      const handler = handlerOf("snapshot");
      if (handler === undefined) return "";
      return String((await handler(quiet("snapshot"), ["-i"])).text ?? "");
    },
    url: () => {
      const page = ctx.state.current ? (ctx.state.pages.get(ctx.state.current) ?? null) : null;
      return page ? flowurl.mask(page.url) : "";
    },
  };
}

export const driver: { live: (ctx: Ctx) => Driver } = { live: liveDriver };

export async function replayFlow(ctx: Ctx, root: string, flow: Json, values: Record<string, string>): Promise<Result> {
  const secrets = flow["params"].filter((param: Json) => param["source"] === "secret").map((param: Json) => values[param["name"]] ?? "").filter((value: string) => value);
  const steps: ReplayStep[] = flow["steps"].map((step: Json) => ({ seq: step["seq"], action: step["action"] ?? null, command: step["command"] ?? null }));
  const report = await replay(driver.live(ctx), { name: flow["name"], site: flow["site"] }, steps, values, secrets);
  const used = Object.fromEntries(Object.entries(values).filter(([name]) => !flow["params"].some((param: Json) => param["name"] === name && param["source"] === "secret")));
  for (const episode of report.episodes) episode.values = used;
  try {
    addEpisodes(root, flow["site"], flow["name"], report.episodes);
  } catch (error) {
    if (!(error instanceof BrowseError)) throw error;
  }
  flag("flow_replayed", true);
  count("flow_replay_steps", report.outcomes.length);
  if (report.episodes.some((episode) => episode.kind === "healed")) flag("flow_replay_fallback", true);
  const lines = report.outcomes.map((outcome) => {
    const how = outcome.skipped ? `skipped: ${outcome.skipped}` : outcome.ok ? (outcome.tier && outcome.tier !== "selector" && outcome.tier !== "command" ? `by ${outcome.tier}` : "") : outcome.fatal ? `✗ ${outcome.fatal}` : "✗ no tier found it";
    return `${outcome.ok ? "✓" : "✗"} [${outcome.seq}] ${outcome.intent}${how ? `  (${how})` : ""}`;
  });
  const data = { flow: flow["name"], site: flow["site"], replayed: true, ok: report.ok, steps: report.outcomes };
  if (!report.ok) {
    mark(root, flow, false);
    flag("flow_step_failed", true);
    const last = report.outcomes.at(-1);
    throw new BrowseError(
      `${flow["name"]} stopped at step ${last?.seq} (${last?.intent}): ${last?.fatal ?? "its selectors, an Escape retry and its role and name all missed"}. ` +
        `The page as it was is kept: \`ardia browse flow heal ${flow["name"]}\` shows it and how to fix the step\n${lines.join("\n")}`,
      { ...data, episode: report.episodes.at(-1) ?? null },
      "flow_step_failed",
    );
  }
  mark(root, flow, true);
  const healed = report.episodes.filter((episode) => episode.kind === "healed").length;
  const tail = healed > 0 ? `\n${healed} step${healed === 1 ? "" : "s"} needed a fallback; \`ardia browse flow heal ${flow["name"]} --apply\` keeps what worked` : "";
  return new Result(data, `✓ ${flow["name"]}: replayed ${report.outcomes.length} steps\n${lines.join("\n")}${tail}`);
}

export async function run(ctx: Ctx, root: string, flow: Json, options: Record<string, unknown>): Promise<Result> {
  const replaying = flow["kind"] === "actions" || Boolean(options["replay"]);
  const values = resolveParams(flow, parseParams(options["param"] as string[] | undefined), replaying);
  if (replaying && flow["writes"] && !options["yes"]) {
    throw new BrowseError(`${flow["name"]} sends a form or other write to ${flow["site"]}; nothing was run. Run it again with --yes once the user wants that done`, null, "flow_writes");
  }
  if (replaying) {
    if (options["replay"] && !flow["steps"].some((step: Json) => step["action"])) throw new Usage(`${flow["name"]} keeps no page actions to replay; save it again with \`flow save --actions\``);
    return replayFlow(ctx, root, flow, values);
  }
  const shape = shaping.parseShape(options["fields"] as string | undefined, options["where"] as string[] | undefined, options["limit"] as string | undefined);
  const timeout = options["timeout"] ? secondsOf(options["timeout"] as string) : RUN_TIMEOUT;
  if (timeout === undefined) throw new Usage("--timeout takes 30s, 2m or milliseconds");
  const request = outputRequest(flow) as Json;
  if (request["method"] !== "GET") throw new BrowseError("Flows are read-only for now; this flow's request isn't a GET, so it wasn't sent. Save it again", null, "flow_not_get");
  const url = fillUrl(request["url"], values);
  try {
    if (!flow["hosts"].includes(flowurl.parse(url).origin)) throw new flowurl.Unsafe("its host isn't one the flow lists");
  } catch (error) {
    if (!(error instanceof flowurl.Unsafe)) throw error;
    throw new BrowseError(`With these params the flow's request isn't safe to send (${error.message}); nothing was sent`, null, "off_site");
  }
  const deadline = monotonic() + timeout;
  const answer = await pageTier(ctx, flow, values, url, request["headers"] || {}, deadline);
  if (answer["landed"]) {
    throw new BrowseError(
      `The flow's start page went to ${String(answer["landed"])}, off ${flow["site"]} (a sign-in page?). Sign in, or drive the page yourself (open, click, read)`,
      { landed: answer["landed"] },
      "redirected",
    );
  }
  if (answer["interrupted"]) {
    throw new BrowseError(
      "The page navigated or closed while the flow's GET was in flight, so whether it reached the site is unknown and it " +
        "wasn't sent again. Drive the page yourself (open, click, read) for this task",
      null,
      "fetch_interrupted",
    );
  }
  const outcome = classify(flow, request, answer);
  if (options["fixture"] && typeof answer["text"] === "string") {
    writeFixture(ctx.path(options["fixture"] as string), fixtureFiles(flow, request, answer["text"]));
    flag("flow_fixture", true);
  }
  if (outcome.kind !== "ok") {
    if (outcome.drift) {
      mark(root, flow, false);
      flag("flow_drifted", true);
    }
    throw outcome.error;
  }
  mark(root, flow, true);
  flag("flow_run_page", true);
  flag("flow_shaped", !shape.empty);
  const shaped = shaping.apply(outcome.value, shape, true, request["expect"]["list"] ?? null);
  const items = (shaped as Map<string, Value>).get("items");
  if (items !== null && items !== undefined) count("flow_items", (items as Value[]).length);
  const lost = lostFields(request["expect"]["itemFields"] ?? [], outcome.value, request["expect"]["list"] ?? null);
  const data = { flow: flow["name"], site: flow["site"], verified: true, result: plainParams(shaped), ...(lost.length > 0 ? { lostFields: lost } : {}) };
  const done = new Result(data, runText(flow, shaped), true);
  if (lost.length > 0) {
    flag("flow_fields_lost", true);
    done.notice = `items no longer carry ${lost.join(", ")}; save the flow again if those fields matter`;
  }
  return done;
}

