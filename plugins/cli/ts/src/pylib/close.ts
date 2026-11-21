import { codePoints } from "../pystr.ts";
import { SequenceMatcher } from "./difflib.ts";

function compareCodePoints(a: string, b: string): number {
  const left = codePoints(a);
  const right = codePoints(b);
  for (let at = 0; at < Math.min(left.length, right.length); at += 1) {
    const x = (left[at] as string).codePointAt(0) as number;
    const y = (right[at] as string).codePointAt(0) as number;
    if (x !== y) return x - y;
  }
  return left.length - right.length;
}

export function getCloseMatches(word: string, possibilities: readonly string[], n = 3, cutoff = 0.6): string[] {
  const scored: [number, string][] = [];
  for (const candidate of possibilities) {
    const score = new SequenceMatcher(candidate, word).ratio();
    if (score >= cutoff) scored.push([score, candidate]);
  }
  scored.sort((x, y) => (x[0] !== y[0] ? y[0] - x[0] : compareCodePoints(y[1], x[1])));
  return scored.slice(0, n).map(([, candidate]) => candidate);
}

export function closest(name: string, candidates: readonly unknown[]): string[] {
  const strings = candidates.filter((candidate): candidate is string => typeof candidate === "string");
  const folded = strings.filter((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return folded.length > 0 ? folded : getCloseMatches(name, strings);
}

export function choices(values: readonly string[]): string {
  if (values.length === 1) return values[0] as string;
  return `${values.slice(0, -1).join(", ")} or ${values[values.length - 1]}`;
}

export function didYouMean(name: string, candidates: readonly unknown[]): string {
  const found = closest(name, candidates);
  return found.length > 0 ? ` (did you mean ${choices(found)}?)` : "";
}
