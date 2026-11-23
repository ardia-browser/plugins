import { groupStats, KILL_GRACE, killLiveGroups, liveGroups, type Ran, run as runGroup, RunCancelled, RunTimedOut, signalGroup, SpawnFailed } from "../../proc/group.ts";
import { Cancelled, currentSignal } from "../cdp/cancel.ts";

export { groupStats, KILL_GRACE, killLiveGroups, liveGroups, type Ran, RunTimedOut, signalGroup, SpawnFailed };

export type RunOptions = { input?: Uint8Array; timeout: number; env?: Record<string, string>; cwd?: string; limit?: number; grace?: number };

export async function run(argv: readonly string[], options: RunOptions): Promise<Ran> {
  const signal = currentSignal();
  if (signal?.aborted) throw new Cancelled();
  try {
    return await runGroup(argv, signal === null ? options : { ...options, signal });
  } catch (error) {
    if (error instanceof RunCancelled) throw new Cancelled();
    throw error;
  }
}
