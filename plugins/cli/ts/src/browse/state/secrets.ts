export const SECRET_FIELDS_PER_DOCUMENT = 1024;
export const MASK = "•";

type Live = { readonly targetId: string; readonly frames: ReadonlyMap<string, { readonly loader: string | null }> };
type Tabs = { readonly pages?: ReadonlyMap<string, unknown> };

const documents = new WeakMap<object, Map<string, Set<number>>>();

export function documentKey(target: string, frame: string | null, loader: string | null): string {
  return JSON.stringify([target, frame, loader ?? ""]);
}

function pruned(state: object, page: Live): Map<string, Set<number>> | undefined {
  const kept = documents.get(state);
  if (kept === undefined) return undefined;
  const tabs = (state as Tabs).pages;
  for (const key of [...kept.keys()]) {
    const [target, frame, loader] = JSON.parse(key) as [string, string | null, string];
    if (target === page.targetId) {
      const live = frame === null ? undefined : page.frames.get(frame);
      if (live === undefined || (live.loader ?? "") !== loader) kept.delete(key);
    } else if (tabs !== undefined && !tabs.has(target)) kept.delete(key);
  }
  return kept;
}

export function markSecret(state: object, page: Live, frame: string | null, loader: string | null, backend: number): void {
  let kept = pruned(state, page);
  if (kept === undefined) documents.set(state, (kept = new Map()));
  const key = documentKey(page.targetId, frame, loader);
  let fields = kept.get(key);
  if (fields === undefined) kept.set(key, (fields = new Set()));
  fields.delete(backend);
  fields.add(backend);
  while (fields.size > SECRET_FIELDS_PER_DOCUMENT) fields.delete(fields.values().next().value as number);
}

export function isSecret(state: object, page: Live, frame: string | null, loader: string | null, backend: number): boolean {
  return pruned(state, page)?.get(documentKey(page.targetId, frame, loader))?.has(backend) ?? false;
}

export function masked(value: string): string {
  return MASK.repeat(Array.from(value).length);
}
