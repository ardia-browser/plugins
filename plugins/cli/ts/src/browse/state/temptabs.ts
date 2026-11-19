import { type Browser } from "../cdp/browser.ts";
import { Cancelled, currentSignal, sleep, untilCancelled, withSignal } from "../cdp/cancel.ts";
import { log } from "../daemon/log.ts";
import { BrowseError, Gated, OutcomeUnknown } from "../daemon-errors.ts";
import { tokenHex } from "../tokens.ts";
import { type Instance, nonceOf, type Registry } from "./registry.ts";

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
  readonly reservedCloses?: Set<string>;
  mustCloseTask: { done: boolean; stop: AbortController; finished: Promise<void> } | null;
  forgetTarget(targetId: string): void;
};

export const SHIELD_DEADLINE = 10.0;
export const MARKER = "about:blank#ardia-temp-";
export const limits = { shield: SHIELD_DEADLINE };
export const counters = { lateCreatesClosed: 0 };

export async function settleThenCancel<T>(run: () => Promise<T>, signal: AbortSignal | null = currentSignal()): Promise<T> {
  const result = await withSignal(AbortSignal.timeout(limits.shield * 1000), run);
  if (signal?.aborted) throw new Cancelled();
  return result;
}

export function giveBack(state: TempTabState, slot: string | null): void {
  if (slot === null) return;
  try {
    state.registry.dropTemporary(state.instance, slot);
  } catch {}
}

export function markerUrl(nonce: string): string {
  return `${MARKER}${nonce}`;
}

export async function create(state: TempTabState, owned: string[]): Promise<string> {
  const registry = state.registry;
  const slot = registry.reserveTemporary(state.instance);
  const nonce = slot === null ? tokenHex(14) : nonceOf(slot);
  return settleThenCancel(async () => {
    let result: Record<string, unknown>;
    const sending = (state.browser as Browser).send("Target.createTarget", { url: markerUrl(nonce), background: true }, { signal: null });
    try {
      result = await untilCancelled(sending);
    } catch (error) {
      if (error instanceof Cancelled) {
        sending.then(
          (late) => {
            counters.lateCreatesClosed += 1;
            log.warning(`a temporary tab arrived after its command gave up; closing it (${counters.lateCreatesClosed} so far)`);
            mustClose(state, String(late["targetId"]));
            giveBack(state, slot);
          },
          (failure: unknown) => {
            if (!(failure instanceof OutcomeUnknown)) giveBack(state, slot);
          },
        );
        throw error;
      }
      if (!(error instanceof OutcomeUnknown)) giveBack(state, slot);
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

async function listTargets(state: TempTabState): Promise<Record<string, unknown>[] | null> {
  if (!state.connected) return null;
  let infos: unknown;
  try {
    infos = (await (state.browser as Browser).send("Target.getTargets", null, { timeout: CLOSE_TIMEOUT }))["targetInfos"];
  } catch (error) {
    if (error instanceof Cancelled) throw error;
    return null;
  }
  return (Array.isArray(infos) ? infos : []).filter((info): info is Record<string, unknown> => info !== null && typeof info === "object");
}

export async function closeMarked(state: TempTabState, slots: ReadonlyMap<string, string>, dropMissing: boolean): Promise<void> {
  if (slots.size === 0) return;
  const infos = await listTargets(state);
  if (infos === null) return;
  for (const [slot, nonce] of slots) {
    const marked = infos.find((info) => info["url"] === markerUrl(nonce));
    if (marked === undefined) {
      if (dropMissing) giveBack(state, slot);
      continue;
    }
    if (await closeUntracked(state, String(marked["targetId"]))) giveBack(state, slot);
  }
}

export type ReservedClose = { closed: boolean; refused: boolean; error: unknown };

export async function closeReserved(state: TempTabState, targetId: string): Promise<ReservedClose> {
  if (!state.registry.reserveClose(state.instance, targetId)) return { closed: false, refused: true, error: null };
  let closed = false;
  let error: unknown = null;
  try {
    if (state.connected) {
      const answer = await (state.browser as Browser).send("Target.closeTarget", { targetId }, { timeout: CLOSE_TIMEOUT });
      closed = answer["success"] !== false && (await gone(state, targetId));
    }
  } catch (thrown) {
    if (thrown instanceof Cancelled) throw thrown;
    error = thrown;
  } finally {
    if (closed) state.registry.finishClose(state.instance, targetId);
    else state.registry.releaseClose(state.instance, targetId);
  }
  return { closed, refused: false, error };
}

async function closeQueued(state: TempTabState, targetId: string): Promise<boolean> {
  if (state.reservedCloses?.has(targetId)) return (await closeReserved(state, targetId)).closed;
  return closeUntracked(state, targetId);
}

export function mustClose(state: TempTabState, targetId: string, reserved = false): void {
  if (reserved) state.reservedCloses?.add(targetId);
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
      if (await closeQueued(state, targetId)) {
        pending.delete(targetId);
        state.reservedCloses?.delete(targetId);
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
  if (pending.size === 0 && !state.connected) return;
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
      for (const targetId of [...pending]) {
        if (await closeQueued(state, targetId)) {
          pending.delete(targetId);
          state.reservedCloses?.delete(targetId);
        }
      }
      if (state.connected) await closeMarked(state, state.registry.nonces(state.instance), false);
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
  if (orphans.length === 0) return;
  const nonces = state.registry.nonces(state.instance);
  const slots = new Map([...nonces].filter(([slot]) => orphans.includes(slot)));
  await closeMarked(state, slots, true);
  const targets = orphans.filter((targetId) => !slots.has(targetId));
  const present = targets.length > 0 ? await presentTargets(state) : null;
  if (present === null) return;
  for (const targetId of targets) if (!present.has(targetId)) state.registry.dropTemporary(state.instance, targetId);
  await release(
    state,
    targets.filter((targetId) => present.has(targetId)),
  );
}
