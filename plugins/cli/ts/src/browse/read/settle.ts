import { sleep } from "../cdp/cancel.ts";
import { BrowseError } from "../daemon-errors.ts";
import { READPAGES_SETTLE_PROBE } from "../js/index.ts";
import { flag } from "../metrics.ts";
import type { Page } from "../state/page.ts";
import { FETCH_FRESH } from "../state/records.ts";
import { monotonic } from "../state/wait.ts";

export const SETTLE_LIMIT = 3.0;
export const SETTLE_QUIET = 0.3;
export const SETTLE_POLL = 0.1;
export const SAME_DOCUMENT_WAIT = 3.0;

export type Probe = [unknown, unknown, boolean];

export async function probe(page: Page): Promise<Probe> {
  try {
    const got = await page.call(READPAGES_SETTLE_PROBE, [], { frame: page.mainFrame, read: true });
    const list = Array.isArray(got) ? got : [];
    return [list[0] ?? null, list[1] ?? null, Boolean(list[2])];
  } catch (error) {
    if (!(error instanceof BrowseError) || error.code === "tab_detached") throw error;
    return [null, null, true];
  }
}

export function fetching(page: Page, earlier: ReadonlySet<string>): boolean {
  if (!page.networkOn) return false;
  const now = monotonic();
  const log = page.network;
  if (now < log.fetchesBusyUntil) return true;
  for (const [requestId, started] of log.fetchesStarted) if (!earlier.has(requestId) && now - started < FETCH_FRESH) return true;
  return false;
}

export async function settle(page: Page, deadline: number, earlier: ReadonlySet<string> = new Set()): Promise<void> {
  let last: string | null = null;
  let since = monotonic();
  while (monotonic() < deadline) {
    const [ready, fingerprint, probed] = await probe(page);
    let busy = probed;
    const now = monotonic();
    if (!busy && fetching(page, earlier)) {
      busy = true;
      flag("read_waited_for_requests", true);
    }
    const seen = JSON.stringify([ready, fingerprint, busy]);
    if (seen !== last) {
      last = seen;
      since = now;
    } else if (ready === "complete" && !busy && now - since >= SETTLE_QUIET) return;
    await sleep(SETTLE_POLL);
  }
}

export async function routeChanged(page: Page, before: unknown, deadline: number): Promise<void> {
  while (monotonic() < deadline) {
    const [, fingerprint, busy] = await probe(page);
    if (busy || fingerprint !== before) return;
    await sleep(SETTLE_POLL / 2);
  }
}

export function sameDocument(page: Page, url: string): boolean {
  const current = page.url || "";
  return url.includes("#") && !current.startsWith("about:") && current.split("#")[0] === url.split("#")[0];
}

export async function beforeNavigating(page: Page, url: string): Promise<unknown> {
  return sameDocument(page, url) ? (await probe(page))[1] : null;
}

export async function afterSameDocument(page: Page, before: unknown, deadline: number, earlier: ReadonlySet<string> = new Set()): Promise<void> {
  await routeChanged(page, before, Math.min(deadline, monotonic() + SAME_DOCUMENT_WAIT));
  await settle(page, Math.min(deadline, monotonic() + SETTLE_LIMIT), earlier);
}

export async function arrivedText(page: Page, loader: string): Promise<boolean> {
  let length: unknown;
  try {
    length = await page.call("() => (document.body && document.body.innerText || '').trim().length", [], { frame: page.mainFrame, read: true });
  } catch (error) {
    if (error instanceof BrowseError) return false;
    throw error;
  }
  return page.loader(page.mainFrame) === loader && Boolean(length);
}
