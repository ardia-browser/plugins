import { BrowseError, CdpError, Gated } from "../daemon-errors.ts";
import type { State } from "../state/state.ts";
import type { Browser, CdpResult } from "./browser.ts";

export const BROWSER = "browser";
export const SESSION_GONE = ["Session with given id not found", "No session with given id", "no attached session has that sessionId"];
export const SESSION_NOT_FOUND_CODE = -32001;
export const ATTACH_TIMEOUT = 10;
export const RESET_NOTICES: Readonly<Record<string, string>> = {
  reopened:
    "→ This session's DevTools connection was reopened since the last cdp call (it closes after 30 s idle), " +
    "so cdp got a fresh session there: domains and settings earlier cdp calls turned on are off again",
  replaced:
    "→ The DevTools session earlier cdp calls used there was gone (the tab or Ardia dropped it), so cdp attached a new one " +
    "on the same DevTools connection: domains and settings earlier cdp calls turned on are off again",
};

export type RawStatus = "kept" | "shared" | "attached" | "reattached";

class RawSessions {
  browser: Browser | null = null;
  sessions = new Map<string, string | null>();
  reset = new Map<string, string>();
}

const RAW = new WeakMap<State, RawSessions>();
const WATCHED = new WeakSet<State>();

function of(state: State): RawSessions {
  let raw = RAW.get(state);
  if (raw === undefined) {
    raw = new RawSessions();
    RAW.set(state, raw);
  }
  if (!WATCHED.has(state)) {
    WATCHED.add(state);
    state.listeners.push((page, method, params) => {
      if (page !== null) return;
      if (method === "Target.targetDestroyed") forgetTarget(state, typeof params["targetId"] === "string" ? params["targetId"] : null);
      else if (method === "Target.detachedFromTarget") forgetSession(state, typeof params["sessionId"] === "string" ? params["sessionId"] : null);
    });
  }
  return raw;
}

export function rawSessionOf(state: State, key: string): string | null {
  return RAW.get(state)?.sessions.get(key) ?? null;
}

export function forgetSession(state: State, sessionId: string | null): void {
  const raw = RAW.get(state);
  if (raw === undefined || !sessionId) return;
  for (const [key, held] of [...raw.sessions]) {
    if (held === sessionId) {
      raw.sessions.delete(key);
      raw.reset.set(key, "replaced");
    }
  }
}

export function forgetTarget(state: State, targetId: string | null): void {
  const raw = RAW.get(state);
  if (raw === undefined || !targetId) return;
  raw.sessions.delete(targetId);
  raw.reset.delete(targetId);
}

const ENVELOPE_GONE = ["Session with given id not found", "no attached session has that sessionId"];

export function envelopeGone(error: CdpError): boolean {
  return error.cdpCode === SESSION_NOT_FOUND_CODE || ENVELOPE_GONE.some((gone) => error.cdpMessage.includes(gone));
}

export function sessionGone(error: CdpError): boolean {
  return error.cdpCode === SESSION_NOT_FOUND_CODE || SESSION_GONE.some((gone) => error.cdpMessage.includes(gone));
}

async function attach(state: State, key: string): Promise<string | null> {
  const browser = state.browser as Browser;
  if (key === BROWSER) {
    try {
      const result = await browser.send("Target.attachToBrowserTarget", null, { timeout: ATTACH_TIMEOUT });
      if (!Object.hasOwn(result, "sessionId")) return null;
      return result["sessionId"] as string;
    } catch (error) {
      if (error instanceof Gated || error instanceof CdpError) return null;
      throw error;
    }
  }
  let result: CdpResult;
  try {
    result = await browser.send("Target.attachToTarget", { targetId: key, flatten: true }, { timeout: ATTACH_TIMEOUT });
  } catch (error) {
    if (error instanceof Gated) throw error.during("cdp");
    throw error;
  }
  if (!Object.hasOwn(result, "sessionId")) throw new BrowseError("Ardia didn't give cdp a session on that tab", null, "tab_detached");
  return result["sessionId"] as string;
}

export async function sessionFor(state: State, key: string): Promise<[string | null, RawStatus]> {
  const raw = of(state);
  if (raw.browser !== state.browser) {
    if (raw.browser !== null) {
      const reset = new Map<string, string>();
      for (const held of [...raw.reset.keys(), ...raw.sessions.keys()]) reset.set(held, "reopened");
      raw.reset = reset;
    }
    raw.browser = state.browser;
    raw.sessions = new Map();
  }
  if (raw.sessions.has(key)) {
    const session = raw.sessions.get(key) ?? null;
    return [session, session || key !== BROWSER ? "kept" : "shared"];
  }
  const session = await attach(state, key);
  raw.sessions.set(key, session);
  if (!session) return [null, "shared"];
  const reason = raw.reset.get(key);
  raw.reset.delete(key);
  if (reason === undefined) return [session, "attached"];
  state.addNotice(RESET_NOTICES[reason] as string);
  return [session, "reattached"];
}

function call(state: State, method: string, params: unknown, session: string | null, timeout: number): Promise<CdpResult> {
  return (state.browser as Browser).send(method, params as CdpResult, { session, timeout, mutation: true });
}

export async function send(state: State, key: string, method: string, params: unknown, timeout: number): Promise<[CdpResult, RawStatus]> {
  let [session, status] = await sessionFor(state, key);
  try {
    return [await call(state, method, params, session, timeout), status];
  } catch (error) {
    if (!(error instanceof CdpError) || !session || !sessionGone(error)) throw error;
  }
  forgetSession(state, session);
  [session, status] = await sessionFor(state, key);
  return [await call(state, method, params, session, timeout), status];
}
