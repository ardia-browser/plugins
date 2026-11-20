import { formatG } from "../../pylib/format.ts";
import { sleep } from "../cdp/cancel.ts";
import { BrowseError } from "../daemon-errors.ts";
import { add } from "../metrics.ts";

export const POLL_STEPS = [0.2, 0.4, 0.6, 0.8, 1.0];

function now(): number {
  return performance.now() / 1000;
}

export function pollWait(attempt: number): number {
  return POLL_STEPS[Math.min(attempt, POLL_STEPS.length - 1)] as number;
}

export async function pollUntil<T>(check: () => Promise<T>, timeout: number, what: string): Promise<T> {
  const deadline = now() + timeout;
  for (let attempt = 0; ; attempt += 1) {
    add("plugin_wait_polls");
    const value = await check();
    if (value) return value;
    const left = deadline - now();
    if (left <= 0) throw new BrowseError(`Timed out after ${formatG(timeout * 1000)}ms waiting for ${what}`, null, "timeout");
    await sleep(Math.min(pollWait(attempt), left));
  }
}
