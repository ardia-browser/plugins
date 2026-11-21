import { Float, type Value } from "../../src/json.ts";
import { extractHtml, llmsCandidates, llmsLinks, postProcess, sections } from "../../src/browse/read/readurl.ts";
import { SequenceMatcher, unifiedDiff } from "../../src/pylib/difflib.ts";
import { groupThousands } from "../../src/pylib/format.ts";
import { unescape } from "../../src/pylib/html.ts";
import { HTMLParser } from "../../src/pylib/htmlparser.ts";
import { shlexQuote, shlexSplit } from "../../src/pylib/shlex.ts";
import { splitlines } from "../../src/pylib/str.ts";
import { urljoin } from "../../src/pylib/urllib.ts";
import { bool, optionalText, text, texts } from "./values.ts";

function sequence(value: Value | undefined): string | string[] {
  return Array.isArray(value) ? texts(value) : text(value);
}

function parse(chunks: Value | undefined, close: Value | undefined): Value {
  const events: Value[] = [];
  const parser = new HTMLParser({
    starttag: (tag, attrs) => events.push(["start", tag, attrs.map(([name, value]): Value => [name, value])]),
    endtag: (tag) => events.push(["end", tag]),
    data: (data) => events.push(["data", data]),
    comment: (data) => events.push(["comment", data]),
    decl: (data) => events.push(["decl", data]),
    pi: (data) => events.push(["pi", data]),
    unknownDecl: (data) => events.push(["unknown", data]),
  });
  for (const chunk of texts(chunks)) parser.feed(chunk);
  if (bool(close)) parser.close();
  return new Map<string, Value>([["events", events], ["rest", parser.rawdata], ["lasttag", parser.lasttag]]);
}

export const P3_FUNCTIONS: Record<string, (...args: Value[]) => Value> = {
  "shlex.split": (value) => shlexSplit(text(value)),
  "shlex.quote": (value) => shlexQuote(text(value)),
  "difflib.ratio": (a, b) => new Float(new SequenceMatcher(sequence(a), sequence(b)).ratio()),
  "difflib.opcodes": (a, b) => new SequenceMatcher(sequence(a), sequence(b)).opcodes().map(([tag, i1, i2, j1, j2]): Value => [tag, BigInt(i1), BigInt(i2), BigInt(j1), BigInt(j2)]),
  "difflib.unified": (before, after) => unifiedDiff(splitlines(text(before)), splitlines(text(after)), "before", "after", "", "", 3, ""),
  "str.splitlines": (value, keep) => splitlines(text(value), bool(keep)),
  "html.unescape": (value) => unescape(text(value)),
  "html.parse": parse,
  "readurl.extract": (value) => {
    const { content, title } = extractHtml(text(value));
    return new Map<string, Value>([["content", content], ["title", title]]);
  },
  "readurl.sections": (value) => sections(text(value)).map(([heading, lines]): Value => [heading, lines]),
  "readurl.post_process": (content, outline, filter) => postProcess(text(content), { outline: bool(outline), filter: optionalText(filter) }),
  "readurl.llms_links": (value, source, filter) => llmsLinks(text(value), text(source), optionalText(filter)),
  "readurl.candidates": (url, name) => llmsCandidates(text(url), text(name)),
  "urllib.urljoin": (base, url) => urljoin(text(base), text(url)),
  "format.comma": (value) => groupThousands((value as bigint).toString()),
};
