import { pyStrip } from "../../pylib/str.ts";

export const MIN_DELTA_LINES = 8;
export const MIN_UNCHANGED_SHARE = 0.4;
export const MIN_COLLAPSE_RUN = 4;
export const MIN_SAVED_LINES = 6;
const MAX_LCS_CELLS = 250_000;

function alignedPrevIndex(prevNorm: readonly string[], currNorm: readonly string[]): Int32Array | null {
  const m = prevNorm.length;
  const n = currNorm.length;
  const prevPos = new Int32Array(n).fill(-1);
  let prefix = 0;
  while (prefix < m && prefix < n && prevNorm[prefix] === currNorm[prefix]) {
    prevPos[prefix] = prefix;
    prefix += 1;
  }
  let suffix = 0;
  while (suffix < m - prefix && suffix < n - prefix && prevNorm[m - 1 - suffix] === currNorm[n - 1 - suffix]) {
    prevPos[n - 1 - suffix] = m - 1 - suffix;
    suffix += 1;
  }
  const midM = m - prefix - suffix;
  const midN = n - prefix - suffix;
  if (midM <= 0 || midN <= 0) return prevPos;
  if (midM * midN > MAX_LCS_CELLS) return null;
  const stride = midN + 1;
  const dp = new Uint32Array((midM + 1) * stride);
  for (let i = midM - 1; i >= 0; i -= 1) {
    const p = prevNorm[prefix + i];
    const row = i * stride;
    const nextRow = (i + 1) * stride;
    for (let j = midN - 1; j >= 0; j -= 1) {
      if (p === currNorm[prefix + j]) dp[row + j] = (dp[nextRow + j + 1] as number) + 1;
      else dp[row + j] = Math.max(dp[nextRow + j] as number, dp[row + j + 1] as number);
    }
  }
  let i = 0;
  let j = 0;
  while (i < midM && j < midN) {
    if (prevNorm[prefix + i] === currNorm[prefix + j]) {
      prevPos[prefix + j] = prefix + i;
      i += 1;
      j += 1;
    } else if ((dp[(i + 1) * stride + j] as number) >= (dp[i * stride + j + 1] as number)) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return prevPos;
}

export function deltaRead(previous: string, current: string): { text: string; omitted: number; unchanged: boolean } {
  if (pyStrip(previous) === pyStrip(current)) {
    const count = current.split("\n").length;
    return { text: "(unchanged since last read; --full shows all)", omitted: count, unchanged: true };
  }
  const prevLines = previous.split("\n");
  const currLines = current.split("\n");
  if (currLines.length < MIN_DELTA_LINES) return { text: current, omitted: 0, unchanged: false };
  const prevNorm: string[] = [];
  for (const raw of prevLines) {
    const line = pyStrip(raw);
    if (line) prevNorm.push(line);
  }
  const currNorm: string[] = [];
  const currIdx: number[] = [];
  currLines.forEach((raw, idx) => {
    const line = pyStrip(raw);
    if (line) {
      currNorm.push(line);
      currIdx.push(idx);
    }
  });
  const nonEmpty = currNorm.length;
  if (nonEmpty === 0 || prevNorm.length === 0) return { text: current, omitted: 0, unchanged: false };
  const prevPos = alignedPrevIndex(prevNorm, currNorm);
  if (prevPos === null) return { text: current, omitted: 0, unchanged: false };
  let matched = 0;
  const linePrev = new Int32Array(currLines.length).fill(-2);
  currLines.forEach((raw, idx) => {
    if (pyStrip(raw) === "") linePrev[idx] = -1;
  });
  for (let pos = 0; pos < nonEmpty; pos += 1) {
    const mapped = prevPos[pos] as number;
    if (mapped >= 0) {
      matched += 1;
      linePrev[currIdx[pos] as number] = mapped;
    }
  }
  if (matched < MIN_DELTA_LINES || matched / nonEmpty < MIN_UNCHANGED_SHARE) {
    return { text: current, omitted: 0, unchanged: false };
  }
  const out: string[] = [];
  let omitted = 0;
  let index = 0;
  let lastPrevMatched = -1;
  while (index < currLines.length) {
    const mapped = linePrev[index] as number;
    if (mapped === -2) {
      out.push(currLines[index] as string);
      index += 1;
      continue;
    }
    let end = index;
    let runLastPrev = -1;
    let gapBefore = 0;
    while (end < currLines.length) {
      const m = linePrev[end] as number;
      if (m === -2) break;
      if (m >= 0) {
        if (runLastPrev === -1) {
          if (lastPrevMatched >= 0 && m > lastPrevMatched + 1) gapBefore = m - lastPrevMatched - 1;
          else if (lastPrevMatched === -1 && m > 0) gapBefore = m;
          runLastPrev = m;
        } else if (m !== runLastPrev + 1) {
          break;
        } else {
          runLastPrev = m;
        }
      }
      end += 1;
    }
    if (gapBefore > 0) out.push(`[… ${gapBefore} line${gapBefore === 1 ? "" : "s"} removed]`);
    const nonBlankInRun = currLines.slice(index, end).filter((line) => pyStrip(line) !== "").length;
    if (nonBlankInRun >= MIN_COLLAPSE_RUN) {
      const keepStart = index > 0 || gapBefore > 0 ? 1 : 0;
      const hasTrailingGap = end < currLines.length || (runLastPrev >= 0 && runLastPrev < prevNorm.length - 1);
      const keepEnd = hasTrailingGap ? 1 : 0;
      const dropStart = index + keepStart;
      const dropEnd = end - keepEnd;
      const dropped = currLines.slice(dropStart, dropEnd).filter((line) => pyStrip(line) !== "").length;
      if (dropped >= MIN_COLLAPSE_RUN) {
        if (keepStart) out.push(currLines[index] as string);
        out.push(`[… ${dropped} unchanged lines omitted; --full shows all]`);
        if (keepEnd) out.push(currLines[end - 1] as string);
        omitted += dropped;
        if (runLastPrev >= 0) lastPrevMatched = runLastPrev;
        index = end;
        continue;
      }
    }
    for (let cursor = index; cursor < end; cursor += 1) out.push(currLines[cursor] as string);
    if (runLastPrev >= 0) lastPrevMatched = runLastPrev;
    index = end;
  }
  if (lastPrevMatched >= 0 && lastPrevMatched < prevNorm.length - 1) {
    const trailing = prevNorm.length - 1 - lastPrevMatched;
    out.push(`[… ${trailing} line${trailing === 1 ? "" : "s"} removed]`);
  }
  if (omitted < MIN_SAVED_LINES) return { text: current, omitted: 0, unchanged: false };
  return { text: out.join("\n").replace(/\n{3,}/gu, "\n\n").trim(), omitted, unchanged: false };
}
