import { Cancelled } from "../cdp/cancel.ts";

type Waiter = { grant: () => void; expire: () => void; settled: boolean; deadline: number };

export class FifoLock {
  private held = false;
  private readonly waiters: Waiter[] = [];

  get locked(): boolean {
    return this.held;
  }

  acquire(timeoutSeconds: number | null = null, signal: AbortSignal | null = null): Promise<boolean> {
    if (signal?.aborted) return Promise.reject(new Cancelled());
    if (!this.held && this.waiters.length === 0) {
      this.held = true;
      return Promise.resolve(true);
    }
    if (timeoutSeconds !== null && timeoutSeconds <= 0) return Promise.resolve(false);
    return new Promise<boolean>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const leave = () => {
        const at = this.waiters.indexOf(waiter);
        if (at >= 0) this.waiters.splice(at, 1);
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
      };
      const aborted = () => {
        if (waiter.settled) return;
        waiter.settled = true;
        leave();
        reject(new Cancelled());
      };
      const waiter: Waiter = {
        settled: false,
        deadline: timeoutSeconds === null ? Number.POSITIVE_INFINITY : performance.now() + timeoutSeconds * 1000,
        grant: () => {
          waiter.settled = true;
          leave();
          resolve(true);
        },
        expire: () => {
          if (waiter.settled) return;
          waiter.settled = true;
          leave();
          resolve(false);
        },
      };
      this.waiters.push(waiter);
      signal?.addEventListener("abort", aborted, { once: true });
      if (timeoutSeconds !== null) timer = setTimeout(() => waiter.expire(), timeoutSeconds * 1000);
    });
  }

  release(): void {
    if (!this.held) throw new Error("Lock is not acquired.");
    for (;;) {
      const next = this.waiters[0];
      if (next === undefined) {
        this.held = false;
        return;
      }
      if (performance.now() >= next.deadline) {
        next.expire();
        continue;
      }
      next.grant();
      return;
    }
  }
}
