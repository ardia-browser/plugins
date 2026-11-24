import { pyLen } from "../../pylib/str.ts";
import { asData, type ReportLine, renderReportLines } from "../changes/text.ts";
import { diff as diffViews, type View } from "../changes/report.ts";
import { previous } from "../changes/views.ts";
import { BrowseError, Usage } from "../daemon-errors.ts";
import { OUTPUT_CAP, Result } from "../daemon/render.ts";
import { makeParents, mediaPairing, writeBytes } from "../media/commands.ts";
import { defaultPath } from "../media/paths.ts";
import { type Boxed, type Paired, type PairedForm, pairedCapture, pairedChoice, pairedData, pairedLine } from "../media/paired.ts";
import { count, flag } from "../metrics.ts";
import { type BudgetRow, fitHeaders, fitWithNotice, isBare, parentsOf, roomAfter } from "../snapshot/budget.ts";
import { lastSeen, newIndexes, rememberSeen, type Seen } from "../snapshot/fresh.ts";
import { ancestorPath, fitFound, foundText, foundWithin, search, shownLines } from "../snapshot/search.ts";
import { diffAgainst, DIFF_SCOPE, forgetShown, lastShown, type Place, placeOf, rememberShown, samePlace, scopeOf, type ShownSnapshot, type SnapshotDiff } from "../snapshot/since.ts";
import { candidates, commit, contentLines, type Line, refsLeftOut, type Shot, shoot, verifyIdentity } from "../snapshot/take.ts";
import { type Node, walk } from "../snapshot/tree.ts";
import { containerKey } from "../changes/report.ts";
import { view } from "../changes/views.ts";
import { headPoints, joinedWords } from "../../pylib/str.ts";
import { quoted, shownName } from "../snapshot/render.ts";
import type { Ref } from "../state/refs.ts";
import type { Page } from "../state/page.ts";
import { type Header, snapshotHeaders, toolsHeader } from "./read.ts";
import type { Ctx } from "./ctx.ts";
import { register } from "./index.ts";
import { need, parse } from "./parse.ts";
import { originOf, pyIntArg } from "./shared.ts";
import "../snapshot/collect.ts";
import "../snapshot/epoch.ts";

export const SNAPSHOT_TRIES = 2;

const FLAGS = {
  "--interactive": "bool",
  "--compact": "bool",
  "--depth": "value",
  "--selector": "value",
  "--urls": "bool",
  "--cursor": "bool",
  "--diff": "bool",
  "--diff-new": "bool",
  "--all": "bool",
  "--no-modal-scope": "bool",
  "--with-screenshot": "value",
  "--tools": "bool",
} as const;
const ALIASES = { "-i": "--interactive", "-c": "--compact", "-d": "--depth", "-s": "--selector", "-u": "--urls", "-C": "--cursor" };

function intOption(value: unknown): number | null {
  return value !== undefined && value !== null ? pyIntArg(String(value)) : null;
}

function limitOf(ctx: Ctx): number {
  if (ctx.options["full"] || ctx.options["json"] || ctx.options["out_only"]) return 0;
  const given = ctx.options["max_output"];
  return given === undefined || given === null ? OUTPUT_CAP : Number(given);
}

function budgetRows(lines: readonly Line[]): BudgetRow[] {
  return lines.map((line) => ({ text: line.text, level: line.level, tier: line.tier, ref: line.ref, bare: isBare(line.node, line.ref) }));
}

function modalHeader(shot: Shot): string | null {
  const modal = shot.info?.modal ?? null;
  if (modal === null) return null;
  const named = modal.name ? `${modal.role} ${quoted(shownName(modal.name))}` : `a ${modal.role}`;
  return `(${named} is open on top of the page, so this snapshot shows only it; snapshot --all shows the whole page)`;
}

function modalData(shot: Shot, refs: readonly Ref[]): Record<string, unknown> | null {
  const modal = shot.info?.modal ?? null;
  if (modal === null) return null;
  return { role: modal.role, name: modal.name, ref: modal.ref && refs.some((ref) => ref.id === modal.ref) ? modal.ref : null };
}

function ago(commands: number): string {
  if (commands <= 0) return "just now";
  return `${commands} command${commands === 1 ? "" : "s"} ago`;
}

function joined(headers: readonly string[], body: string): string {
  return [...headers, body].join("\n");
}

async function siteHeaders(ctx: Ctx, page: Page, tools = false): Promise<Header[]> {
  const out: Header[] = [];
  for (const make of tools ? [toolsHeader, ...[...snapshotHeaders].reverse()] : [...snapshotHeaders].reverse()) {
    const found = await make(ctx, page);
    if (found !== null) out.push(found);
  }
  return out;
}

async function retried<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= SNAPSHOT_TRIES || !(error instanceof BrowseError) || error.code !== "document_changed") throw error;
    }
  }
}

type Plan = {
  options: Record<string, unknown>;
  selector: string | null;
  depth: number | null;
  scope: string;
  seen: boolean;
  place: Place;
  shown: ShownSnapshot | null;
  before: View | null;
  seenBefore: Seen | null;
  limit: number;
  notes: Header[];
  shaping: boolean;
  lean: boolean;
  pairedPath: string | null;
};

async function planOf(ctx: Ctx, page: Page, options: Record<string, unknown>, selector: string | null, depth: number | null, pairedPath: string | null = null): Promise<Plan> {
  const scope = scopeOf(options, selector, depth);
  const seen = ctx.state.topCommand !== "script" && ctx.state.scriptsRunning === 0;
  const place = placeOf(ctx.state, page);
  const fullListing = ctx.state.topCommand === "batch" ? Boolean(ctx.options["full_listing"]) : Boolean(ctx.options["full"]);
  const uncapped = ctx.options["max_output"] !== undefined && ctx.options["max_output"] !== null && Number(ctx.options["max_output"]) === 0;
  return {
    options,
    selector,
    depth,
    scope,
    seen,
    place,
    shown: seen && scope === DIFF_SCOPE && !options["diff_new"] && !fullListing && !uncapped && !ctx.options["json"] ? lastShown(ctx.state, place) : null,
    before: options["diff"] ? previous(ctx.state, page) : null,
    seenBefore: options["diff_new"] ? lastSeen(ctx.state, page) : null,
    limit: limitOf(ctx),
    notes: await siteHeaders(ctx, page, Boolean(options["tools"])),
    shaping: !options["diff"],
    lean: !options["diff"] && !fullListing,
    pairedPath,
  };
}

type Attempt = {
  shot: Shot;
  headers: string[];
  body: string;
  kept: boolean[];
  excluded: Set<string> | null;
  extra: Record<string, unknown>;
  since: SnapshotDiff | null;
  refs: Ref[];
  trimmed: boolean;
  pairedForm: PairedForm | null;
};

export const MAX_OPENED_TEXT = 120;

function textOf(node: Node): string {
  if (node.role === "StaticText") return node.name;
  return node.children.map(textOf).join(" ");
}

export function openedDialogs(before: View, after: View, nodes: readonly Node[]): ReportLine[] {
  const out: ReportLine[] = [];
  for (const node of walk(nodes)) {
    if ((node.role !== "dialog" && node.role !== "alertdialog") || node.backend === null) continue;
    const key = containerKey(node.frame, node.backend);
    if (before.containers.has(key) || !after.containers.has(key)) continue;
    const words = joinedWords(textOf(node));
    const text = pyLen(words) <= MAX_OPENED_TEXT ? words : `${headPoints(words, MAX_OPENED_TEXT - 1)}…`;
    out.push({ text: `+ ${node.role}${node.name ? ` ${quoted(shownName(node.name))}` : ""} opened${text ? `: ${quoted(text)}` : ""}`, refs: [] });
  }
  return out;
}

export function reportText(lines: readonly ReportLine[]): string {
  return lines.length ? `changes:\n${lines.map((line) => line.text).join("\n")}` : "changes: none";
}

export type FittedReport = { text: string; exposed: Set<string>; trimmed: boolean };

export function fitReport(lines: readonly ReportLine[], room: number | null): FittedReport {
  const whole = reportText(lines);
  if (room === null || pyLen(whole) <= room) return { text: whole, exposed: new Set(lines.flatMap((line) => line.refs)), trimmed: false };
  const tail = (left: number) => `[${left} more change line${left === 1 ? "" : "s"} past the cap; --full lists them]`;
  for (let keep = lines.length - 1; keep >= 0; keep -= 1) {
    const text = ["changes:", ...lines.slice(0, keep).map((line) => line.text), tail(lines.length - keep)].join("\n");
    if (pyLen(text) <= room) return { text, exposed: new Set(lines.slice(0, keep).flatMap((line) => line.refs)), trimmed: true };
  }
  return { text: "", exposed: new Set(), trimmed: true };
}

function freshBody(plan: Plan, shot: Shot, seenBefore: Seen, room: number, commands: number): { body: string; kept: boolean[]; excluded: Set<string>; shownNew: number[]; total: number } {
  const parents = parentsOf(shot.lines);
  const fresh = newIndexes(seenBefore, shot.lines);
  const texts = fresh.map((index) => {
    const path = ancestorPath(shot.lines, parents, index);
    return `+ ${(shot.lines[index] as Line).text.trimStart().slice(2)}${path ? ` (in ${path})` : ""}`;
  });
  const lead = `snapshot --diff-new (${fresh.length === 0 ? "nothing new" : `${fresh.length} new`} since your snapshot ${ago(commands - seenBefore.command)}; earlier refs stay valid)`;
  let shownCount = fresh.length;
  const tail = (left: number) => `[${left} more new line${left === 1 ? "" : "s"} past the cap; --full lists them]`;
  const text = (upto: number) => [lead, ...texts.slice(0, upto), ...(upto < fresh.length ? [tail(fresh.length - upto)] : [])].join("\n");
  if (plan.limit > 0) while (shownCount > 0 && pyLen(text(shownCount)) > room) shownCount -= 1;
  const fits = plan.limit <= 0 || pyLen(text(shownCount)) <= room;
  const shownNew = fresh.slice(0, shownCount);
  const shownSet = new Set(shownNew);
  const freshSet = new Set(fresh);
  const kept = shot.lines.map((_, index) => !freshSet.has(index) || shownSet.has(index));
  const excluded = new Set<string>();
  shot.lines.forEach((line, index) => {
    if (line.ref && !seenBefore.refs.has(line.ref) && !shownSet.has(index)) excluded.add(line.ref);
  });
  return { body: fits ? text(shownCount) : "", kept, excluded, shownNew, total: fresh.length };
}

async function shotOf(ctx: Ctx, page: Page, plan: Plan): Promise<Shot> {
  const { options, selector, depth } = plan;
  return shoot(ctx.state, page, {
    interactive: Boolean(options["interactive"]),
    compact: Boolean(options["compact"]),
    depth,
    selector,
    urls: Boolean(options["urls"]),
    modal: plan.shaping && !options["all"] && !options["no_modal_scope"] && !selector,
    visible: plan.shaping,
    tidy: plan.shaping,
    lean: plan.lean,
  });
}

async function fitAttempt(ctx: Ctx, page: Page, plan: Plan, shot: Shot, reserve: number, pairedForm: PairedForm | null): Promise<Attempt> {
  const { options, limit } = plan;
  const fullText = shot.lines.map((line) => line.text).join("\n");
  const header = modalHeader(shot);
  const sameDocument = plan.seenBefore !== null && plan.seenBefore.loader === (page.loader(page.mainFrame) || "");
  const wanted = plan.notes.map((note) => note.line);
  if (header !== null) wanted.push(header);
  if (options["diff"] && plan.before === null) wanted.push("(no earlier snapshot of this document in this session, so here is all of it)");
  if (options["diff_new"] && !sameDocument) {
    wanted.push(plan.seenBefore === null ? "(no earlier snapshot of this page in this session, so here is all of it)" : "(the page changed document since your last snapshot, so all of it is new)");
  }
  const headers = fitHeaders(wanted, limit > 0 ? Math.max(limit - reserve, 0) : null);
  const room = roomAfter(headers, limit, reserve);
  const steady = samePlace(plan.place, placeOf(ctx.state, page));
  let since = !options["diff_new"] && plan.shown !== null && steady && plan.shown.scope === plan.scope && shot.listed !== null && header === null ? diffAgainst(plan.shown, shot.listed, fullText || "(empty page)", ctx.state.commandsRun, page.url) : null;
  if (since !== null && limit > 0 && pyLen(since.text) > room) since = null;
  if (plan.shown !== null) flag(since === null ? "snapshot_diff_full" : "snapshot_diff", true);
  const extra: Record<string, unknown> = {};
  let body: string;
  let kept = shot.lines.map(() => true);
  let excluded: Set<string> | null = null;
  let trimmed = false;
  if (options["diff"] && plan.before !== null) {
    const after = await view(ctx.state, page, shot.nodes);
    const report = diffViews(plan.before, after);
    const opened = openedDialogs(plan.before, after, shot.nodes);
    const fitted = fitReport([...opened, ...renderReportLines(report)], limit > 0 ? room : null);
    body = fitted.text;
    trimmed = fitted.trimmed;
    extra["changes"] = { ...asData(report), opened: opened.map((line) => line.text) };
    if (limit > 0) {
      excluded = new Set([...walk(shot.nodes)].flatMap((node) => (node.ref && !fitted.exposed.has(node.ref) ? [node.ref] : [])));
      kept = shot.lines.map((line) => line.ref === null || fitted.exposed.has(line.ref));
    }
  } else if (since !== null) {
    body = since.text;
    extra["diff"] = since.data;
  } else if (options["diff_new"] && sameDocument && plan.seenBefore !== null) {
    const fresh = freshBody(plan, shot, plan.seenBefore, room, ctx.state.commandsRun);
    body = fresh.body;
    kept = fresh.kept;
    excluded = fresh.excluded;
    trimmed = fresh.shownNew.length < fresh.total;
    extra["new"] = fresh.shownNew.map((index) => (shot.lines[index] as Line).ref ?? (shot.lines[index] as Line).text.trimStart().slice(2));
  } else {
    const fitted = fitWithNotice(budgetRows(shot.lines), limit, limit > 0 ? limit - room : 0);
    kept = fitted.kept;
    body = [fitted.text, fitted.notice ?? ""].filter((part) => part).join("\n");
    if (fitted.trimmed) {
      trimmed = true;
      excluded = refsLeftOut(shot.lines, kept);
      extra["fit"] = { limit, kept: fitted.shown, total: fitted.total };
    }
  }
  await verifyIdentity(page, shot.nodes);
  const refs = candidates(ctx.state, page, shot, excluded);
  if (options["diff"] && plan.before === null) extra["changes"] = null;
  const empty = "(empty page)";
  const shown = body || (limit <= 0 || pyLen(empty) <= room ? empty : "");
  return { shot, headers, body: shown, kept, excluded, extra, since, refs, trimmed, pairedForm };
}

type Built = { body: string; data: Record<string, unknown>; refs: Ref[] };

async function finish(ctx: Ctx, page: Page, plan: Plan, attempt: Attempt): Promise<Built> {
  const { shot, kept, excluded, extra } = attempt;
  const keptText = shot.lines.filter((_, index) => kept[index]).map((line) => line.text).join("\n");
  const { refs, epoch } = await commit(ctx.state, page, shot, keptText, excluded, false, Boolean(plan.options["diff"]) && attempt.trimmed);
  if (shot.info?.modal) flag("snapshot_modal_scoped", true);
  if (extra["fit"] !== undefined) {
    flag("snapshot_budget_trimmed", true);
    count("snapshot_lines_dropped", kept.filter((keep) => !keep).length);
  }
  if (extra["new"] !== undefined) count("snapshot_new_lines", (extra["new"] as unknown[]).length);
  const origin = originOf(page, page.mainFrame) || page.url;
  const data: Record<string, unknown> = { origin: origin.endsWith("/") ? origin : `${origin}/`, refs: ctx.state.refsJson(), snapshot: keptText, epoch, ...extra };
  const scoped = modalData(shot, refs);
  if (scoped !== null) data["modal"] = scoped;
  for (const note of plan.notes) data[note.key] = note.data;
  const settled = placeOf(ctx.state, page);
  const steady = samePlace(plan.place, settled);
  const visible = !ctx.options["json"] && !ctx.options["out_only"];
  const title = (ctx.state.views.get(page.targetId) as View | undefined)?.title ?? "";
  if (visible && plan.seen && steady && !attempt.trimmed && modalHeader(shot) === null) {
    rememberShown(ctx.state, { ...settled, scope: plan.scope, command: ctx.state.commandsRun, url: page.url, title, listed: (shot.listed ?? []).map(({ text, ref, key }) => ({ text, ref, key })) });
  } else if (visible && plan.seen && !attempt.trimmed) forgetShown(ctx.state, page.targetId);
  if (shot.whole && plan.seen) {
    const shownLines = shot.lines.filter((_, index) => kept[index]);
    rememberSeen(ctx.state, page, shownLines, ctx.state.commandsRun, shot.listed === null ? shownLines : contentLines({ ...shot, lines: shownLines }));
  }
  return { body: [...attempt.headers, attempt.body].filter((part) => part).join("\n"), data, refs };
}

async function built(ctx: Ctx, page: Page, plan: Plan): Promise<Built> {
  return retried(async () => finish(ctx, page, plan, await fitAttempt(ctx, page, plan, await shotOf(ctx, page, plan), 0, null)));
}

type Taken = { shot: Shot; refs: Ref[] };
type PairedBuilt = { paired: Paired<Taken>; attempt: Attempt; result: Built };

async function pairedBuilt(ctx: Ctx, page: Page, plan: Plan, shownPath: string, file: string): Promise<PairedBuilt> {
  return retried(async () => {
    const captured = await pairedCapture(page, async (): Promise<Taken> => {
      const shot = await shotOf(ctx, page, plan);
      return { shot, refs: (await fitAttempt(ctx, page, plan, shot, 0, null)).refs };
    });
    const choice = pairedChoice(shownPath, plan.limit, { ...captured, boxes: new Array<Boxed>(Math.max(captured.boxes.length, 2)) });
    const attempt = await fitAttempt(ctx, page, plan, captured.taken.shot, choice.room, choice.form);
    const ids = new Set(attempt.refs.map((ref) => ref.id));
    const paired = { ...captured, boxes: captured.boxes.filter((box) => ids.has(box.ref)) };
    if (attempt.pairedForm !== null && plan.limit > 0 && pyLen(pairedLine(shownPath, paired, attempt.pairedForm)) + 1 > choice.room) attempt.pairedForm = null;
    makeParents(file);
    writeBytes(file, paired.png);
    return { paired, attempt, result: await finish(ctx, page, plan, attempt) };
  });
}

function pairedOutput(shown: string, built: PairedBuilt): string {
  const form = built.attempt.pairedForm;
  return [form === null ? "" : pairedLine(shown, built.paired, form), built.result.body].filter((part) => part).join("\n");
}

async function snapshotFind(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, { "--all": "bool", "--no-modal-scope": "bool", "--interactive": "bool", "--selector": "value" }, { "-i": "--interactive", "-s": "--selector" });
  need(args, 1, "snapshot find <query> [-i] [-s sel] [--all]");
  const query = args.join(" ");
  const selector = (options["selector"] as string | undefined) ?? null;
  const page = await ctx.state.page();
  await page.refreshFrames();
  const limit = limitOf(ctx);
  const notes = await siteHeaders(ctx, page);
  return retried(async () => {
    const shot = await shoot(ctx.state, page, {
      interactive: Boolean(options["interactive"]),
      selector,
      modal: !options["all"] && !options["no_modal_scope"] && !selector,
      visible: true,
      tidy: true,
    });
    const header = modalHeader(shot);
    const headers = fitHeaders([...notes.map((note) => note.line), ...(header === null ? [] : [header])], limit > 0 ? limit : null);
    const room = limit > 0 ? roomAfter(headers, limit) : null;
    let found = room !== null ? fitFound(shot.lines, query, search(shot.lines, query), room) : search(shot.lines, query);
    const summary = foundWithin(shot.lines, query, found, room);
    if (summary !== foundText(shot.lines, query, found)) found = { blocks: [], matches: [], more: found.matches.length + found.more };
    const lines = shownLines(found);
    const kept = shot.lines.map((_, index) => lines.has(index));
    const excluded = refsLeftOut(shot.lines, kept);
    const keptText = shot.lines.filter((_, index) => kept[index]).map((line) => line.text).join("\n");
    const { refs, epoch } = await commit(ctx.state, page, shot, keptText, excluded, true);
    flag("snapshot_find", true);
    count("snapshot_find_matches", found.matches.length + found.more);
    const data: Record<string, unknown> = {
      query,
      count: found.matches.length + found.more,
      matches: found.matches.map((match) => ({ line: (shot.lines[match.index] as Line).text.trimStart(), ref: (shot.lines[match.index] as Line).ref, path: match.path })),
      refs: Object.fromEntries(refs.map((ref) => [ref.id, { name: ref.name, role: ref.role }])),
      epoch,
    };
    const scoped = modalData(shot, refs);
    if (scoped !== null) data["modal"] = scoped;
    for (const note of notes) data[note.key] = note.data;
    return new Result(data, [...headers, summary].filter((part) => part).join("\n"), true);
  });
}

export async function cmdSnapshot(ctx: Ctx, argv: string[]): Promise<Result> {
  if (argv[0] === "find") return snapshotFind(ctx, argv.slice(1));
  const [options, args] = parse(argv, { ...FLAGS }, ALIASES);
  const selector = (options["selector"] as string | undefined) || (args[0] ?? null);
  const depth = intOption(options["depth"]);
  if (options["diff"] && (selector || depth !== null)) throw new Usage("snapshot --diff compares the whole page, so it takes no -s or -d");
  if (options["diff_new"] && (selector || depth !== null)) throw new Usage("snapshot --diff-new compares the whole page, so it takes no -s or -d");
  if (options["diff_new"] && options["diff"]) throw new Usage("pick one of --diff (what changed) and --diff-new (only what appeared)");
  const target = options["with_screenshot"] as string | undefined;
  if (target !== undefined && (!target || target === "--")) throw new Usage("--with-screenshot needs a path for the PNG");
  const page = await ctx.state.page();
  await page.refreshFrames();
  const plan = await planOf(ctx, page, options, selector, depth, target ?? null);
  if (target === undefined) {
    const result = await built(ctx, page, plan);
    return new Result(result.data, result.body, true);
  }
  const done = await pairedBuilt(ctx, page, plan, target, ctx.path(target));
  const data = { ...done.result.data, screenshot: pairedData(target, done.paired) };
  return new Result(data, pairedOutput(target, done), true);
}

export async function snapshotWithScreenshot(ctx: Ctx, file: string | null): Promise<Result> {
  const page = await ctx.state.page();
  await page.refreshFrames();
  const shownPath = file ?? defaultPath(ctx, "png");
  const plan = await planOf(ctx, page, {}, null, null, shownPath);
  const done = await pairedBuilt(ctx, page, plan, shownPath, file === null ? shownPath : ctx.path(file));
  const data = { path: shownPath, ...pairedData(shownPath, done.paired), snapshot: done.result.data };
  return new Result(data, pairedOutput(shownPath, done), true);
}

mediaPairing.withSnapshot = snapshotWithScreenshot;
register("snapshot", cmdSnapshot);
