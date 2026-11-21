import { shield } from "../cdp/cancel.ts";
import { BrowseError } from "../daemon-errors.ts";
import { type Page, quiet } from "../state/page.ts";
import { type Json, record } from "../state/records.ts";
import type { Listener, State } from "../state/state.ts";
import { removeListener } from "./store.ts";

export type Frame = [number, string, Json];

export class Screencast {
  latest: Frame | null = null;
  seq = 0;
  readonly watchers = new Set<() => void>();
  private listener: Listener | null = null;

  constructor(
    readonly page: Page,
    readonly quality = 80,
    readonly maxWidth: number | null = null,
    readonly maxHeight: number | null = null,
  ) {}

  async start(state: State): Promise<void> {
    const listener: Listener = (eventPage, method, params) => {
      if (eventPage !== this.page || method !== "Page.screencastFrame") return;
      this.seq += 1;
      this.latest = [this.seq, String(params["data"] ?? ""), record(params["metadata"])];
      for (const watcher of [...this.watchers]) watcher();
      const session = params["sessionId"];
      shield(() => this.ack(session)).catch(() => {});
    };
    const params: Json = { format: "jpeg", quality: this.quality, everyNthFrame: 1 };
    if (this.maxWidth) params["maxWidth"] = this.maxWidth;
    if (this.maxHeight) params["maxHeight"] = this.maxHeight;
    await this.page.send("Page.startScreencast", params);
    state.listeners.push(listener);
    this.listener = listener;
  }

  private async ack(session: unknown): Promise<void> {
    try {
      await this.page.send("Page.screencastFrameAck", { sessionId: session });
    } catch (error) {
      if (!(error instanceof BrowseError)) throw error;
    }
  }

  async stop(state: State): Promise<void> {
    removeListener(state, this.listener);
    try {
      await this.page.send("Page.stopScreencast");
    } catch (error) {
      if (!quiet(error)) throw error;
    }
  }
}
