import fs from "node:fs";
import { opaqueSlot } from "../opaque.ts";
import os from "node:os";
import path from "node:path";
import { formatG, groupThousands } from "../../pylib/format.ts";
import { joinedWords, pyFloat, pyLen } from "../../pylib/str.ts";
import { shlexQuote } from "../../pylib/shlex.ts";
import { click, hover, tap, TOUCH_OFF } from "../act/pointer.ts";
import { drag, listAfter, listBefore } from "../act/drag.ts";
import { choose, comboKind, fill, plain, select, settledSuggestions, SUGGESTION_HINT_WAIT, setChecked, type Item, typeText, uniqueMatch, unwatchSuggestions, watchSuggestions } from "../act/fields.ts";
import { asRecord, expectInput, mouseButton, overFrame, textInserted } from "../act/common.ts";
import { scroll, SCROLL_DEFAULT } from "../act/scroll.ts";
import { scrollIntoView } from "../act/pointer.ts";
import { attach, observe, type Reaction, TimedOut, within } from "../changes/observe.ts";
import { type Report } from "../changes/report.ts";
import { BrowseError, Gated, Usage } from "../daemon-errors.ts";
import { Result } from "../daemon/render.ts";
import { inputOf } from "../input/input.ts";
import { COMMANDS_FETCH_BYTES, COMMANDS_PAGE_TEXT_MARK } from "../js/index.ts";
import { flag } from "../metrics.ts";
import type { Element, Page } from "../state/page.ts";
import type { Json } from "../state/records.ts";
import { newTab } from "./core.ts";
import type { Ctx } from "./ctx.ts";
import { register } from "./index.ts";
import { leadingSelector, need, parse, SELECTOR_ALIAS, SELECTOR_FLAG, withSelector } from "./parse.ts";

export const APPEAR_WAIT = 3.0;
const CHECKS_PRESENCE = new Set(["is"]);
export const NO_REACTION_HINT =
  "\n→ Nothing else on the page changed yet. Some fields only apply when you press Enter or leave them: " + "`press Enter` or `press Tab`, then check again";
export const DOWNLOAD_FETCH_LIMIT = 50 * 1024 * 1024;

export async function resolve(ctx: Ctx, selector: string): Promise<[Page, Element]> {
  return ctx.state.locate(selector, null, CHECKS_PRESENCE.has(ctx.command) ? 0 : APPEAR_WAIT);
}

function humanizing(ctx: Ctx, options: Record<string, unknown>): boolean {
  return ctx.humanize && !options["no_humanize"];
}

function withText(result: Result, text: string, data: Record<string, unknown> = {}): Result {
  const made = new Result({ ...(result.data as Record<string, unknown>), ...data }, text, result.pageContent);
  made.failed = result.failed;
  return made;
}

export function consentNote(ctx: Ctx, given: Result): Result {
  let result = given;
  const note = ctx.state.consentDismissed;
  ctx.state.consentDismissed = null;
  if (note) result = withText(result, `${result.text || "✓ Done"}\n${note}`, { dismissed: note });
  const fallback = ctx.state.clickNote;
  ctx.state.clickNote = null;
  if (fallback) result = withText(result, `${result.text || "✓ Done"}\n${fallback}`, { domClick: fallback });
  return result;
}

async function cmdClick(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, given] = parse(argv, { "--new-tab": "bool", "--button": "value", "--no-humanize": "bool", "--touch": "bool", ...SELECTOR_FLAG }, SELECTOR_ALIAS);
  const args = withSelector(options, given, 0, 0);
  need(args, 1, "click <selector> [--new-tab]");
  const selector = args[0] as string;
  const [page, element] = await resolve(ctx, selector);
  const humanize = humanizing(ctx, options);
  if (options["new_tab"]) {
    const href = await page.call("(el) => { const a = el.closest('a[href]'); return a ? a.href : null; }", [element], { frame: element.frame });
    if (!href) throw new BrowseError(`--new-tab needs a link; ${selector} has no href`);
    const previous = ctx.state.current;
    const tab = await newTab(ctx, String(href));
    ctx.state.current = previous || tab.targetId;
    return new Result({ clicked: selector, newTab: ctx.state.tabId(tab.targetId), url: tab.url });
  }
  if (options["touch"]) {
    const [touched, report] = await observe(ctx, page, () => tap(page, element, humanize));
    const done = touched ? new Result({ clicked: selector, touch: true }) : new Result({ clicked: selector, touch: false }, `✓ Done (${TOUCH_OFF})`);
    return consentNote(ctx, attach(done, report));
  }
  const [, report] = await observe(ctx, page, () => click(page, element, humanize, 1, (options["button"] as string | undefined) || "left"));
  return consentNote(ctx, attach(new Result({ clicked: selector }), report));
}

async function cmdDblclick(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, { "--no-humanize": "bool" });
  need(args, 1, "dblclick <selector>");
  const [page, element] = await resolve(ctx, args[0] as string);
  const [, report] = await observe(ctx, page, () => click(page, element, humanizing(ctx, options), 2));
  return consentNote(ctx, attach(new Result({ clicked: args[0], count: 2 }), report));
}

async function cmdHover(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, { "--no-humanize": "bool" });
  need(args, 1, "hover <selector>");
  const [page, element] = await resolve(ctx, args[0] as string);
  const [, report] = await observe(ctx, page, () => hover(page, element, humanizing(ctx, options)));
  return attach(new Result({ hovered: args[0] }), report);
}

async function cmdFocus(ctx: Ctx, argv: string[]): Promise<Result> {
  const [, args] = parse(argv, { "--no-humanize": "bool" });
  need(args, 1, "focus <selector>");
  const [page, element] = await resolve(ctx, args[0] as string);
  const [, report] = await observe(ctx, page, () => page.focusElement(element));
  return attach(new Result({ focused: args[0] }), report);
}

function onlyTheFieldChanged(report: Report | null): boolean {
  if (!report || report.document !== "same" || report.unsettled) return false;
  const quiet = !(report.added.length || report.removed.length || report.network.length || report.text || report.url || report.title);
  return quiet && report.changed.length <= 1;
}

async function pageTextMark(page: Page, element: Element): Promise<unknown> {
  try {
    return await page.call(COMMANDS_PAGE_TEXT_MARK, [], { frame: element.frame, read: true });
  } catch (error) {
    if (error instanceof BrowseError) return null;
    throw error;
  }
}

async function isInput(page: Page, element: Element): Promise<boolean> {
  let facts: Record<string, unknown>;
  try {
    facts = asRecord(await page.call("(el) => ardiaBrowse.info(el)", [element], { frame: element.frame, read: true }));
  } catch (error) {
    if (error instanceof BrowseError) return false;
    throw error;
  }
  return facts["tag"] === "input" && ["text", "number", "search", "tel"].includes(String(facts["type"] || "text"));
}

export function typedResult(key: string, selector: string, retargeted: boolean): Result {
  if (!retargeted) return new Result({ [key]: selector });
  return new Result({ [key]: selector, retargeted: true }, `✓ Done (the page replaced ${selector} with a new field when it was focused; typed into that one)`);
}

export function filledResult(key: string, selector: string, retargeted: boolean, text: string, stored: unknown): Result {
  if (stored === null || stored === undefined) return typedResult(key, selector, retargeted);
  if (typeof stored === "object") {
    const cell = stored as Record<string, unknown>;
    const now = cell["value"];
    const shown = now === null || now === undefined ? "(couldn't read it back)" : String(now) || "empty";
    return new Result(
      { [key]: selector, cell: cell["cell"], value: now ?? null, was: cell["was"] },
      `✓ Done\n~ gridcell "${String(cell["cell"])}": ${shown} (was ${String(cell["was"] || "") || "empty"})`,
    );
  }
  const note = stored === text ? "✓ Done" : `✓ Done (the field holds ${String(stored) || "nothing"})`;
  return new Result({ [key]: selector, value: stored }, note);
}

function samePair(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function cmdFill(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(leadingSelector(argv), { "--no-humanize": "bool" }, {}, (positionals) => opaqueSlot("fill", positionals));
  need(args, 2, "fill <selector> <text>");
  const selector = args[0] as string;
  const [page, element] = await resolve(ctx, selector);
  const text = args.slice(1).join(" ");
  const humanize = humanizing(ctx, options);
  const typeahead = (await comboKind(page, element)) === "typeahead";
  const run = async (): Promise<[[boolean, unknown], Item[]]> => {
    if (!(typeahead && text)) return [await fill(page, element, text, humanize), []];
    await watchSuggestions(page, element);
    try {
      const filled = await fill(page, element, text, humanize);
      return [filled, (await settledSuggestions(page, element, SUGGESTION_HINT_WAIT))[1]];
    } finally {
      await unwatchSuggestions(page, element);
    }
  };
  const textBefore = await pageTextMark(page, element);
  const react: Reaction | null = typeahead ? null : [element, null];
  const [[[retargeted, stored], found], report] = await observe(ctx, page, run, react);
  let result = filledResult("filled", selector, retargeted, text, stored);
  if (found.length > 0) {
    const best = uniqueMatch(text, found) ? text : (found[0] as Item).text;
    result = withText(
      result,
      `${result.text}\n→ ${found.length} suggestion${found.length !== 1 ? "s" : ""} showing, none picked. ` + `To pick one: ardia browse select ${selector} ${shlexQuote(best)}`,
      { suggestions: found.map((item) => item.text) },
    );
  }
  result = attach(result, report);
  if (
    text &&
    !typeahead &&
    found.length === 0 &&
    (stored === null || stored === undefined) &&
    textBefore !== null &&
    onlyTheFieldChanged(report) &&
    (await isInput(page, element)) &&
    samePair(await pageTextMark(page, element), textBefore)
  ) {
    flag("fill_no_reaction_hint", true);
    result = withText(result, `${result.text}${NO_REACTION_HINT}`);
  }
  return result;
}

async function cmdType(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, { "--no-humanize": "bool", "--delay": "value" }, {}, (positionals) => opaqueSlot("type", positionals));
  need(args, 2, "type <selector> <text>");
  const [page, element] = await resolve(ctx, args[0] as string);
  const [retargeted, report] = await observe(ctx, page, () => typeText(page, element, args.slice(1).join(" "), humanizing(ctx, options)), [element, null]);
  return attach(typedResult("typed", args[0] as string, retargeted), report);
}

async function cmdPress(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, { "--no-humanize": "bool" });
  need(args, 1, "press [selector] <key>");
  const humanize = humanizing(ctx, options);
  if (args.length >= 2) {
    const key = args[1] as string;
    const [page, element] = await resolve(ctx, args[0] as string);
    const frame = element.frame || page.mainFrame;
    const input = inputOf(page);
    const focusAndPress = async () => {
      flag("press_targeted", true);
      await page.focusElement(element);
      return input.gesture("press", () => input.pressCombo(key, humanize));
    };
    const [, report] = await observe(ctx, page, () => expectInput(page, frame, focusAndPress, { keydown: 1 }, "The key press"), [element, null]);
    return attach(new Result({ pressed: key, in: args[0] }), report);
  }
  const page = await ctx.state.page();
  const frame = ctx.state.frameFor(page) || page.mainFrame;
  const input = inputOf(page);
  const [, report] = await observe(
    ctx,
    page,
    () => expectInput(page, frame, () => input.gesture("press", () => input.pressCombo(args[0] as string, humanize)), { keydown: 1 }, "The key press"),
    [null, frame],
  );
  return attach(new Result({ pressed: args[0] }), report);
}

async function cmdKeydown(ctx: Ctx, argv: string[]): Promise<Result> {
  const [, args] = parse(argv, { "--no-humanize": "bool" });
  need(args, 1, `${ctx.command} <key>`);
  const page = await ctx.state.page();
  const down = ctx.command === "keydown";
  const frame = ctx.state.frameFor(page) || page.mainFrame;
  const input = inputOf(page);
  await expectInput(
    page,
    frame,
    () => input.gesture(ctx.command, () => input.pressCombo(args[0] as string, false, down, !down), { keepHeld: true }),
    { [down ? "keydown" : "keyup"]: 1 },
    `The ${ctx.command}`,
  );
  return new Result({ key: args[0], [down ? "down" : "up"]: true });
}

async function cmdKeyboard(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, { "--no-humanize": "bool" }, {}, (positionals) => opaqueSlot("keyboard", positionals));
  need(args, 2, "keyboard type|inserttext <text>");
  const page = await ctx.state.page();
  const text = args.slice(1).join(" ");
  const input = inputOf(page);
  const frame = ctx.state.frameFor(page) || page.mainFrame;
  if (args[0] === "inserttext") {
    await page.requireVisible();
    const [, report] = await observe(
      ctx,
      page,
      () =>
        expectInput(
          page,
          frame,
          () => input.gesture("keyboard inserttext", () => page.send("Input.insertText", { text }, { inputEvent: true })),
          text ? { "beforeinput|input": 1 } : {},
          "The text insert",
          null,
          text ? textInserted(page, frame, text) : null,
        ),
      [null, frame],
    );
    return attach(new Result({ inserted: true }), report);
  }
  if (args[0] !== "type") throw new Usage(`Unknown keyboard subcommand: ${args[0]} (type or inserttext)`);
  const keyboard = input.keyboard();
  const humanize = humanizing(ctx, options);
  const [, report] = await observe(
    ctx,
    page,
    () => expectInput(page, frame, () => input.gesture("keyboard type", () => keyboard.typeText(text, humanize)), { keydown: pyLen(text) }, "The typing"),
    [null, frame],
  );
  return attach(new Result({ typed: true }), report);
}

async function cmdCheck(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, { "--no-humanize": "bool" });
  need(args, 1, `${ctx.command} <selector>`);
  const [page, element] = await resolve(ctx, args[0] as string);
  const wanted = ctx.command === "check";
  const [, report] = await observe(ctx, page, () => setChecked(page, element, wanted, humanizing(ctx, options)));
  return attach(new Result({ [wanted ? "checked" : "unchecked"]: args[0] }), report);
}

async function fieldName(page: Page, element: Element, selector: string): Promise<string> {
  const names = await page.call("(el) => ardiaBrowse.labelText(el).concat([el.getAttribute('placeholder') || ''])", [element], { frame: element.frame, read: true });
  const found = (Array.isArray(names) ? names : []).map((item) => joinedWords(String(item))).find((item) => item !== "");
  return found ? `"${found}" (${selector})` : selector;
}

export async function selectIn(ctx: Ctx, page: Page, element: Element, selector: string, values: string[], humanize: boolean): Promise<Result> {
  if ((await comboKind(page, element)) === "select") {
    const [, report] = await observe(ctx, page, () => select(page, element, values));
    return attach(new Result({ selected: values }), report);
  }
  const where = await fieldName(page, element, selector);
  const [picked, report] = await observe(ctx, page, () => choose(page, element, values, humanize, where, undefined, true));
  const text = picked.map((item) => `✓ Picked "${item.picked}"` + (plain(item.picked) !== plain(item.value) ? ` for "${item.value}"` : "")).join("\n");
  return attach(new Result({ selected: values, picked: picked.map((item) => item.picked) }, text), report);
}

async function cmdSelect(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, { "--no-humanize": "bool" });
  need(args, 2, "select <selector> <value...>");
  const [page, element] = await resolve(ctx, args[0] as string);
  return selectIn(ctx, page, element, args[0] as string, args.slice(1), humanizing(ctx, options));
}

export function dragText(outcome: Record<string, unknown>): string {
  let text: string;
  if (!outcome["html5"]) text = "✓ Done";
  else if (!outcome["started"]) text = "✓ Done (the page didn't start an HTML5 drag, so it was a plain mouse drag)";
  else if (outcome["dropped"] === false) text = "✓ Done (HTML5 drag; the target didn't accept the drop, so the page got no drop event)";
  else text = "✓ Done (HTML5 drag and drop)";
  const position = outcome["position"] as Record<string, unknown> | undefined;
  if (position && position["to"] !== position["from"]) text += `\nmoved to ${String(position["to"])} of ${String(position["count"])} (was ${String(position["from"])})`;
  else if (position) text += `\nthe order didn't change: still ${String(position["to"])} of ${String(position["count"])}`;
  if (outcome["interceptionLeftOn"]) text += "\n  Ardia didn't confirm drag interception was turned off; it ends when this session disconnects (30 s idle)";
  return text;
}

async function cmdDrag(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, { "--no-humanize": "bool", "--before": "bool", "--after": "bool" });
  need(args, 2, "drag <source> <target> [--before|--after]");
  if (options["before"] && options["after"]) throw new Usage("drag takes --before or --after, not both");
  const side = options["before"] ? "before" : options["after"] ? "after" : null;
  if (side) flag("drag_side_given", true);
  const [page, source] = await resolve(ctx, args[0] as string);
  const [targetPage, target] = await resolve(ctx, args[1] as string);
  if (targetPage !== page) throw new BrowseError("Both ends of a drag must be in the same tab");
  const listed = await listBefore(page, source, target);
  const [outcome, report] = await observe(ctx, page, () => drag(page, source, target, humanizing(ctx, options), side));
  if (listed) {
    const position = await listAfter(page, source.frame, listed);
    if (position) outcome["position"] = position;
  }
  return attach(new Result({ dragged: args[0], to: args[1], ...outcome }, dragText(outcome)), report);
}

function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

async function cmdUpload(ctx: Ctx, argv: string[]): Promise<Result> {
  const [, args] = parse(argv);
  need(args, 2, "upload <selector> <files...>");
  const files = args.slice(1).map((item) => ctx.path(item));
  for (const item of files) if (!isFile(item)) throw new BrowseError(`No such file: ${item}`);
  const [page, element] = await resolve(ctx, args[0] as string);
  const run = async () => {
    try {
      await page.send("DOM.setFileInputFiles", { files, backendNodeId: element.backendId });
    } catch (error) {
      if (error instanceof Gated) throw error.during("upload");
      throw error;
    }
  };
  const [, report] = await observe(ctx, page, run);
  return attach(new Result({ uploaded: files }), report);
}

async function cmdScroll(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, { "--selector": "value", "--no-humanize": "bool" }, { "-s": "--selector" });
  const direction = args.length > 0 ? (args[0] as string) : "down";
  const amount = args.length > 1 ? pyFloat(args[1] as string) : SCROLL_DEFAULT;
  let page = await ctx.state.page();
  let element: Element | null = null;
  if (options["selector"]) [page, element] = await resolve(ctx, options["selector"] as string);
  const here = page;
  const [, report] = await observe(ctx, here, () => scroll(here, direction, amount, humanizing(ctx, options), element));
  return attach(new Result({ scrolled: true }), report);
}

async function cmdScrollintoview(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, { "--no-humanize": "bool" });
  need(args, 1, "scrollintoview <selector>");
  const [page, element] = await resolve(ctx, args[0] as string);
  const humanize = humanizing(ctx, options);
  await inputOf(page).gesture("scrollintoview", () => scrollIntoView(page, element, humanize), { allowHidden: true });
  return new Result({ scrolled: args[0] });
}

async function cmdMouse(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, { "--no-humanize": "bool" });
  need(args, 1, "mouse move <x> <y> | down [button] | up [button] | wheel <dy> [dx]");
  const page = await ctx.state.page();
  const input = inputOf(page);
  const mouse = input.pointer;
  const humanize = humanizing(ctx, options);
  const action = args[0];
  if (action === "move") {
    need(args, 3, "mouse move <x> <y>");
    const x = pyFloat(args[1] as string);
    const y = pyFloat(args[2] as string);
    const needs = (await overFrame(page, x, y)) ? {} : { mousemove: 1 };
    await expectInput(page, page.mainFrame, () => input.gesture("mouse move", () => mouse.move(x, y, humanize), { keepHeld: true }), needs, "The mouse move");
    return new Result({ moved: true });
  }
  if (action === "down" || action === "up") {
    const button = mouseButton(args.length > 1 ? args[1] : null);
    const run = action === "down" ? () => mouse.down(button) : () => mouse.up(button);
    const [x, y] = mouse.position;
    const over = await overFrame(page, x, y);
    await expectInput(page, page.mainFrame, () => input.gesture(`mouse ${action}`, run, { keepHeld: true }), over ? {} : { [action === "down" ? "mousedown|pointerdown" : "mouseup|pointerup"]: 1 }, `The mouse ${action}`);
    return new Result({ [action]: true });
  }
  if (action === "wheel") {
    need(args, 2, "mouse wheel <dy> [dx]");
    const dy = pyFloat(args[1] as string);
    const dx = args.length > 2 ? pyFloat(args[2] as string) : 0;
    const [x, y] = mouse.position;
    const over = await overFrame(page, x, y);
    const wheel = { type: "mouseWheel", x: Math.trunc(x), y: Math.trunc(y), deltaX: dx, deltaY: dy };
    await expectInput(
      page,
      page.mainFrame,
      () => input.gesture("mouse wheel", () => page.send("Input.dispatchMouseEvent", wheel, { inputEvent: true }), { keepHeld: true }),
      over ? {} : { wheel: 1 },
      "The wheel",
    );
    return new Result({ scrolled: true });
  }
  throw new Usage(`Unknown mouse action: ${action}`);
}

async function fetchAgain(ctx: Ctx, url: string): Promise<Buffer> {
  const remote = "The browser saved the file on its own machine (a browser reached with --ws on another host), and fetching it again from the page failed";
  if (!url) throw new BrowseError(`${remote}: the download had no address`, null, "download_remote");
  const page = await ctx.state.page();
  let got: Record<string, unknown>;
  try {
    got = asRecord(await page.call(COMMANDS_FETCH_BYTES, [url, DOWNLOAD_FETCH_LIMIT], { frame: page.mainFrame, read: true }));
  } catch (error) {
    if (!(error instanceof BrowseError)) throw error;
    throw new BrowseError(`${remote}: ${error.message}`, null, "download_remote");
  }
  if (Object.keys(got).length === 0 || got["status"]) {
    throw new BrowseError(`${remote}: HTTP ${Object.keys(got).length > 0 ? String(got["status"]) : "no answer"}`, null, "download_remote");
  }
  if (got["size"]) {
    throw new BrowseError(
      `${remote}: the file is ${groupThousands(String(got["size"]))} bytes, over the ${groupThousands(String(DOWNLOAD_FETCH_LIMIT))}-byte limit`,
      null,
      "download_remote",
    );
  }
  flag("download_fetched_again", true);
  return Buffer.from(String(got["data"]), "base64");
}

export async function waitDownload(ctx: Ctx, trigger: (() => Promise<void>) | null, destination: string | null, timeout: number): Promise<string> {
  await ctx.state.connect();
  const browser = ctx.state.browser;
  if (browser === null) throw new BrowseError("not connected");
  const folder = destination ? path.dirname(destination) : fs.mkdtempSync(path.join(os.tmpdir(), "ardia-browse-download-"));
  try {
    await browser.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: folder, eventsEnabled: true });
  } catch (error) {
    if (error instanceof Gated) throw error.during(trigger ? "download" : "wait --download");
    throw error;
  }
  const seen: { guid?: unknown; name?: string; url?: string } = {};
  let finish: (state: string) => void = () => {};
  let finished = false;
  const done = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const listener = (_page: unknown, method: string, params: Json) => {
    if (method === "Browser.downloadWillBegin" && Object.keys(seen).length === 0) {
      Object.assign(seen, { guid: params["guid"], name: String(params["suggestedFilename"] || "download"), url: String(params["url"] || "") });
    }
    if (method === "Browser.downloadProgress" && params["guid"] === seen.guid && (params["state"] === "completed" || params["state"] === "canceled") && !finished) {
      finished = true;
      finish(String(params["state"]));
    }
  };
  ctx.state.listeners.push(listener);
  let outcome: string;
  try {
    if (trigger !== null) await trigger();
    try {
      outcome = await within(done, timeout);
    } catch (error) {
      if (error instanceof TimedOut) throw new BrowseError(`No download finished in ${formatG(timeout)}s`, null, "timeout");
      throw error;
    }
  } finally {
    const at = ctx.state.listeners.indexOf(listener);
    if (at >= 0) ctx.state.listeners.splice(at, 1);
    try {
      await browser.send("Browser.setDownloadBehavior", { behavior: "default" });
    } catch (error) {
      if (!(error instanceof BrowseError)) throw error;
    }
  }
  if (outcome !== "completed") throw new BrowseError("The download was canceled");
  const target = destination || path.join(folder, path.basename(seen.name ?? "download"));
  const saved = path.join(folder, String(seen.guid));
  if (fs.existsSync(saved)) fs.renameSync(saved, target);
  else fs.writeFileSync(target, await fetchAgain(ctx, seen.url ?? ""));
  return target;
}

async function cmdDownload(ctx: Ctx, argv: string[]): Promise<Result> {
  const [, args] = parse(argv);
  need(args, 2, "download <selector> <path>");
  const [page, element] = await resolve(ctx, args[0] as string);
  await waitDownload(ctx, () => click(page, element, ctx.humanize), ctx.path(args[1] as string), ctx.timeout);
  return new Result({ path: args[1] }, `✓ Downloaded to ${args[1]}`);
}

register("click", cmdClick);
register("dblclick", cmdDblclick);
register("hover", cmdHover);
register("focus", cmdFocus);
register("fill", cmdFill);
register("type", cmdType);
register("press", cmdPress);
register(["keydown", "keyup"], cmdKeydown);
register("keyboard", cmdKeyboard);
register(["check", "uncheck"], cmdCheck);
register("select", cmdSelect);
register("drag", cmdDrag);
register("upload", cmdUpload);
register("scroll", cmdScroll);
register("scrollintoview", cmdScrollintoview);
register("mouse", cmdMouse);
register("download", cmdDownload);
