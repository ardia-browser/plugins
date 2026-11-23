import { sleep } from "../cdp/cancel.ts";
import type { Ctx } from "../commands/ctx.ts";
import { register } from "../commands/index.ts";
import { need, parse } from "../commands/parse.ts";
import { resolve } from "../commands/shared.ts";
import { BrowseError, CdpError, Gated, Usage } from "../daemon-errors.ts";
import { Result } from "../daemon/render.ts";
import type { Page } from "../state/page.ts";
import type { Listener } from "../state/state.ts";
import { record } from "../state/records.ts";
import { askArdia, askArdiaAboutTab } from "./inspect.ts";
import { activate, removeListener } from "./store.ts";

export const ISSUE_SETTLE = 0.3;
export const ISSUE_LIMIT = 500;
export const STYLES_METHOD = "devtools.styles";
export const ISSUES_METHOD = "devtools.issues";
export const ISSUES_WAIT_MS = 500;
export const UNIQUE_SELECTOR_LIMIT = 1000;

export function engineLacks(command: string, method: string): BrowseError {
  return new BrowseError(
    `\`${command}\` needs ${method}, which this Ardia's engine doesn't have. Update Ardia and run it again`,
    { method },
    "ardia_too_old",
  );
}

export async function devtoolsCall(page: Page, command: string, method: string, params: Record<string, unknown> | null = null, session: string | null = null): Promise<Record<string, unknown>> {
  try {
    return await page.send(method, params, session === null ? {} : { session });
  } catch (error) {
    if (error instanceof Gated) throw error.during(command);
    if (error instanceof CdpError && error.cdpCode === -32601) throw engineLacks(command, method);
    throw error;
  }
}

const IMPORTANT = /\s*!\s*important\s*$/iu;

type Declaration = { name: string; value: string; important: boolean; origin: string; order: number; agent: boolean };

function ruleOrigin(rule: Record<string, unknown>, sheets: ReadonlyMap<string, string>): string {
  const selectors = record(rule["selectorList"])["text"];
  const range = record(record(rule["style"])["range"]);
  const sheet = typeof rule["styleSheetId"] === "string" ? sheets.get(rule["styleSheetId"] as string) : undefined;
  const where = sheet ? `${sheet}${typeof range["startLine"] === "number" ? `:${(range["startLine"] as number) + 1}` : ""}` : String(rule["origin"] ?? "");
  return `${String(selectors ?? "")}${where ? ` (${where})` : ""}`;
}

function declarations(style: Record<string, unknown>, origin: string, order: number, agent = false): Declaration[] {
  const properties = Array.isArray(style["cssProperties"]) ? style["cssProperties"] : [];
  const byName = new Map<string, Declaration>();
  for (const raw of properties) {
    const property = record(raw);
    if (property["disabled"] === true || property["parsedOk"] === false) continue;
    if (typeof property["name"] !== "string" || typeof property["value"] !== "string") continue;
    const important = property["important"] === true || IMPORTANT.test(property["value"]);
    const declared = { name: property["name"], value: property["value"].replace(IMPORTANT, ""), important, origin, order, agent };
    const earlier = byName.get(declared.name);
    if (earlier !== undefined && earlier.important && !declared.important) continue;
    byName.delete(declared.name);
    byName.set(declared.name, declared);
  }
  return [...byName.values()];
}

export function cascadeRank(declaration: { important: boolean; agent: boolean }): number {
  if (declaration.important) return declaration.agent ? 3 : 2;
  return declaration.agent ? 0 : 1;
}

export function cascade(matched: Record<string, unknown>, sheets: ReadonlyMap<string, string> = new Map()): { winners: Map<string, Declaration>; losers: Map<string, Declaration[]> } {
  const all: Declaration[] = [];
  let order = 0;
  const rules = Array.isArray(matched["matchedCSSRules"]) ? matched["matchedCSSRules"] : [];
  for (const raw of rules) {
    const rule = record(record(raw)["rule"]);
    all.push(...declarations(record(rule["style"]), ruleOrigin(rule, sheets), order, rule["origin"] === "user-agent"));
    order += 1;
  }
  const attributes = record(matched["attributesStyle"]);
  if (Object.keys(attributes).length > 0) all.unshift(...declarations(attributes, "element attributes", -1));
  const inline = record(matched["inlineStyle"]);
  if (Object.keys(inline).length > 0) all.push(...declarations(inline, "style attribute", order + 1));
  const winners = new Map<string, Declaration>();
  const losers = new Map<string, Declaration[]>();
  for (const declaration of all) {
    const current = winners.get(declaration.name);
    if (current === undefined) {
      winners.set(declaration.name, declaration);
      continue;
    }
    const beats = cascadeRank(declaration) !== cascadeRank(current) ? cascadeRank(declaration) > cascadeRank(current) : declaration.order >= current.order;
    const [won, lost] = beats ? [declaration, current] : [current, declaration];
    winners.set(declaration.name, won);
    losers.set(declaration.name, [...(losers.get(declaration.name) ?? []), lost]);
  }
  return { winners, losers };
}

type SheetLog = { urls: Map<string, string>; listener: Listener; session: string | null };
const STYLE_SHEETS = new WeakMap<Page, SheetLog>();

async function styleSheets(ctx: Ctx, page: Page, session: string | null): Promise<Map<string, string>> {
  const known = STYLE_SHEETS.get(page);
  if (known !== undefined && known.session === page.session) return known.urls;
  if (known !== undefined) {
    known.urls.clear();
    await devtoolsCall(page, "styles", "DOM.enable", null, session);
    await devtoolsCall(page, "styles", "CSS.enable", null, session);
    known.session = page.session;
    return known.urls;
  }
  const log: SheetLog = { urls: new Map(), listener: () => {}, session: page.session };
  log.listener = (eventPage, method, params) => {
    if (eventPage !== page || method !== "CSS.styleSheetAdded") return;
    const header = record(params["header"]);
    const url = typeof header["sourceURL"] === "string" && header["sourceURL"] ? header["sourceURL"] : header["isInline"] ? "inline <style>" : "";
    if (typeof header["styleSheetId"] === "string" && url) log.urls.set(header["styleSheetId"], url);
  };
  ctx.state.listeners.push(log.listener);
  try {
    await activate(ctx, page, "styles", async () => {
      await devtoolsCall(page, "styles", "DOM.enable", null, session);
      await devtoolsCall(page, "styles", "CSS.enable", null, session);
    });
  } catch (error) {
    removeListener(ctx.state, log.listener);
    throw error;
  }
  STYLE_SHEETS.set(page, log);
  return log.urls;
}

const UNIQUE_SELECTOR = `(el) => {
  const unique = (selector) => { try { return document.querySelectorAll(selector).length === 1 && document.querySelector(selector) === el; } catch { return false; } };
  if (el.id && unique("#" + CSS.escape(el.id))) return "#" + CSS.escape(el.id);
  const parts = [];
  for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
    if (node !== el && node.id && document.querySelectorAll("#" + CSS.escape(node.id)).length === 1) {
      parts.unshift("#" + CSS.escape(node.id));
      break;
    }
    let index = 1;
    for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) if (sibling.localName === node.localName) index += 1;
    parts.unshift(node.localName + ":nth-of-type(" + index + ")");
  }
  const selector = parts.join(" > ");
  return unique(selector) ? selector : null;
}`;

function placeText(source: unknown): string {
  if (typeof source === "string") return source;
  const place = record(source);
  const url = typeof place["url"] === "string" ? place["url"] : typeof place["href"] === "string" ? place["href"] : "";
  const line = typeof place["line"] === "number" ? place["line"] : typeof place["lineNumber"] === "number" ? (place["lineNumber"] as number) + 1 : null;
  return url ? `${url}${line === null ? "" : `:${line}`}` : "";
}

function declaredBy(item: Record<string, unknown>): string {
  const selector = typeof item["selector"] === "string" && item["selector"] ? item["selector"] : String(item["origin"] ?? "");
  const where = placeText(item["source"]);
  const inherited = typeof item["inheritedFrom"] === "string" && item["inheritedFrom"] ? `, inherited from ${item["inheritedFrom"] as string}` : "";
  return `${selector}${where ? ` (${where})` : ""}${inherited}`;
}

export function ardiaStyleLines(answer: Record<string, unknown>, all: boolean): string[] {
  const lines: string[] = [];
  for (const raw of Array.isArray(answer["properties"]) ? answer["properties"] : []) {
    const item = record(raw);
    const winner = record(item["winner"]);
    const computed = typeof item["computed"] === "string" ? `  [computed ${item["computed"] as string}]` : "";
    const value = typeof winner["value"] === "string" ? winner["value"] : "(not set by a rule)";
    lines.push(`${String(item["property"])}: ${value}${winner["important"] === true ? " !important" : ""}  ← ${declaredBy(winner)}${computed}`);
    if (!all) continue;
    for (const lostRaw of Array.isArray(item["overridden"]) ? item["overridden"] : []) {
      const lost = record(lostRaw);
      const why = typeof lost["reason"] === "string" && lost["reason"] ? ` (${lost["reason"] as string})` : "";
      lines.push(`  overridden: ${String(lost["value"] ?? "")}${lost["important"] === true ? " !important" : ""}  ← ${declaredBy(lost)}${why}`);
    }
  }
  return lines;
}

async function selectorFor(page: Page, element: { frame: string }, given: string, args: readonly unknown[]): Promise<string | null> {
  if (element.frame !== page.mainFrame) return null;
  if (!/^@?e\d+$/u.test(given) && given.length <= UNIQUE_SELECTOR_LIMIT && !given.includes(">>") && !/^(text|xpath|role)=/u.test(given)) return given;
  try {
    const found = await page.call(UNIQUE_SELECTOR, [...args], { frame: element.frame, read: true });
    return typeof found === "string" && found.length <= UNIQUE_SELECTOR_LIMIT ? found : null;
  } catch {
    return null;
  }
}

async function computedStyles(page: Page, session: string | null, nodeId: unknown): Promise<Map<string, string>> {
  const answer = await devtoolsCall(page, "styles", "CSS.getComputedStyleForNode", { nodeId }, session);
  const out = new Map<string, string>();
  for (const raw of Array.isArray(answer["computedStyle"]) ? answer["computedStyle"] : []) {
    const item = record(raw);
    if (typeof item["name"] === "string" && typeof item["value"] === "string") out.set(item["name"], item["value"]);
  }
  return out;
}

function wantedProperties(given: unknown): Set<string> | null {
  if (typeof given !== "string") return null;
  return new Set(given.split(",").map((name) => name.trim()).filter(Boolean));
}

export async function cmdStyles(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, { "--all": "bool", "--property": "value", "--selector": "value" }, { "-s": "--selector" });
  const given = (options["selector"] as string | undefined) ?? args[0];
  if (given === undefined) need(args, 1, "styles <sel> [--property color,margin] [--all]");
  const [page, element] = await resolve(ctx, given as string);
  const wanted = wantedProperties(options["property"]);
  const selector = await selectorFor(page, element, given as string, [element]);
  if (selector !== null) {
    const params: Record<string, unknown> = { selector };
    if (wanted !== null) params["properties"] = [...wanted];
    const answer = await askArdiaAboutTab(ctx, page, STYLES_METHOD, params, 15);
    if (answer !== null) {
      const lines = ardiaStyleLines(answer, Boolean(options["all"]));
      return new Result({ element: element.label, source: "ardia", ...answer }, lines.length > 0 ? lines.join("\n") : `No author rule sets a property on ${element.label}`);
    }
  }
  const session = page.sessionFor(element.frame);
  const sheets = await styleSheets(ctx, page, session);
  await devtoolsCall(page, "styles", "DOM.getDocument", { depth: 0 }, session);
  const node = await devtoolsCall(page, "styles", "DOM.requestNode", { objectId: element.objectId }, session);
  const matched = await devtoolsCall(page, "styles", "CSS.getMatchedStylesForNode", { nodeId: node["nodeId"] }, session);
  const computed = await computedStyles(page, session, node["nodeId"]);
  const { winners, losers } = cascade(matched, sheets);
  const names = [...winners.keys()].filter((name) => (wanted === null ? options["all"] || !(winners.get(name) as Declaration).agent : wanted.has(name))).sort();
  const lines: string[] = [];
  const data: Record<string, unknown>[] = [];
  for (const name of names) {
    const won = winners.get(name) as Declaration;
    const value = computed.get(name);
    lines.push(`${name}: ${won.value}${won.important ? " !important" : ""}  ← ${won.origin}${value !== undefined && value !== won.value ? `  [computed ${value}]` : ""}`);
    const beaten = losers.get(name) ?? [];
    if (options["all"]) for (const lost of beaten) lines.push(`  overridden: ${lost.value}${lost.important ? " !important" : ""}  ← ${lost.origin}`);
    data.push({ property: name, value: won.value, computed: value ?? null, important: won.important, from: won.origin, overridden: beaten.map((lost) => ({ value: lost.value, from: lost.origin })) });
  }
  if (wanted !== null) {
    for (const name of wanted) {
      if (winners.has(name)) continue;
      const value = computed.get(name);
      lines.push(`${name}: ${value ?? "(none)"}  ← no rule on ${element.label} sets it (inherited or the browser default)`);
      data.push({ property: name, value: null, computed: value ?? null, important: false, from: null, overridden: [] });
    }
  }
  const text = lines.length > 0 ? lines.join("\n") : `No author rule sets a property on ${element.label}`;
  return new Result({ element: element.label, source: "cli", styles: data }, text);
}

type IssueLog = { items: Record<string, unknown>[]; dropped: number; listener: Listener; session: string | null };
const ISSUES = new WeakMap<Page, IssueLog>();

const COOKIE_WHY: Readonly<Record<string, string>> = {
  ExcludeSameSiteUnspecifiedTreatedAsLax: "it has no SameSite attribute, so the browser treats it as Lax and leaves it off cross-site requests; set SameSite=None; Secure if it must go cross-site",
  ExcludeSameSiteNoneInsecure: "it says SameSite=None without Secure, so the browser drops it; add Secure",
  ExcludeSameSiteLax: "it's SameSite=Lax, so it stays off this cross-site request",
  ExcludeSameSiteStrict: "it's SameSite=Strict, so it stays off this cross-site request",
  WarnSameSiteUnspecifiedCrossSiteContext: "it has no SameSite attribute and was used cross-site; it will be blocked once Lax is enforced",
  WarnSameSiteNoneInsecure: "it says SameSite=None without Secure",
  ExcludeThirdPartyPhaseout: "third-party cookies are blocked for this site",
  WarnThirdPartyPhaseout: "it's a third-party cookie, which the browser is phasing out",
  ExcludeInvalidSameParty: "its SameParty attribute is invalid",
  ExcludeDomainNonASCII: "its domain has non-ASCII characters",
};

function first(...values: unknown[]): string {
  for (const value of values) if (typeof value === "string" && value !== "") return value;
  return "";
}

export function issueKind(code: string): string {
  if (code.startsWith("Cookie")) return "cookie";
  if (code.startsWith("Cors")) return "cors";
  if (code.startsWith("ContentSecurityPolicy")) return "csp";
  if (code.startsWith("MixedContent")) return "mixed";
  return code.replace(/Issue$/u, "").toLowerCase();
}

const SECRET_COOKIE_KEYS = new Set(["rawCookieLine", "value", "cookieValue"]);

export function sanitizedIssue(value: unknown, insideCookie = false): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizedIssue(item, insideCookie));
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "rawCookieLine" || (insideCookie && SECRET_COOKIE_KEYS.has(key))) continue;
    out[key] = sanitizedIssue(item, insideCookie || key === "cookie" || key === "cookieIssueDetails");
  }
  return out;
}

export function describeIssue(issue: Record<string, unknown>): string {
  const code = String(issue["code"] ?? "Issue");
  const details = record(issue["details"]);
  const kind = issueKind(code);
  if (kind === "cookie") {
    const cookie = record(details["cookieIssueDetails"]);
    const name = record(cookie["cookie"]);
    const reasons = [...(Array.isArray(cookie["cookieExclusionReasons"]) ? cookie["cookieExclusionReasons"] : []), ...(Array.isArray(cookie["cookieWarningReasons"]) ? cookie["cookieWarningReasons"] : [])].map(String);
    const why = reasons.map((reason) => COOKIE_WHY[reason] ?? reason).join("; ");
    const label = first(name["name"]) || "a cookie";
    const url = first(record(cookie["request"])["url"], cookie["siteForCookies"]);
    return `[cookie] ${label}${name["domain"] ? ` (${String(name["domain"])})` : ""}${url ? ` on ${url}` : ""}: ${why || code}`;
  }
  if (kind === "cors") {
    const cors = record(details["corsIssueDetails"]);
    const status = record(cors["corsErrorStatus"]);
    const url = first(record(cors["request"])["url"]);
    const origin = first(cors["initiatorOrigin"]);
    return `[cors] ${url || "a request"}${origin ? ` from ${origin}` : ""}: ${first(status["corsError"]) || "blocked by CORS"}${status["failedParameter"] ? ` (${String(status["failedParameter"])})` : ""}`;
  }
  if (kind === "csp") {
    const csp = record(details["contentSecurityPolicyIssueDetails"]);
    const source = record(csp["sourceCodeLocation"]);
    const at = source["url"] ? ` at ${String(source["url"])}:${Number(source["lineNumber"] ?? 0) + 1}` : "";
    return `[csp] ${first(csp["contentSecurityPolicyViolationType"]) || "violation"}: ${first(csp["blockedURL"]) || "inline content"} broke ${first(csp["violatedDirective"]) || "a directive"}${at}`;
  }
  if (kind === "mixed") {
    const mixed = record(details["mixedContentIssueDetails"]);
    return `[mixed] ${first(mixed["insecureURL"]) || "an http:// resource"} on ${first(mixed["mainResourceURL"]) || "this https page"}: ${first(mixed["resolutionStatus"]) || "mixed content"}`;
  }
  const detailKeys = Object.keys(details);
  const firstDetail = detailKeys.length > 0 ? record(details[detailKeys[0] as string]) : {};
  const hint = first(firstDetail["violationType"], firstDetail["type"], firstDetail["reason"], firstDetail["errorType"]);
  return `[${kind}] ${code}${hint ? `: ${hint}` : ""}`;
}

async function issueLog(ctx: Ctx, page: Page): Promise<[IssueLog, boolean]> {
  const known = ISSUES.get(page);
  if (known !== undefined && known.session === page.session) return [known, false];
  if (known !== undefined) {
    await devtoolsCall(page, "issues", "Audits.enable");
    known.session = page.session;
    return [known, true];
  }
  const log: IssueLog = { items: [], dropped: 0, listener: () => {}, session: page.session };
  log.listener = (eventPage, method, params) => {
    if (eventPage !== page || method !== "Audits.issueAdded") return;
    const issue = record(sanitizedIssue(params["issue"]));
    if (log.items.length >= ISSUE_LIMIT) {
      log.items.shift();
      log.dropped += 1;
    }
    log.items.push(issue);
  };
  ctx.state.listeners.push(log.listener);
  try {
    await activate(ctx, page, "issues", () => devtoolsCall(page, "issues", "Audits.enable"));
  } catch (error) {
    removeListener(ctx.state, log.listener);
    throw error;
  }
  ISSUES.set(page, log);
  return [log, true];
}

function affectedText(affected: Record<string, unknown>): string {
  const cookie = record(affected["cookie"]);
  if (typeof cookie["name"] === "string") return `cookie ${cookie["name"] as string}${typeof cookie["domain"] === "string" ? ` (${cookie["domain"] as string})` : ""}`;
  const request = affected["request"];
  const url = typeof request === "string" ? request : record(request)["url"];
  if (typeof url === "string" && url) return url;
  const where = placeText(affected["source"]);
  return where;
}

export function ardiaIssueLine(issue: Record<string, unknown>): string {
  const kind = typeof issue["kind"] === "string" ? issue["kind"] : issueKind(String(issue["code"] ?? ""));
  const title = first(issue["title"], issue["code"]) || "issue";
  const affected = affectedText(record(issue["affected"]));
  const explanation = typeof issue["explanation"] === "string" && issue["explanation"] ? `: ${issue["explanation"] as string}` : "";
  const fix = typeof issue["fix"] === "string" && issue["fix"] ? ` Fix: ${issue["fix"] as string}` : "";
  return `[${kind}] ${title}${affected ? ` (${affected})` : ""}${explanation}${fix}`;
}

export function kindKey(kind: string): string {
  return kind.trim().toLowerCase().replace(/-content$/u, "").replaceAll("-", "").replaceAll("_", "");
}

function kindsOf(given: unknown): Set<string> | null {
  return typeof given === "string" ? new Set(given.split(",").map(kindKey).filter(Boolean)) : null;
}

function kindOfAnswered(issue: Record<string, unknown>): string {
  return kindKey(typeof issue["kind"] === "string" ? issue["kind"] : issueKind(String(issue["code"] ?? "")));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function issueFingerprint(issue: Record<string, unknown>): string {
  return canonicalJson(sanitizedIssue(issue));
}

const CLEARED = new WeakMap<Page, Set<string>>();
export const CLEARED_KEPT = 2000;

function remember(page: Page, issues: readonly Record<string, unknown>[]): void {
  const cleared = CLEARED.get(page) ?? new Set<string>();
  for (const issue of issues) cleared.add(issueFingerprint(issue));
  while (cleared.size > CLEARED_KEPT) cleared.delete(cleared.values().next().value as string);
  CLEARED.set(page, cleared);
}

export function ardiaIssues(answer: Record<string, unknown>, kinds: Set<string> | null, cleared: ReadonlySet<string> = new Set()): Record<string, unknown>[] {
  const all = (Array.isArray(answer["issues"]) ? answer["issues"] : []).map((item) => record(sanitizedIssue(item)));
  return all.filter((issue) => (kinds === null || kinds.has(kindOfAnswered(issue))) && !cleared.has(issueFingerprint(issue)));
}

export async function cmdIssues(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, { "--kind": "value", "--clear": "bool" });
  if (args.length > 0) throw new Usage("Usage: ardia browse issues [--kind cookie,cors,csp,mixed] [--clear]");
  const page = await ctx.state.page();
  const kinds = kindsOf(options["kind"]);
  const fromTab = await askArdiaAboutTab(ctx, page, ISSUES_METHOD, { waitMs: ISSUES_WAIT_MS }, 15);
  if (fromTab !== null) {
    const issues = ardiaIssues(fromTab, options["clear"] ? null : kinds, CLEARED.get(page));
    if (options["clear"]) {
      remember(page, issues);
      return new Result({ cleared: true }, "✓ Issues cleared");
    }
    return new Result({ source: "ardia", issues, dropped: fromTab["dropped"] ?? 0 }, issues.length > 0 ? issues.map(ardiaIssueLine).join("\n") : "No issues", true);
  }
  const [log, started] = await issueLog(ctx, page);
  if (started) await sleep(ISSUE_SETTLE);
  if (options["clear"]) {
    log.items.length = 0;
    log.dropped = 0;
    return new Result({ cleared: true }, "✓ Issues cleared");
  }
  const shown = log.items.filter((issue) => kinds === null || kinds.has(kindKey(issueKind(String(issue["code"] ?? "")))));
  const explained = shown.length > 0 ? await askArdia(ctx, ISSUES_METHOD, { issues: shown }, 10) : null;
  const issues = explained === null ? shown : ardiaIssues(explained, null);
  const lines = explained === null ? shown.map(describeIssue) : issues.map(ardiaIssueLine);
  if (log.dropped) lines.unshift(`(${log.dropped} older issues dropped)`);
  if (lines.length === 0) lines.push(started ? "No issues so far; Ardia reports new ones from now on (reload to see the page's load-time issues)" : "No issues");
  return new Result({ source: explained === null ? "cli" : "ardia", issues, dropped: log.dropped, started }, lines.join("\n"), true);
}

register("styles", cmdStyles);
register("issues", cmdIssues);
