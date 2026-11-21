import { codePoints } from "./pystr.ts";

type Block = [number, number, number];

class SequenceMatcher {
  private a: string[] = [];
  private b: string[] = [];
  private b2j = new Map<string, number[]>();
  private fullbcount: Map<string, number> | undefined;
  private blocks: Block[] | undefined;

  setSeq1(a: string[]): void {
    this.a = a;
    this.blocks = undefined;
  }

  setSeq2(b: string[]): void {
    this.b = b;
    this.blocks = undefined;
    this.fullbcount = undefined;
    this.chainB();
  }

  private chainB(): void {
    const b2j = new Map<string, number[]>();
    this.b.forEach((element, index) => {
      const indices = b2j.get(element);
      if (indices === undefined) b2j.set(element, [index]);
      else indices.push(index);
    });
    const n = this.b.length;
    if (n >= 200) {
      const ntest = Math.floor(n / 100) + 1;
      for (const [element, indices] of [...b2j]) if (indices.length > ntest) b2j.delete(element);
    }
    this.b2j = b2j;
  }

  private findLongestMatch(alo: number, ahi: number, blo: number, bhi: number): Block {
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i += 1) {
      const newj2len = new Map<number, number>();
      for (const j of this.b2j.get(this.a[i] as string) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = newj2len;
    }
    while (besti > alo && bestj > blo && this.sameAt(besti - 1, bestj - 1)) {
      besti -= 1;
      bestj -= 1;
      bestsize += 1;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && this.sameAt(besti + bestsize, bestj + bestsize)) bestsize += 1;
    return [besti, bestj, bestsize];
  }

  private sameAt(i: number, j: number): boolean {
    return this.a[i] === this.b[j];
  }

  matchingBlocks(): Block[] {
    if (this.blocks !== undefined) return this.blocks;
    const la = this.a.length;
    const lb = this.b.length;
    const queue: [number, number, number, number][] = [[0, la, 0, lb]];
    const found: Block[] = [];
    while (queue.length > 0) {
      const [alo, ahi, blo, bhi] = queue.pop() as [number, number, number, number];
      const [i, j, k] = this.findLongestMatch(alo, ahi, blo, bhi);
      if (k) {
        found.push([i, j, k]);
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    found.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
    this.blocks = found;
    return found;
  }

  ratio(): number {
    const matches = this.matchingBlocks().reduce((sum, block) => sum + block[2], 0);
    return calculateRatio(matches, this.a.length + this.b.length);
  }

  quickRatio(): number {
    if (this.fullbcount === undefined) {
      this.fullbcount = new Map();
      for (const element of this.b) this.fullbcount.set(element, (this.fullbcount.get(element) ?? 0) + 1);
    }
    const avail = new Map<string, number>();
    let matches = 0;
    for (const element of this.a) {
      const numb = avail.has(element) ? (avail.get(element) as number) : (this.fullbcount.get(element) ?? 0);
      avail.set(element, numb - 1);
      if (numb > 0) matches += 1;
    }
    return calculateRatio(matches, this.a.length + this.b.length);
  }

  realQuickRatio(): number {
    const la = this.a.length;
    const lb = this.b.length;
    return calculateRatio(Math.min(la, lb), la + lb);
  }
}

function calculateRatio(matches: number, length: number): number {
  return length ? (2.0 * matches) / length : 1.0;
}

function comparePoints(left: string[], right: string[]): number {
  const shorter = Math.min(left.length, right.length);
  for (let index = 0; index < shorter; index += 1) {
    const a = (left[index] as string).codePointAt(0) as number;
    const b = (right[index] as string).codePointAt(0) as number;
    if (a !== b) return a - b;
  }
  return left.length - right.length;
}

export function getCloseMatches(word: string, possibilities: readonly string[], n = 3, cutoff = 0.6): string[] {
  const result: [number, string, string[]][] = [];
  const matcher = new SequenceMatcher();
  matcher.setSeq2(codePoints(word));
  for (const x of possibilities) {
    const points = codePoints(x);
    matcher.setSeq1(points);
    if (matcher.realQuickRatio() >= cutoff && matcher.quickRatio() >= cutoff) {
      const score = matcher.ratio();
      if (score >= cutoff) result.push([score, x, points]);
    }
  }
  result.sort((left, right) => right[0] - left[0] || comparePoints(right[2], left[2]));
  return result.slice(0, n).map(([, x]) => x);
}
