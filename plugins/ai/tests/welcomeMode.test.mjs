import { test } from "node:test";
import assert from "node:assert/strict";
import { shownMode } from "../page/src/welcomeMode.ts";

test("setup shows the saved mode once it arrives, and the person's choice over it", () => {
  assert.equal(shownMode({}, null), "browser", "before the saved values arrive");
  assert.equal(shownMode({ mode: "ai" }, null), "ai", "the saved mode, even though the page mounted before it");
  assert.equal(shownMode({ mode: "ai" }, "browser"), "browser");
});
