import { dumps, type Value } from "./json.ts";
import { codePoints } from "./pystr.ts";

type Block = [number, number, number];

class Matcher {
  private readonly b2j = new Map<string, number[]>();
  private readonly fullCount = new Map<string, number>();

  constructor(
    readonly a: string[],
    readonly b: string[],
  ) {
    b.forEach((element, index) => {
      const indices = this.b2j.get(element);
      if (indices === undefined) this.b2j.set(element, [index]);
      else indices.push(index);
      this.fullCount.set(element, (this.fullCount.get(element) ?? 0) + 1);
    });
    if (b.length >= 200) {
      const popular = Math.floor(b.length / 100) + 1;
      for (const [element, indices] of [...this.b2j]) if (indices.length > popular) this.b2j.delete(element);
    }
  }

  private longest(alo: number, ahi: number, blo: number, bhi: number): Block {
    const { a, b } = this;
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let lengths = new Map<number, number>();
    for (let i = alo; i < ahi; i += 1) {
      const next = new Map<number, number>();
      for (const j of this.b2j.get(a[i] as string) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (lengths.get(j - 1) ?? 0) + 1;
        next.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      lengths = next;
    }
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti -= 1;
      bestj -= 1;
      bestsize += 1;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) bestsize += 1;
    return [besti, bestj, bestsize];
  }

  private matches(): number {
    const queue: [number, number, number, number][] = [[0, this.a.length, 0, this.b.length]];
    let total = 0;
    for (let range = queue.pop(); range !== undefined; range = queue.pop()) {
      const [alo, ahi, blo, bhi] = range;
      const [i, j, k] = this.longest(alo, ahi, blo, bhi);
      if (k === 0) continue;
      total += k;
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
    return total;
  }

  private scaled(matches: number): number {
    const length = this.a.length + this.b.length;
    return length === 0 ? 1.0 : (2.0 * matches) / length;
  }

  realQuickRatio(): number {
    return this.scaled(Math.min(this.a.length, this.b.length));
  }

  quickRatio(): number {
    const available = new Map<string, number>();
    let matches = 0;
    for (const element of this.a) {
      const left = available.has(element) ? (available.get(element) as number) : (this.fullCount.get(element) ?? 0);
      available.set(element, left - 1);
      if (left > 0) matches += 1;
    }
    return this.scaled(matches);
  }

  ratio(): number {
    return this.scaled(this.matches());
  }
}

function compareCodePoints(left: string, right: string): number {
  const a = codePoints(left);
  const b = codePoints(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const x = (a[index] as string).codePointAt(0) as number;
    const y = (b[index] as string).codePointAt(0) as number;
    if (x !== y) return x - y;
  }
  return a.length - b.length;
}

export function closeMatches(word: string, possibilities: string[], n = 3, cutoff = 0.6): string[] {
  const wordPoints = codePoints(word);
  const scored: [number, string][] = [];
  for (const candidate of possibilities) {
    const matcher = new Matcher(codePoints(candidate), wordPoints);
    if (matcher.realQuickRatio() >= cutoff && matcher.quickRatio() >= cutoff) {
      const ratio = matcher.ratio();
      if (ratio >= cutoff) scored.push([ratio, candidate]);
    }
  }
  scored.sort((x, y) => y[0] - x[0] || compareCodePoints(y[1], x[1]));
  return scored.slice(0, n).map(([, candidate]) => candidate);
}

export function closest(name: string, candidates: Value[]): string[] {
  const words = candidates.filter((candidate): candidate is string => typeof candidate === "string");
  const lowered = name.toLowerCase();
  const folded = words.filter((word) => word.toLowerCase() === lowered);
  return folded.length > 0 ? folded : closeMatches(name, words);
}

export function show(value: Value): string {
  return typeof value === "string" ? value : dumps(value, "spaced");
}

export function choices(values: Value[]): string {
  const shown = values.map(show);
  if (shown.length === 1) return shown[0] as string;
  return `${shown.slice(0, -1).join(", ")} or ${shown.at(-1)}`;
}

export function didYouMean(name: string, candidates: Value[]): string {
  const found = closest(name, candidates);
  return found.length > 0 ? ` (did you mean ${choices(found)}?)` : "";
}
