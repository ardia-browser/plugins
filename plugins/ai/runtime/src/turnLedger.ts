// @effect-diagnostics globalTimers:off globalDate:off
export type TurnToken = { readonly runId: string; readonly signal: AbortSignal };

export type TurnRefusal = "unknown" | "ended" | "stopped";

export type TurnLookup = { ok: true; turn: TurnToken } | { ok: false; refusal: TurnRefusal };

export type ToolCallInfo = { readonly toolUseId: string | null; readonly tool: string };

type ToolItem = { readonly nativeId: string; name: string; claimed: boolean };

type Turn = {
  readonly threadId: string;
  readonly runId: string;
  readonly session: string;
  readonly controller: AbortController;
  stopped: boolean;
  readonly items: Map<string, ToolItem>;
};

export const ATTRIBUTION_WAIT_MS = 5_000;
export const ALLOWED_MESSAGES_LIMIT = 10_000;
const ITEMS_PER_TURN_LIMIT = 512;

export const providerTurnKey = (providerThreadId: string, runOrdinal: number) => `${providerThreadId}#${runOrdinal}`;

function toolOf(name: string): string {
  const cut = name.lastIndexOf("__");
  return cut < 0 ? name : name.slice(cut + 2);
}

export class TurnLedger {
  private readonly turns = new Map<string, Turn>();
  private readonly onProvider = new Map<string, string>();
  private readonly allowed = new Map<string, Set<string>>();
  private allowedCount = 0;
  private readonly waiters = new Set<() => void>();

  get turnCount() {
    return this.turns.size;
  }

  get size() {
    return this.turns.size + this.allowedCount;
  }

  launched(input: { threadId: string; runId: string; providerTurn: string; session: string; messageId?: string | undefined }): void {
    const known = this.turns.get(input.runId);
    if (known && known.threadId === input.threadId) {
      this.onProvider.set(input.providerTurn, input.runId);
      return;
    }
    const allowed = input.messageId !== undefined && !!this.allowed.get(input.threadId)?.has(input.messageId);
    const turn: Turn = { threadId: input.threadId, runId: input.runId, session: input.session, controller: new AbortController(), stopped: !allowed, items: new Map() };
    if (!allowed) turn.controller.abort(new Error("stopped"));
    this.turns.set(input.runId, turn);
    this.onProvider.set(input.providerTurn, input.runId);
    this.wake();
  }

  ended(providerTurn: string): void {
    const runId = this.onProvider.get(providerTurn);
    if (runId === undefined) return;
    this.onProvider.delete(providerTurn);
    this.end(runId);
  }

  endSession(session: string): void {
    for (const turn of [...this.turns.values()]) if (turn.session === session) this.end(turn.runId);
    for (const [key, runId] of this.onProvider) if (!this.turns.has(runId)) this.onProvider.delete(key);
  }

  stop(threadId: string): number {
    this.forgetAllowed(threadId);
    let stopped = 0;
    for (const turn of this.turns.values()) {
      if (turn.threadId !== threadId || turn.stopped) continue;
      turn.stopped = true;
      turn.controller.abort(new Error("stopped"));
      stopped++;
    }
    this.wake();
    return stopped;
  }

  allow(threadId: string, messageId: string): void {
    const messages = this.allowed.get(threadId) ?? new Set<string>();
    if (messages.has(messageId)) return;
    messages.add(messageId);
    this.allowed.delete(threadId);
    this.allowed.set(threadId, messages);
    this.allowedCount++;
    while (this.allowedCount > ALLOWED_MESSAGES_LIMIT) {
      const [oldest, set] = this.allowed.entries().next().value!;
      const first = set.values().next().value!;
      set.delete(first);
      this.allowedCount--;
      if (set.size === 0) this.allowed.delete(oldest);
    }
  }

  private forgetAllowed(threadId: string): void {
    this.allowedCount -= this.allowed.get(threadId)?.size ?? 0;
    this.allowed.delete(threadId);
  }

  noteToolItem(item: { runId: string | null; nativeId: string | null; name: string | null }): void {
    if (!item.runId || !item.nativeId || !item.name) return;
    const name = item.name;
    const turn = this.turns.get(item.runId);
    if (!turn) return;
    const known = turn.items.get(item.nativeId);
    if (known) {
      known.name = name;
    } else {
      if (turn.items.size >= ITEMS_PER_TURN_LIMIT) turn.items.delete(turn.items.keys().next().value!);
      turn.items.set(item.nativeId, { nativeId: item.nativeId, name, claimed: false });
    }
    this.wake();
  }

  async attribute(threadId: string, call: ToolCallInfo, waitMs = ATTRIBUTION_WAIT_MS, signal?: AbortSignal): Promise<TurnLookup> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const found = this.claim(threadId, call);
      if (found) return found.stopped ? { ok: false, refusal: "stopped" } : { ok: true, turn: { runId: found.runId, signal: found.controller.signal } };
      const left = deadline - Date.now();
      if (left <= 0 || signal?.aborted) return { ok: false, refusal: this.refusalFor(threadId) };
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.waiters.delete(done);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, left);
        this.waiters.add(done);
        signal?.addEventListener("abort", done, { once: true });
      });
    }
  }

  private claim(threadId: string, call: ToolCallInfo): Turn | null {
    if (call.toolUseId === null) return null;
    for (const turn of this.turns.values()) {
      if (turn.threadId !== threadId) continue;
      for (const item of turn.items.values()) {
        if (item.claimed || item.nativeId !== call.toolUseId || toolOf(item.name) !== call.tool) continue;
        item.claimed = true;
        return turn;
      }
    }
    return null;
  }

  private refusalFor(threadId: string): TurnRefusal {
    for (const turn of this.turns.values()) if (turn.threadId === threadId && turn.stopped) return "stopped";
    return "unknown";
  }

  private end(runId: string): void {
    const turn = this.turns.get(runId);
    if (!turn) return;
    this.turns.delete(runId);
    turn.controller.abort(new Error(turn.stopped ? "stopped" : "ended"));
    this.wake();
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) waiter();
  }
}

export const turnLedger = new TurnLedger();
