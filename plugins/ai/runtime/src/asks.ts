// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off extendsNativeError:off effectFnOpportunity:off globalFetch:off
import * as Crypto from "node:crypto";
import type { Answer } from "./permissions.ts";

export type AskKind = "read" | "act" | "close" | "group" | "open";

export type Ask = {
  id: string;
  chatId: string;
  kind: AskKind;
  tool: string;
  tabTitle: string;
  origin: string | null;
  detail: string | null;
  createdAt: number;
};

export type AskOutcome = Answer | "timeout";

type Waiting = { ask: Ask; resolve: (answer: AskOutcome) => void; timer: ReturnType<typeof setTimeout> };

export const ASK_TIMEOUT_MS = 5 * 60_000;

export class Asks {
  private readonly waiting = new Map<string, Waiting>();
  private readonly listeners = new Set<(chatId: string) => void>();
  private readonly timeoutMs: number;

  constructor(timeoutMs = ASK_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  pending(chatId: string): Ask[] {
    return [...this.waiting.values()].filter((w) => w.ask.chatId === chatId).map((w) => w.ask);
  }

  onChange(listener: (chatId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  ask(fields: Omit<Ask, "id" | "createdAt">, signal?: AbortSignal): Promise<AskOutcome> {
    const ask: Ask = { ...fields, id: Crypto.randomUUID(), createdAt: Date.now() };
    return new Promise<AskOutcome>((resolve) => {
      const settle = (answer: AskOutcome) => {
        const w = this.waiting.get(ask.id);
        if (!w) return;
        clearTimeout(w.timer);
        this.waiting.delete(ask.id);
        resolve(answer);
        this.emit(ask.chatId);
      };
      const timer = setTimeout(() => settle("timeout"), this.timeoutMs);
      this.waiting.set(ask.id, { ask, resolve: settle, timer });
      signal?.addEventListener("abort", () => settle("deny"), { once: true });
      this.emit(ask.chatId);
    });
  }

  answer(chatId: string, id: string, answer: Answer): boolean {
    const w = this.waiting.get(id);
    if (!w || w.ask.chatId !== chatId) return false;
    w.resolve(answer);
    return true;
  }

  cancelChat(chatId: string) {
    for (const w of [...this.waiting.values()]) if (w.ask.chatId === chatId) w.resolve("deny");
  }

  private emit(chatId: string) {
    for (const listener of this.listeners) listener(chatId);
  }
}
