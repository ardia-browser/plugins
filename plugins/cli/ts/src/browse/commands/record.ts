import { sleep } from "../cdp/cancel.ts";
import { BrowseError, ConnectionLost, Usage } from "../daemon-errors.ts";
import { Result } from "../daemon/render.ts";
import { pyValue } from "../daemon/render.ts";
import { dumps } from "../../json.ts";
import * as flowurl from "../flowurl.ts";
import { type Action } from "../flows/actions.ts";
import { compileEvents, type RecEvent } from "../flows/compile.ts";
import { ACTIONS_VERSION, checkName, originAllowed, save, siteOf, validate, type Json } from "../flows/flows.ts";
import { selectorOf } from "../flows/locators.ts";
import { secondsOf } from "../limits.ts";
import { count, flag } from "../metrics.ts";
import type { Page } from "../state/page.ts";
import type { Listener } from "../state/state.ts";
import { monotonic } from "../state/wait.ts";
import { cliVersion } from "../../version.ts";
import type { Ctx } from "./ctx.ts";
import { parse } from "./parse.ts";

export const RECORD_WORLD = "ardia-record";
export const BINDING = "__ardiaRecord";
export const DEFAULT_TIMEOUT = 120;
export const MAX_TIMEOUT = 600;
export const DEFAULT_IDLE = 20;
export const MAX_EVENTS = 500;
export const MAX_PAYLOAD = 16 * 1024;
const POLL = 0.2;
export const FLAGS = { "--save": "value", "--timeout": "value", "--idle": "value", "--here": "bool", "--description": "value" } as const;

export const RECORDER_SOURCE = `(() => {
  if (globalThis.__ardiaRecorderStop) return;
  const send = globalThis[${JSON.stringify(BINDING)}];
  if (typeof send !== "function") return;
  const INPUT_ROLES = { button: "button", submit: "button", reset: "button", image: "button", checkbox: "checkbox", radio: "radio", range: "slider", number: "spinbutton", search: "searchbox" };
  const TAG_ROLES = { button: "button", summary: "button", textarea: "textbox", option: "option", h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading", nav: "navigation", main: "main", dialog: "dialog" };
  const short = (text, limit = 100) => String(text || "").replace(/\\s+/g, " ").trim().slice(0, limit);
  const roleOf = (el) => {
    const explicit = short(el.getAttribute("role")).split(" ")[0];
    if (explicit) return explicit.toLowerCase();
    const tag = el.localName;
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (el.getAttribute("list")) return "combobox";
      return INPUT_ROLES[type] || "textbox";
    }
    if (tag === "a") return el.hasAttribute("href") ? "link" : null;
    if (tag === "select") return el.multiple || el.size > 1 ? "listbox" : "combobox";
    if (tag === "img") return el.getAttribute("alt") ? "img" : null;
    if (el.isContentEditable) return "textbox";
    return TAG_ROLES[tag] || null;
  };
  const labelledBy = (el) => {
    const ids = short(el.getAttribute("aria-labelledby"), 400).split(" ").filter(Boolean);
    return short(ids.map((id) => { const node = el.ownerDocument.getElementById(id); return node ? node.textContent : ""; }).join(" "));
  };
  const labels = (el) => (el.labels && el.labels.length ? short([...el.labels].map((label) => label.innerText || label.textContent).join(" ")) : "");
  const field = (el) => ["input", "textarea", "select"].includes(el.localName);
  const nameOf = (el) => short(el.getAttribute("aria-label")) || labelledBy(el) || labels(el)
    || (el.localName === "input" && ["submit", "button", "reset"].includes(el.type) ? short(el.value) : "")
    || short(el.getAttribute("alt"))
    || (field(el) ? short(el.getAttribute("placeholder")) || short(el.getAttribute("title")) : short(el.innerText || el.textContent) || short(el.getAttribute("title")));
  const stableId = (id) => Boolean(id) && /^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(id) && !/[0-9]{3,}|[0-9a-f]{8,}/i.test(id) && !/^(ember|react|radix|headlessui|mui|rc-|downshift)/i.test(id);
  const unique = (selector, el) => { try { const found = el.ownerDocument.querySelectorAll(selector); return found.length === 1 && found[0] === el; } catch { return false; } };
  const cssPath = (el) => {
    if (stableId(el.id) && unique("#" + CSS.escape(el.id), el)) return "#" + CSS.escape(el.id);
    const parts = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 5; depth += 1) {
      let part = node.localName;
      const name = node.getAttribute("name");
      if (name && /^[A-Za-z0-9_.\\[\\]-]{1,60}$/.test(name)) part += '[name="' + name + '"]';
      else if (stableId(node.id)) { parts.unshift("#" + CSS.escape(node.id)); if (unique(parts.join(" > "), el)) return parts.join(" > "); break; }
      else if (node.parentElement) {
        const same = [...node.parentElement.children].filter((child) => child.localName === node.localName);
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      if (unique(parts.join(" > "), el)) return parts.join(" > ");
      node = node.parentElement;
    }
    return "";
  };
  const xpathOf = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 12) {
      let index = 1;
      for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) if (sibling.localName === node.localName) index += 1;
      parts.unshift(node.localName + "[" + index + "]");
      node = node.parentElement;
    }
    return "/" + parts.join("/");
  };
  const describe = (el) => ({
    tag: el.localName, role: roleOf(el), name: nameOf(el), ariaLabel: short(el.getAttribute("aria-label")), placeholder: short(el.getAttribute("placeholder")),
    fieldName: short(el.getAttribute("name"), 80), testId: short(el.getAttribute("data-testid") || el.getAttribute("data-test-id") || el.getAttribute("data-test"), 80),
    text: field(el) ? "" : short(el.innerText || el.textContent, 60), id: short(el.id, 80), classes: [...el.classList].slice(0, 6), css: cssPath(el), xpath: xpathOf(el),
    type: short(el.getAttribute("type") || (el.localName === "select" ? "select" : ""), 20).toLowerCase(), checked: "checked" in el ? Boolean(el.checked) : null,
  });
  const INTERACTIVE = "a[href],button,input,select,textarea,summary,label,option,[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=option],[role=combobox],[role=textbox],[contenteditable=''],[contenteditable=true],[onclick],[tabindex]";
  const targetOf = (event) => {
    const path = event.composedPath ? event.composedPath() : [event.target];
    const first = path.find((node) => node && node.nodeType === 1);
    return first ? first.closest(INTERACTIVE) || first : null;
  };
  const frameInfo = () => {
    try {
      if (window.top === window) return null;
      const owner = window.frameElement;
      return { css: owner ? cssPath(owner) || null : null, url: location.href };
    } catch {
      return { css: null, url: location.href };
    }
  };
  const secret = (el) => el.localName === "input" && (el.type === "password" || /one-time-code|cc-|password/.test(el.autocomplete || ""));
  const textual = (el) => (el.localName === "input" && !["checkbox", "radio", "submit", "button", "reset", "image", "file", "range", "color"].includes(el.type)) || el.localName === "textarea" || Boolean(el.isContentEditable);
  const emit = (event) => { try { send(JSON.stringify({ ...event, at: Date.now(), frame: frameInfo() })); } catch {} };
  const pending = new Set();
  const flush = (el) => {
    if (!pending.has(el)) return;
    pending.delete(el);
    const hidden = secret(el);
    emit({ kind: "fill", target: describe(el), value: hidden ? "" : String(el.isContentEditable ? el.innerText : el.value ?? "").slice(0, 2000), secret: hidden });
  };
  const flushAll = () => { for (const el of [...pending]) flush(el); };
  const onInput = (event) => { if (!event.isTrusted) return; const el = targetOf(event); if (el && textual(el)) pending.add(el); };
  const onChange = (event) => {
    if (!event.isTrusted) return;
    const el = event.target;
    if (!el || el.nodeType !== 1) return;
    if (el.localName === "select") emit({ kind: "select", target: describe(el), value: [...el.selectedOptions].map((option) => short(option.label || option.text)).join(", ") });
    else if (textual(el)) flush(el);
  };
  const onClick = (event) => {
    if (!event.isTrusted || event.button !== 0) return;
    let el = targetOf(event);
    if (!el) return;
    if (el.localName === "label" && el.control) el = el.control;
    if (textual(el) || el.localName === "select" || el.localName === "option") return;
    flushAll();
    emit({ kind: "click", target: describe(el), checked: "checked" in el ? Boolean(el.checked) : null, method: el.form ? (el.form.getAttribute("method") || "get").toLowerCase() : null });
  };
  const onKey = (event) => {
    if (!event.isTrusted || (event.key !== "Enter" && event.key !== "Escape")) return;
    const el = targetOf(event) || document.activeElement;
    if (el && textual(el)) flush(el);
    if (event.key === "Enter" && el && el.localName === "textarea") return;
    emit({ kind: "press", key: event.key, target: el && el !== document.body && el.nodeType === 1 ? describe(el) : null });
  };
  const onSubmit = (event) => {
    if (!event.isTrusted) return;
    const form = event.target;
    flushAll();
    emit({ kind: "submit", target: form && form.nodeType === 1 ? describe(form) : null, method: form && form.getAttribute ? (form.getAttribute("method") || "get").toLowerCase() : "get" });
  };
  const options = { capture: true, passive: true };
  const listeners = [["input", onInput], ["change", onChange], ["click", onClick], ["keydown", onKey], ["submit", onSubmit]];
  for (const [name, listener] of listeners) addEventListener(name, listener, options);
  globalThis.__ardiaRecorderStop = () => {
    flushAll();
    for (const [name, listener] of listeners) removeEventListener(name, listener, options);
    delete globalThis.__ardiaRecorderStop;
  };
})()`;

export const STOP_SOURCE = "(() => { if (globalThis.__ardiaRecorderStop) globalThis.__ardiaRecorderStop(); })()";

export function parseEvent(payload: unknown): RecEvent | null {
  if (typeof payload !== "string" || payload.length > MAX_PAYLOAD) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object") return null;
  const event = raw as Record<string, unknown>;
  if (!["click", "fill", "select", "press", "submit"].includes(String(event["kind"]))) return null;
  if (typeof event["at"] !== "number") return null;
  return event as unknown as RecEvent;
}

function originOf(url: string): string | null {
  try {
    return flowurl.parse(url).origin;
  } catch (error) {
    if (error instanceof flowurl.Unsafe) return null;
    throw error;
  }
}

function safeOpen(url: string, hosts: readonly string[]): string | null {
  for (const candidate of [url, url.replace(/[?#].*$/u, "")]) {
    try {
      const parsed = flowurl.checked(candidate);
      if (hosts.includes(parsed.origin)) return parsed.text;
    } catch {
      continue;
    }
  }
  return null;
}

export function recordedFlow(name: string, events: readonly RecEvent[], startUrl: string, description: string | null = null, toolVersion = ""): { flow: Json; skipped: { at: number; why: string }[] } {
  checkName(name);
  const start = safeOpen(startUrl, [originOf(startUrl) ?? ""]);
  if (start === null) throw new BrowseError(`record needs a plain web page to start on, not ${flowurl.hostLabel(startUrl)}`, null, "not_a_web_page");
  const compiled = compileEvents(events, start);
  const startParsed = flowurl.parse(start);
  const hosts = compiled.hosts.filter((origin) => {
    try {
      return originAllowed(flowurl.parse(`${origin}/`), startParsed);
    } catch (error) {
      if (error instanceof flowurl.Unsafe) return false;
      throw error;
    }
  });
  if (!hosts.includes(startParsed.origin)) hosts.unshift(startParsed.origin);
  const skipped = [...compiled.skipped];
  const steps: Json[] = [];
  for (const step of compiled.steps) {
    const action: Action = step.action;
    if (action.type === "open") {
      const url = safeOpen(String(action.value ?? ""), hosts);
      if (url === null) {
        skipped.push({ at: 0, why: "a page on another site or with an address a flow can't keep" });
        continue;
      }
      action.value = url;
      step.command = ["open", url];
    }
    steps.push({ seq: steps.length + 1, command: step.command.map((part) => (part.length > 200 ? `${part.slice(0, 200)}…` : part)), url: safeOpen(step.url, hosts) ?? "", ok: true, requests: [], action });
  }
  const words = String(description ?? "").split(/\s+/u).filter((word) => word).join(" ");
  const flow: Json = {
    version: ACTIONS_VERSION,
    name,
    description: words.slice(0, 120) || null,
    site: siteOf(startParsed.text),
    origin: startParsed.origin,
    startUrl: startParsed.text,
    hosts: [...new Set(hosts)].sort(),
    createdAt: `${new Date().toISOString().slice(0, 19)}Z`,
    createdBy: { tool: "ardia browse record", version: toolVersion },
    params: compiled.params,
    output: null,
    verified: true,
    steps,
    kind: "actions",
    writes: compiled.writes,
  };
  return { flow, skipped };
}

async function installIn(page: Page, frame: string): Promise<number> {
  const created = await page.send("Page.createIsolatedWorld", { frameId: frame, worldName: RECORD_WORLD }, { session: page.sessionFor(frame) });
  const context = Number(created["executionContextId"]);
  await page.send("Runtime.evaluate", { expression: RECORDER_SOURCE, contextId: context, returnByValue: true }, { session: page.sessionFor(frame) });
  return context;
}

export async function capture(ctx: Ctx, page: Page, timeout: number, idle: number): Promise<{ events: RecEvent[]; startUrl: string; stoppedBy: string }> {
  const state = ctx.state;
  const startUrl = page.url;
  const events: RecEvent[] = [];
  let lastAt = monotonic();
  let closed = false;
  const contexts = new Set<number>();
  const listener: Listener = (source, method, params) => {
    if (source !== page) {
      if (source === null && method === "Target.targetDestroyed" && params["targetId"] === page.targetId) closed = true;
      return;
    }
    if (method === "Runtime.executionContextCreated") {
      const context = params["context"] as Record<string, unknown> | undefined;
      if (context && context["name"] === RECORD_WORLD && typeof context["id"] === "number") contexts.add(context["id"]);
    } else if (method === "Runtime.bindingCalled" && params["name"] === BINDING) {
      if (typeof params["executionContextId"] === "number") contexts.add(params["executionContextId"]);
      const event = parseEvent(params["payload"]);
      if (event !== null && events.length < MAX_EVENTS) {
        events.push(event);
        lastAt = monotonic();
      }
    } else if (method === "Page.frameNavigated") {
      const frame = params["frame"] as Record<string, unknown> | undefined;
      if (frame && !frame["parentId"] && typeof frame["url"] === "string" && events.length < MAX_EVENTS) events.push({ kind: "navigate", at: Date.now(), url: frame["url"] });
    } else if (method === "Inspector.detached" || method === "Inspector.targetCrashed") closed = true;
  };
  await page.enableRuntime();
  await page.send("Runtime.addBinding", { name: BINDING, executionContextName: RECORD_WORLD });
  const added = await page.send("Page.addScriptToEvaluateOnNewDocument", { source: RECORDER_SOURCE, worldName: RECORD_WORLD });
  const identifier = typeof added["identifier"] === "string" ? added["identifier"] : null;
  state.listeners.push(listener);
  let stoppedBy = "timeout";
  try {
    await page.refreshFrames();
    for (const frame of page.frames.keys()) {
      try {
        contexts.add(await installIn(page, frame));
      } catch (error) {
        if (error instanceof ConnectionLost) throw error;
      }
    }
    const deadline = monotonic() + timeout;
    for (;;) {
      if (closed) {
        stoppedBy = "the tab closed";
        break;
      }
      const now = monotonic();
      if (now >= deadline) break;
      if (events.some((event) => event.kind !== "navigate") && now - lastAt >= idle) {
        stoppedBy = "idle";
        break;
      }
      await sleep(POLL);
    }
  } finally {
    const at = state.listeners.indexOf(listener);
    if (at >= 0) state.listeners.splice(at, 1);
    if (!closed) {
      for (const [method, params] of [
        ["Page.removeScriptToEvaluateOnNewDocument", identifier ? { identifier } : null],
        ["Runtime.removeBinding", { name: BINDING }],
      ] as const) {
        if (params === null) continue;
        try {
          await page.send(method, params as Record<string, unknown>);
        } catch (error) {
          if (error instanceof ConnectionLost) throw error;
        }
      }
      for (const context of contexts) {
        try {
          await page.send("Runtime.evaluate", { expression: STOP_SOURCE, contextId: context, returnByValue: true });
        } catch (error) {
          if (error instanceof ConnectionLost) throw error;
        }
      }
    }
  }
  return { events, startUrl, stoppedBy };
}

function stepLines(flow: Json): string[] {
  return flow["steps"].map((step: Json) => {
    const action = step["action"] as Action;
    const by = action.candidates.length > 0 ? ` (by ${action.candidates.slice(0, 3).map((candidate) => selectorOf(candidate)).join(" | ")}${action.fingerprint ? ` | role ${action.fingerprint.role} "${action.fingerprint.name}"` : ""})` : "";
    return `[${step["seq"]}] ${action.intent}${by}`;
  });
}

export async function recordInteractions(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, positional] = parse(argv, FLAGS);
  if (positional.length > 0) throw new Usage("Usage: ardia browse record [--save <flow-name>] [--timeout 2m] [--idle 20s] [--here] [--description text]  (or record start <path.webm> for video)");
  const name = (options["save"] as string | undefined) ?? "recorded";
  checkName(name);
  const timeout = options["timeout"] ? secondsOf(options["timeout"] as string) : DEFAULT_TIMEOUT;
  const idle = options["idle"] ? secondsOf(options["idle"] as string) : DEFAULT_IDLE;
  if (timeout === undefined || timeout <= 0 || idle === undefined || idle <= 0) throw new Usage("--timeout and --idle take 30s, 2m or milliseconds");
  const state = ctx.state;
  const page = options["here"] ? await state.page() : await state.page(await state.takeActive());
  const { events, startUrl, stoppedBy } = await capture(ctx, page, Math.min(timeout, MAX_TIMEOUT), idle);
  const { flow, skipped } = recordedFlow(name, events, startUrl, (options["description"] as string | undefined) ?? null, cliVersion());
  count("flow_recorded_steps", flow["steps"].length);
  const actions = flow["steps"].filter((step: Json) => (step["action"] as Action).type !== "open");
  if (actions.length === 0) {
    throw new BrowseError(`Nothing was recorded in the tab before the recording stopped (${stoppedBy}): click, type or pick something in ${flowurl.hostLabel(startUrl)} while it runs`, { stoppedBy }, "nothing_recorded");
  }
  validate(flow);
  const lines = [`Recorded ${actions.length} actions on ${flow["site"]} (stopped: ${stoppedBy})`, ...stepLines(flow)];
  for (const item of skipped.slice(0, 5)) lines.push(`  left out ${item.why}`);
  const usage = flow["params"].map((param: Json) => `--param ${param["name"]}=…`).join(" ");
  const data: Json = { flow, skipped, stoppedBy };
  if (options["save"]) {
    const root = state.dataRoot;
    if (root === null) throw new BrowseError("This session has no data folder for flows");
    const path = save(root, flow);
    data["path"] = path;
    flag("flow_recorded", true);
    lines.push(`✓ Saved flow ${name} for ${flow["site"]} (${path})`, `→ ardia browse flow run ${name}${usage ? ` ${usage}` : ""}${flow["writes"] ? " --yes" : ""}`);
  } else {
    lines.push("→ add --save <name> to keep it as a flow; the definition:", dumps(pyValue(flow), "indented", false, false, 1));
  }
  return new Result(data, lines.join("\n"));
}
