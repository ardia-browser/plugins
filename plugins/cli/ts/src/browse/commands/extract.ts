import { dumps } from "../../json.ts";
import { groupThousands } from "../../pylib/format.ts";
import { headPoints, joinedWords, pyLen } from "../../pylib/str.ts";
import { BrowseError, Usage } from "../daemon-errors.ts";
import { pyValue, Result } from "../daemon/render.ts";
import { count, flag } from "../metrics.ts";
import { luhnCard, MASKED, sensitiveFacts } from "../snapshot/mask.ts";
import { quoted } from "../snapshot/render.ts";
import type { Element, Page } from "../state/page.ts";
import { record } from "../state/records.ts";
import { isSecret, markSecret } from "../state/secrets.ts";
import type { Ctx } from "./ctx.ts";
import { register } from "./index.ts";
import { parse } from "./parse.ts";
import { frameOrMain } from "./shared.ts";

export const MAX_FIELDS = 200;
export const SHOWN_VALUE = 120;
export const QUERY_LIMIT = 50;
export const QUERY_MAX = 500;
export const CELL_TEXT = 300;

const FIELD_SELECTOR = [
  "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image])",
  "select",
  "textarea",
  "[contenteditable=''], [contenteditable=true]",
  "[role=checkbox], [role=radio], [role=switch], [role=combobox], [role=textbox], [role=searchbox], [role=spinbutton], [role=slider], [role=listbox]",
].join(", ");

export const MAX_EXAMINED = 5000;

const NATIVE_FIELD = "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]), select, textarea";

const FIELDS_OF = `(scope, all) => {
  ardiaBrowse.fieldsCut = false;
  const selector = ${JSON.stringify(FIELD_SELECTOR)};
  const root = scope ? ardiaBrowse.query(scope) : document;
  if (!root) return null;
  const shown = (el) => {
    if (ardiaBrowse.visible(el)) return true;
    if (el.type !== "checkbox" && el.type !== "radio") return false;
    return [...(el.labels || [])].some((label) => ardiaBrowse.visible(label));
  };
  const native = (el) => el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA";
  const holdsNative = (el) => !native(el) && el.querySelector(${JSON.stringify(NATIVE_FIELD)}) !== null;
  const nested = (el) => {
    if (native(el)) return false;
    const outer = el.parentElement ? el.parentElement.closest(selector) : null;
    return outer !== null && (root === document || root.contains(outer)) && outer.getAttribute("role") !== "listbox";
  };
  const kept = [];
  let examined = 0;
  const consider = (el) => {
    examined += 1;
    if (!holdsNative(el) && !nested(el) && (all || shown(el))) kept.push(el);
  };
  if (root !== document && root.matches && root.matches(selector)) consider(root);
  for (const el of root.querySelectorAll(selector)) {
    if (kept.length > ${MAX_FIELDS}) break;
    if (examined >= ${MAX_EXAMINED}) {
      ardiaBrowse.fieldsCut = true;
      break;
    }
    consider(el);
  }
  return kept;
}`;

const FACTS_OF = `(...els) => els.map((el) => {
  const clean = (text) => String(text || "").replace(/\\s+/g, " ").trim();
  const ownText = (root, skip) => {
    const chunks = [];
    const walk = (node) => {
      if (!node || node === skip) return;
      if (node.nodeType === 3) {
        if (node.nodeValue) chunks.push(node.nodeValue);
        return;
      }
      if (node.nodeType !== 1) return;
      if (["SELECT", "INPUT", "TEXTAREA", "BUTTON", "METER", "OUTPUT", "PROGRESS", "SCRIPT", "STYLE"].includes(node.tagName)) return;
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return;
      for (const child of node.childNodes) walk(child);
    };
    walk(root);
    return clean(chunks.join(" "));
  };
  const labelParts = () => {
    const parts = [];
    if (el.getAttribute("aria-label")) parts.push(el.getAttribute("aria-label"));
    const ids = (el.getAttribute("aria-labelledby") || "").split(/\\s+/).filter(Boolean);
    for (const id of ids) {
      const ref = document.getElementById(id);
      if (ref) parts.push(ownText(ref, el) || ref.innerText || ref.textContent);
    }
    if (el.labels) for (const lbl of el.labels) parts.push(ownText(lbl, el) || lbl.innerText || lbl.textContent);
    return parts.map(clean).filter(Boolean);
  };
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute("role") || "";
  const type = tag === "input" ? (el.type || "text") : tag === "select" ? (el.multiple ? "select-multiple" : "select") : tag === "textarea" ? "textarea" : role || (el.isContentEditable ? "contenteditable" : tag);
  const labels = labelParts();
  const label = labels[0] || clean(el.getAttribute("placeholder")) || clean(el.getAttribute("title")) || clean(el.getAttribute("name")) || el.id || "";
  const checkable = type === "checkbox" || type === "radio" || ["checkbox", "radio", "switch"].includes(role);
  let value = null;
  let options = null;
  let optionLabels = null;
  if (tag === "select") {
    value = [...el.selectedOptions].map((option) => clean(option.label || option.text)).join(", ");
    options = el.options.length;
    if (el.options.length <= 12) optionLabels = [...el.options].map((option) => clean(option.label || option.text)).filter(Boolean);
  } else if (!checkable && tag !== "input" && tag !== "textarea" && el.isContentEditable) value = el.innerText;
  else if (!checkable && "value" in el && (tag === "input" || tag === "textarea")) value = type === "file" ? [...(el.files || [])].map((file) => file.name).join(", ") : el.value;
  else if (!checkable) value = el.getAttribute("aria-valuetext") || el.getAttribute("aria-valuenow") || clean(el.textContent);
  let invalid = "";
  if (el.willValidate && el.validity && !el.validity.valid) invalid = el.validationMessage || "invalid";
  else if (el.getAttribute("aria-invalid") === "true") {
    const ids = (el.getAttribute("aria-errormessage") || el.getAttribute("aria-describedby") || "").split(/\\s+/).filter(Boolean);
    invalid = ids.map((id) => clean(document.getElementById(id) && document.getElementById(id).textContent)).filter(Boolean).join(" ") || "invalid";
  }
  return {
    tag, type, role, label,
    name: el.getAttribute("name") || "",
    value: value === null ? null : String(value),
    checked: checkable ? el.checked === true || el.getAttribute("aria-checked") === "true" : null,
    disabled: (el.matches(":disabled") && (tag === "input" || tag === "select" || tag === "textarea")) || el.getAttribute("aria-disabled") === "true",
    required: el.required === true || el.getAttribute("aria-required") === "true",
    readonly: el.readOnly === true || el.getAttribute("aria-readonly") === "true",
    invalid: clean(invalid),
    autocomplete: el.getAttribute("autocomplete") || "",
    options,
    optionLabels,
  };
})`;

const SUBMITS_OF = `(scope) => {
  const root = scope ? ardiaBrowse.query(scope) : document;
  if (!root) return [];
  const out = [];
  const seen = new Set();
  for (const el of root.querySelectorAll("button[type=submit], input[type=submit], form button:not([type])")) {
    if (seen.has(el) || !ardiaBrowse.visible(el)) continue;
    seen.add(el);
    out.push(el);
    if (out.length >= 6) break;
  }
  return out;
}`;

const SUBMIT_FACTS = `(...els) => els.map((el) => {
  const clean = (text) => String(text || "").replace(/\\s+/g, " ").trim();
  const label = clean(el.tagName === "INPUT" ? el.value : el.innerText) || clean(el.getAttribute("aria-label")) || clean(el.getAttribute("title")) || "";
  return { label, disabled: el.matches(":disabled") || el.getAttribute("aria-disabled") === "true" };
})`;

const ROLE_OF_TYPE: Readonly<Record<string, string>> = {
  checkbox: "checkbox",
  radio: "radio",
  search: "searchbox",
  number: "spinbutton",
  range: "slider",
  select: "combobox",
  "select-multiple": "listbox",
  file: "button",
};
const PLAIN_TYPES = new Set(["text", "textarea", "contenteditable", "select", "checkbox", "radio", "search", "number", "range"]);

export type Field = {
  ref: string;
  role: string;
  label: string;
  type: string;
  name: string;
  value: string | null;
  checked: boolean | null;
  disabled: boolean;
  required: boolean;
  readonly: boolean;
  invalid: string;
  options: number | null;
  optionLabels?: string[] | null;
};

export type SubmitControl = { ref: string; label: string; disabled: boolean };

function roleOf(facts: Record<string, unknown>): string {
  const role = String(facts["role"] || "");
  if (role) return role;
  return ROLE_OF_TYPE[String(facts["type"])] ?? "textbox";
}

function shownValue(text: string): string {
  const flat = joinedWords(text);
  return pyLen(flat) <= SHOWN_VALUE ? flat : `${headPoints(flat, SHOWN_VALUE - 1)}…`;
}

export const SECRET_INVALID = "invalid";

export function secretFacts(facts: Record<string, unknown>, latched = false): boolean {
  if (latched) return true;
  const said = [facts["label"], facts["name"]].map((item) => String(item ?? "")).join(" ");
  const value = facts["value"];
  return sensitiveFacts({ type: String(facts["type"] ?? "").toLowerCase(), autocomplete: String(facts["autocomplete"] ?? ""), said }) || (typeof value === "string" && luhnCard(value));
}

export function maskedValue(facts: Record<string, unknown>, secret = secretFacts(facts)): string | null {
  const value = facts["value"];
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (text === "") return "";
  return secret ? MASKED : text;
}

export function shownInvalid(facts: Record<string, unknown>, secret: boolean): string {
  const invalid = String(facts["invalid"] ?? "");
  return secret && invalid ? SECRET_INVALID : invalid;
}

export function fieldLine(field: Field): string {
  const marks: string[] = [];
  if (!PLAIN_TYPES.has(field.type) && field.type !== field.role) marks.push(`type=${field.type}`);
  if (field.checked !== null) marks.push(`checked=${field.checked}`);
  if (field.role === "radio" && field.name) marks.push(`group=${field.name}`);
  if (field.required) marks.push("required");
  if (field.disabled) marks.push("disabled");
  if (field.readonly) marks.push("readonly");
  if (field.invalid) marks.push(`invalid: ${field.invalid}`);
  marks.push(`ref=${field.ref}`);
  const label = field.label ? ` ${quoted(shownValue(field.label))}` : "";
  let value = "";
  if (field.checked === null && field.value !== null) {
    value = field.value === "" ? ": (empty)" : `: ${shownValue(field.value)}`;
    if (field.optionLabels && field.optionLabels.length > 0) value += ` [options: ${field.optionLabels.map((item) => quoted(shownValue(item))).join(", ")}]`;
    else if (field.options !== null) value += ` (of ${field.options})`;
  }
  return `- ${field.role}${label} [${marks.join(", ")}]${value}`;
}

export type Stop = "fields" | "candidates" | null;

export function stopNote(stop: Stop): string {
  if (stop === "fields") return `more past the first ${MAX_FIELDS}: narrow with -s <selector>`;
  if (stop === "candidates") return `stopped after ${groupThousands(String(MAX_EXAMINED))} candidates: narrow with -s <selector>`;
  return "";
}

export function formSummary(fields: readonly Field[], stop: Stop = null): string {
  const required = fields.filter((field) => field.required).length;
  const invalid = fields.filter((field) => field.invalid).length;
  const empty = fields.filter((field) => field.required && field.checked === null && field.value === "").length;
  const parts = [`${fields.length} field${fields.length === 1 ? "" : "s"}`];
  if (required) parts.push(`${required} required`);
  if (empty) parts.push(`${empty} required and empty`);
  if (invalid) parts.push(`${invalid} invalid`);
  return `form: ${parts.join(", ")}${stop === null ? "" : `; ${stopNote(stop)}`}`;
}

async function fieldsOf(ctx: Ctx, page: Page, frame: string, scope: string | null, all: boolean): Promise<{ fields: Field[]; stop: Stop }> {
  const remote = await page.call(FIELDS_OF, [scope, all], { frame, byValue: false, read: true });
  if (record(remote)["subtype"] === "null") throw new BrowseError(`Element not found: ${scope ?? ""}`, null, "not_found");
  const found: Element[] = await page.elementsFrom(remote, frame, "form field", MAX_FIELDS + 1);
  const cut = (await page.call("() => ardiaBrowse.fieldsCut === true", [], { frame, read: true })) === true;
  const stop: Stop = found.length > MAX_FIELDS ? "fields" : cut ? "candidates" : null;
  const elements = found.slice(0, MAX_FIELDS);
  if (elements.length === 0) return { fields: [], stop };
  const facts = await page.call(FACTS_OF, elements, { frame, read: true });
  const rows = Array.isArray(facts) ? facts.map(record) : [];
  const fields = rows.map((row, index) => {
    const role = roleOf(row);
    const label = String(row["label"] ?? "");
    const element = elements[index] as Element;
    const loader = page.loader(element.frame);
    const secret = secretFacts(row, isSecret(ctx.state, page, element.frame, loader, element.backendId));
    if (secret) markSecret(ctx.state, page, element.frame, loader, element.backendId);
    const ref = ctx.state.addRef(page, element, role, label);
    return {
      ref,
      role,
      label,
      type: String(row["type"] ?? ""),
      name: String(row["name"] ?? ""),
      value: maskedValue(row, secret),
      checked: typeof row["checked"] === "boolean" ? row["checked"] : null,
      disabled: Boolean(row["disabled"]),
      required: Boolean(row["required"]),
      readonly: Boolean(row["readonly"]),
      invalid: shownInvalid(row, secret),
      options: typeof row["options"] === "number" ? row["options"] : null,
      optionLabels: !secret && Array.isArray(row["optionLabels"]) ? row["optionLabels"].map((item) => (luhnCard(String(item)) ? MASKED : String(item))) : null,
    };
  });
  return { fields, stop };
}

async function submitsOf(ctx: Ctx, page: Page, frame: string, scope: string | null): Promise<SubmitControl[]> {
  const remote = await page.call(SUBMITS_OF, [scope], { frame, byValue: false, read: true });
  const elements = await page.elementsFrom(remote, frame, "submit button", 6);
  if (elements.length === 0) return [];
  const facts = await page.call(SUBMIT_FACTS, elements, { frame, read: true });
  const rows = Array.isArray(facts) ? facts.map(record) : [];
  return rows.map((row, index) => {
    const label = String(row["label"] ?? "");
    const ref = ctx.state.addRef(page, elements[index] as Element, "button", label);
    return { ref, label, disabled: Boolean(row["disabled"]) };
  });
}

function submitLine(submits: readonly SubmitControl[]): string {
  const items = submits.map((item) => `button${item.label ? ` ${quoted(shownValue(item.label))}` : ""} [${item.disabled ? "disabled, " : ""}ref=${item.ref}]`);
  return `submit: ${items.join(", ")}`;
}

export async function cmdForm(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, { "--selector": "value", "--all": "bool" }, { "-s": "--selector" });
  if (args.length > 1) throw new Usage("Usage: ardia browse form [<selector>] [-s <selector>] [--all]");
  const scope = (options["selector"] as string | undefined) ?? args[0] ?? null;
  const page = await ctx.state.page();
  await page.refreshFrames();
  const frame = frameOrMain(ctx, page);
  const { fields, stop } = await fieldsOf(ctx, page, frame, scope, Boolean(options["all"]));
  const submits = fields.length > 0 ? await submitsOf(ctx, page, frame, scope) : [];
  flag("form", true);
  count("form_fields", fields.length);
  const data = { url: page.url, count: fields.length, more: stop !== null, stopped: stop, fields, ...(submits.length > 0 ? { submits } : {}) };
  if (fields.length === 0) {
    const none = scope ? `No form fields in ${scope}` : "No form fields on this page";
    return new Result(data, stop === null ? none : `${none} among the first ${groupThousands(String(MAX_EXAMINED))} candidates; ${stopNote(stop)}`, true);
  }
  const lines = [formSummary(fields, stop), ...fields.map(fieldLine), ...(submits.length > 0 ? [submitLine(submits)] : [])];
  return new Result(data, lines.join("\n"), true);
}

export type FieldSpec = { key: string; selector: string | null; attribute: string | null };

const ATTRIBUTE = /@([A-Za-z_:][\w:.-]*)$/u;

export function splitTop(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (const char of text) {
    if (quote !== null) {
      if (char === quote) quote = null;
      current += char;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "[" || char === "(") depth += 1;
    else if ((char === "]" || char === ")") && depth > 0) depth -= 1;
    else if (char === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  out.push(current);
  return out.map((part) => part.trim()).filter((part) => part !== "");
}

export function fieldSpecs(given: readonly string[]): FieldSpec[] {
  const specs: FieldSpec[] = [];
  for (const part of given.flatMap(splitTop)) {
    const at = part.indexOf("=");
    const opensSelector = /[[("']/u.exec(part);
    const named = at > 0 && (opensSelector === null || at < opensSelector.index);
    const key = named ? part.slice(0, at).trim() : part;
    let selector = named ? part.slice(at + 1).trim() : part;
    if (!key || part.startsWith("=")) throw new Usage(`--fields takes name=selector pairs, like name=h2,price=.price,url=a@href; ${JSON.stringify(part)} has no name`);
    let attribute: string | null = null;
    const found = ATTRIBUTE.exec(selector);
    if (found !== null) {
      attribute = found[1] as string;
      selector = selector.slice(0, found.index);
    }
    specs.push({ key, selector: selector || null, attribute });
  }
  return specs;
}

export const MAX_COLUMNS = 30;

const ROWS_OF = `(selector, fields, limit, all, cap, columns) => {
  const clean = (text) => {
    const flat = String(text == null ? "" : text).replace(/\\s+/g, " ").trim();
    return flat.length > cap ? flat.slice(0, cap - 1) + "…" : flat;
  };
  const textOf = (el) => clean(el.innerText != null ? el.innerText : el.textContent);
  const read = (el, spec) => {
    const target = spec.selector ? (el.matches && el.matches(spec.selector) ? el : ardiaBrowse.query(spec.selector, el)) : el;
    if (!target) return null;
    if (spec.attribute) {
      const linked = (spec.attribute === "href" || spec.attribute === "src") && typeof target[spec.attribute] === "string" ? target[spec.attribute] : null;
      const raw = linked || target.getAttribute(spec.attribute);
      return raw == null ? null : clean(raw);
    }
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return clean(target.value);
    return textOf(target);
  };
  const headerCache = new Map();
  const headersOf = (table) => {
    if (headerCache.has(table)) return headerCache.get(table);
    const found = headersFound(table);
    headerCache.set(table, found);
    return found;
  };
  const headersFound = (table) => {
    const head = table.tHead && table.tHead.rows[0] ? table.tHead.rows[0] : [...table.rows].find((row) => [...row.cells].every((cell) => cell.tagName === "TH"));
    if (!head) return null;
    const used = new Set();
    return [...head.cells].slice(0, columns).map((cell, index) => unique(used, textOf(cell) || "column " + (index + 1)));
  };
  const unique = (used, base) => {
    let key = base;
    for (let times = 2; used.has(key); times += 1) key = base + " " + times;
    used.add(key);
    return key;
  };
  const rowOf = (row, headers) => {
    const out = {};
    const used = new Set();
    [...row.cells].slice(0, columns).forEach((cell, index) => { out[unique(used, (headers && headers[index]) || "column " + (index + 1))] = textOf(cell); });
    return out;
  };
  const rows = [];
  let more = false;
  const add = (make) => {
    if (rows.length >= limit) {
      more = true;
      return false;
    }
    rows.push(make());
    return true;
  };
  for (const el of ardiaBrowse.queryAll(selector)) {
    if (more) break;
    if (!all && !ardiaBrowse.visible(el)) continue;
    if (fields.length > 0) {
      add(() => {
        const row = {};
        for (const spec of fields) row[spec.key] = read(el, spec);
        return row;
      });
    } else if (el.tagName === "TABLE") {
      const headers = headersOf(el);
      for (const row of el.rows) {
        if ([...row.cells].every((cell) => cell.tagName === "TH")) continue;
        if (!all && !ardiaBrowse.visible(row)) continue;
        if (!add(() => rowOf(row, headers))) break;
      }
    } else if (el.tagName === "TR") {
      const table = el.closest("table");
      add(() => rowOf(el, table ? headersOf(table) : null));
    } else {
      add(() => {
        const row = { text: textOf(el) };
        const link = el.matches("a[href]") ? el : el.querySelector("a[href]");
        if (link) row.link = clean(link.href);
        return row;
      });
    }
  }
  return { rows, more };
}`;

export function rowsText(selector: string, shown: number, more: boolean, rows: readonly unknown[]): string {
  if (shown === 0) return `No visible matches for ${selector}`;
  const head = more ? `${shown} rows for ${selector}, and more match (--limit ${Math.min(shown * 2, QUERY_MAX)} for more):` : `${shown} row${shown === 1 ? "" : "s"} for ${selector}:`;
  return [head, ...rows.map((row) => dumps(pyValue(row), "spaced"))].join("\n");
}

export async function cmdQuery(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, { "--fields": "multi", "--field": "multi", "--limit": "value", "--all": "bool" });
  if (args.length !== 1) throw new Usage("Usage: ardia browse query <selector> [--fields name=sel,price=.price,url=a@href] [--limit n] [--all]");
  const selector = args[0] as string;
  const given = [...((options["fields"] as string[] | undefined) ?? []), ...((options["field"] as string[] | undefined) ?? [])];
  const fields = fieldSpecs(given);
  if (fields.length > MAX_COLUMNS) throw new Usage(`--fields takes up to ${MAX_COLUMNS} fields`);
  const limitText = options["limit"] as string | undefined;
  if (limitText !== undefined && !/^[0-9]+$/u.test(limitText)) throw new Usage(`--limit takes a number of rows, not ${limitText}`);
  const limit = Math.min(Math.max(limitText === undefined ? QUERY_LIMIT : Number(limitText), 1), QUERY_MAX);
  const page = await ctx.state.page();
  await page.refreshFrames();
  const frame = frameOrMain(ctx, page);
  let found: Record<string, unknown>;
  try {
    found = record(await page.call(ROWS_OF, [selector, fields, limit, Boolean(options["all"]), CELL_TEXT, MAX_COLUMNS], { frame, read: true }));
  } catch (error) {
    if (error instanceof BrowseError && error.code === "page_script_error") throw new BrowseError(`Invalid selector ${selector}: ${error.text}`, null, "usage_error");
    throw error;
  }
  const rows = Array.isArray(found["rows"]) ? (found["rows"] as unknown[]) : [];
  const more = found["more"] === true;
  flag("query", true);
  if (fields.length > 0) flag("query_fields", true);
  count("query_rows", rows.length);
  return new Result({ selector, count: rows.length, more, rows }, rowsText(selector, rows.length, more, rows), true);
}

register("form", cmdForm);
register("query", cmdQuery);
