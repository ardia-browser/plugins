export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let beforePrevious: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= b.length; column += 1) {
      const cost = a[row - 1] === b[column - 1] ? 0 : 1;
      let best = Math.min((previous[column] as number) + 1, (current[column - 1] as number) + 1, (previous[column - 1] as number) + cost);
      if (row > 1 && column > 1 && a[row - 1] === b[column - 2] && a[row - 2] === b[column - 1]) {
        best = Math.min(best, (beforePrevious[column - 2] as number) + 1);
      }
      current.push(best);
    }
    beforePrevious = previous;
    previous = current;
  }
  return previous[b.length] as number;
}

function allowedDistance(word: string): number {
  const length = word.replace(/^-+/u, "").length;
  if (length <= 3) return 1;
  if (length <= 6) return 2;
  return 3;
}

export function closest(word: string, candidates: Iterable<string>): string | undefined {
  const typed = word.toLowerCase();
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (candidate === word) return undefined;
    const distance = editDistance(typed, candidate.toLowerCase());
    if (distance < bestDistance || (distance === bestDistance && best !== undefined && candidate < best)) {
      best = candidate;
      bestDistance = distance;
    }
  }
  if (best === undefined) return undefined;
  if (bestDistance <= allowedDistance(word)) return best;
  const bare = typed.replace(/^-+/u, "");
  const prefixed = [...candidates].filter((candidate) => bare.length >= 3 && candidate.replace(/^-+/u, "").toLowerCase().startsWith(bare));
  return prefixed.length === 1 ? prefixed[0] : undefined;
}

export function didYouMean(word: string, candidates: Iterable<string>): string {
  const found = closest(word, candidates);
  return found === undefined ? "" : `. Did you mean ${found}?`;
}
