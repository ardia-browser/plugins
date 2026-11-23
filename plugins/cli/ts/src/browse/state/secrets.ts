export const SECRET_FIELDS_PER_DOCUMENT = 1024;
export const MASK = "•";

type Live = { readonly targetId: string; readonly frames: ReadonlyMap<string, { readonly loader: string | null }> };
type Tabs = { readonly pages?: ReadonlyMap<string, unknown> };

type Marked = { fields: Set<number>; all: boolean };

const documents = new WeakMap<object, Map<string, Marked>>();

export function documentKey(target: string, frame: string | null, loader: string | null): string {
  return JSON.stringify([target, frame, loader ?? ""]);
}

function pruned(state: object, page: Live): Map<string, Marked> | undefined {
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
  let marked = kept.get(key);
  if (marked === undefined) kept.set(key, (marked = { fields: new Set(), all: false }));
  if (marked.all || marked.fields.has(backend)) return;
  if (marked.fields.size >= SECRET_FIELDS_PER_DOCUMENT) {
    marked.all = true;
    marked.fields.clear();
    return;
  }
  marked.fields.add(backend);
}

export function isSecret(state: object, page: Live, frame: string | null, loader: string | null, backend: number): boolean {
  const marked = pruned(state, page)?.get(documentKey(page.targetId, frame, loader));
  return marked !== undefined && (marked.all || marked.fields.has(backend));
}

export function masked(value: string): string {
  return MASK.repeat(Array.from(value).length);
}
