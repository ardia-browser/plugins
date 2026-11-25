import { formatG } from "../../pylib/format.ts";
import { joinedWords, pyLen, reprText } from "../../pylib/str.ts";
import { casefold } from "../../pylib/unicode.ts";
import { sleep } from "../cdp/cancel.ts";
import { BrowseError, CdpError, ConnectionLost } from "../daemon-errors.ts";
import { FORMATS, normalize, SET_DIRECTLY, SET_VALUE } from "../fields.ts";
import { inputOf } from "../input/input.ts";
import {
  ACTIONS_CELL_EDITOR,
  ACTIONS_CELL_EDITOR_STATE,
  ACTIONS_CELL_FIND,
  ACTIONS_CELL_INNER,
  ACTIONS_CELL_NOW,
  ACTIONS_CELL_OF,
  ACTIONS_CELL_REVEAL,
  ACTIONS_CELL_START,
  ACTIONS_HOLDS_TEXT,
  ACTIONS_REPLACEMENT,
  ACTIONS_SETTLED_FRAMES,
} from "../js/index.ts";
import { add, flag } from "../metrics.ts";
import { Element, type Page } from "../state/page.ts";
import { monotonic } from "../state/wait.ts";
import { asRecord, expectInput, poll, POLL, pollTimes, textInserted } from "./common.ts";
import { checkedFrom, CHECK_STATE, HOLDS_FOCUS, matchOptions, OPTION_ROWS, type OptionRow, OVERLAY_INPUT, splitFinal } from "./choices.ts";
import { latchSecret, type Readback, readBack, secretField } from "./readback.ts";
import { click, scrollIntoView, targetPoint, waitEnabled } from "./pointer.ts";
import { masked } from "../state/secrets.ts";

export const SUGGESTION_TIMEOUT = 4.0;
export const SUGGESTION_HINT_WAIT = 1.2;
export const SUGGESTION_SETTLE = 0.35;
export const EXACT = 4;
export const PIECE = 3;
export const WORDS = 2;
export const MAX_SUGGESTIONS = 8;
export const EDITOR_WAIT = 1.0;
export const COMMIT_WAIT = 0.5;
export const COMMIT_CHECKS = Math.round(COMMIT_WAIT / POLL) + 1;
export const INSERTED_INPUT_TYPES = new Set(["text", "search", "email", "url", "tel", "number"]);
const EMAIL = /[^\s@<>()[\],;:"']+@[^\s@<>()[\],;:"']+\.[A-Za-z]{2,}/gu;
const NOT_EDITABLE_FACTS = `(el) => ({ role: (el.getAttribute("role") || el.tagName).toLowerCase(), name: ardiaBrowse.accessibleText(el).trim().slice(0, 60),
            popup: (el.getAttribute("aria-haspopup") || "").toLowerCase(), expands: el.hasAttribute("aria-expanded"),
            combo: ardiaBrowse.comboKind(el) })`;

export type Item = { text: string; exact?: string[]; pieces?: string[] };
export type Guard = (() => Promise<void>) | null;
export type Stored = string | Record<string, unknown> | null;

export const FIELD_FACTS = "(el) => Object.assign(ardiaBrowse.info(el), { kind: ardiaBrowse.comboKind(el), shown: document.visibilityState !== 'hidden' })";

export async function fieldFacts(page: Page, element: Element): Promise<Record<string, unknown>> {
  const facts = asRecord(await page.call(FIELD_FACTS, [element], { frame: element.frame, read: true }));
  if (facts["shown"]) page.shownAt = monotonic();
  return facts;
}

async function info(page: Page, element: Element): Promise<Record<string, unknown>> {
  return asRecord(await page.call("(el) => ardiaBrowse.info(el)", [element], { frame: element.frame }));
}

export async function focusField(page: Page, element: Element, facts: Record<string, unknown>, humanize: boolean, tolerateDetach = false): Promise<void> {
  try {
    if (humanize && !facts["focused"]) await click(page, element, true);
    else await page.focusElement(element);
  } catch (error) {
    if (!(error instanceof CdpError) || !tolerateDetach || !error.cdpMessage.includes("focusable")) throw error;
  }
}

export async function settleFocus(page: Page, element: Element, loader: string | null): Promise<[Element, boolean]> {
  if (await page.call("(el) => el.isConnected", [element], { frame: element.frame })) return [element, false];
  await page.refreshFrames();
  if (page.loader(element.frame) !== loader) throw new BrowseError(`The page navigated when ${element.label} was focused, so nothing was typed`, null, "element_replaced");
  const remote = await page.call(ACTIONS_REPLACEMENT, [element], { frame: element.frame, byValue: false });
  const replacement = await page.elementFrom(remote, element.frame, `the field that replaced ${element.label}`);
  if (replacement === null) {
    throw new BrowseError(
      `${element.label} was replaced when it was focused, and focus didn't land on a matching field in the same page, ` + "so nothing was typed. Snapshot again and use the new ref",
      null,
      "element_replaced",
    );
  }
  return [replacement, true];
}

export async function typeInto(page: Page, element: Element, text: string, humanize: boolean, guard: Guard = null): Promise<void> {
  const input = inputOf(page);
  const keyboard = input.keyboard(element, guard);
  const count = pyLen(text);
  await expectInput(page, element.frame, () => input.gesture("type", () => keyboard.typeText(text, humanize)), { keydown: count, keyup: count }, "The typing", element);
}

export async function clearField(page: Page, element: Element, humanize: boolean): Promise<void> {
  if (!(await info(page, element))["value"]) return;
  const input = inputOf(page);
  const guarded = (combo: string) => async () => {
    await refuseMovedFocus(page, element, "");
    await input.pressCombo(combo, humanize);
  };
  await expectInput(page, element.frame, () => input.gesture("clear", guarded("Meta+a")), { keydown: 2 }, "Select all", element);
  await expectInput(page, element.frame, () => input.gesture("clear", guarded("Backspace")), { keydown: 1 }, "Backspace", element);
  const held = await editableText(page, element);
  if (held["text"]) throw new BrowseError(`Couldn't clear ${element.label}; it still holds text`);
  if (held["chrome"]) flag("fill_cleared_beside_chrome", true);
}

async function editableText(page: Page, element: Element): Promise<Record<string, unknown>> {
  return asRecord(await page.call(ACTIONS_HOLDS_TEXT, [element], { frame: element.frame }));
}

export async function notEditableMessage(page: Page, element: Element): Promise<string> {
  let facts: Record<string, unknown>;
  try {
    facts = asRecord(await page.call(NOT_EDITABLE_FACTS, [element], { frame: element.frame, read: true }));
  } catch (error) {
    if (!(error instanceof BrowseError)) throw error;
    return `Element ${element.label} isn't an editable field`;
  }
  const named = facts["name"] ? `${String(facts["role"])} "${String(facts["name"])}"` : String(facts["role"]);
  if (facts["combo"]) return `${element.label} is a ${named}, not a text field: pick from it with \`select ${element.label} <option>\``;
  if ((facts["popup"] && facts["popup"] !== "false") || facts["expands"]) {
    return (
      `${element.label} is a ${named} that opens a picker, not a text field: click it, then click the value in what opens ` +
      "(a date picker's day button usually carries the full date as its name)"
    );
  }
  return `${element.label} is a ${named}, which takes no typing; use click, select or check`;
}

export const OVERLAY_WAIT = 1.0;

export type Filled = [boolean, Stored, (Readback | null)?];

export async function overlayInput(page: Page, element: Element): Promise<Element | null> {
  try {
    const remote = await page.call(OVERLAY_INPUT, [element], { frame: element.frame, byValue: false, read: true });
    return remote !== null && typeof remote === "object" ? await page.elementFrom(remote, element.frame, `the field that took focus from ${element.label}`) : null;
  } catch (error) {
    if (error instanceof BrowseError && !(error instanceof ConnectionLost)) return null;
    throw error;
  }
}

async function overlayAfterOpening(page: Page, element: Element, humanize: boolean): Promise<Element | null> {
  if ((await comboKind(page, element)) !== "button") return null;
  await click(page, element, humanize);
  return poll(() => overlayInput(page, element), OVERLAY_WAIT);
}

export async function fill(page: Page, given: Element, text: string, humanize: boolean, guard: Guard = null, known: Record<string, unknown> | null = null): Promise<Filled> {
  let element = given;
  let facts = known ?? (await info(page, element));
  if (facts["disabled"]) {
    await waitEnabled(page, element);
    facts = await info(page, element);
  }
  if (facts["tag"] === "select" && guard === null) return [false, await pickOption(page, element, text), null];
  let retargeted = false;
  let secret = secretField(facts);
  if (!facts["editable"] || facts["disabled"]) {
    const cell = guard === null ? await cellOf(page, element) : null;
    if (cell !== null) return [false, await fillCell(page, element, cell, text, humanize), null];
    const opened = guard === null ? await overlayAfterOpening(page, element, humanize) : null;
    if (opened === null) throw new BrowseError(await notEditableMessage(page, element), null, "not_editable");
    flag("fill_followed_focus", true);
    element = opened;
    retargeted = true;
    facts = await info(page, element);
    secret ||= secretField(facts);
  }
  if (facts["tag"] === "input" && SET_DIRECTLY.has(String(facts["type"]))) {
    const hidden = await latchSecret(page, element, secret);
    return [retargeted, await setValue(page, element, String(facts["type"]), text, hidden), null];
  }
  const loader = page.loader(element.frame);
  await focusField(page, element, facts, humanize, true);
  let replaced: boolean;
  [element, replaced] = await settleFocus(page, element, loader);
  const followed = await overlayInput(page, element);
  if (followed !== null) {
    flag("fill_followed_focus", true);
    element = followed;
    replaced = true;
    facts = await info(page, element);
    secret ||= secretField(facts);
  }
  retargeted = retargeted || replaced;
  secret = await latchSecret(page, element, secret);
  await clearField(page, element, humanize);
  if (text && insertsAtOnce(facts, humanize, guard)) await insertThenFinalKey(page, element, text);
  else if (text) await typeInto(page, element, text, humanize, guard);
  return [retargeted, null, text ? await readBack(page, element, text, secret) : null];
}

export function insertsAtOnce(facts: Record<string, unknown>, humanize: boolean, guard: Guard): boolean {
  if (humanize || guard !== null) return false;
  if (facts["tag"] === "input") return INSERTED_INPUT_TYPES.has(String(facts["type"] || "text"));
  return facts["tag"] === "textarea" || Boolean(facts["editable"]);
}

export async function pickOption(page: Page, element: Element, text: string): Promise<string> {
  const options = (await page.call(
    "(el) => Array.from(el.options).filter((o) => !o.disabled).map((o) => ({ text: (o.label || o.textContent || '').trim(), exact: [o.value] }))",
    [element],
    { frame: element.frame, read: true },
  )) as Item[] | null;
  let index: number;
  try {
    index = pickSuggestion(text, options ?? [], element.label);
  } catch (error) {
    if (!(error instanceof BrowseError)) throw error;
    throw new BrowseError(error.message.replaceAll("suggestion", "option"), error.data, error.code);
  }
  const option = (options as Item[])[index] as Item;
  await select(page, element, [(option.exact as string[])[0] as string]);
  flag("fill_picked_option", true);
  return option.text;
}

async function cellOf(page: Page, element: Element): Promise<Element | null> {
  const remote = await page.call(ACTIONS_CELL_OF, [element], { frame: element.frame, byValue: false, read: true });
  return remote !== null && typeof remote === "object" ? page.elementFrom(remote, element.frame, `the cell of ${element.label}`) : null;
}

export async function pressKey(page: Page, frame: string | null, key: string, humanize: boolean): Promise<void> {
  const input = inputOf(page);
  await expectInput(page, frame, () => input.gesture("press", () => input.pressCombo(key, humanize)), { keydown: 1 }, "The key press");
}

async function cellEditor(page: Page, cell: Element, humanize: boolean): Promise<[unknown, Element, boolean]> {
  const started = asRecord(await page.call(ACTIONS_CELL_START, [cell], { frame: cell.frame }));
  if (started["inner"]) {
    const inner = await page.call(ACTIONS_CELL_INNER, [], { frame: cell.frame, byValue: false });
    const field = await page.elementFrom(inner, cell.frame, `the field in ${cell.label}`);
    if (field !== null) return [started["was"], field, Boolean(started["open"])];
  }
  await scrollIntoView(page, cell, humanize);
  await page.call(ACTIONS_SETTLED_FRAMES, [], { frame: cell.frame, read: true });
  await page.call(ACTIONS_CELL_REVEAL, [], { frame: cell.frame });
  await page.call(ACTIONS_SETTLED_FRAMES, [], { frame: cell.frame, read: true });
  const found = await page.call(ACTIONS_CELL_FIND, [], { frame: cell.frame, byValue: false, read: true });
  const shown = found !== null && typeof found === "object" ? await page.elementFrom(found, cell.frame, cell.label) : null;
  if (shown === null) {
    throw new BrowseError(`The grid redrew ${cell.label} when it scrolled into view, and the cell couldn't be found again; snapshot and retry`, null, "element_replaced");
  }
  const focused = async () => {
    const remote = await page.call(ACTIONS_CELL_EDITOR, [shown], { frame: shown.frame, byValue: false, read: true });
    return remote !== null && typeof remote === "object" ? page.elementFrom(remote, shown.frame, `the editor of ${cell.label}`) : null;
  };
  await click(page, shown, humanize, 2);
  let editor = await poll(focused, EDITOR_WAIT);
  if (editor === null) {
    await pressKey(page, cell.frame, "Enter", humanize);
    editor = await poll(focused, EDITOR_WAIT);
  }
  if (editor === null) {
    throw new BrowseError(
      `Double-clicking ${cell.label} and pressing Enter opened no editor, so nothing was typed. Snapshot to see what it ` +
        "opened, or focus the cell and use `keyboard type <text>` then `press Enter`",
      null,
      "not_editable",
    );
  }
  return [started["was"], editor, true];
}

async function setEditor(page: Page, editor: Element, text: string, humanize: boolean): Promise<void> {
  const kind = await comboKind(page, editor);
  if (kind === "select") await pickOption(page, editor, text);
  else if (kind === "datalist") {
    const known = ((await page.call("(el) => ardiaBrowse.datalistValues(el)", [editor], { frame: editor.frame, read: true })) as string[] | null) ?? [];
    const levels = known.map((item) => matchLevel(text, { text: item, pieces: [] }, false));
    const best = Math.max(0, ...levels);
    await fill(page, editor, best && levels.filter((level) => level === best).length === 1 ? (known[levels.indexOf(best)] as string) : text, humanize);
  } else if (kind === "typeahead" || kind === "button") await choose(page, editor, [text], humanize, editor.label);
  else await fill(page, editor, text, humanize);
}

async function commitCell(page: Page, editor: Element, humanize: boolean, key = "Enter"): Promise<void> {
  const editorState = async () => asRecord(await page.call(ACTIONS_CELL_EDITOR_STATE, [editor], { frame: editor.frame, read: true }));
  if (!(await editorState())["open"]) return;
  await pressKey(page, editor.frame, key, humanize);
  if (await pollTimes(async () => ((await editorState())["open"] ? null : true), COMMIT_CHECKS)) return;
  const state = await editorState();
  try {
    await pressKey(page, editor.frame, "Escape", humanize);
  } catch (error) {
    if (!(error instanceof BrowseError)) throw error;
  }
  const message = state["message"] ? String(state["message"]) : "";
  const said = message ? `: ${message.replace(/\.+$/u, "")}` : "";
  throw new BrowseError(
    `The cell's editor stayed open after ${key}${said}. The edit was cancelled (Escape), so the cell keeps its old value`,
    { message: message || null },
    "rejected",
  );
}

async function fillCell(page: Page, element: Element, cell: Element, text: string, humanize: boolean, commit = "Enter"): Promise<Record<string, unknown> | null> {
  const labelled = new Element(cell.frame, cell.objectId, cell.backendId, element.label);
  const [was, editor, opened] = await cellEditor(page, labelled, humanize);
  const names = ((await page.call("(el) => ardiaBrowse.labelText(el)", [editor], { frame: editor.frame, read: true })) as unknown[] | null) ?? [];
  const name = names.map((item) => String(item)).find((item) => joinedWords(item) !== "");
  await setEditor(page, editor, text, humanize);
  add("cell_edits");
  if (!opened) return null;
  await commitCell(page, editor, humanize, commit);
  const now = await page.call(ACTIONS_CELL_NOW, [], { frame: cell.frame, read: true });
  return { cell: name !== undefined ? joinedWords(name) : element.label, value: now, was };
}

export async function editCell(page: Page, element: Element, text: string, humanize: boolean, commit = "Enter"): Promise<Record<string, unknown> | null> {
  const cell = await cellOf(page, element);
  if (cell === null) {
    throw new BrowseError(`${element.label} isn't a grid cell (no gridcell, cell or td holds it); use \`fill\` for a plain field`, null, "not_a_cell");
  }
  return fillCell(page, element, cell, text, humanize, commit);
}

export async function refuseMovedFocus(page: Page, element: Element, typed: string): Promise<void> {
  let held: unknown;
  try {
    held = await page.call(HOLDS_FOCUS, [element], { frame: element.frame, read: true });
  } catch (error) {
    if (!(error instanceof BrowseError) || error instanceof ConnectionLost) throw error;
    held = false;
  }
  if (held === true) return;
  flag("fill_focus_moved", true);
  if (!typed) {
    throw new BrowseError(
      `Focus moved off ${element.label} before any text was sent, so nothing was typed (it would have landed in another field). ` +
        "Snapshot to see where focus went, then fill it again",
      { sent: 0 },
      "focus_moved",
    );
  }
  throw new BrowseError(
    `Focus had moved off ${element.label} by the last keystroke, so that keystroke wasn't sent (it would have landed in another field). ` +
      `The text before it was sent while ${element.label} held focus, but focus may have moved while it went in, so check what ` +
      `${element.label} holds (get value) and where focus went (snapshot) before going on`,
    { sent: Array.from(typed).length },
    "focus_moved",
  );
}

export async function insertThenFinalKey(page: Page, element: Element, text: string): Promise<void> {
  const split = splitFinal(text);
  if (split === null) {
    await insertText(page, element, text, true);
    return;
  }
  const [head, last] = split;
  if (head) await insertText(page, element, head, true);
  flag("fill_final_key", true);
  const input = inputOf(page);
  const keyboard = input.keyboard();
  const pressLast = async () => {
    await refuseMovedFocus(page, element, head);
    await keyboard.typeText(last, false);
  };
  await expectInput(
    page,
    element.frame,
    () => input.gesture("fill", pressLast),
    { keydown: 1, keyup: 1 },
    "The last keystroke",
    element,
    null,
    textInserted(page, element.frame || page.mainFrame, last),
  );
}

export async function insertText(page: Page, element: Element, text: string, holdsFocus = false): Promise<void> {
  flag("fill_inserted_text", true);
  const input = inputOf(page);
  const send = async () => {
    if (holdsFocus) await refuseMovedFocus(page, element, "");
    return page.send("Input.insertText", { text }, { inputEvent: true });
  };
  await expectInput(
    page,
    element.frame,
    () => input.gesture("fill", send),
    { "beforeinput|input": 1 },
    "The text insert",
    element,
    null,
    textInserted(page, element.frame || page.mainFrame, text),
  );
}

export async function setValue(page: Page, element: Element, kind: string, text: string, hidden = false): Promise<string> {
  const wanted = normalize(kind, text);
  await page.focusElement(element);
  const outcome = asRecord(await page.call(SET_VALUE, [element, wanted], { frame: element.frame }));
  const raw = outcome["stored"];
  const stored = hidden && typeof raw === "string" ? masked(raw) : raw;
  if (!outcome["set"]) {
    const asked = hidden ? masked(wanted) : wanted;
    throw new BrowseError(`The ${kind} input ${element.label} refused ${reprText(asked)} (it holds ${reprValue(stored)}); ${FORMATS[kind]}`, { value: stored }, "bad_value");
  }
  return stored as string;
}

function reprValue(value: unknown): string {
  if (typeof value === "string") return reprText(value);
  if (value === null || value === undefined) return "None";
  return String(value);
}

export async function typeText(page: Page, given: Element, text: string, humanize: boolean): Promise<boolean> {
  const facts = await info(page, given);
  const loader = page.loader(given.frame);
  await focusField(page, given, facts, humanize, true);
  const [element, retargeted] = await settleFocus(page, given, loader);
  await latchSecret(page, element, secretField(facts));
  if (text && insertsAtOnce(facts, humanize, null)) await insertThenFinalKey(page, element, text);
  else await typeInto(page, element, text, humanize);
  return retargeted;
}

export async function checkedState(page: Page, element: Element): Promise<boolean | "mixed" | null> {
  return checkedFrom(await page.call(CHECK_STATE, [element], { frame: element.frame, read: true }));
}

export async function setChecked(page: Page, element: Element, wanted: boolean, humanize: boolean): Promise<boolean> {
  let facts = await info(page, element);
  const before = await checkedState(page, element);
  if (before === wanted || (before === null && facts["checked"] === wanted)) {
    flag("check_already_set", true);
    return false;
  }
  if (facts["disabled"]) await waitEnabled(page, element);
  let target: Element | null = element;
  try {
    await targetPoint(page, element, humanize, false);
  } catch (error) {
    if (!(error instanceof BrowseError) || error.code !== "not_visible") throw error;
    const label = await page.call("(el) => (el.labels && el.labels[0]) || null", [element], { frame: element.frame, byValue: false });
    target = await page.elementFrom(label, element.frame, `label of ${element.label}`);
    if (target === null) throw error;
  }
  await click(page, target, humanize);
  await sleep(0.05);
  facts = await info(page, element);
  const after = await checkedState(page, element);
  if ((after ?? facts["checked"]) !== wanted) throw new BrowseError(`Clicking ${element.label} didn't ${wanted ? "check" : "uncheck"} it`);
  return true;
}

export async function optionRows(page: Page, element: Element): Promise<OptionRow[] | null> {
  try {
    const rows = await page.call(OPTION_ROWS, [element], { frame: element.frame, read: true });
    return Array.isArray(rows) ? (rows as OptionRow[]) : null;
  } catch (error) {
    if (error instanceof BrowseError && !(error instanceof ConnectionLost)) return null;
    throw error;
  }
}

export async function select(page: Page, element: Element, values: string[]): Promise<unknown> {
  await waitEnabled(page, element);
  const rows = await optionRows(page, element);
  const chosen = rows === null ? values : matchOptions(values, rows, element.label);
  await page.focusElement(element);
  return page.call("(el, values) => ardiaBrowse.selectOptions(el, values)", [element, chosen], { frame: element.frame });
}

export function plain(text: unknown): string {
  return casefold(joinedWords(text === null || text === undefined || text === "" ? "" : String(text)));
}

export function matchLevel(value: string, item: Item, words = true): number {
  const wanted = plain(value);
  if (!wanted) return 0;
  const exact = [item.text, ...(item.exact ?? [])];
  const emails = exact.flatMap((each) => String(each).match(EMAIL) ?? []);
  if ([...exact, ...emails].some((each) => plain(each) === wanted)) return EXACT;
  if ((item.pieces ?? []).some((piece) => plain(piece) === wanted)) return PIECE;
  const shown = plain(item.text);
  if (!words) return shown.includes(wanted) ? 1 : 0;
  const composed = wanted.normalize("NFC");
  const composedShown = shown.normalize("NFC");
  if (!composedShown.includes(composed)) return 0;
  return wholeWords(composed, composedShown) ? WORDS : 1;
}

export function wholeWords(wanted: string, shown: string): boolean {
  const target = wanted.normalize("NFC");
  const escaped = target.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
  const joiner = "[.@_+'\u2019\\p{Pd}]";
  const before = `(?<![\\p{L}\\p{N}\\p{M}])(?<![\\p{L}\\p{N}\\p{M}]${joiner})`;
  const after = `(?![\\p{L}\\p{N}\\p{M}])(?!${joiner}[\\p{L}\\p{N}\\p{M}])`;
  return new RegExp(`${before}${escaped}${after}`, "u").test(shown.normalize("NFC"));
}

export function exactPick(value: string, items: readonly Item[]): number | null {
  const exact = items.flatMap((item, index) => (matchLevel(value, item) === EXACT ? [index] : []));
  return exact.length === 1 ? (exact[0] as number) : null;
}



export function pickSuggestion(value: string, items: readonly Item[], where: string, words = false): number {
  const levels = items.map((item) => matchLevel(value, item, words));
  const best = Math.max(0, ...levels);
  const listed =
    items
      .slice(0, MAX_SUGGESTIONS)
      .map((item) => `"${item.text}"`)
      .join(", ") + (items.length > MAX_SUGGESTIONS ? ` (and ${items.length - MAX_SUGGESTIONS} more)` : "");
  if (best === 0) {
    if (items.length === 0) throw new BrowseError(`No suggestions appeared in ${where} for "${value}"`, { suggestions: [] }, "no_match");
    throw new BrowseError(`None of the suggestions in ${where} match "${value}": ${listed}`, { suggestions: items.map((item) => item.text) }, "no_match");
  }
  const top = levels.flatMap((level, index) => (level === best ? [index] : []));
  if (top.length > 1) {
    const names = top
      .slice(0, MAX_SUGGESTIONS)
      .map((index) => `"${(items[index] as Item).text}"`)
      .join(", ");
    throw new BrowseError(
      `"${value}" matches ${top.length} suggestions in ${where}: ${names}. Give the full text or the email to pick one`,
      { suggestions: top.map((index) => (items[index] as Item).text) },
      "ambiguous",
    );
  }
  return top[0] as number;
}

export function uniqueMatch(value: string, items: readonly Item[]): boolean {
  try {
    pickSuggestion(value, items, "");
  } catch (error) {
    if (error instanceof BrowseError) return false;
    throw error;
  }
  return true;
}

export async function comboKind(page: Page, element: Element): Promise<string | null> {
  const kind = await page.call("(el) => ardiaBrowse.comboKind(el)", [element], { frame: element.frame, read: true });
  return typeof kind === "string" ? kind : null;
}

async function suggestionsNow(page: Page, element: Element): Promise<[Element[], Item[]]> {
  const remote = await page.call("(el) => ardiaBrowse.suggestions(el)", [element], { frame: element.frame, byValue: false, read: true });
  const items = ((await page.call("() => globalThis.ardiaBrowseSuggestions || []", [], { frame: element.frame, read: true })) as Item[] | null) ?? [];
  const options = await page.elementsFrom(remote, element.frame, "suggestion", 200);
  return [options, items.slice(0, options.length)];
}

async function unlinkedNote(page: Page, element: Element): Promise<string> {
  if (await page.call("(el) => ardiaBrowse.popupsOf(el).length", [element], { frame: element.frame, read: true })) return "";
  const lists = ((await page.call("(el) => ardiaBrowse.unlinkedListboxes(el)", [element], { frame: element.frame, read: true })) as string[] | null) ?? [];
  const shown = lists.length > 0 ? ` (visible lists: ${lists.join(", ")})` : "";
  return (
    "no list of suggestions is linked to this field (aria-controls, aria-owns, aria-activedescendant, or one inside the same " +
    `component)${shown}, so picking one automatically could pick another field's option. Click the option yourself: ` +
    "find role option click --name <text>"
  );
}

export const SUGGESTION_MOVED = "the suggestion \"{was}\" moved out from under the pointer as it arrived, so nothing was clicked; run select again";
export const SUGGESTION_CHANGED = "the suggestion \"{was}\" became \"{now}\" as the pointer reached it, so it wasn't clicked; run select again";

async function sameSuggestion(page: Page, option: Element, chosen: string): Promise<void> {
  const now = await page.call("(el) => el.isConnected ? [ardiaBrowse.optionFacts(el).text, el.matches(':hover')] : null", [option], { frame: option.frame, read: true });
  const [text, hovered] = Array.isArray(now) ? now : [null, false];
  if (text === chosen && hovered === true) return;
  if (text === chosen) throw new BrowseError(SUGGESTION_MOVED.replace("{was}", chosen), null, "target_replaced");
  throw new BrowseError(SUGGESTION_CHANGED.replace("{was}", chosen).replace("{now}", typeof text === "string" ? text : "gone"), null, "target_replaced");
}

export async function watchSuggestions(page: Page, element: Element): Promise<void> {
  await page.call("(el) => ardiaBrowse.watchSuggestions(el)", [element], { frame: element.frame });
}

export async function unwatchSuggestions(page: Page, element: Element): Promise<void> {
  try {
    await page.call("(el) => ardiaBrowse.unwatchSuggestions(el)", [element], { frame: element.frame });
  } catch (error) {
    if (!(error instanceof BrowseError)) throw error;
  }
}

type Watch = { busy: boolean; changed: number; since: number; now: number };

export function suggestionsReady(watch: Watch): boolean {
  return !watch.busy && watch.changed > 0 && watch.changed >= watch.since && (watch.now - watch.changed) / 1000 >= SUGGESTION_SETTLE;
}

export function quiet(watch: Watch): boolean {
  return !watch.busy && (watch.now - Math.max(watch.changed, watch.since)) / 1000 >= SUGGESTION_SETTLE;
}

export async function settledSuggestions(page: Page, element: Element, timeout: number, value: string | null = null): Promise<[Element[], Item[], boolean]> {
  const deadline = monotonic() + timeout;
  for (;;) {
    const watch = asRecord(await page.call("(el) => ardiaBrowse.suggestionState(el)", [element], { frame: element.frame, read: true })) as unknown as Watch;
    if (suggestionsReady(watch)) return [...(await suggestionsNow(page, element)), true];
    if (value !== null && quiet(watch)) {
      const [options, items] = await suggestionsNow(page, element);
      if (exactPick(value, items) !== null) return [options, items, false];
    }
    if (monotonic() >= deadline) return [...(await suggestionsNow(page, element)), false];
    await sleep(0.1);
  }
}

async function holdsText(page: Page, element: Element, value: string): Promise<boolean> {
  const wanted = plain(value);
  return wanted !== "" && plain((await info(page, element))["value"]) === wanted;
}

async function staleRefusal(page: Page, element: Element, value: string, items: readonly Item[], where: string, timeout: number): Promise<BrowseError> {
  const unlinked = await unlinkedNote(page, element);
  if (unlinked) return new BrowseError(`Nothing was picked in ${where}: ${unlinked}`, null, "no_fresh_suggestions");
  const listed = items
    .slice(0, MAX_SUGGESTIONS)
    .map((item) => `"${item.text}"`)
    .join(", ");
  const showing = items.length > 0 ? ` What's showing: ${listed}.` : "";
  return new BrowseError(
    `The suggestions in ${where} didn't change within ${formatG(timeout)} s after typing "${value}", so they may be for an earlier query, and ` +
      `none matches it exactly, so nothing was picked.${showing} Pick with the exact text or email, or click an option yourself ` +
      "(find role option click --name <text>)",
    { suggestions: items.map((item) => item.text) },
    "no_fresh_suggestions",
  );
}

export type Picked = { value: string; picked: string };

export async function choose(
  page: Page,
  element: Element,
  values: readonly string[],
  humanize: boolean,
  where: string,
  timeout = SUGGESTION_TIMEOUT,
  words = false,
): Promise<Picked[]> {
  const kind = await comboKind(page, element);
  if (kind !== null) await waitEnabled(page, element);
  if (kind === null) throw new BrowseError(`${element.label} isn't a <select> or a combobox, so there's nothing to pick from; use fill or click`, null, "not_selectable");
  const picked: Picked[] = [];
  for (const value of values) {
    if (kind === "datalist") {
      const known = ((await page.call("(el) => ardiaBrowse.datalistValues(el)", [element], { frame: element.frame, read: true })) as string[] | null) ?? [];
      const index = pickSuggestion(
        value,
        known.map((item) => ({ text: item, pieces: [] })),
        where,
      );
      await fill(page, element, known[index] as string, humanize);
      picked.push({ value, picked: known[index] as string });
      continue;
    }
    await watchSuggestions(page, element);
    let options: Element[];
    let items: Item[];
    let fresh: boolean;
    let index: number;
    try {
      if (kind === "typeahead") {
        if (await holdsText(page, element, value)) flag("select_retyped", true);
        await fill(page, element, value, humanize);
        [options, items, fresh] = await settledSuggestions(page, element, timeout, value);
      } else {
        const expanded = await page.call("(el) => el.getAttribute('aria-expanded') === 'true'", [element], { frame: element.frame, read: true });
        if (!expanded) {
          await click(page, element, humanize);
          [options, items, fresh] = await settledSuggestions(page, element, timeout, value);
        } else {
          [options, items] = await suggestionsNow(page, element);
          fresh = true;
        }
      }
      const found = fresh ? pickSuggestion(value, items, where, words && kind === "typeahead") : exactPick(value, items);
      if (found === null) throw await staleRefusal(page, element, value, items, where, timeout);
      index = found;
      if (items.length > 0 && (await page.call("(el) => ardiaBrowse.usedOpenedList(el)", [element], { frame: element.frame, read: true }))) flag("select_opened_list", true);
    } finally {
      await unwatchSuggestions(page, element);
    }
    if (matchLevel(value, items[index] as Item) === WORDS) flag("select_word_match", true);
    const option = options[index] as Element;
    const chosen = (items[index] as Item).text;
    const labelled = new Element(option.frame, option.objectId, option.backendId, `the suggestion "${chosen}"`);
    await click(page, labelled, humanize, 1, "left", () => sameSuggestion(page, option, chosen));
    picked.push({ value, picked: (items[index] as Item).text });
  }
  return picked;
}
