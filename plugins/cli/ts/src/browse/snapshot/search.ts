import { pyLen } from "../../pylib/str.ts";
import { Usage } from "../daemon-errors.ts";
import { parentsOf } from "./budget.ts";
import { quoted, shownName } from "./render.ts";
import type { Line } from "./take.ts";

export const CONTEXT_LINES = 3;
export const MAX_MATCHES = 50;
export const PATH_STEPS = 5;
const REF_ATTR = /\bref=(?:f[0-9]+)?e[0-9]+\b,? ?/gu;

export type Match = { index: number; path: string };
export type Block = { start: number; end: number; matches: Match[] };
export type Found = { blocks: Block[]; matches: Match[]; more: number };

export function matcher(query: string): (text: string) => boolean {
  const slashed = /^\/(.+)\/([a-z]*)$/su.exec(query);
  if (slashed !== null) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(slashed[1] as string, (slashed[2] as string).replaceAll("g", "") || "i");
    } catch (error) {
      throw new Usage(`snapshot find: ${query} isn't a valid pattern (${error instanceof Error ? error.message : String(error)})`);
    }
    return (text) => pattern.test(text);
  }
  const wanted = query.toLowerCase().replace(/\s+/gu, " ").trim();
  return (text) => text.toLowerCase().replace(/\s+/gu, " ").includes(wanted);
}

export function searchable(line: Line): string {
  return line.text.trimStart().replace(/^- /u, "").replace(REF_ATTR, "").replace(/ \[\]/gu, "");
}

function step(line: Line): string {
  const node = line.node;
  if (node === null) return searchable(line);
  return node.name ? `${node.role} ${quoted(shownName(node.name))}` : node.role;
}

export function ancestorPath(lines: readonly Line[], parents: readonly number[], index: number): string {
  const steps: string[] = [];
  for (let at = parents[index] as number; at >= 0; at = parents[at] as number) steps.unshift(step(lines[at] as Line));
  const shown = steps.length > PATH_STEPS ? ["…", ...steps.slice(-PATH_STEPS)] : steps;
  return shown.join(" > ");
}

export function search(lines: readonly Line[], query: string, around = CONTEXT_LINES): Found {
  const test = matcher(query);
  const parents = parentsOf(lines);
  const all: Match[] = [];
  lines.forEach((line, index) => {
    if (test(searchable(line))) all.push({ index, path: ancestorPath(lines, parents, index) });
  });
  const matches = all.slice(0, MAX_MATCHES);
  return { blocks: blocksOf(lines, matches, around), matches, more: all.length - matches.length };
}

export function blocksOf(lines: readonly Line[], matches: readonly Match[], around = CONTEXT_LINES): Block[] {
  const blocks: Block[] = [];
  for (const match of matches) {
    const start = Math.max(0, match.index - around);
    const end = Math.min(lines.length - 1, match.index + around);
    const last = blocks.at(-1);
    if (last !== undefined && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
      last.matches.push(match);
    } else blocks.push({ start, end, matches: [match] });
  }
  return blocks;
}

export function foundText(lines: readonly Line[], query: string, found: Found): string {
  const count = found.matches.length + found.more;
  const head = `snapshot find ${quoted(query)}: ${count === 0 ? "no" : count} match${count === 1 ? "" : "es"} in ${lines.length} line${lines.length === 1 ? "" : "s"}`;
  if (count === 0) return `${head} (search is over names, roles and values; try fewer words, or a /pattern/)`;
  if (found.matches.length === 0) return `${head}; none fit under the output cap (a longer query, -s <sel> or --full)`;
  const out = [found.more > 0 ? `${head}; the first ${found.matches.length} are shown, a longer query narrows it` : head];
  for (const block of found.blocks) {
    const matched = new Set(block.matches.map((match) => match.index));
    const paths = [...new Set(block.matches.map((match) => match.path))];
    out.push("");
    for (const path of paths) out.push(`in: ${path || "(page)"}`);
    for (let index = block.start; index <= block.end; index += 1) out.push(`${matched.has(index) ? ">" : " "} ${(lines[index] as Line).text}`);
  }
  return out.join("\n");
}

export function shownLines(found: Found): Set<number> {
  const out = new Set<number>();
  for (const block of found.blocks) for (let index = block.start; index <= block.end; index += 1) out.add(index);
  return out;
}

export function fitFound(lines: readonly Line[], query: string, found: Found, room: number): Found {
  for (let keep = found.matches.length; keep >= 0; keep -= 1) {
    const matches = found.matches.slice(0, keep);
    const trimmed: Found = { blocks: blocksOf(lines, matches), matches, more: found.more + found.matches.length - keep };
    if (keep === 0 || pyLen(foundText(lines, query, trimmed)) <= room) return trimmed;
  }
  return found;
}

export function foundWithin(lines: readonly Line[], query: string, found: Found, room: number | null): string {
  const text = foundText(lines, query, found);
  if (room === null || pyLen(text) <= room) return text;
  const count = found.matches.length + found.more;
  const short = `snapshot find ${quoted(query)}: ${count === 0 ? "no" : count} match${count === 1 ? "" : "es"}`;
  return pyLen(short) <= room ? short : "";
}
