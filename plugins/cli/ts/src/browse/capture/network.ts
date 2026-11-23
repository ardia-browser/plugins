import fs from "node:fs";
import path from "node:path";
import { dumps, Float, type Value } from "../../json.ts";
import { isSpace, strip } from "../../py.ts";
import { codePoints } from "../../pystr.ts";
import { Cancelled, shield, sleep } from "../cdp/cancel.ts";
import { globMatch, navigate } from "../commands/core.ts";
import type { Ctx } from "../commands/ctx.ts";
import { register } from "../commands/index.ts";
import { need, parse } from "../commands/parse.ts";
import { refuseOnBorrowed } from "../commands/shared.ts";
import { BrowseError, CdpTimeout, Gated, OutcomeUnknown, Usage } from "../daemon-errors.ts";
import { pyValue, Result } from "../daemon/render.ts";
import { flag } from "../metrics.ts";
import { pyIntArg } from "../pyerror.ts";
import { type Page, quiet, ROUTE_PATTERNS } from "../state/page.ts";
import { type Json, record } from "../state/records.ts";
import type { Listener } from "../state/state.ts";
import { defaultPath } from "../media/paths.ts";
import { activate, captureOf, credentialsOf, type Route, releaseClaim, removeListener } from "./store.ts";

export const BODY_LIMIT = 1024 * 1024;
export const HAR_BODY_LIMIT = 2 * 1024 * 1024;
export const HAR_TOTAL_LIMIT = 64 * 1024 * 1024;
export const TEXT_TYPES = ["text/", "application/json", "application/javascript", "application/xml", "application/x-javascript", "+json", "+xml"];
export const RELOAD_SETTLE = 1.5;

function pyLower(text: string): string {
  return text.toLowerCase();
}

function pyUpper(text: string): string {
  return text.toUpperCase();
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function given(row: Json, key: string): unknown {
  const value = row[key];
  return value === undefined ? null : value;
}

export function statusMatches(status: unknown, wanted: string): boolean {
  if (status === null || status === undefined) return false;
  const want = pyLower(strip(wanted, isSpace));
  if (want.endsWith("xx") && codePoints(want).length === 3) return String(status)[0] === codePoints(want)[0];
  if (want.includes("-")) {
    const cut = want.indexOf("-");
    const low = pyIntArg(want.slice(0, cut));
    const high = pyIntArg(want.slice(cut + 1));
    const value = typeof status === "number" ? Math.trunc(status) : pyIntArg(String(status));
    return low <= value && value <= high;
  }
  return String(status) === want;
}

const ROW_KEYS = ["requestId", "url", "method", "headers", "resourceType", "status", "mimeType", "responseHeaders", "timestamp", "failed"];

export function requestRow(entry: Json): Json {
  const row: Json = {};
  for (const key of ROW_KEYS) {
    const value = entry[key];
    if (value !== null && value !== undefined) row[key] = value;
  }
  return row;
}

export async function cmdNetwork(ctx: Ctx, argv: string[]): Promise<Result> {
  if (argv.length === 0) throw new Usage("Usage: ardia browse network route|unroute|requests|request|har ...");
  const action = argv[0] as string;
  const rest = argv.slice(1);
  if (action === "requests") return networkRequests(ctx, rest);
  if (action === "request") return networkRequest(ctx, rest);
  if (action === "har") return networkHar(ctx, rest);
  if (action === "route") return networkRoute(ctx, rest);
  if (action === "unroute") return networkUnroute(ctx, rest);
  throw new Usage(`Unknown network subcommand: ${action}`);
}

async function networkRequests(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options] = parse(argv, { "--clear": "bool", "--filter": "value", "--type": "value", "--method": "value", "--status": "value", "--reload": "bool" });
  const page = await ctx.state.page();
  let started = !page.networkOn;
  await activate(ctx, page, "network", () => page.enableNetwork());
  ctx.state.leases.add("network");
  if (options["reload"]) {
    flag("network_reloaded", true);
    await navigate(ctx, page, page.url);
    await sleep(RELOAD_SETTLE);
    started = false;
  }
  if (options["clear"]) {
    page.network.requests.clear();
    page.network.sizes.clear();
    page.network.dropped = 0;
    return new Result({ cleared: true }, "✓ Request log cleared");
  }
  let rows = [...page.network.requests.values()];
  const filter = options["filter"] as string | undefined;
  if (filter) rows = rows.filter((row) => text(row["url"] ?? "").includes(filter) || globMatch(filter, text(row["url"] ?? "")));
  const type = options["type"] as string | undefined;
  if (type) {
    const types = new Set(type.split(",").map((value) => pyLower(strip(value, isSpace))));
    rows = rows.filter((row) => types.has(pyLower(text(row["resourceType"] ?? ""))));
  }
  const method = options["method"] as string | undefined;
  if (method) rows = rows.filter((row) => pyUpper(text(row["method"] ?? "")) === pyUpper(method));
  const status = options["status"] as string | undefined;
  if (status) rows = rows.filter((row) => statusMatches(given(row, "status"), status));
  const lines = rows.map(
    (row) =>
      `[${text(row["requestId"])}] ${shownValue(given(row, "method"))} ${shownValue(given(row, "url"))} (${shownValue(given(row, "resourceType"))}) ` +
      `${shownValue(row["status"] || row["failed"] || "pending")}`,
  );
  if (started && rows.length === 0) {
    lines.push(
      "Network capture started; requests from now on are kept. To see what the page loaded, " +
        "run `network requests --reload` (add `--type xhr,fetch` for its data calls)",
    );
  }
  return new Result({ requests: rows.map(requestRow), dropped: page.network.dropped, started }, lines.join("\n") || "(no requests)", true);
}

function shownValue(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}

export async function responseBody(page: Page, requestId: string, limit: number): Promise<[string | null, boolean]> {
  let body: Json;
  try {
    body = await page.send("Network.getResponseBody", { requestId });
  } catch (error) {
    if (quiet(error)) return [null, false];
    throw error;
  }
  const content = body["body"] ? String(body["body"]) : "";
  const encoded = Boolean(body["base64Encoded"]);
  if (content.length > limit) {
    const points = codePoints(content);
    if (points.length > limit) return [points.slice(0, limit).join(""), encoded];
  }
  return [content, encoded];
}

async function networkRequest(ctx: Ctx, argv: string[]): Promise<Result> {
  const [, args] = parse(argv);
  need(args, 1, "network request <requestId>");
  const page = await ctx.state.page();
  const id = args[0] as string;
  const entry = page.network.requests.get(id);
  if (entry === undefined) throw new BrowseError(`No captured request ${id}; run \`ardia browse network requests\` first`);
  const detail = requestRow(entry);
  detail["postData"] = given(entry, "postData");
  const [body, encoded] = await responseBody(page, id, BODY_LIMIT);
  detail["body"] = body;
  detail["base64Encoded"] = encoded;
  const lines = [
    `${shownValue(given(entry, "method"))} ${shownValue(given(entry, "url"))}`,
    pyRstrip(`status: ${shownValue(given(entry, "status"))} ${shownValue(entry["statusText"] ?? "")}`),
    "request headers:",
  ];
  for (const [key, value] of Object.entries(record(entry["headers"]))) lines.push(`  ${key}: ${shownValue(value)}`);
  lines.push("response headers:");
  for (const [key, value] of Object.entries(record(entry["responseHeaders"]))) lines.push(`  ${key}: ${shownValue(value)}`);
  if (body !== null) lines.push("body:", !encoded ? body : `(base64, ${codePoints(body).length} chars)`);
  return new Result(detail, lines.join("\n"), true);
}

function pyRstrip(value: string): string {
  let end = value.length;
  while (end > 0 && isSpace(value[end - 1] as string)) end -= 1;
  return value.slice(0, end);
}

function isoSeconds(milliseconds: number): string {
  return `${new Date(Math.floor(milliseconds / 1000) * 1000).toISOString().slice(0, 19)}.${String(Math.trunc(milliseconds) % 1000).padStart(3, "0")}Z`;
}

function headerList(headers: unknown): { name: string; value: unknown }[] {
  return Object.entries(record(headers)).map(([name, value]) => ({ name, value }));
}

function harTime(entry: Json): Value {
  if (!entry["finished"]) return 0n;
  const elapsed = (Number(entry["finished"] || 0) - Number(entry["monotonic"] || 0)) * 1000;
  return elapsed > 0 ? new Float(elapsed) : 0n;
}

async function harEntry(page: Page, requestId: string, entry: Json, mode: string, total: { used: number }): Promise<Map<string, Value>> {
  const mimeType = text(entry["mimeType"] ?? "");
  const content = new Map<string, Value>([
    ["size", pyValue(entry["encodedDataLength"] || 0)],
    ["mimeType", pyValue(entry["mimeType"] ?? "")],
  ]);
  const textual = TEXT_TYPES.some((marker) => mimeType.includes(marker));
  if (mode !== "none" && entry["finished"] && (textual || mode === "all") && total.used < HAR_TOTAL_LIMIT) {
    const [body, encoded] = await responseBody(page, requestId, HAR_BODY_LIMIT);
    if (body !== null) {
      content.set("text", body);
      total.used += codePoints(body).length;
      if (encoded) content.set("encoding", "base64");
    }
  }
  const headers = record(entry["headers"]);
  const responseHeaders = record(entry["responseHeaders"]);
  const postData = entry["postData"];
  const request = new Map<string, Value>([
    ["method", pyValue(entry["method"])],
    ["url", pyValue(entry["url"])],
    ["httpVersion", pyValue(entry["protocol"] || "")],
    ["headers", pyValue(headerList(headers))],
    ["queryString", []],
    ["cookies", []],
    ["headersSize", -1n],
    ["bodySize", BigInt(codePoints(text(postData || "")).length)],
  ]);
  if (postData) request.set("postData", new Map<string, Value>([["mimeType", pyValue(headers["Content-Type"] ?? "")], ["text", pyValue(postData)]]));
  const response = new Map<string, Value>([
    ["status", pyValue(entry["status"] || 0)],
    ["statusText", pyValue(entry["statusText"] ?? "")],
    ["httpVersion", pyValue(entry["protocol"] || "")],
    ["headers", pyValue(headerList(responseHeaders))],
    ["cookies", []],
    ["content", content],
    ["redirectURL", pyValue(responseHeaders["location"] ?? "")],
    ["headersSize", -1n],
    ["bodySize", pyValue(entry["encodedDataLength"] || -1)],
  ]);
  const har = new Map<string, Value>([
    ["startedDateTime", isoSeconds(Number(entry["timestamp"] || 0))],
    ["time", harTime(entry)],
    ["request", request],
    ["response", response],
    ["cache", new Map()],
    ["timings", new Map<string, Value>([["send", 0n], ["wait", 0n], ["receive", 0n]])],
    ["_resourceType", pyValue(entry["resourceType"])],
  ]);
  if (entry["failed"]) har.set("_error", pyValue(entry["failed"]));
  return har;
}

async function networkHar(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, { "--content": "value" });
  need(args, 1, "network har start|stop [path]");
  const page = await ctx.state.page();
  const capture = captureOf(ctx.state);
  if (args[0] === "start") {
    const mode = (options["content"] as string | undefined) || "text";
    if (!["text", "all", "none"].includes(mode)) throw new Usage("--content takes text, all or none");
    await activate(ctx, page, "har", () => page.enableNetwork());
    ctx.state.leases.add("har");
    capture.har = { target: page.targetId, since: Date.now(), mode, seen: new Set(page.network.requests.keys()) };
    return new Result({ started: true, content: mode }, "✓ HAR recording started");
  }
  if (args[0] !== "stop") throw new Usage("Usage: ardia browse network har start|stop [path]");
  const har = capture.har;
  capture.har = null;
  ctx.state.leases.delete("har");
  if (har === null) throw new BrowseError("No HAR recording is running; start one with `ardia browse network har start`");
  releaseClaim(ctx, har.target, "har");
  const entries: Value[] = [];
  const total = { used: 0 };
  for (const [requestId, entry] of [...page.network.requests]) {
    if (har.seen.has(requestId)) continue;
    entries.push(await harEntry(page, requestId, entry, har.mode, total));
  }
  const document = new Map<string, Value>([
    [
      "log",
      new Map<string, Value>([
        ["version", "1.2"],
        ["creator", new Map<string, Value>([["name", "ardia browse"], ["version", "1"]])],
        ["pages", []],
        ["entries", entries],
      ]),
    ],
  ]);
  const named = args[1];
  const target = named !== undefined ? ctx.path(named) : path.join(path.dirname(defaultPath(ctx, "png")), `capture-${Math.floor(Date.now() / 1000)}.har`);
  fs.writeFileSync(target, dumps(document, "spaced").toWellFormed(), "utf8");
  const shown = named ?? target;
  const note = " (cookie and authorization headers are left out)";
  return new Result({ path: shown, entries: entries.length }, `✓ HAR saved to ${shown} (${entries.length} entries)${note}`);
}

async function networkRoute(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, { "--abort": "bool", "--body": "value", "--resource-type": "value", "--status": "value", "--content-type": "value" });
  need(args, 1, "network route <url> [--abort | --body <json>] [--resource-type <csv>]");
  const page = await ctx.state.page();
  refuseOnBorrowed(ctx, page, "reroute the requests of");
  const capture = captureOf(ctx.state);
  const types = options["resource_type"] as string | undefined;
  const route: Route = {
    pattern: args[0] as string,
    abort: Boolean(options["abort"]),
    body: (options["body"] as string | undefined) ?? null,
    types: types ? new Set(types.split(",").map((value) => pyLower(strip(value, isSpace)))) : null,
    status: options["status"] ? pyIntArg(options["status"] as string) : 200,
    contentType: (options["content_type"] as string | undefined) ?? null,
  };
  await intercept(ctx, page, { patterns: ROUTE_PATTERNS }, (error) => error.during("network route"));
  capture.routes.push(route);
  ctx.state.leases.add("route");
  return new Result({ routed: route.pattern, abort: route.abort }, `✓ Routing ${route.pattern}`);
}

export const INTERCEPT_UNDO_WAIT = 2;

function interceptionUnknown(error: unknown): boolean {
  return error instanceof Cancelled || error instanceof CdpTimeout || error instanceof OutcomeUnknown;
}

async function intercept(ctx: Ctx, page: Page, params: Json, refused: (error: Gated) => Gated): Promise<void> {
  const capture = captureOf(ctx.state);
  const fresh = !ctx.state.claims.has(page.targetId, "route");
  const hadRouter = capture.router !== null;
  installRouter(ctx);
  try {
    await activate(ctx, page, "route", async () => {
      try {
        await page.send("Fetch.enable", params);
      } catch (error) {
        if (fresh && interceptionUnknown(error)) {
          await shield(() => page.send("Fetch.disable", null, { timeout: INTERCEPT_UNDO_WAIT }).catch(() => ({})));
          flag("route_enable_undone", true);
        }
        if (error instanceof Gated) throw refused(error);
        throw error;
      }
    });
  } catch (error) {
    if (!hadRouter && !interceptionUnknown(error) && capture.routes.length === 0 && !ctx.state.credentials) {
      removeListener(ctx.state, capture.router);
      capture.router = null;
    }
    throw error;
  }
}

export async function enableCredentials(ctx: Ctx, page: Page, username: string, password: string): Promise<void> {
  await intercept(ctx, page, { patterns: ROUTE_PATTERNS, handleAuthRequests: true }, (error) =>
    error.during("set credentials", "HTTP auth answers Fetch.authRequired"),
  );
  ctx.state.credentials = { username, password, origin: null };
  ctx.state.leases.add("route");
}

export function credentialsFor(ctx: Ctx, page: Page, params: Json): { username: string; password: string } | null {
  const credentials = credentialsOf(ctx.state);
  const challenge = record(params["authChallenge"]);
  if (!credentials || challenge["source"] !== "Server") return null;
  if (params["resourceType"] !== "Document" || params["frameId"] !== page.targetId) return null;
  const origin = challenge["origin"];
  if (credentials.origin === null) credentials.origin = (origin as string | undefined) ?? null;
  return origin && origin === credentials.origin ? credentials : null;
}

async function handleAuth(ctx: Ctx, page: Page, params: Json): Promise<void> {
  const credentials = credentialsFor(ctx, page, params);
  const response = credentials
    ? { response: "ProvideCredentials", username: credentials.username, password: credentials.password }
    : { response: "Default" };
  try {
    await page.send("Fetch.continueWithAuth", { requestId: params["requestId"], authChallengeResponse: response });
  } catch (error) {
    if (!(error instanceof BrowseError)) throw error;
  }
}

function background(work: () => Promise<void>): void {
  shield(work).catch(() => {});
}

export function installRouter(ctx: Ctx): void {
  const capture = captureOf(ctx.state);
  if (capture.router !== null) return;
  const listener: Listener = (eventPage, method, params) => {
    if (method === "Fetch.requestPaused" && eventPage !== null) background(() => handlePaused(ctx, eventPage, params));
    else if (method === "Fetch.authRequired" && eventPage !== null) background(() => handleAuth(ctx, eventPage, params));
  };
  ctx.state.listeners.push(listener);
  capture.router = listener;
}

function contentTypeOf(route: Route, body: string): string {
  if (route.contentType) return route.contentType;
  const first = codePoints(strip(body, isSpace))[0];
  return first === "{" || first === "[" ? "application/json" : "text/plain";
}

export async function handlePaused(ctx: Ctx, page: Page, params: Json): Promise<void> {
  const request = record(params["request"]);
  const url = text(request["url"] ?? "");
  const kind = pyLower(text(params["resourceType"] ?? ""));
  const requestId = params["requestId"];
  try {
    for (const route of [...captureOf(ctx.state).routes].reverse()) {
      if (route.types && !route.types.has(kind)) continue;
      if (!(route.pattern === "*" || route.pattern === "**" || globMatch(route.pattern, url))) continue;
      if (route.abort) {
        await page.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
        return;
      }
      if (route.body !== null) {
        const body = route.body;
        await page.send("Fetch.fulfillRequest", {
          requestId,
          responseCode: route.status,
          responseHeaders: [
            { name: "Content-Type", value: contentTypeOf(route, body) },
            { name: "Access-Control-Allow-Origin", value: "*" },
          ],
          body: Buffer.from(body, "utf8").toString("base64"),
        });
        return;
      }
      break;
    }
    await page.send("Fetch.continueRequest", { requestId });
  } catch (error) {
    if (!(error instanceof BrowseError)) throw error;
  }
}

async function networkUnroute(ctx: Ctx, argv: string[]): Promise<Result> {
  const [, args] = parse(argv);
  const capture = captureOf(ctx.state);
  const pattern = args[0];
  if (pattern !== undefined) capture.routes = capture.routes.filter((route) => route.pattern !== pattern);
  else capture.routes = [];
  if (capture.routes.length === 0 && !ctx.state.credentials) {
    ctx.state.leases.delete("route");
    for (const targetId of ctx.state.claims.targetsOf("route")) releaseClaim(ctx, targetId, "route");
    for (const page of [...ctx.state.pages.values()]) {
      if (page.sessionId) {
        try {
          await page.send("Fetch.disable");
        } catch (error) {
          if (!quiet(error)) throw error;
        }
      }
    }
  }
  return new Result({ unrouted: pattern ?? "all" }, "✓ Done");
}

register("network", cmdNetwork);
