import { ControlRefused } from "../state/apptabs.ts";

export const HOLD_SECONDS = 120;
export const RENEW_EVERY = 60;
export const ACTIVE_FOR = 300;
export const MAX_HELD = 32;

export type HoldCall = (method: "tabs.hold" | "tabs.release", params: Record<string, unknown>) => Promise<unknown>;

export class TabHolds {
  private held = new Set<string>();
  private renewedAt = Number.NEGATIVE_INFINITY;
  private unsupported = false;

  constructor(private readonly call: HoldCall) {}

  get holding(): ReadonlySet<string> {
    return this.held;
  }

  async tick(wanted: Iterable<string>, now: number, active: boolean): Promise<void> {
    if (this.unsupported) return;
    const want = new Set(active ? [...wanted].slice(0, MAX_HELD) : []);
    const dropped = [...this.held].filter((tab) => !want.has(tab));
    if (dropped.length > 0 && (await this.send("tabs.release", { tabs: dropped }))) for (const tab of dropped) this.held.delete(tab);
    if (want.size === 0) return;
    const added = [...want].some((tab) => !this.held.has(tab));
    if (!added && now - this.renewedAt < RENEW_EVERY) return;
    if (await this.send("tabs.hold", { tabs: [...want], seconds: HOLD_SECONDS })) {
      this.held = want;
      this.renewedAt = now;
    }
  }

  async releaseAll(): Promise<void> {
    if (this.unsupported || this.held.size === 0) return;
    const tabs = [...this.held];
    this.held = new Set();
    this.renewedAt = Number.NEGATIVE_INFINITY;
    await this.send("tabs.release", { tabs });
  }

  private async send(method: "tabs.hold" | "tabs.release", params: Record<string, unknown>): Promise<boolean> {
    try {
      await this.call(method, params);
      return true;
    } catch (error) {
      if (error instanceof ControlRefused && error.code === "unknown_method") this.unsupported = true;
      return false;
    }
  }
}
