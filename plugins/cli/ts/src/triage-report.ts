import { createHash } from "node:crypto";
import { isSpace } from "./py.ts";
import { codePoints, joinCodePoints, utf8 } from "./pystr.ts";
import { onlyPlaceholders, wholeWords } from "./scrub.ts";
import { addRemoved, emptyRemoved, nothingLeft, type Removed, triageScrub } from "./triage-scrub.ts";
import { TriageRefused } from "./triage-session.ts";

export type Section = { heading: string; id: string; required: boolean; fenced: boolean };

export const SECTIONS: readonly Section[] = [
  { heading: "What happened", id: "what-happened", required: true, fenced: false },
  { heading: "Diagnosis", id: "diagnosis", required: true, fenced: false },
  { heading: "Steps to reproduce", id: "steps", required: true, fenced: false },
  { heading: "Version", id: "version", required: true, fenced: false },
  { heading: "Environment", id: "environment", required: true, fenced: false },
  { heading: "Evidence", id: "evidence", required: false, fenced: true },
  { heading: "Related issues", id: "related", required: false, fenced: false },
  { heading: "Fix applied or workaround", id: "workaround", required: false, fenced: false },
];
export const FILED_BY: Section = { heading: "Filed by", id: "agent", required: false, fenced: false };
export const MAX_TITLE = 67;
export const FORM_LIMIT = 6000;
const CUT_ORDER = ["evidence", "diagnosis", "steps", "what-happened", "workaround", "related"];
const CUT_NOTE = "\n\n(Shortened to fit the form; ask the reporter for the rest.)";
const MAX_BODY_BYTES = 256 * 1024;
const OUTER_FENCE = /^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\1[ \t]*$/;

export type Report = { title: string; fields: Map<string, string>; body: string; text: string; code: string; removed: Removed };

function allowedHeadings(): string {
  return SECTIONS.map((section) => `"## ${section.heading}"`).join(", ");
}

function trimmed(text: string): string {
  const points = codePoints(text);
  let start = 0;
  let end = points.length;
  while (start < end && isSpace(points[start] as string)) start += 1;
  while (end > start && isSpace(points[end - 1] as string)) end -= 1;
  return joinCodePoints(points.slice(start, end));
}

export function parseSections(markdown: string): Map<string, string> {
  if (utf8(markdown).length > MAX_BODY_BYTES) throw new TriageRefused(`the report is over ${MAX_BODY_BYTES / 1024} KB; keep only the lines that matter`);
  const found = new Map<string, string[]>();
  let current: string | undefined;
  let fenced: string | undefined;
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const fence = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== undefined) {
      if (fenced === undefined) fenced = fence;
      else if (fence.startsWith(fenced)) fenced = undefined;
    }
    const heading = fenced === undefined && fence === undefined ? /^##[ \t]+(.+?)[ \t#]*$/.exec(line)?.[1] : undefined;
    if (heading !== undefined) {
      const section = SECTIONS.find((candidate) => candidate.heading.toLowerCase() === heading.toLowerCase());
      if (section === undefined) throw new TriageRefused(`"## ${heading}" isn't a heading the report takes; use ${allowedHeadings()}`);
      if (found.has(section.id)) throw new TriageRefused(`"## ${section.heading}" is in the report twice`);
      current = section.id;
      found.set(current, []);
      continue;
    }
    if (current === undefined) {
      if (trimmed(line) !== "") throw new TriageRefused(`the report has text above its first heading; start it with "## What happened"`);
      continue;
    }
    found.get(current)?.push(line);
  }
  const out = new Map<string, string>();
  for (const section of SECTIONS) {
    const lines = found.get(section.id);
    const text = lines === undefined ? "" : trimmed(lines.join("\n"));
    if (section.required && text === "") throw new TriageRefused(`the report needs a "## ${section.heading}" section with text under it`);
    if (text !== "") out.set(section.id, text);
  }
  return out;
}

function unfenced(text: string): string {
  const found = OUTER_FENCE.exec(text);
  if (found === null) return text;
  const inner = found[2] as string;
  return /^\s*(`{3,}|~{3,})/m.test(inner) ? text : inner;
}

function fenceFor(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(longest + 1);
}

export function cleanTitle(given: string): [string, Removed] {
  const words = given.split(/\s+/u).filter((word) => word !== "").join(" ");
  if (words === "") throw new TriageRefused(`the report needs --title "…" (1-${MAX_TITLE} characters)`);
  const done = triageScrub(words);
  const length = codePoints(done.text).length;
  if (nothingLeft(done.text) || onlyPlaceholders(done.text.replaceAll("<removed>", " "))) throw new TriageRefused("nothing is left of the title once secrets and personal data are removed; describe the problem instead");
  if (length > MAX_TITLE) throw new TriageRefused(`the title is ${length} characters after scrubbing; keep it to ${MAX_TITLE}`);
  return [done.text, done.removed];
}

export function renderBody(fields: Map<string, string>): string {
  const parts: string[] = [];
  for (const section of [...SECTIONS, FILED_BY]) {
    const text = fields.get(section.id);
    if (text === undefined) continue;
    if (section.fenced) {
      const fence = fenceFor(text);
      parts.push(`### ${section.heading}\n\n${fence}shell\n${text}\n${fence}`);
    } else parts.push(`### ${section.heading}\n\n${text}`);
  }
  return `${parts.join("\n\n")}\n`;
}

export function codeOf(title: string, body: string): string {
  return createHash("sha256").update(utf8(`${title}\0${body}`)).digest("hex").slice(0, 8);
}

export function buildReport(title: string, markdown: string, filedBy: string): Report {
  const [cleanedTitle, titleRemoved] = cleanTitle(title);
  const removed = emptyRemoved();
  addRemoved(removed, titleRemoved);
  const fields = new Map<string, string>();
  for (const [id, raw] of parseSections(markdown)) {
    const section = SECTIONS.find((candidate) => candidate.id === id) as Section;
    const done = triageScrub(section.fenced ? unfenced(raw) : raw);
    addRemoved(removed, done.removed);
    if (nothingLeft(done.text) || onlyPlaceholders(done.text.replaceAll("<removed>", " "))) {
      if (section.required) throw new TriageRefused(`nothing is left of "## ${section.heading}" once secrets and personal data are removed; describe it without them`);
      continue;
    }
    fields.set(id, done.text);
  }
  fields.set(FILED_BY.id, filedBy);
  const body = renderBody(fields);
  return { title: cleanedTitle, fields, body, text: `Title: ${cleanedTitle}\n\n${body}`, code: codeOf(cleanedTitle, body), removed };
}

export type FormUrl = { url: string; cuts: { heading: string; from: number; to: number }[] };

function formUrlOf(base: string, title: string, fields: Map<string, string>): string {
  const query = [`template=via-triage.yml`, `title=${encodeURIComponent(title)}`];
  for (const section of [...SECTIONS, FILED_BY]) {
    const text = fields.get(section.id);
    if (text !== undefined) query.push(`${section.id}=${encodeURIComponent(text)}`);
  }
  return `${base}?${query.join("&")}`;
}

function shortened(text: string, keep: number): string {
  if (keep <= 0) return CUT_NOTE.trimStart();
  const cut = wholeWords(text, keep) || joinCodePoints(codePoints(text).slice(0, keep));
  return `${trimmed(cut)}${CUT_NOTE}`;
}

export function formUrl(base: string, title: string, given: Map<string, string>): FormUrl {
  const fields = new Map(given);
  const cuts: FormUrl["cuts"] = [];
  let url = formUrlOf(base, title, fields);
  for (const id of CUT_ORDER) {
    if (url.length < FORM_LIMIT) break;
    const text = fields.get(id);
    if (text === undefined) continue;
    const length = codePoints(text).length;
    let low = 0;
    let high = length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      fields.set(id, shortened(text, middle));
      if (formUrlOf(base, title, fields).length < FORM_LIMIT) low = middle;
      else high = middle - 1;
    }
    fields.set(id, shortened(text, low));
    url = formUrlOf(base, title, fields);
    const heading = (SECTIONS.find((section) => section.id === id) as Section).heading;
    cuts.push({ heading, from: length, to: low });
  }
  if (url.length >= FORM_LIMIT) throw new TriageRefused(`the report doesn't fit in a form link even shortened; use --via feedback, or sign in to gh`);
  return { url, cuts };
}
