import assert from "node:assert/strict";
import { test } from "bun:test";
import { adBlockerNote } from "../src/browse/commands/core.ts";

test("a blocked or aborted navigation names the call that trusts the site, word for word as the Python daemon does", () => {
  assert.equal(
    adBlockerNote("www.example.test"),
    "If Ardia's ad blocker stopped it (the tab shows uBlock Origin's \"Page blocked\" page), `ardia call sites.allowAds -p site=www.example.test` trusts the site, where Ardia offers that method (`ardia methods` lists it); then open the page again",
  );
});
