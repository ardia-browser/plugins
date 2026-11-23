import { HTMLParser } from "../../pylib/htmlparser.ts";
import { pyStrip } from "../../pylib/str.ts";
import { urljoin, urlsplit, urlunsplit } from "../../pylib/urllib.ts";
import { BrowseError } from "../daemon-errors.ts";
import { type HopGuard, hopGuard, type Resolver } from "./netguard.ts";
import { collapseSpaces, extractHtml, llmsCandidates, llmsHrefs, llmsLinks, MARKDOWN_TYPES, postProcess, sameDocument } from "./readurl.ts";

export const ARD_PATH = "/.well-known/ard.json";
export const MARKDOWN_ACCEPT = "text/markdown, text/x-markdown;q=0.95, text/plain;q=0.5, text/html;q=0.3";
export const RETENTION_FLOOR = 0.25;
export const MIN_VISIBLE = 200;
export const ARD_ENTRIES = 200;
export type Method = "markdown" | "llms_txt" | "ard" | "readability" | "raw";
export type Fetched = [number, string, string, string, Uint8Array?];
export type Fetcher = (url: string, timeout: number, accept: string, binary: "refuse" | "keep" | "skip", guard: HopGuard | null) => Promise<Fetched>;
export type FastResult = { content: string; method: Method; source: string; finalUrl: string; title: string; tried: string[]; contentType: string };

const RAW_SKIP = new Set(["script", "style", "noscript", "template", "svg", "head"]);
const RAW_BLOCK = new Set(["p", "div", "section", "article", "main", "header", "footer", "nav", "aside", "ul", "ol", "li", "table", "tr", "td", "th", "blockquote", "pre", "br", "hr", "form", "dl", "dt", "dd", "h1", "h2", "h3", "h4", "h5", "h6"]);

export function rawText(html: string): string {
  const lines: string[] = [];
  let buffer: string[] = [];
  let skip = 0;
  const flush = () => {
    const text = pyStrip(collapseSpaces(buffer.join("")));
    if (text) lines.push(text);
    buffer = [];
  };
  const parser = new HTMLParser({
    starttag: (tag) => {
      if (RAW_SKIP.has(tag)) skip += 1;
      else if (RAW_BLOCK.has(tag)) flush();
    },
    endtag: (tag) => {
      if (RAW_SKIP.has(tag)) skip = Math.max(0, skip - 1);
      else if (RAW_BLOCK.has(tag)) flush();
    },
    data: (text) => {
      if (!skip) buffer.push(text);
    },
  });
  parser.feed(html);
  flush();
  return lines.join("\n");
}

function visibleLength(text: string): number {
  return text.replace(/\s+/gu, "").replace(/^#+/gmu, "").length;
}

export function retention(readable: string, visible: string): number {
  const whole = visibleLength(visible);
  if (whole === 0) return 1;
  return Math.min(1, visibleLength(readable.replace(/^#{1,6} /gmu, "")) / whole);
}

export function pickReadable(readable: string, visible: string): { content: string; method: "readability" | "raw"; kept: number } {
  const kept = retention(readable, visible);
  if (visibleLength(readable) === 0 && visibleLength(visible) > 0) return { content: visible, method: "raw", kept };
  if (visibleLength(visible) >= MIN_VISIBLE && kept < RETENTION_FLOOR) return { content: visible, method: "raw", kept };
  return { content: readable, method: "readability", kept };
}

export function listedMarkdown(kind: string, text: string): boolean {
  return !/html|xml|json/iu.test(kind) && !text.trimStart().startsWith("<");
}

function isMarkdown(kind: string, text: string): boolean {
  if (MARKDOWN_TYPES.includes(kind)) return true;
  return kind === "text/plain" && Boolean(text) && !text.slice(0, 300).toLowerCase().includes("<html");
}

function rootOf(url: string): string {
  const parts = urlsplit(url);
  return urlunsplit(parts.scheme, parts.netloc, "", "", "");
}

function atRoot(url: string): boolean {
  const path = urlsplit(url).path;
  return path === "" || path === "/" || /^\/(index\.html?|docs\/?)$/iu.test(path);
}

export type ArdEntry = { title: string; url: string; markdown: string | null; description: string };
export type ArdDocument = { name: string; description: string; entries: ArdEntry[]; markdown: string | null; llms: string | null };

function text(value: unknown, limit = 300): string {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, limit) : "";
}

function link(value: unknown, base: string): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const joined = urljoin(base, value.trim());
    const scheme = urlsplit(joined).scheme.toLowerCase();
    return scheme === "http" || scheme === "https" ? joined : null;
  } catch {
    return null;
  }
}

export function parseArd(body: string, base: string): ArdDocument | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const doc = raw as Record<string, unknown>;
  const list = [doc["documents"], doc["docs"], doc["pages"], doc["resources"], doc["entries"]].find(Array.isArray) as unknown[] | undefined;
  const entries: ArdEntry[] = [];
  for (const item of (list ?? []).slice(0, ARD_ENTRIES)) {
    if (item === null || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const url = link(entry["url"] ?? entry["href"] ?? entry["page"], base);
    const markdown = link(entry["markdown"] ?? entry["md"] ?? entry["markdownUrl"] ?? entry["source"], base);
    if (url === null && markdown === null) continue;
    entries.push({ title: text(entry["title"] ?? entry["name"], 120), url: url ?? (markdown as string), markdown, description: text(entry["description"] ?? entry["summary"], 200) });
  }
  return {
    name: text(doc["name"] ?? doc["title"], 120),
    description: text(doc["description"] ?? doc["summary"], 400),
    entries,
    markdown: link(doc["markdown"] ?? doc["index"], base),
    llms: link(doc["llms"] ?? doc["llmsTxt"] ?? doc["llms_txt"], base),
  };
}

export function ardIndex(doc: ArdDocument): string {
  const lines: string[] = [];
  if (doc.name) lines.push(`# ${doc.name}`, "");
  if (doc.description) lines.push(doc.description, "");
  for (const entry of doc.entries) {
    const label = entry.title || entry.url;
    lines.push(`- [${label}](${entry.markdown ?? entry.url})${entry.description ? `: ${entry.description}` : ""}`);
  }
  return lines.join("\n").trim();
}

function canonical(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href.replace(/\/+$/u, "").replace(/\.md$/u, "").replace(/\/index(\.html?)?$/u, "");
  } catch {
    return url;
  }
}

export function ardEntryFor(doc: ArdDocument, page: string): ArdEntry | null {
  const wanted = canonical(page);
  return doc.entries.find((entry) => canonical(entry.url) === wanted && entry.markdown !== null) ?? null;
}

export function markdownSibling(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.pathname.endsWith(".md")) return null;
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = parsed.pathname.endsWith("/") ? `${parsed.pathname}index.md` : `${parsed.pathname}.md`;
  return parsed.href;
}

export type Probe = { tried: string[]; binary: string | null; guard?: HopGuard | null };

function refused(error: unknown): boolean {
  return error instanceof BrowseError && error.code === "unsafe_address";
}

async function quiet(fetcher: Fetcher, url: string, timeout: number, accept: string, guard: HopGuard): Promise<Fetched | null> {
  try {
    const got = await fetcher(url, timeout, accept, "skip", guard);
    return got[0] === 200 && got[4] === undefined ? got : null;
  } catch (error) {
    if (refused(error)) throw error;
    if (error instanceof BrowseError) return null;
    throw error;
  }
}

export type FastOptions = { outline?: unknown; filter?: string | null };

function done(result: Omit<FastResult, "content"> & { content: string }, options: FastOptions): FastResult {
  return { ...result, content: postProcess(result.content, { outline: options.outline, filter: options.filter ?? null }) };
}

export async function fastRead(
  url: string,
  timeout: number,
  fetcher: Fetcher,
  options: FastOptions = {},
  htmlFallback = true,
  probe: Probe = { tried: [], binary: null, guard: null },
  resolve?: Resolver,
): Promise<FastResult | null> {
  const tried = probe.tried;
  const guard = hopGuard(url, resolve);
  probe.guard = guard;
  tried.push("markdown");
  let first: Fetched | null = null;
  try {
    const got = await fetcher(url, timeout, MARKDOWN_ACCEPT, "skip", guard);
    if (got[0] === 200 && got[4] !== undefined) {
      probe.binary = got[1] || "application/octet-stream";
      return null;
    }
    first = got[0] === 200 ? got : null;
  } catch (error) {
    if (refused(error) || !(error instanceof BrowseError)) throw error;
  }
  if (first && isMarkdown(first[1], first[2])) {
    return done({ content: first[2], method: "markdown", source: first[3], finalUrl: first[3], title: "", tried, contentType: first[1] || "text/markdown" }, options);
  }
  const final = first ? first[3] : url;
  const sibling = markdownSibling(final);
  if (sibling !== null) {
    const md = await quiet(fetcher, sibling, timeout, MARKDOWN_ACCEPT, guard);
    if (md && isMarkdown(md[1], md[2])) return done({ content: md[2], method: "markdown", source: md[3], finalUrl: final, title: "", tried, contentType: "text/markdown" }, options);
  }
  tried.push("llms_txt");
  let llms: [string, string] | null = null;
  for (const candidate of llmsCandidates(final)) {
    const got = await quiet(fetcher, candidate, timeout, "text/plain, text/markdown", guard);
    if (got && got[2] && !got[2].slice(0, 500).toLowerCase().includes("<html")) {
      llms = [got[3], got[2]];
      break;
    }
  }
  if (llms !== null) {
    const [source, body] = llms;
    for (const href of llmsHrefs(body)) {
      const target = urljoin(source, href);
      if (!sameDocument(target, final)) continue;
      const md = await quiet(fetcher, target, timeout, MARKDOWN_ACCEPT, guard);
      if (md && md[2] && listedMarkdown(md[1], md[2])) return done({ content: md[2], method: "llms_txt", source: md[3], finalUrl: final, title: "", tried, contentType: "text/markdown" }, options);
    }
    if (atRoot(final)) {
      const content = options.outline ? body : llmsLinks(body, source, options.filter ?? null).join("\n") || body;
      return { content: options.outline ? postProcess(content, { outline: true, filter: options.filter ?? null }) : content, method: "llms_txt", source, finalUrl: final, title: "", tried, contentType: "text/plain" };
    }
  }
  tried.push("ard");
  const ardUrl = `${rootOf(final)}${ARD_PATH}`;
  const ard = await quiet(fetcher, ardUrl, timeout, "application/json", guard);
  const doc = ard ? parseArd(ard[2], ard[3]) : null;
  if (doc !== null) {
    const entry = ardEntryFor(doc, final);
    if (entry?.markdown) {
      const md = await quiet(fetcher, entry.markdown, timeout, MARKDOWN_ACCEPT, guard);
      if (md && md[2] && listedMarkdown(md[1], md[2])) return done({ content: md[2], method: "ard", source: md[3], finalUrl: final, title: entry.title, tried, contentType: "text/markdown" }, options);
    }
    if (atRoot(final) && (doc.entries.length > 0 || doc.description)) {
      if (doc.markdown) {
        const md = await quiet(fetcher, doc.markdown, timeout, MARKDOWN_ACCEPT, guard);
        if (md && md[2] && listedMarkdown(md[1], md[2])) return done({ content: md[2], method: "ard", source: md[3], finalUrl: final, title: doc.name, tried, contentType: "text/markdown" }, options);
      }
      return done({ content: ardIndex(doc), method: "ard", source: ard?.[3] ?? ardUrl, finalUrl: final, title: doc.name, tried, contentType: "text/markdown" }, options);
    }
  }
  if (!htmlFallback) return null;
  tried.push("readability");
  const page = first ?? (await quiet(fetcher, url, timeout, "text/html, */*;q=0.5", guard));
  if (page === null) return null;
  if (page[1] !== "text/html" && page[1] !== "application/xhtml+xml") {
    return done({ content: page[2], method: "raw", source: page[3], finalUrl: page[3], title: "", tried, contentType: page[1] }, options);
  }
  const extracted = extractHtml(page[2]);
  const picked = pickReadable(extracted.content, rawText(page[2]));
  if (picked.method === "raw") tried.push("raw");
  return done({ content: picked.content, method: picked.method, source: page[3], finalUrl: page[3], title: extracted.title, tried, contentType: page[1] }, options);
}

export const BODY_TEXT = "() => { const body = document.body; return body ? String(body.innerText || '') : ''; }";
