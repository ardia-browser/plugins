import assert from "node:assert/strict";
import { test } from "bun:test";
import { adBlockerNote } from "../src/browse/commands/core.ts";

test("a blocked or aborted navigation names the call that trusts the site, word for word as the Python daemon does", () => {
  assert.equal(
    adBlockerNote("https://www.example.test/page", "www.example.test"),
    "If Ardia's ad blocker stopped it (the tab shows uBlock Origin's \"Page blocked\" page), `ardia call sites.allowAds -p site=www.example.test` trusts the site, where Ardia offers that method (`ardia methods` lists it); then open the page again",
  );
});

test("a URL parsers could read two ways, or an odd host, gets no copyable site", () => {
  for (const [url, host] of [
    ["https://blocked.example.com\\@other.example.org/", "other.example.org"],
    ["https://user@blocked.example.com/", "blocked.example.com"],
    ["https://[::1]/", "::1"],
    ["https://localhost/", "localhost"],
  ]) {
    const note = adBlockerNote(url, host);
    assert.ok(note.includes("site=<the site's host>"), url);
    assert.ok(!note.includes(`site=${host}\``), url);
  }
});
