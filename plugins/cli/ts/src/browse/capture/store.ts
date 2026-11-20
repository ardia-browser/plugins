import { claim as claimTab, release as releaseTab } from "../daemon/claims.ts";
import type { FifoLock } from "../daemon/lock.ts";
import type { Ctx } from "../commands/ctx.ts";
import type { Element, Page } from "../state/page.ts";
import type { Listener, State } from "../state/state.ts";
import type { Recording } from "./record.ts";
import type { Stream } from "./stream.ts";

export type Route = { pattern: string; abort: boolean; body: string | null; types: Set<string> | null; status: number; contentType: string | null };
export type Credentials = { username: string; password: string; origin: string | null };
export type Har = { target: string; since: number; mode: string; seen: Set<string> };
export type Tracing = { events: unknown[]; done: Promise<void>; finish: () => void; target: string; dropped: number; listener: Listener };

export type CaptureState = {
  routes: Route[];
  router: Listener | null;
  har: Har | null;
  tracing: Tracing | null;
  recording: Recording | null;
  stream: Stream | null;
  lastShots: Map<string, Uint8Array>;
};

const STORES = new WeakMap<State, CaptureState>();
const LOCKS = new WeakMap<State, FifoLock>();

export function captureOf(state: State): CaptureState {
  let store = STORES.get(state);
  if (store === undefined) {
    store = { routes: [], router: null, har: null, tracing: null, recording: null, stream: null, lastShots: new Map() };
    STORES.set(state, store);
  }
  return store;
}

export function bindCommandLock(state: State, lock: FifoLock): void {
  LOCKS.set(state, lock);
}

export function commandLockOf(state: State): FifoLock | null {
  return LOCKS.get(state) ?? null;
}

export function credentialsOf(state: State): Credentials | null {
  return (state.credentials as Credentials | null) ?? null;
}

export function claim(ctx: Ctx, page: Page, kind: string): void {
  const config = ctx.state.config;
  if (config.browseFd !== null) claimTab(config.browseFd, config.key, ctx.state.session, page.targetId, kind);
  ctx.state.claims.add(page.targetId, kind);
}

export function releaseClaim(ctx: Ctx, targetId: string, kind: string): void {
  const config = ctx.state.config;
  ctx.state.claims.delete(targetId, kind);
  if (config.browseFd !== null) releaseTab(config.browseFd, config.key, targetId, kind);
}

export async function activate<T>(ctx: Ctx, page: Page, kind: string, enable: () => Promise<T>): Promise<T> {
  const fresh = !ctx.state.claims.has(page.targetId, kind);
  claim(ctx, page, kind);
  try {
    return await enable();
  } catch (error) {
    if (fresh) releaseClaim(ctx, page.targetId, kind);
    throw error;
  }
}

export function removeListener(state: State, listener: Listener | null): void {
  const at = listener === null ? -1 : state.listeners.indexOf(listener);
  if (at >= 0) state.listeners.splice(at, 1);
}

export type Peers = {
  take: ((state: State, page: Page, options: { interactive?: boolean }) => Promise<unknown>) | null;
  frameOffset: ((page: Page, frameId: string) => Promise<[number, number]>) | null;
  currentOrNew: ((ctx: Ctx) => Promise<Page>) | null;
  refuseOnBorrowed: ((ctx: Ctx, page: Page, what: string) => void) | null;
  resolve: ((ctx: Ctx, selector: string) => Promise<[Page, Element]>) | null;
};

export const peers: Peers = { take: null, frameOffset: null, currentOrNew: null, refuseOnBorrowed: null, resolve: null };

