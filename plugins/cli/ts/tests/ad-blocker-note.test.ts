import assert from "node:assert/strict";
import { test } from "bun:test";
import { AD_BLOCKER_NOTE } from "../src/browse/commands/core.ts";

test("a blocked or aborted navigation names the call that trusts a site, never a host read from the address asked for, word for word as the Python daemon", () => {
  assert.equal(AD_BLOCKER_NOTE, "If Ardia's ad blocker stopped it (the tab shows uBlock Origin's \"Page blocked\" page, which names the blocked host), `ardia call sites.allowAds -p site=<that host>` trusts the site, where Ardia offers that method (`ardia methods` lists it); then open the page again");
});
