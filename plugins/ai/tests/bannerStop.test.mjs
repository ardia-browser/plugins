import { test } from "node:test";
import assert from "node:assert/strict";
import { BANNER_STOP_REASON, bannerStopper } from "../page/src/bannerStop.ts";

test("Stop in a tab's banner stops the thread once per press, whatever the chat looked like when the watch began", () => {
  const sent = [];
  const onStopped = bannerStopper((reason) => sent.push(reason));
  onStopped(false);
  onStopped(true);
  onStopped(true);
  assert.deepEqual(sent, [BANNER_STOP_REASON], "a repeated stopped report doesn't stop twice");
  onStopped(false);
  onStopped(true);
  assert.deepEqual(sent, [BANNER_STOP_REASON, BANNER_STOP_REASON], "a new press after a new message stops again");
});
