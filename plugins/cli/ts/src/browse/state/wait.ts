import { formatG } from "../../pylib/format.ts";
import { sleep } from "../cdp/cancel.ts";
import { BrowseError } from "../daemon-errors.ts";

export function monotonic(): number {
  return performance.now() / 1000;
}

export async function waitUntil<T>(check: () => Promise<T>, timeout: number, interval = 0.1, what = "condition"): Promise<T> {
  const deadline = monotonic() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (monotonic() >= deadline) throw new BrowseError(`Timed out after ${formatG(timeout * 1000)}ms waiting for ${what}`, null, "timeout");
    await sleep(interval);
  }
}
