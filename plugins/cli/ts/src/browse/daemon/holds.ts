import { ControlRefused } from "../state/apptabs.ts";

export const HOLD_SECONDS = 120;
export const RENEW_EVERY = 60;
export const ACTIVE_FOR = 300;
export const MAX_HELD = 32;

export type HoldCall = (method: "tabs.hold" | "tabs.release", params: Record<string, unknown>) => Promise<unknown>;

export const MAP_RETRY = 5;

export function recentlyUsed(usedAt: ReadonlyMap<string, number>, now: number): string[] {
  return [...usedAt]
    .filter(([, at]) => now - at < ACTIVE_FOR)
    .sort((a, b) => b[1] - a[1])
    .map(([tab]) => tab);
}

export function keepRunningCommandsTargets(usedAt: Map<string, number>, runningSince: readonly number[], now: number): void {
  if (runningSince.length === 0) return;
  const oldest = Math.min(...runningSince);
  for (const [target, at] of usedAt) if (at >= oldest) usedAt.set(target, now);
}

export function shouldScan(unmapped: readonly string[], usedAt: ReadonlyMap<string, number>, scannedAt: number, now: number): boolean {
  if (unmapped.length === 0 || now - scannedAt < MAP_RETRY) return false;
  return now - scannedAt >= RENEW_EVERY || unmapped.some((target) => (usedAt.get(target) ?? Number.NEGATIVE_INFINITY) > scannedAt);
}

export function heldAppTabs(recent: readonly string[], live: (target: string) => boolean, appTab: (target: string) => string | undefined): string[] {
  const tabs: string[] = [];
  for (const target of recent) {
    const app = live(target) ? appTab(target) : undefined;
    if (app !== undefined && !tabs.includes(app)) tabs.push(app);
    if (tabs.length === MAX_HELD) break;
  }
  return tabs;
}

const REFUSED = Symbol("refused");

export class TabHolds {
  private held: string[] = [];
  private goneLast: string[] = [];
  private asked: string[] = [];
  private mayHold = false;
  private renewedAt = Number.NEGATIVE_INFINITY;
  private refusedUntil = Number.NEGATIVE_INFINITY;
  private unsupported = false;
  private closed = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly session: string,
    private readonly call: HoldCall,
    private readonly onRefused: (why: string) => void = () => {},
  ) {}

  get holding(): readonly string[] {
    return this.held;
  }

  get gone(): readonly string[] {
    return this.goneLast;
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
    if (now < this.refusedUntil) return;
    const same = want.length === this.asked.length && want.every((tab, i) => tab === this.asked[i]);
    if (same && now - this.renewedAt < RENEW_EVERY) return;
    this.mayHold = true;
    const reply = await this.send("tabs.hold", { session: this.session, tabs: want, seconds: HOLD_SECONDS });
    if (reply === REFUSED) {
      this.held = [];
      this.refusedUntil = now + RENEW_EVERY;
      return;
    }
    if (reply === null) return;
    const held = (reply as { held?: unknown }).held;
    const gone = (reply as { gone?: unknown }).gone;
    this.goneLast = Array.isArray(gone) ? gone.filter((tab): tab is string => typeof tab === "string") : [];
    this.held = Array.isArray(held) ? held.filter((tab): tab is string => typeof tab === "string") : want;
    this.asked = want;
    this.renewedAt = now;
  }

  private async releaseHeld(): Promise<void> {
    if (this.unsupported || !this.mayHold) return;
    const reply = await this.send("tabs.release", { session: this.session });
    if (reply === null || reply === REFUSED) return;
    this.mayHold = false;
    this.held = [];
    this.asked = [];
    this.renewedAt = Number.NEGATIVE_INFINITY;
  }

  private async send(method: "tabs.hold" | "tabs.release", params: Record<string, unknown>): Promise<object | null | typeof REFUSED> {
    try {
      const reply = await this.call(method, params);
      return typeof reply === "object" && reply !== null ? reply : {};
    } catch (error) {
      if (error instanceof ControlRefused && error.code === "unknown_method") this.unsupported = true;
      if (error instanceof ControlRefused && error.code === "refused") {
        this.onRefused(error.message);
        return REFUSED;
      }
      return null;
    }
  }
}
