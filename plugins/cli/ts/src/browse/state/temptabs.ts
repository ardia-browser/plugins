import { type Browser } from "../cdp/browser.ts";
import { Cancelled, currentSignal, sleep, withSignal } from "../cdp/cancel.ts";
import { BrowseError, Gated } from "../daemon-errors.ts";
import { type Instance, type Registry } from "./registry.ts";

export const CLOSE_TIMEOUT = 3.0;
export const GONE_WAIT = 2.0;
export const GONE_POLL = 0.05;
export const RETRY_FIRST = 1.0;
export const RETRY_MAX = 30.0;
export const DRAIN_BUDGET = 3.0;

export type TempTabState = {
  readonly registry: Registry;
  readonly instance: Instance;
  readonly connected: boolean;
  readonly browser: Browser | null;
  mustClose: Set<string>;
  mustCloseTask: { done: boolean; stop: AbortController; finished: Promise<void> } | null;
  forgetTarget(targetId: string): void;
};

export const SHIELD_DEADLINE = 10.0;

export async function settleThenCancel<T>(run: () => Promise<T>, signal: AbortSignal | null = currentSignal()): Promise<T> {
  const result = await withSignal(AbortSignal.timeout(SHIELD_DEADLINE * 1000), run);
  if (signal?.aborted) throw new Cancelled();
  return result;
}

export function giveBack(state: TempTabState, slot: string | null): void {
  if (slot === null) return;
  try {
    state.registry.dropTemporary(state.instance, slot);
  } catch {}
}

export async function create(state: TempTabState, owned: string[]): Promise<string> {
  const registry = state.registry;
  const slot = registry.reserveTemporary(state.instance);
  return settleThenCancel(async () => {
    let result: Record<string, unknown>;
    try {
      result = await (state.browser as Browser).send("Target.createTarget", { url: "about:blank", background: true });
    } catch (error) {
      giveBack(state, slot);
      if (error instanceof Gated) throw new BrowseError(`Ardia's policy refused to open a tab for the ardia command (${error.refusal})`);
      throw error;
    }
    const targetId = String(result["targetId"]);
    try {
      registry.noteTemporary(state.instance, targetId, slot);
    } catch (error) {
      mustClose(state, targetId);
      giveBack(state, slot);
      throw error;
    }
    owned.push(targetId);
    return targetId;
  });
}

export function mustClose(state: TempTabState, targetId: string): void {
  state.mustClose.add(targetId);
  const task = state.mustCloseTask;
  if (task === null || task.done) {
    const stop = new AbortController();
    const entry = { done: false, stop, finished: Promise.resolve() };
    entry.finished = withSignal(stop.signal, () => retryCloses(state))
      .catch(() => {})
      .finally(() => {
        entry.done = true;
      });
    state.mustCloseTask = entry;
  }
}

export async function closeUntracked(state: TempTabState, targetId: string): Promise<boolean> {
  if (!state.connected) return false;
  try {
    await (state.browser as Browser).send("Target.closeTarget", { targetId }, { timeout: CLOSE_TIMEOUT });
  } catch (error) {
    if (error instanceof Cancelled) throw error;
    return false;
  }
  return gone(state, targetId);
}

async function retryCloses(state: TempTabState): Promise<void> {
  const pending = state.mustClose;
  let delay = RETRY_FIRST;
  while (pending.size > 0) {
    for (const targetId of [...pending]) {
      if (await closeUntracked(state, targetId)) {
        pending.delete(targetId);
        state.forgetTarget(targetId);
      }
    }
    if (pending.size > 0) {
      await sleep(delay);
      delay = Math.min(delay * 2, RETRY_MAX);
    }
  }
}

export async function drain(state: TempTabState): Promise<void> {
  const pending = state.mustClose;
  if (pending.size === 0) return;
  const task = state.mustCloseTask;
  state.mustCloseTask = null;
  if (task !== null && !task.done) {
    task.stop.abort();
    await task.finished;
  }
  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(), DRAIN_BUDGET * 1000);
  try {
    await withSignal(budget.signal, async () => {
      for (const targetId of [...pending]) if (await closeUntracked(state, targetId)) pending.delete(targetId);
    });
  } catch (error) {
    if (!(error instanceof Cancelled)) throw error;
  } finally {
    clearTimeout(timer);
  }
  for (const targetId of [...pending]) {
    try {
      state.registry.noteTemporary(state.instance, targetId);
    } catch {
      continue;
    }
    pending.delete(targetId);
  }
}

export async function presentTargets(state: TempTabState): Promise<Set<string> | null> {
  if (!state.connected) return null;
  let infos: unknown;
  try {
    infos = (await (state.browser as Browser).send("Target.getTargets", null, { timeout: CLOSE_TIMEOUT }))["targetInfos"];
  } catch (error) {
    if (error instanceof Cancelled) throw error;
    return null;
  }
  const out = new Set<string>();
  for (const info of Array.isArray(infos) ? infos : []) {
    if (info !== null && typeof info === "object") out.add((info as Record<string, unknown>)["targetId"] as string);
  }
  return out;
}

export async function gone(state: TempTabState, targetId: string): Promise<boolean> {
  const deadline = performance.now() / 1000 + GONE_WAIT;
  for (;;) {
    const present = await presentTargets(state);
    if (present !== null && !present.has(targetId)) return true;
    if (present === null || performance.now() / 1000 >= deadline) return false;
    await sleep(GONE_POLL);
  }
}

export async function closeOne(state: TempTabState, targetId: string): Promise<void> {
  const registry = state.registry;
  if (registry.reserveClose(state.instance, targetId)) {
    let closed = false;
    try {
      if (state.connected) {
        await (state.browser as Browser).send("Target.closeTarget", { targetId }, { timeout: CLOSE_TIMEOUT });
        closed = await gone(state, targetId);
      }
    } catch (error) {
      if (error instanceof Cancelled) throw error;
      closed = false;
    } finally {
      if (closed) registry.finishClose(state.instance, targetId);
      else registry.releaseClose(state.instance, targetId);
    }
  }
  state.forgetTarget(targetId);
}

export async function closeAll(state: TempTabState, owned: string[]): Promise<void> {
  for (const targetId of [...owned]) {
    await closeOne(state, targetId);
    owned.splice(owned.indexOf(targetId), 1);
  }
}

export async function release(state: TempTabState, owned: string[]): Promise<void> {
  await settleThenCancel(() => closeAll(state, owned));
}

export async function sweep(state: TempTabState): Promise<void> {
  const orphans = state.registry.claimOrphans(state.instance);
  const present = orphans.length > 0 ? await presentTargets(state) : null;
  if (present === null) return;
  for (const targetId of orphans) if (!present.has(targetId)) state.registry.dropTemporary(state.instance, targetId);
  await release(
    state,
    orphans.filter((targetId) => present.has(targetId)),
  );
}
