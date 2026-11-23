import { COMBINING, COMPOSED, DECOMPOSED, LEFT_TO_RIGHT, MAPPED, PROHIBITED, RAND_AL } from "./idna-data.ts";

export type Ranges = { starts: number[]; ends: number[] };

function entries(text: string): [number, string][] {
  const found: [number, string][] = [];
  let at = 0;
  for (const item of text.split(" ")) {
    if (!item) continue;
    const colon = item.indexOf(":");
    at += parseInt(item.slice(0, colon), 16);
    found.push([at, item.slice(colon + 1)]);
  }
  return found;
}

function pointsOf(hexes: string): number[] {
  return hexes === "" ? [] : hexes.split(".").map((hex) => parseInt(hex, 16));
}

function sequences(text: string): Map<number, number[]> {
  return new Map(entries(text).map(([point, hexes]) => [point, pointsOf(hexes)]));
}

function rangesOf(text: string): Ranges {
  const starts: number[] = [];
  const ends: number[] = [];
  let last = 0;
  for (const item of text.split(" ")) {
    if (!item) continue;
    const [offset, span] = item.split("+") as [string, string];
    const start = last + parseInt(offset, 16);
    last = start + parseInt(span, 16);
    starts.push(start);
    ends.push(last);
  }
  return { starts, ends };
}

export function within(ranges: Ranges, point: number): boolean {
  let low = 0;
  let high = ranges.starts.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (point < (ranges.starts[middle] as number)) high = middle - 1;
    else if (point > (ranges.ends[middle] as number)) low = middle + 1;
    else return true;
  }
  return false;
}

export type Tables = {
  mapped: Map<number, number[]>;
  decomposed: Map<number, number[]>;
  composed: Map<number, Map<number, number>>;
  combining: Map<number, number>;
  prohibited: Ranges;
  randAl: Ranges;
  leftToRight: Ranges;
};

let loaded: Tables | undefined;

export function tables(): Tables {
  if (loaded !== undefined) return loaded;
  const composed = new Map<number, Map<number, number>>();
  for (const [point, hexes] of entries(COMPOSED)) {
    const [first, second] = pointsOf(hexes) as [number, number];
    let row = composed.get(first);
    if (row === undefined) composed.set(first, (row = new Map()));
    row.set(second, point);
  }
  loaded = {
    mapped: sequences(MAPPED),
    decomposed: sequences(DECOMPOSED),
    composed,
    combining: new Map(entries(COMBINING).map(([point, hex]) => [point, parseInt(hex, 16)])),
    prohibited: rangesOf(PROHIBITED),
    randAl: rangesOf(RAND_AL),
    leftToRight: rangesOf(LEFT_TO_RIGHT),
  };
  return loaded;
}
