import { ControlRefused } from "../state/apptabs.ts";

export const HOLD_SECONDS = 120;
export const RENEW_EVERY = 60;
export const ACTIVE_FOR = 300;
export const MAX_HELD = 32;

export type HoldCall = (method: "tabs.hold" | "tabs.release", params: Record<string, unknown>) => Promise<unknown>;

export function recentlyUsed(usedAt: ReadonlyMap<string, number>, now: number): string[] {
  return [...usedAt]
    .filter(([, at]) => now - at < ACTIVE_FOR)
    .sort((a, b) => b[1] - a[1])
    .map(([tab]) => tab)
    .slice(0, MAX_HELD);
}

export class TabHolds {
  private held: string[] = [];
  private asked: string[] = [];
  private renewedAt = Number.NEGATIVE_INFINITY;
  private unsupported = false;
  private closed = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly session: string,
    private readonly call: HoldCall,
  ) {}

  get holding(): readonly string[] {
    return this.held;
  }

  tick(wanted: readonly string[], now: number): Promise<void> {
    return this.enqueue(() => this.step([...new Set(wanted)].slice(0, MAX_HELD), now));
  }

  close(): Promise<void> {
    this.closed = true;
    return this.enqueue(() => this.releaseHeld());
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async step(want: string[], now: number): Promise<void> {
    if (this.closed || this.unsupported) return;
    if (want.length === 0) return this.releaseHeld();
    const same = want.length === this.asked.length && want.every((tab, i) => tab === this.asked[i]);
    if (same && now - this.renewedAt < RENEW_EVERY) return;
    const reply = await this.send("tabs.hold", { session: this.session, tabs: want, seconds: HOLD_SECONDS });
    if (reply === null) return;
    const held = (reply as { held?: unknown }).held;
    this.held = Array.isArray(held) ? held.filter((tab): tab is string => typeof tab === "string") : want;
    this.asked = want;
    this.renewedAt = now;
  }

  private async releaseHeld(): Promise<void> {
    if (this.unsupported || this.asked.length === 0) return;
    if ((await this.send("tabs.release", { session: this.session })) === null) return;
    this.held = [];
    this.asked = [];
    this.renewedAt = Number.NEGATIVE_INFINITY;
  }

  private async send(method: "tabs.hold" | "tabs.release", params: Record<string, unknown>): Promise<object | null> {
    try {
      const reply = await this.call(method, params);
      return typeof reply === "object" && reply !== null ? reply : {};
    } catch (error) {
      if (error instanceof ControlRefused && error.code === "unknown_method") this.unsupported = true;
      return null;
    }
  }
}
