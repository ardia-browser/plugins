// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off extendsNativeError:off effectFnOpportunity:off globalFetch:off
import * as Fs from "node:fs";
import * as Path from "node:path";
import type { Channel } from "./channel.ts";
import type { ToolUse } from "./browserTools.ts";

export const COUNTERS = [
  "chats_started",
  "mode_browser_first",
  "mode_ai_first",
  "tool_read",
  "tool_act",
  "tool_open",
  "tool_close",
  "tool_group",
  "tool_split_to_group",
  "permission_allowed",
  "permission_always",
  "permission_denied",
  "permission_timed_out",
  "runtime_crashes",
  "banner_stops",
  "tag_groups_created",
  "tag_groups_joined",
  "signin_started",
  "tool_refused_stopped",
  "tool_refused_ended",
  "tool_refused_unknown",
] as const;

export type Counter = (typeof COUNTERS)[number];

const FLUSH_MS = 60_000;

export function countersForUse(use: ToolUse): Counter[] {
  const out: Counter[] = [];
  if (use.outcome === "allowed" || use.outcome === "asked-allowed" || use.outcome === "asked-always") {
    if (use.tool === "split_to_group") out.push("tool_split_to_group");
    else if (use.kind === "read") out.push("tool_read");
    else if (use.kind === "act") out.push("tool_act");
    else if (use.kind === "open") out.push("tool_open");
    else if (use.kind === "close") out.push("tool_close");
    else if (use.kind === "group") out.push("tool_group");
  }
  if (use.outcome === "asked-allowed") out.push("permission_allowed");
  if (use.outcome === "asked-always") out.push("permission_always");
  if (use.outcome === "denied") out.push("permission_denied");
  if (use.outcome === "timed-out") out.push("permission_timed_out");
  return out;
}

export class Telemetry {
  private pending = new Map<Counter, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly channel: Channel | null;

  constructor(channel: Channel | null) {
    this.channel = channel;
    if (channel) {
      this.timer = setInterval(() => void this.flush(), FLUSH_MS);
      this.timer.unref?.();
    }
  }

  count(counter: Counter, n = 1) {
    this.pending.set(counter, (this.pending.get(counter) ?? 0) + n);
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.pending);
  }

  async flush() {
    if (!this.channel || this.channel.isClosed || this.pending.size === 0) return;
    const batch = this.pending;
    this.pending = new Map();
    for (const [counter, n] of batch) await this.channel.request("telemetry.count", { counter, n }).catch(() => undefined);
  }
}

export function noteRunStart(dataDir: string): boolean {
  const marker = Path.join(dataDir, "run", "alive");
  const crashed = Fs.existsSync(marker);
  Fs.mkdirSync(Path.dirname(marker), { recursive: true, mode: 0o700 });
  Fs.writeFileSync(marker, String(process.pid), { mode: 0o600 });
  return crashed;
}

export function noteCleanExit(dataDir: string) {
  try {
    Fs.unlinkSync(Path.join(dataDir, "run", "alive"));
  } catch {}
}
