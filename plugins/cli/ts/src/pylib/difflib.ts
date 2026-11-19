import { codePoints } from "../pystr.ts";

export type Block = readonly [number, number, number];
export type Opcode = readonly [string, number, number, number, number];

export class SequenceMatcher {
  readonly a: readonly string[];
  readonly b: readonly string[];
  private readonly b2j = new Map<string, number[]>();
  private matching: Block[] | null = null;

  constructor(a: string | readonly string[], b: string | readonly string[], readonly autojunk = true) {
    this.a = typeof a === "string" ? codePoints(a) : a;
    this.b = typeof b === "string" ? codePoints(b) : b;
    this.b.forEach((element, index) => {
      const indices = this.b2j.get(element);
      if (indices) indices.push(index);
      else this.b2j.set(element, [index]);
    });
    const n = this.b.length;
    if (autojunk && n >= 200) {
      const ntest = Math.floor(n / 100) + 1;
      for (const [element, indices] of [...this.b2j]) if (indices.length > ntest) this.b2j.delete(element);
    }
  }

  findLongestMatch(alo: number, ahi: number, blo: number, bhi: number): Block {
    const { a, b, b2j } = this;
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i += 1) {
      const newj2len = new Map<number, number>();
      const indices = b2j.get(a[i] as string);
      if (indices) {
        for (const j of indices) {
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
      }
      j2len = newj2len;
    }
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti -= 1;
      bestj -= 1;
      bestsize += 1;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) bestsize += 1;
    return [besti, bestj, bestsize];
  }

  matchingBlocks(): Block[] {
    if (this.matching) return this.matching;
    const la = this.a.length;
    const lb = this.b.length;
    const queue: [number, number, number, number][] = [[0, la, 0, lb]];
    const blocks: Block[] = [];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop() as [number, number, number, number];
      const found = this.findLongestMatch(alo, ahi, blo, bhi);
      const [i, j, k] = found;
      if (k) {
        blocks.push(found);
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
    let [i1, j1, k1] = [0, 0, 0];
    const merged: Block[] = [];
    for (const [i2, j2, k2] of blocks) {
      if (i1 + k1 === i2 && j1 + k1 === j2) k1 += k2;
      else {
        if (k1) merged.push([i1, j1, k1]);
        [i1, j1, k1] = [i2, j2, k2];
      }
    }
    if (k1) merged.push([i1, j1, k1]);
    merged.push([la, lb, 0]);
    this.matching = merged;
    return merged;
  }

  opcodes(): Opcode[] {
    let i = 0;
    let j = 0;
    const answer: Opcode[] = [];
    for (const [ai, bj, size] of this.matchingBlocks()) {
      const tag = i < ai && j < bj ? "replace" : i < ai ? "delete" : j < bj ? "insert" : "";
      if (tag) answer.push([tag, i, ai, j, bj]);
      i = ai + size;
      j = bj + size;
      if (size) answer.push(["equal", ai, i, bj, j]);
    }
    return answer;
  }

  groupedOpcodes(n = 3): Opcode[][] {
    let codes = this.opcodes();
    if (!codes.length) codes = [["equal", 0, 1, 0, 1]];
    const first = codes[0] as Opcode;
    if (first[0] === "equal") codes[0] = [first[0], Math.max(first[1], first[2] - n), first[2], Math.max(first[3], first[4] - n), first[4]];
    const last = codes.at(-1) as Opcode;
    if (last[0] === "equal") codes[codes.length - 1] = [last[0], last[1], Math.min(last[2], last[1] + n), last[3], Math.min(last[4], last[3] + n)];
    const nn = n + n;
    const groups: Opcode[][] = [];
    let group: Opcode[] = [];
    for (const code of codes) {
      let [tag, i1, i2, j1, j2] = code;
      if (tag === "equal" && i2 - i1 > nn) {
        group.push([tag, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)]);
        groups.push(group);
        group = [];
        [i1, j1] = [Math.max(i1, i2 - n), Math.max(j1, j2 - n)];
      }
      group.push([tag, i1, i2, j1, j2]);
    }
    if (group.length && !(group.length === 1 && (group[0] as Opcode)[0] === "equal")) groups.push(group);
    return groups;
  }

  ratio(): number {
    const matches = this.matchingBlocks().reduce((sum, block) => sum + block[2], 0);
    const length = this.a.length + this.b.length;
    return length ? (2.0 * matches) / length : 1.0;
  }
}

function unifiedRange(start: number, stop: number): string {
  let beginning = start + 1;
  const length = stop - start;
  if (length === 1) return `${beginning}`;
  if (!length) beginning -= 1;
  return `${beginning},${length}`;
}

export function unifiedDiff(a: readonly string[], b: readonly string[], fromfile = "", tofile = "", fromdate = "", todate = "", n = 3, lineterm = "\n"): string[] {
  const out: string[] = [];
  let started = false;
  for (const group of new SequenceMatcher(a, b).groupedOpcodes(n)) {
    if (!started) {
      started = true;
      out.push(`--- ${fromfile}${fromdate ? `\t${fromdate}` : ""}${lineterm}`, `+++ ${tofile}${todate ? `\t${todate}` : ""}${lineterm}`);
    }
    const first = group[0] as Opcode;
    const last = group.at(-1) as Opcode;
    out.push(`@@ -${unifiedRange(first[1], last[2])} +${unifiedRange(first[3], last[4])} @@${lineterm}`);
    for (const [tag, i1, i2, j1, j2] of group) {
      if (tag === "equal") {
        for (const line of a.slice(i1, i2)) out.push(` ${line}`);
        continue;
      }
      if (tag === "replace" || tag === "delete") for (const line of a.slice(i1, i2)) out.push(`-${line}`);
      if (tag === "replace" || tag === "insert") for (const line of b.slice(j1, j2)) out.push(`+${line}`);
    }
  }
  return out;
}
