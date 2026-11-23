import os from "node:os";
import { Ctx } from "../commands/ctx.ts";
import { BrowseError } from "../daemon-errors.ts";
import type { State } from "../state/state.ts";
import { stopRecording } from "./record.ts";
import { captureOf } from "./store.ts";
import { stopStream } from "./stream.ts";

export async function closeCaptures(state: State): Promise<void> {
  const capture = captureOf(state);
  const ctx = new Ctx(state, {}, os.homedir(), {}, null);
  if (capture.recording !== null) {
    try {
      await stopRecording(ctx);
    } catch (error) {
      if (!(error instanceof BrowseError)) throw error;
    }
  }
  if (capture.stream !== null) await stopStream(ctx);
}
