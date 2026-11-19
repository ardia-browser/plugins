import { dumps, parseText, type Value } from "../../json.ts";
import { reprText, pyLen, pyStrip } from "../../pylib/str.ts";
import { groupThousands } from "../../pylib/format.ts";
import { PY_SPACE_CLASS } from "../../pylib/re.ts";
import { BrowseError, Usage } from "../daemon-errors.ts";
import { Result } from "../daemon/render.ts";
import { PAGEDATA_SCRIPTS } from "../js/index.ts";
import { count, flag } from "../metrics.ts";
import { apply, itemFields, mainList, parseShape } from "../shape.ts";
import type { Page } from "../state/page.ts";
import { record } from "../state/records.ts";

export const KEY_PREVIEW = 12;
export const FIELD_PREVIEW = 8;
const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu;
const ATTRIBUTE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+)/gu;
const WORD = "\\p{L}\\p{N}\\p{Mn}\\p{Mc}\\p{Pc}";
const ASSIGNED = new RegExp(
  `^[${PY_SPACE_CLASS}]*(?:(?:window|self|globalThis)\\.|var[${PY_SPACE_CLASS}]+|let[${PY_SPACE_CLASS}]+|const[${PY_SPACE_CLASS}]+)?([A-Za-z_$][${WORD}$.]*(?:\\[[${PY_SPACE_CLASS}]*['"][^'"]+['"][${PY_SPACE_CLASS}]*\\])*)[${PY_SPACE_CLASS}]*=[${PY_SPACE_CLASS}]*([\\s\\S]+?)[${PY_SPACE_CLASS}]*;?[${PY_SPACE_CLASS}]*$`,
  "u",
);

export type Script = { id: string; type: string; text: string };
export type Block = { id: string | null; kind: string; size: number; value: Value; block: number };

function stripQuotes(value: string): string {
  return value.replace(/^["']+|["']+$/gu, "");
}

export function attributes(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of text.matchAll(ATTRIBUTE)) out.set((match[1] as string).toLowerCase(), stripQuotes(match[2] as string));
  return out;
}

export function embeddedJson(html: string): [Record<string, unknown>, Value, number][] {
  const out: [Record<string, unknown>, Value, number][] = [];
  let index = 0;
  for (const match of html.matchAll(SCRIPT)) {
    const attrs = attributes(match[1] as string);
    const kind = (attrs.get("type") ?? "").toLowerCase();
    if (kind && !kind.includes("json") && !["text/javascript", "application/javascript", "module"].includes(kind)) continue;
    let content = pyStrip(match[2] as string);
    if (!kind.includes("json")) {
      const assigned = ASSIGNED.exec(content);
      if (!assigned) continue;
      content = pyStrip(assigned[2] as string);
    }
    if (!content.startsWith("{") && !content.startsWith("[")) continue;
    let value: Value | undefined;
    try {
      value = parseText(content);
    } catch {
      continue;
    }
    if (value === undefined) continue;
    const spec = attrs.get("id") ? { scriptId: attrs.get("id") } : { scriptIndex: index };
    index += 1;
    out.push([spec, value, pyLen(content)]);
  }
  return out;
}

export function blocksOf(scripts: readonly Script[]): Block[] {
  const found: Block[] = [];
  for (const script of scripts ?? []) {
    const attrs = (script.id ? ` id="${script.id}"` : "") + (script.type ? ` type="${script.type}"` : "");
    for (const [, value, size] of embeddedJson(`<script${attrs}>${script.text}</script>`)) {
      const type = script.type ?? "";
      const kind = type.includes("ld+json") ? "ld+json" : type.includes("json") ? "json" : "assigned";
      found.push({ id: script.id || null, kind, size, value, block: 0 });
    }
  }
  found.forEach((block, index) => {
    block.block = index + 1;
  });
  return found;
}

function keyText(key: string): string {
  return key;
}

export function summary(block: Block): string {
  const value = block.value;
  const name = block.id ? `#${block.id}` : block.kind;
  let head = `[${block.block}] ${name} (${block.kind}, ${groupThousands(String(block.size))} chars)`;
  if (value instanceof Map) {
    const keys = [...value.keys()];
    head += `: keys ${keys.slice(0, KEY_PREVIEW).map(keyText).join(", ")}${keys.length > KEY_PREVIEW ? " …" : ""}`;
  } else if (Array.isArray(value)) head += `: a list of ${value.length}`;
  const found = mainList(value);
  if (found && found[1].length) {
    const [path, items] = found;
    const fields = itemFields(items);
    head += `\n    main list ${path || "(the block itself)"}: ${items.length} items with ${fields.slice(0, FIELD_PREVIEW).join(", ")}${fields.length > FIELD_PREVIEW ? " …" : ""}`;
  }
  return head;
}

export function pickBlock(blocks: readonly Block[], wanted: string | null): Block {
  if (wanted === null) return blocks.reduce((best, block) => (block.size > best.size ? block : best));
  for (const block of blocks) {
    if (String(block.block) === wanted || (block.id && block.id === wanted.replace(/^#+/u, ""))) return block;
  }
  throw new Usage(`--block takes a block number (1–${blocks.length}) or a script id from \`read --data\`, not ${reprText(wanted)}`);
}

function rowsLike(value: Value): boolean {
  return Array.isArray(value) && value.length > 0 && value.every((item) => item instanceof Map || Array.isArray(item));
}

export function renderJson(value: Value): string {
  if (rowsLike(value)) return (value as Value[]).map((item) => dumps(item, "spaced")).join("\n");
  if (value instanceof Map && [...value.values()].some(rowsLike)) {
    const lines: string[] = [];
    for (const [key, item] of value) {
      if (rowsLike(item)) {
        lines.push(`${key}: ${(item as Value[]).length} rows`);
        for (const row of item as Value[]) lines.push(dumps(row, "spaced"));
      } else lines.push(`${key}: ${dumps(item, "spaced")}`);
    }
    return lines.join("\n");
  }
  return dumps(value, "indented");
}

export async function run(page: Page, frame: string, options: Record<string, unknown>): Promise<Result> {
  const raw = await page.call(PAGEDATA_SCRIPTS, [], { frame, read: true });
  const scripts = (Array.isArray(raw) ? raw : []).map((item) => {
    const script = record(item);
    return { id: String(script["id"] ?? ""), type: String(script["type"] ?? ""), text: String(script["text"] ?? "") };
  });
  const blocks = blocksOf(scripts);
  flag("read_data", true);
  count("read_data_blocks", blocks.length);
  if (blocks.length === 0) {
    throw new BrowseError(
      "This page embeds no JSON data (no __NEXT_DATA__, JSON-LD, application/json script or window state); read its text with `read` instead",
      null,
      "no_data",
    );
  }
  const wanted = (options["block"] as string | undefined) ?? null;
  const plan = parseShape((options["fields"] as string | undefined) ?? null, (options["where"] as string[] | undefined) ?? null, (options["limit"] as string | undefined) ?? null);
  if (plan.empty && wanted === null) {
    const listing = blocks.map((block) => ({ block: block.block, id: block.id, kind: block.kind, size: block.size }));
    const text = `${blocks.length} data block${blocks.length !== 1 ? "s" : ""} on this page (pick one with --block N; shape it with --fields a,b.c --where f=v --limit n):\n`;
    return new Result({ blocks: listing, url: page.url }, text + blocks.map(summary).join("\n"), true);
  }
  const block = pickBlock(blocks, wanted);
  const shaped = plan.empty ? block.value : apply(block.value, plan);
  if (!plan.empty) flag("read_data_shaped", true);
  return new Result(new Map<string, Value>([["block", BigInt(block.block)], ["id", block.id], ["kind", block.kind], ["url", page.url], ["data", shaped]]), renderJson(shaped), true);
}
