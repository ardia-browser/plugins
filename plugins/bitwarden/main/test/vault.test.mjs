import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { GUID, OTHER_GUID, PASSWORD, SESSION_KEY, argvOf, harness, listAll, login, manifest, sdk, unlockedContext } from "./support.mjs";

const TOTP_URI = "otpauth://totp/Example:me?secret=JBSWY3DPEHPK3PXP&issuer=Example&period=60";
const listing = (entries) => ["list items", { stdout: JSON.stringify(entries) }];
const guid = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const decodedStdin = (launch) => JSON.parse(Buffer.from(launch.stdin, "base64").toString("utf8"));

describe("listing the vault", () => {
  test("maps logins with their passwords and codes, and lists nothing else", async () => {
    const entries = [
      login({}, { totp: TOTP_URI }),
      login({ id: OTHER_GUID, name: "Card", type: 3, login: undefined, card: {} }),
      login({ id: guid(1), reprompt: 1 }),
      login({ id: guid(2), deletedDate: "2026-01-01T00:00:00.000Z" }),
      login({ id: guid(3), archivedDate: "2026-01-01T00:00:00.000Z" }),
      login({ id: "not-a-guid" }),
    ];
    const { items } = await listAll(harness([listing(entries)], unlockedContext()));
    assert.deepEqual(items, [
      {
        id: GUID,
        title: "Example",
        username: "me",
        urls: ["https://example.com"],
        hasTotp: true,
        totpPeriod: 60,
        updatedAt: Date.parse("2026-01-02T03:04:05.000Z"),
        urlMatch: ["host"],
        secrets: { password: PASSWORD, totp: TOTP_URI },
      },
    ]);
  });

  test("an empty vault is an empty list", async () => {
    const { answer, items } = await listAll(harness([listing([])], unlockedContext()));
    assert.equal(answer.ok, true);
    assert.deepEqual(items, []);
  });

  test("output that isn't a JSON list is an error, never an empty vault", async () => {
    for (const stdout of ["<html>proxy error</html>", '[{"id":"abc","name"', "", '{"object":"list"}']) {
      const { answer } = await listAll(harness([["list items", { stdout }]], unlockedContext()));
      assert.deepEqual(answer, { ok: false, error: { code: "failed", problem: "unreadable" } }, stdout);
    }
  });

  test("reads past a notice bw prints before the JSON", async () => {
    const { items } = await listAll(harness([["list items", { stdout: `Could not find data file, "/x/data.json"; creating it instead.\n${JSON.stringify([login()])}` }]], unlockedContext()));
    assert.equal(items.length, 1);
  });

  test("a locked or signed-out bw reads as locked or signed out", async () => {
    const locked = await listAll(harness([["list items", { status: 1, stderr: "Vault is locked." }]], unlockedContext()));
    assert.deepEqual(locked.answer.error, { code: "locked" });
    const out = await listAll(harness([["list items", { status: 1, stderr: "You are not logged in." }]], unlockedContext()));
    assert.deepEqual(out.answer.error, { code: "signedOut" });
    const none = harness([listing([login()])]);
    assert.deepEqual((await none.call("list", { snapshot: null, cursor: null })).error, { code: "locked" });
    assert.equal(none.launches.length, 0);
  });

  test("a vault of thousands pages under the result limit and keeps every login once", async () => {
    const entries = Array.from({ length: 6000 }, (_, n) =>
      login({ id: guid(n), name: `Site ${n} ${"x".repeat(200)}` }, { username: `user${n}@example.com`, uris: [{ uri: `https://site${n}.example.com/login` }] }),
    );
    const h = harness([listing(entries)], unlockedContext());
    const pages = [];
    let snapshot = null;
    let cursor = null;
    do {
      const answer = await h.call("list", { snapshot, cursor });
      assert.equal(answer.ok, true);
      assert.ok(Buffer.byteLength(JSON.stringify(answer.result)) <= sdk.CREDENTIAL_LIMITS.pageBytes);
      if (snapshot) assert.equal(answer.result.snapshot, snapshot);
      pages.push(answer.result.items.length);
      snapshot = answer.result.snapshot;
      cursor = answer.result.cursor ?? null;
    } while (cursor !== null);
    assert.ok(pages.length > 1);
    assert.equal(pages.reduce((sum, count) => sum + count, 0), 6000);
    assert.deepEqual(argvOf(h), ["list items --nointeraction"]);
  });

  test("a page asked for from a forgotten listing starts a fresh one", async () => {
    const h = harness([listing([login()])], unlockedContext());
    const answer = await h.call("list", { snapshot: "gone", cursor: "3" });
    assert.equal(answer.result.items.length, 1);
    assert.notEqual(answer.result.snapshot, "gone");
    assert.equal(answer.result.cursor, undefined);
  });

  test("the same item twice is listed once; two items that look alike are both kept", async () => {
    const { items } = await listAll(harness([listing([login(), login(), login({ id: OTHER_GUID })])], unlockedContext()));
    assert.deepEqual(
      items.map((item) => item.id),
      [GUID, OTHER_GUID],
    );
  });

  test("addresses: none, many, never-match and exact modes", async () => {
    const many = Array.from({ length: 80 }, (_, n) => ({ uri: `https://a${n}.example.com`, match: n % 2 ? 3 : 0 }));
    const entries = [
      login({ id: guid(1) }, { uris: [] }),
      login({ id: guid(2) }, { uris: many }),
      login({ id: guid(3) }, { uris: [{ uri: "https://never.example.com", match: 5 }, { uri: "https://regex.example.com", match: 4 }, { uri: "https://exact.example.com", match: 3 }] }),
      login({ id: guid(4) }, { uris: null }),
    ];
    const { items } = await listAll(harness([listing(entries)], unlockedContext()));
    assert.deepEqual(items[0].urls, []);
    assert.equal(items[0].urlMatch, undefined);
    assert.equal(items[1].urls.length, sdk.CREDENTIAL_LIMITS.urlsPerItem);
    assert.deepEqual(items[1].urlMatch.slice(0, 2), ["", "exact"]);
    assert.deepEqual(items[2].urls, ["https://exact.example.com"]);
    assert.deepEqual(items[2].urlMatch, ["exact"]);
    assert.deepEqual(items[3].urls, []);
  });

  test("unicode is kept, and over-long or hidden characters are trimmed to what Ardia reads", async () => {
    const entries = [
      login({ id: guid(1), name: "Café \u{1F510} 日本語" }, { username: "üser" }),
      login({ id: guid(2), name: `${"\u{1F510}".repeat(600)}` }, { username: "bad‮ltr\u0000", password: "p".repeat(5000) }),
    ];
    const { answer, items } = await listAll(harness([listing(entries)], unlockedContext()));
    assert.equal(answer.ok, true);
    assert.equal(items[0].title, "Café \u{1F510} 日本語");
    assert.equal(items[0].username, "üser");
    assert.ok(Buffer.byteLength(items[1].title) <= sdk.CREDENTIAL_LIMITS.itemTitleLength);
    assert.ok(!items[1].title.includes("�"));
    assert.equal(items[1].username, "badltr");
    assert.equal(items[1].secrets, undefined);
  });

  test("a code Ardia can't compute is noted but not handed over", async () => {
    const entries = [login({ id: guid(1) }, { totp: "otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP" }), login({ id: guid(2) }, { totp: "JBSWY3DPEHPK3PXP" }), login({ id: guid(3) }, { totp: null })];
    const { items } = await listAll(harness([listing(entries)], unlockedContext()));
    assert.deepEqual(
      items.map((item) => [item.hasTotp, item.secrets?.totp ?? null, item.totpPeriod ?? null]),
      [
        [true, null, null],
        [true, "JBSWY3DPEHPK3PXP", null],
        [false, null, null],
      ],
    );
  });

  test("an organization item says so, and favorites and dates come through", async () => {
    const { items } = await listAll(harness([listing([login({ organizationId: "org-1", favorite: true, revisionDate: 1767323045 })])], unlockedContext()));
    assert.equal(items[0].vault, "Organization");
    assert.equal(items[0].favorite, true);
    assert.equal(items[0].updatedAt, 1767323045000);
  });

  test("output over bw's cap fails as too much output", async () => {
    const small = structuredClone(manifest);
    small.contributes.credentialProvider.cli.verbs["list.items"].outputLimitBytes = 1024;
    const h = harness([listing(Array.from({ length: 50 }, (_, n) => login({ id: guid(n) })))], unlockedContext(), { manifest: small });
    assert.deepEqual((await h.call("list", { snapshot: null, cursor: null })).error, { code: "failed", problem: "overflowed" });
  });

  test("bw list that never answers times out", async () => {
    const h = harness([["list items", { stdout: "[]", finishAfterMs: 200_000 }]], unlockedContext());
    const pending = h.call("list", { snapshot: null, cursor: null });
    await h.advance(91_000);
    assert.deepEqual((await pending).error, { code: "failed", problem: "timedOut" });
  });
});

describe("syncing before a listing", () => {
  test("syncs when the last sync is over five minutes old and remembers when", async () => {
    const h = harness([["sync", { stdout: "Syncing complete." }], listing([])], { session: { key: SESSION_KEY }, scratch: { syncedAt: String(Date.now() - 301_000) } });
    await listAll(h);
    assert.deepEqual(argvOf(h), ["sync --nointeraction", "list items --nointeraction"]);
    assert.equal(h.launches[0].env.BW_SESSION, SESSION_KEY);
    assert.ok(Date.now() - Number(h.scratch.syncedAt) < 5_000);
  });

  test("skips the sync within five minutes, and while offline", async () => {
    const recent = harness([listing([])], unlockedContext());
    await listAll(recent);
    assert.deepEqual(argvOf(recent), ["list items --nointeraction"]);
    const offline = harness([listing([])], { session: { key: SESSION_KEY }, offline: true });
    await listAll(offline);
    assert.deepEqual(argvOf(offline), ["list items --nointeraction"]);
  });

  test("a sync that can't reach the server still lists what bw has", async () => {
    const h = harness([["sync", { status: 1, stderr: "getaddrinfo ENOTFOUND api.bitwarden.com" }], listing([login()])], { session: { key: SESSION_KEY } });
    const { items } = await listAll(h);
    assert.equal(items.length, 1);
    assert.equal(h.scratch.syncedAt, undefined);
  });

  test("a sync that finds the vault locked stops there", async () => {
    const h = harness([["sync", { status: 1, stderr: "Vault is locked." }], listing([login()])], { session: { key: SESSION_KEY } });
    assert.deepEqual((await h.call("list", { snapshot: null, cursor: null })).error, { code: "locked" });
    assert.deepEqual(argvOf(h), ["sync --nointeraction"]);
  });

  test("a lock during the sync ends the call before bw lists anything", async () => {
    const h = harness([["sync", { stdout: "", finishAfterMs: 20_000 }], listing([login()])], { session: { key: SESSION_KEY } });
    const pending = h.call("list", { snapshot: null, cursor: null });
    await h.advance(1_000);
    await h.lock();
    assert.deepEqual(await pending, { ok: false, error: { code: "stale" } });
    await h.advance(30_000);
    assert.deepEqual(argvOf(h), ["sync --nointeraction", "lock --nointeraction"]);
  });
});

describe("revealing a field", () => {
  const reveal = (h, fields, id = GUID) => h.call("reveal", { id, fields });

  test("reads the password, username and current code with get", async () => {
    const h = harness([["get password", { stdout: `${PASSWORD}\n` }], ["get username", { stdout: "me\r\n" }], ["get totp", { stdout: "123456\n" }]], unlockedContext());
    assert.deepEqual((await reveal(h, ["password"])).result, { password: PASSWORD });
    assert.deepEqual((await reveal(h, ["username"])).result, { username: "me" });
    assert.deepEqual((await reveal(h, ["totp"])).result, { totp: { code: "123456" } });
    assert.deepEqual(argvOf(h), [`get password ${GUID} --nointeraction`, `get username ${GUID} --nointeraction`, `get totp ${GUID} --nointeraction`]);
  });

  test("codes without Premium say Premium is needed", async () => {
    const h = harness([["get totp", { status: 1, stderr: "Premium status is required to use this feature." }]], unlockedContext());
    assert.deepEqual((await reveal(h, ["totp"])).error, { code: "failed", problem: "premiumNeeded" });
  });

  test("asking for the password and code together still gives the password without Premium or a code", async () => {
    for (const stderr of ["Premium status is required to use this feature.", "No TOTP available for this login."]) {
      const h = harness([["get password", { stdout: PASSWORD }], ["get totp", { status: 1, stderr }]], unlockedContext());
      assert.deepEqual((await reveal(h, ["password", "totp"])).result, { password: PASSWORD });
    }
  });

  test("a missing item, a bad id and a locked vault", async () => {
    const missing = harness([["get password", { status: 1, stderr: "Not found." }]], unlockedContext());
    assert.deepEqual((await reveal(missing, ["password"])).error, { code: "notFound" });
    const bad = harness([], unlockedContext());
    assert.deepEqual((await reveal(bad, ["password"], "--session=x")).error, { code: "notFound" });
    assert.equal(bad.launches.length, 0);
    const locked = harness([]);
    assert.deepEqual((await reveal(locked, ["password"])).error, { code: "locked" });
  });

  test("a password with unicode and an empty field", async () => {
    const h = harness([["get password", { stdout: "päss \u{1F510}\n" }], ["get username", { stdout: "\n" }]], unlockedContext());
    assert.deepEqual((await reveal(h, ["password"])).result, { password: "päss \u{1F510}" });
    assert.deepEqual((await reveal(h, ["username"])).result, {});
  });
});

describe("saving a login", () => {
  const newLogin = { title: "Example", username: "me@example.com", password: PASSWORD, url: "https://example.com/login" };

  test("creates a Bitwarden login item from base64 JSON and returns it", async () => {
    const created = login({ id: OTHER_GUID }, { username: newLogin.username, uris: [{ uri: newLogin.url, match: null }] });
    const h = harness([["create item", { stdout: JSON.stringify(created) }]], unlockedContext());
    const answer = await h.call("save", { login: newLogin });
    assert.equal(answer.result.id, OTHER_GUID);
    assert.deepEqual(decodedStdin(h.launches[0]), {
      type: 1,
      name: "Example",
      notes: null,
      favorite: false,
      folderId: null,
      organizationId: null,
      reprompt: 0,
      fields: [],
      login: { uris: [{ uri: newLogin.url, match: null }], totp: null, username: newLogin.username, password: PASSWORD },
    });
    assert.ok(!h.launches[0].argv.join(" ").includes(PASSWORD));
  });

  test("when bw doesn't echo the item, the newest matching login is found", async () => {
    const older = login({ id: guid(1), revisionDate: "2025-01-01T00:00:00.000Z" }, { username: newLogin.username, uris: [{ uri: newLogin.url }] });
    const newer = login({ id: guid(2), revisionDate: "2026-06-01T00:00:00.000Z" }, { username: newLogin.username, uris: [{ uri: "https://example.com/" }] });
    const elsewhere = login({ id: guid(3) }, { username: newLogin.username, uris: [{ uri: "https://other.example.org" }] });
    const h = harness([["create item", { stdout: "" }], listing([older, newer, elsewhere])], unlockedContext());
    assert.equal((await h.call("save", { login: newLogin })).result.id, guid(2));
  });

  test("a save bw can't show afterwards asks you to check before saving again", async () => {
    const h = harness([["create item", { stdout: "" }], listing([])], unlockedContext());
    assert.deepEqual((await h.call("save", { login: newLogin })).error, { code: "failed", problem: "savedNotReturned" });
  });

  test("a failure never repeats the password back", async () => {
    const h = harness([["create item", { status: 1, stderr: `Error: could not save ${PASSWORD} for me@example.com` }]], unlockedContext());
    const answer = await h.call("save", { login: newLogin });
    assert.equal(answer.error.problem, "failed");
    assert.ok(!answer.error.detail.includes(PASSWORD));
  });

  test("saving while locked is refused before bw runs", async () => {
    const h = harness([]);
    assert.deepEqual((await h.call("save", { login: newLogin })).error, { code: "locked" });
  });
});

describe("editing a login", () => {
  const current = login({}, { uris: [{ uri: "https://old.example.com", match: 3, uriChecksum: "abc" }, { uri: "https://second.example.com" }], totp: TOTP_URI });
  const edited = (h) => decodedStdin(h.launches.find((launch) => launch.argv[0] === "edit"));

  test("changes the password, username, first address and code, keeping the rest", async () => {
    const h = harness([["get item", { stdout: JSON.stringify(current) }], ["edit item", (launch) => ({ stdout: JSON.stringify(decodedStdin(launch)) })]], unlockedContext());
    const answer = await h.call("edit", { id: GUID, change: { username: "", password: "fixture-pw-2", url: "https://new.example.com", totp: "remove" } });
    assert.equal(answer.ok, true);
    const sent = edited(h);
    assert.equal(sent.login.username, null);
    assert.equal(sent.login.password, "fixture-pw-2");
    assert.deepEqual(sent.login.uris, [{ uri: "https://new.example.com", match: 3 }, { uri: "https://second.example.com" }]);
    assert.equal(sent.login.totp, null);
    assert.equal(sent.name, "Example");
    assert.deepEqual(argvOf(h), [`get item ${GUID} --nointeraction`, `edit item ${GUID} --nointeraction`]);
  });

  test("adding a code sets the login's totp", async () => {
    const h = harness([["get item", { stdout: JSON.stringify(login()) }], ["edit item", (launch) => ({ stdout: JSON.stringify(decodedStdin(launch)) })]], unlockedContext());
    const answer = await h.call("addTotp", { id: GUID, uri: TOTP_URI });
    assert.equal(answer.result.hasTotp, true);
    assert.equal(edited(h).login.totp, TOTP_URI);
  });

  test("re-reads the login when bw doesn't echo it, and says so when it can't", async () => {
    const reread = harness([["get item", { stdout: JSON.stringify(login()) }], ["edit item", { stdout: "" }]], unlockedContext());
    assert.equal((await reread.call("edit", { id: GUID, change: { password: "fixture-pw-2" } })).ok, true);
    assert.equal(reread.launches.length, 3);
    let reads = 0;
    const lost = harness([["get item", () => (reads++ === 0 ? { stdout: JSON.stringify(login()) } : { status: 1, stderr: "Not found." })], ["edit item", { stdout: "" }]], unlockedContext());
    assert.deepEqual((await lost.call("edit", { id: GUID, change: { password: "fixture-pw-2" } })).error, { code: "failed", problem: "savedNotReturned" });
  });

  test("refuses what it can't change: no change, not a login, another id, a missing item", async () => {
    const run = async (item, change = { password: "x" }, id = GUID) => (await harness([["get item", item]], unlockedContext()).call("edit", { id, change })).error;
    assert.deepEqual(await run({ stdout: JSON.stringify(login()) }, {}), { code: "failed", problem: "cantPrepare" });
    assert.deepEqual(await run({ stdout: JSON.stringify({ id: GUID, type: 2, secureNote: {} }) }), { code: "notFound" });
    assert.deepEqual(await run({ stdout: JSON.stringify(login({ id: OTHER_GUID })) }), { code: "failed", problem: "cantPrepare" });
    assert.deepEqual(await run({ status: 1, stderr: "Not found." }), { code: "notFound" });
    assert.deepEqual(await run({ stdout: "{}" }, { password: "x" }, "nope"), { code: "notFound" });
  });
});
