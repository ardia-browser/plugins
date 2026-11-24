import { HTMLParser } from "../../pylib/htmlparser.ts";
import { PY_SPACE_CLASS } from "../../pylib/re.ts";
import { isSpaceCode, pyStrip, splitlines } from "../../pylib/str.ts";
import { urljoin, urlsplit, urlunsplit } from "../../pylib/urllib.ts";

export const FLAGS: Readonly<Record<string, string>> = { "--raw": "bool", "--require-md": "bool", "--llms": "value", "--outline": "bool", "--filter": "value", "--timeout": "value", "--fast": "bool" };
export const MAX_BODY = 8 * 1024 * 1024;
export const MARKDOWN_TYPES = ["text/markdown", "text/x-markdown"];
const LINK = new RegExp(`\\[([^\\]]+)\\]\\(([^)${PY_SPACE_CLASS}]+)\\)`, "g");
const SKIP_BASE = new Set(["script", "style", "noscript", "template", "svg", "head"]);
const SKIP = new Set([...SKIP_BASE, "nav", "footer"]);
const BLOCK = new Set(["p", "div", "section", "article", "main", "header", "ul", "ol", "table", "tr", "blockquote", "pre", "br", "hr", "form", "dl", "dt", "dd"]);
const HEADING = /^h[1-6]$/;
const MARKDOWN_HEADING = /^#{1,6} /;

export function collapseSpaces(text: string): string {
  let out = "";
  let index = 0;
  let copied = 0;
  while (index < text.length) {
    if (!isSpaceCode(text.charCodeAt(index))) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < text.length && isSpaceCode(text.charCodeAt(end))) end += 1;
    out += `${text.slice(copied, index)} `;
    copied = end;
    index = end;
  }
  return out + text.slice(copied);
}

export class TextExtractor {
  readonly lines: string[] = [];
  private buffer: string[] = [];
  private skip = 0;
  private heading: number | null = null;
  private rowCells: string[] | null = null;
  private cellBuf: string[] | null = null;
  private nestedTable = 0;
  title = "";
  private inTitle = false;
  private readonly readable: boolean;
  private readonly skipTags: ReadonlySet<string>;
  private readonly parser = new HTMLParser({
    starttag: (tag) => this.starttag(tag),
    endtag: (tag) => this.endtag(tag),
    data: (text) => this.data(text),
  });

  constructor(readable = false, keepChrome = false) {
    this.readable = readable;
    this.skipTags = keepChrome ? SKIP_BASE : SKIP;
  }

  feed(text: string): void {
    this.parser.feed(text);
  }

  private flush(): void {
    const text = pyStrip(collapseSpaces(this.buffer.join("")));
    if (text) this.lines.push(text);
    this.buffer = [];
  }

  private finishCell(): void {
    if (this.cellBuf !== null && this.rowCells !== null) {
      this.rowCells.push(pyStrip(collapseSpaces(this.cellBuf.join(""))));
      this.cellBuf = null;
    }
  }

  private finishRow(): void {
    this.finishCell();
    if (this.rowCells !== null) {
      if (this.rowCells.some((cell) => cell !== "")) this.lines.push(this.rowCells.join(" | "));
      this.rowCells = null;
    }
  }

  private starttag(tag: string): void {
    if (tag === "title") this.inTitle = true;
    if (this.skipTags.has(tag)) {
      this.skip += 1;
      return;
    }
    if (this.readable && this.skip) return;
    if (this.readable && this.cellBuf !== null) {
      if (tag === "table") {
        this.nestedTable += 1;
        this.cellBuf.push(" ");
        return;
      }
      if (this.nestedTable > 0) {
        if (tag === "tr" || tag === "td" || tag === "th" || BLOCK.has(tag) || HEADING.test(tag) || tag === "li") this.cellBuf.push(" ");
        return;
      }
      if (tag !== "tr" && tag !== "td" && tag !== "th") {
        if (BLOCK.has(tag) || HEADING.test(tag) || tag === "li") this.cellBuf.push(" ");
        return;
      }
    }
    if (this.readable && tag === "tr") {
      this.finishRow();
      this.flush();
      this.rowCells = [];
      return;
    }
    if (this.readable && (tag === "td" || tag === "th")) {
      if (this.rowCells === null) {
        this.flush();
        this.rowCells = [];
      }
      this.finishCell();
      this.cellBuf = [];
      return;
    }
    if (HEADING.test(tag)) {
      this.flush();
      this.heading = Number(tag[1]);
    } else if (tag === "li") {
      this.flush();
      this.buffer.push("- ");
    } else if (BLOCK.has(tag)) this.flush();
  }

  private endtag(tag: string): void {
    if (tag === "title") this.inTitle = false;
    if (this.skipTags.has(tag)) {
      this.skip = Math.max(0, this.skip - 1);
      return;
    }
    if (this.readable && this.skip) return;
    if (this.readable && this.cellBuf !== null && this.nestedTable > 0) {
      if (tag === "table") this.nestedTable -= 1;
      if (tag === "tr" || tag === "td" || tag === "th" || BLOCK.has(tag) || HEADING.test(tag) || tag === "li") this.cellBuf.push(" ");
      return;
    }
    if (this.readable && (tag === "td" || tag === "th")) {
      this.finishCell();
      return;
    }
    if (this.readable && (tag === "tr" || tag === "table")) {
      this.finishRow();
      return;
    }
    if (this.readable && this.cellBuf !== null) {
      if (BLOCK.has(tag) || HEADING.test(tag) || tag === "li") this.cellBuf.push(" ");
      return;
    }
    if (HEADING.test(tag) && this.heading) {
      const text = pyStrip(collapseSpaces(this.buffer.join("")));
      this.buffer = [];
      if (text) this.lines.push("", `${"#".repeat(this.heading)} ${text}`, "");
      this.heading = null;
    } else if (BLOCK.has(tag) || tag === "li") this.flush();
  }

  private data(text: string): void {
    if (this.inTitle) this.title += text;
    if (!this.skip) {
      if (this.readable && this.cellBuf !== null) this.cellBuf.push(text);
      else this.buffer.push(text);
    }
  }

  text(): string {
    if (this.readable) this.finishRow();
    this.flush();
    const out: string[] = [];
    for (const line of this.lines) {
      if (line === "" && (out.length === 0 || out.at(-1) === "")) continue;
      out.push(line);
    }
    return pyStrip(out.join("\n"));
  }
}

export function extractHtml(html: string, readable = false, keepChrome = false): { content: string; title: string } {
  const extractor = new TextExtractor(readable, keepChrome);
  extractor.feed(html);
  const content = extractor.text();
  return { content, title: pyStrip(collapseSpaces(extractor.title)) };
}

export function sections(markdown: string): [string, string[]][] {
  const out: [string, string[]][] = [["", []]];
  for (const line of splitlines(markdown)) {
    if (MARKDOWN_HEADING.test(line)) out.push([line, [line]]);
    else (out.at(-1) as [string, string[]])[1].push(line);
  }
  return out;
}

function stripHashes(line: string): string {
  let start = 0;
  while (line[start] === "#") start += 1;
  return line.slice(start);
}

export function postProcess(content: string, options: { outline?: unknown; filter?: string | null }): string {
  if (options.outline) {
    let headings = splitlines(content).filter((line) => MARKDOWN_HEADING.test(line));
    if (options.filter) {
      const wanted = options.filter.toLowerCase();
      headings = headings.filter((line) => line.toLowerCase().includes(wanted));
    }
    return headings.map((line) => "  ".repeat(Math.max(0, line.length - stripHashes(line).length - 1)) + pyStrip(stripHashes(line))).join("\n");
  }
  if (options.filter) {
    const wanted = options.filter.toLowerCase();
    let kept = sections(content).filter(([heading]) => heading && heading.toLowerCase().includes(wanted)).map(([, lines]) => pyStrip(lines.join("\n")));
    if (kept.length === 0) kept = sections(content).filter(([, lines]) => lines.join("\n").toLowerCase().includes(wanted)).map(([, lines]) => pyStrip(lines.join("\n")));
    return kept.join("\n\n");
  }
  return content;
}

export function llmsLinks(text: string, source: string, filter?: string | null): string[] {
  let links = [...text.matchAll(LINK)].map((match) => `- ${match[1]}: ${urljoin(source, match[2] as string)}`);
  if (filter) {
    const wanted = filter.toLowerCase();
    links = links.filter((line) => line.toLowerCase().includes(wanted));
  }
  return links;
}

export function llmsHrefs(text: string): string[] {
  return [...text.matchAll(LINK)].map((match) => match[2] as string);
}

export function llmsCandidates(url: string, name = "llms.txt"): string[] {
  const parts = urlsplit(url);
  let path = parts.path.replace(/\/+$/, "");
  const out: string[] = [];
  for (;;) {
    out.push(urlunsplit(parts.scheme, parts.netloc, `${path || ""}/${name}`, "", ""));
    if (!path) return out;
    path = path.slice(0, Math.max(0, path.lastIndexOf("/")));
  }
}

function canonicalUrl(text: string): string {
  try {
    return new URL(text).href;
  } catch {
    return text;
  }
}

export function sameDocument(target: string, final: string): boolean {
  const trim = (text: string) => {
    const bare = canonicalUrl(text).replace(/\/+$/, "");
    return bare.endsWith(".md") ? bare.slice(0, -3) : bare;
  };
  return trim(target) === trim(final) && target.endsWith(".md");
}
