import { pyStrip } from "../../pylib/str.ts";

export const MIN_CHROME_PAGES = 3;
export const CHROME_SHARE = 0.75;
export const CHROME_EDGE_LINES = 15;
export const MIN_BODY_LINES = 2;

function nonEmptyLines(text: string): string[] {
  return text.split("\n").map(pyStrip).filter((line) => line !== "");
}

const DATA_LINE = /^(?:[A-Za-z][A-Za-z0-9 _/-]{0,36}:\s+\S|[$€£¥]?\d[\d,.:/%-]*$)/u;

function chromeCandidate(line: string): boolean {
  return line.length > 0 && !DATA_LINE.test(line);
}

function sharedPrefix(pages: readonly (readonly string[])[], threshold: number): string[] {
  const prefix: string[] = [];
  for (let pos = 0; pos < CHROME_EDGE_LINES; pos += 1) {
    const counts = new Map<string, number>();
    for (const lines of pages) {
      if (pos >= lines.length) continue;
      const line = lines[pos] as string;
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
    let bestLine = "";
    let bestCount = 0;
    for (const [line, count] of counts) {
      if (count > bestCount) {
        bestLine = line;
        bestCount = count;
      }
    }
    if (bestCount < threshold || !chromeCandidate(bestLine)) break;
    prefix.push(bestLine);
  }
  return prefix;
}

function sharedSuffix(pages: readonly (readonly string[])[], threshold: number): string[] {
  const suffix: string[] = [];
  for (let pos = 0; pos < CHROME_EDGE_LINES; pos += 1) {
    const counts = new Map<string, number>();
    for (const lines of pages) {
      const idx = lines.length - 1 - pos;
      if (idx < 0) continue;
      const line = lines[idx] as string;
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
    let bestLine = "";
    let bestCount = 0;
    for (const [line, count] of counts) {
      if (count > bestCount) {
        bestLine = line;
        bestCount = count;
      }
    }
    if (bestCount < threshold || !chromeCandidate(bestLine)) break;
    suffix.push(bestLine);
  }
  return suffix;
}

function dedupeGroup(texts: readonly string[]): { texts: string[]; omitted: number } {
  const parsed = texts.map(nonEmptyLines);
  const nonEmpty = parsed.filter((lines) => lines.length > 0);
  if (nonEmpty.length < MIN_CHROME_PAGES) return { texts: [...texts], omitted: 0 };
  const threshold = Math.max(MIN_CHROME_PAGES, Math.ceil(nonEmpty.length * CHROME_SHARE));
  const prefix = sharedPrefix(nonEmpty, threshold);
  const suffix = sharedSuffix(nonEmpty, threshold);
  if (prefix.length === 0 && suffix.length === 0) return { texts: [...texts], omitted: 0 };
  let removed = 0;
  const distinct = new Set<string>();
  const cleaned = texts.map((text) => {
    if (!pyStrip(text)) return text;
    const rawLines = text.split("\n");
    const nonEmptyIndices: number[] = [];
    rawLines.forEach((raw, idx) => {
      if (pyStrip(raw)) nonEmptyIndices.push(idx);
    });
    let lead = 0;
    while (lead < prefix.length && lead < nonEmptyIndices.length && pyStrip(rawLines[nonEmptyIndices[lead] as number] as string) === prefix[lead]) {
      distinct.add(prefix[lead] as string);
      lead += 1;
    }
    let trail = 0;
    while (
      trail < suffix.length &&
      lead + trail < nonEmptyIndices.length &&
      pyStrip(rawLines[nonEmptyIndices[nonEmptyIndices.length - 1 - trail] as number] as string) === suffix[trail]
    ) {
      distinct.add(suffix[trail] as string);
      trail += 1;
    }
    if (lead === 0 && trail === 0) return text;
    if (nonEmptyIndices.length - (lead + trail) < MIN_BODY_LINES) return text;
    removed += lead + trail;
    const drop = new Set<number>();
    for (let i = 0; i < lead; i += 1) drop.add(nonEmptyIndices[i] as number);
    for (let i = 0; i < trail; i += 1) drop.add(nonEmptyIndices[nonEmptyIndices.length - 1 - i] as number);
    const kept = rawLines.filter((_, idx) => !drop.has(idx));
    return kept.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
  });
  return { texts: cleaned, omitted: removed > 0 ? distinct.size : 0 };
}

export function dedupeChrome(texts: readonly string[], origins?: readonly string[]): { texts: string[]; omitted: number } {
  if (!origins) return dedupeGroup(texts);
  const groups = new Map<string, number[]>();
  origins.forEach((origin, index) => {
    if (!origin) return;
    const list = groups.get(origin) ?? [];
    list.push(index);
    groups.set(origin, list);
  });
  const out = [...texts];
  let omitted = 0;
  for (const indices of groups.values()) {
    if (indices.length < MIN_CHROME_PAGES) continue;
    const groupTexts = indices.map((index) => texts[index] as string);
    const deduped = dedupeGroup(groupTexts);
    if (deduped.omitted > 0) {
      omitted += deduped.omitted;
      indices.forEach((origIndex, pos) => {
        out[origIndex] = deduped.texts[pos] as string;
      });
    }
  }
  return { texts: out, omitted };
}
