import type { Page } from "../state/page.ts";
import { type Ref, Refs, type Vocabulary } from "../state/refs.ts";

type Known = Vocabulary & { keys: Set<string> };

const vocabularies = new WeakMap<object, Map<string, Map<string, Known>>>();

function framesOf(state: Refs, target: string): Map<string, Known> {
  let tabs = vocabularies.get(state);
  if (tabs === undefined) {
    tabs = new Map();
    vocabularies.set(state, tabs);
  }
  let frames = tabs.get(target);
  if (frames === undefined) {
    frames = new Map();
    tabs.set(target, frames);
  }
  return frames;
}

export function keysOf(refs: readonly Pick<Ref, "role" | "name">[]): Set<string> {
  return new Set(refs.filter((ref) => ref.name).map((ref) => JSON.stringify([ref.role, ref.name])));
}

export function nextEpoch(before: Known | undefined, loader: string, keys: ReadonlySet<string>, whole: boolean): number {
  if (before === undefined) return 1;
  const overlaps = [...keys].some((key) => before.keys.has(key));
  if (before.loader !== loader) return overlaps ? before.epoch : before.epoch + 1;
  if (whole && keys.size > 0 && before.keys.size > 0 && !overlaps) return before.epoch + 1;
  return before.epoch;
}

export type Epochs = { main: number; frames: Map<string, number> };

export function advance(state: Refs, page: Page, refs: readonly Ref[], whole: boolean): Epochs {
  const known = framesOf(state, page.targetId);
  const byFrame = new Map<string, Ref[]>();
  const main = page.mainFrame ?? "";
  byFrame.set(main, []);
  for (const ref of refs) {
    const list = byFrame.get(ref.frame) ?? [];
    list.push(ref);
    byFrame.set(ref.frame, list);
  }
  const frames = new Map<string, number>();
  for (const [frame, list] of byFrame) {
    const before = known.get(frame);
    const loader = page.loader(frame) || "";
    const keys = keysOf(list);
    const epoch = nextEpoch(before, loader, keys, whole);
    const fresh = whole || before === undefined || before.loader !== loader || epoch !== before.epoch;
    if (fresh) known.set(frame, { epoch, loader, keys: whole || before === undefined || before.loader !== loader ? keys : new Set([...before.keys, ...keys]) });
    else if (before !== undefined) for (const key of keys) before.keys.add(key);
    frames.set(frame, epoch);
  }
  return { main: frames.get(main) ?? 1, frames };
}

export function vocabulary(state: Refs, target: string, frame: string): Vocabulary | null {
  const found = vocabularies.get(state)?.get(target)?.get(frame);
  return found === undefined ? null : { epoch: found.epoch, loader: found.loader };
}

export function forget(state: Refs, target: string): void {
  vocabularies.get(state)?.delete(target);
}

Refs.epochs = { vocabulary, forget };
