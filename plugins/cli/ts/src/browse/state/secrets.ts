export const SECRET_FIELDS_KEPT = 256;
export const MASK = "•";

const fields = new WeakMap<object, Set<string>>();

export function secretKey(target: string, frame: string | null, loader: string | null, backend: number): string {
  return JSON.stringify([target, frame, loader ?? "", backend]);
}

export function markSecret(state: object, key: string): void {
  let kept = fields.get(state);
  if (kept === undefined) fields.set(state, (kept = new Set()));
  kept.delete(key);
  kept.add(key);
  while (kept.size > SECRET_FIELDS_KEPT) kept.delete(kept.values().next().value as string);
}

export function isSecret(state: object, key: string): boolean {
  return fields.get(state)?.has(key) ?? false;
}

export function masked(value: string): string {
  return MASK.repeat(Array.from(value).length);
}
