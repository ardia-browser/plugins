import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  ACCOUNT,
  ITEM_ID,
  NEW_PASSWORD,
  PASSWORD,
  TOTP_URI,
  WORK_ACCOUNT,
  fail,
  harness,
  listAll,
  listedEntry,
  ok,
  revealedEntry,
  sdk,
  unlocked,
} from "./support.mjs";
import { base32Bytes, referenceCode } from "./support-totp.mjs";

const accounts = (...list) => ["account list --format json", ok(list)];
const oneAccount = accounts(ACCOUNT);
const approve = ["vault list --format json --account=*", ok([])];
const signedOut = { session: null, preferences: {} };
const locked = { session: null, preferences: { account: ACCOUNT.account_uuid } };
const start = { method: "app", step: "start", fields: {} };
const failure = (answer) => (answer.ok ? null : answer.error);
const problemOf = (answer) => failure(answer)?.problem ?? failure(answer)?.code;
const notLaunched = () => {
  throw new Error("spawn op ENOENT");
};

describe("state", () => {
  test("an approved account is unlocked and names its email and server", async () => {
    const { h } = harness([oneAccount]);
    const answer = await h.call("state", { explicit: true });
    assert.deepEqual(answer, { ok: true, result: { state: "unlocked", account: "me@example.com", server: { url: "https://my.1password.com" } } });
  });

  test("without a session the remembered account reads as locked", async () => {
    const { h } = harness([oneAccount], locked);
    assert.equal((await h.call("state", { explicit: false })).result.state, "locked");
  });

  for (const [name, reply] of [
    ["an empty account list", ok([])],
    ["op saying there are no accounts", fail("[ERROR] 2026/11/22 10:00:00 No accounts configured for use with 1Password CLI.")],
  ]) {
    test(`${name} means the CLI integration is off`, async () => {
      const { h } = harness([["account list --format json", reply]], signedOut);
      assert.deepEqual((await h.call("state", { explicit: true })).result, { state: "signedOut", problem: "setupNeeded" });
    });
  }

  for (const [name, stdout] of [
    ["html", "<html>proxy error</html>"],
    ["truncated JSON", '[{"account_uuid":"ACCOUNTUUID1","email"'],
    ["nothing", ""],
  ]) {
    test(`an account list of ${name} is unreadable, never signed out`, async () => {
      const { h } = harness([["account list --format json", ok(stdout)]]);
      assert.deepEqual((await h.call("state", { explicit: true })).result, { state: "unavailable", problem: "unreadable" });
    });
  }

  test("an op that can't start reads as unavailable", async () => {
    const { h } = harness([["account list --format json", notLaunched]]);
    assert.deepEqual((await h.call("state", { explicit: true })).result, { state: "unavailable", problem: "notLaunched" });
  });

  test("an op too old for --format reads as outdated", async () => {
    const { h } = harness([["account list --format json", fail("unknown flag: --format")]]);
    assert.deepEqual((await h.call("state", { explicit: true })).result, { state: "unavailable", problem: "outdated" });
  });

  test("several accounts with none chosen wait for the sign-in sheet", async () => {
    const { h } = harness([accounts(ACCOUNT, WORK_ACCOUNT)], signedOut);
    assert.deepEqual((await h.call("state", { explicit: true })).result, { state: "signedOut" });
  });

  test("the chosen account of several is the one reported", async () => {
    const { h } = harness([accounts(ACCOUNT, WORK_ACCOUNT)], { session: { key: null }, preferences: { account: "work" } });
    assert.equal((await h.call("state", { explicit: true })).result.account, "me@work.example");
  });

  test("a remembered account that left 1Password is forgotten", async () => {
    const { h } = harness([oneAccount], { session: null, preferences: { account: "GONE" } });
    const answer = await h.call("state", { explicit: true });
    assert.equal(answer.result.account, "me@example.com");
    assert.equal(h.preferences.account, undefined);
  });
});

describe("sign in through the 1Password app", () => {
  test("one account is approved in the app and remembered", async () => {
    const { h, cli } = harness([oneAccount, approve], signedOut);
    const answer = await h.call("signIn", start);
    assert.deepEqual(answer, { ok: true, result: { ok: true } });
    assert.deepEqual(h.session, { key: null });
    assert.equal(h.preferences.account, "ACCOUNTUUID1");
    const connect = cli.seen.find((entry) => entry.launch.verb === "connect").launch;
    assert.deepEqual(connect.argv, ["vault", "list", "--format", "json", "--account=ACCOUNTUUID1"]);
    assert.equal(connect.timeoutMs, 90_000);
    assert.equal(connect.signIn, true);
    assert.deepEqual(connect.env, { OP_INTEGRATION_NAME: "Ardia", OP_INTEGRATION_ID: "ardia", OP_BIOMETRIC_UNLOCK_ENABLED: "true" });
  });

  test("with several accounts it asks which, then connects the one chosen", async () => {
    const { h, cli } = harness([accounts(ACCOUNT, WORK_ACCOUNT), approve], signedOut);
    const asked = await h.call("signIn", start);
    assert.deepEqual(asked.result, {
      ok: false,
      need: { kind: "account", choices: [{ id: "ACCOUNTUUID1", title: "me@example.com" }, { id: "ACCOUNTUUID2", title: "me@work.example" }] },
      state: "signedOut",
    });
    assert.equal(cli.lines().some((line) => line.startsWith("vault list")), false);
    const chosen = await h.call("signIn", { ...start, step: "account", account: "ACCOUNTUUID2" });
    assert.equal(chosen.result.ok, true);
    assert.equal(h.preferences.account, "ACCOUNTUUID2");
    assert.ok(cli.lines().includes("vault list --format json --account=ACCOUNTUUID2"));
  });

  test("a choice that no longer matches an account asks again", async () => {
    const { h, cli } = harness([accounts(ACCOUNT, WORK_ACCOUNT), approve], signedOut);
    const answer = await h.call("signIn", { ...start, step: "account", account: "ACCOUNTUUID9" });
    assert.equal(answer.result.need.kind, "account");
    assert.equal(cli.lines().some((line) => line.startsWith("vault list")), false);
  });

  test("two accounts with one email are told apart by their server", async () => {
    const { h } = harness([accounts(ACCOUNT, { ...WORK_ACCOUNT, email: ACCOUNT.email })], signedOut);
    const titles = (await h.call("signIn", start)).result.need.choices.map((choice) => choice.title);
    assert.deepEqual(titles, ["me@example.com on my.1password.com", "me@example.com on work.1password.com"]);
  });

  test("unlock reuses the remembered account without asking", async () => {
    const { h, cli } = harness([accounts(ACCOUNT, WORK_ACCOUNT), approve], { session: null, preferences: { account: "ACCOUNTUUID2" } });
    assert.deepEqual((await h.call("unlock", { password: null })).result, { ok: true });
    assert.ok(cli.lines().includes("vault list --format json --account=ACCOUNTUUID2"));
  });

  test("unlock with several accounts and none remembered asks, staying locked", async () => {
    const { h } = harness([accounts(ACCOUNT, WORK_ACCOUNT)], signedOut);
    const answer = await h.call("unlock", { password: null });
    assert.equal(answer.result.need.kind, "account");
    assert.equal(answer.result.state, "locked");
  });

  const approvalRows = [
    ["denied in the app", fail("[ERROR] 2026/11/22 10:00:00 authorization prompt dismissed, please try again"), "stayedLocked"],
    ["with the app not running", fail("[ERROR] 2026/11/22 10:00:00 error initializing client: connecting to desktop app: cannot connect to 1Password app, make sure it is running"), "appUnreachable"],
    ["with the CLI integration off in 1Password's settings", fail("[ERROR] 2026/11/22 10:00:00 You are not currently signed in. Please run `op signin --help` for instructions"), "setupNeeded"],
    ["left waiting past 90 seconds", { finishAfterMs: 120_000 }, "approvalTimedOut"],
    ["while offline", fail("[ERROR] 2026/11/22 10:00:00 dial tcp: lookup my.1password.com: no such host"), "offline", { offline: true }],
    ["with the server unreachable", fail("[ERROR] 2026/11/22 10:00:00 dial tcp: lookup my.1password.com: no such host"), "unreachable"],
  ];
  for (const [name, reply, problem, extra = {}] of approvalRows) {
    test(`approval ${name} fails as ${problem} and leaves it signed out`, async () => {
      const { h } = harness([oneAccount, ["vault list*", reply]], { ...signedOut, ...extra });
      const pending = h.call("signIn", start);
      await h.advance(reply.finishAfterMs ?? 0);
      const answer = await pending;
      assert.deepEqual(answer.result, { ok: false, problem });
      assert.equal(h.session, null);
    });
  }

  test("an unknown approval error shows op's own first line", async () => {
    const { h } = harness([oneAccount, ["vault list*", fail("[ERROR] 2026/11/22 10:00:00 something odd happened\nmore detail")]], signedOut);
    const answer = await h.call("signIn", start);
    assert.equal(answer.result.problem, "failed");
    assert.match(answer.result.detail, /^something odd happened/);
  });

  const BAD_REQUEST = "[ERROR] 2026/11/23 10:00:00 (400) Bad Request: The structure of request was invalid.";
  for (const [call, input, context] of [["signIn", start, signedOut], ["unlock", { password: null }, locked]]) {
    test(`${call} rejected by 1Password's server is a plain failure with op's line, never setup`, async () => {
      const { h } = harness([oneAccount, ["vault list*", fail(BAD_REQUEST, 8)]], context);
      const answer = await h.call(call, input);
      assert.deepEqual(answer.result, { ok: false, problem: "failed", detail: "(400) Bad Request: The structure of request was invalid." });
      assert.equal(h.session, null);
    });
  }

  test("an account list the server rejects fails with op's line, never setup", async () => {
    const { h } = harness([["account list --format json", fail(BAD_REQUEST, 8)]], signedOut);
    const detail = "(400) Bad Request: The structure of request was invalid.";
    assert.deepEqual((await h.call("signIn", start)).result, { ok: false, problem: "failed", detail, state: "unavailable" });
    assert.deepEqual((await h.call("state", { explicit: true })).result, { state: "unavailable", problem: "failed", detail });
  });

  test("an account list op can't give stops before any approval", async () => {
    const { h, cli } = harness([["account list --format json", ok("{")]], signedOut);
    assert.deepEqual((await h.call("signIn", start)).result, { ok: false, problem: "unreadable", state: "unavailable" });
    assert.equal(cli.seen.length, 1);
  });

  test("locking while the approval waits ends the call, signs op out of that account and leaves nothing unlocked", async () => {
    const { h, cli } = harness([oneAccount, ["vault list*", { finishAfterMs: 60_000, stdout: "[]" }], ["signout*", ok("")]], signedOut);
    const pending = h.call("signIn", start);
    while (!cli.lines().some((line) => line.startsWith("vault list"))) await h.advance(0);
    await h.lock();
    assert.deepEqual(await pending, { ok: false, error: { code: "stale" } });
    await h.advance(60_000);
    assert.equal(h.session, null);
    assert.ok(cli.lines().includes("signout --account=ACCOUNTUUID1"));
  });
});

describe("sign out", () => {
  test("signs op out of the chosen account and forgets the choice and session", async () => {
    const { h, cli } = harness([["signout*", ok("")]]);
    assert.deepEqual(await h.call("signOut", {}), { ok: true, result: null });
    assert.deepEqual(cli.lines(), ["signout --account=ACCOUNTUUID1"]);
    assert.equal(h.session, null);
    assert.deepEqual(h.preferences, {});
  });
});

describe("listing logins", () => {
  const list = (reply, context) => harness([["item list --categories Login --format json*", reply]], context);

  test("locked lists nothing and runs nothing", async () => {
    const { h, cli } = list(ok([]), locked);
    assert.deepEqual(failure(await h.call("list", { snapshot: null, cursor: null })), { code: "locked" });
    assert.equal(cli.seen.length, 0);
  });

  test("items read with their username, sites, vault and edit time, for the chosen account", async () => {
    const { h, cli } = list(ok([listedEntry({ favorite: true })]));
    const { items, pages } = await listAll(h);
    assert.equal(pages.length, 1);
    assert.deepEqual(items, [{ id: ITEM_ID, title: "Example", username: "me@example.com", urls: ["https://example.com"], vault: "Private", favorite: true, updatedAt: Date.parse("2026-01-02T03:04:05.678Z") }]);
    assert.deepEqual(cli.seen[0].launch.argv, ["item", "list", "--categories", "Login", "--format", "json", "--account=ACCOUNTUUID1"]);
  });

  test("an empty vault is an empty list", async () => {
    const { h } = list(ok([]));
    const { answer, items } = await listAll(h);
    assert.equal(answer.ok, true);
    assert.deepEqual(items, []);
  });

  for (const [name, stdout] of [
    ["html", "<html>proxy error</html>"],
    ["truncated JSON", '[{"id":"abc","title"'],
    ["nothing", ""],
    ["an object", '{"items":[]}'],
  ]) {
    test(`a listing of ${name} is an error, never an empty vault`, async () => {
      const { h } = list(ok(stdout));
      assert.equal(problemOf(await h.call("list", { snapshot: null, cursor: null })), "unreadable");
    });
  }

  const failures = [
    ["op signed out of the app", fail("[ERROR] 2026/11/15 10:00:00 You are not currently signed in."), { code: "locked" }],
    ["an expired authorization", fail("[ERROR] 2026/11/15 10:00:00 authorization timeout"), { code: "locked" }],
    ["the account removed", fail("No accounts configured for use with 1Password CLI."), { code: "signedOut" }],
    ["the app quit", fail("connecting to desktop app: cannot connect to 1Password app"), { code: "failed", problem: "appUnreachable" }],
    ["a timeout", { timedOut: true }, { code: "failed", problem: "timedOut" }],
    ["a crash", fail("panic: runtime error", 2), { code: "failed", problem: "failed", detail: "panic: runtime error" }],
  ];
  for (const [name, reply, error] of failures) {
    test(`${name} fails the listing as ${error.problem ?? error.code}`, async () => {
      const { h } = list(reply);
      assert.deepEqual(failure(await h.call("list", { snapshot: null, cursor: null })), error);
    });
  }

  test("an unreachable server is offline when the Mac is", async () => {
    const offline = list(fail("dial tcp: lookup my.1password.com: no such host"), { ...unlocked, offline: true });
    assert.equal(problemOf(await offline.h.call("list", { snapshot: null, cursor: null })), "offline");
  });

  test("a single item over a megabyte overflows instead of filling", async () => {
    const { h } = list(ok([listedEntry({ title: "x".repeat(1_100_000) })]));
    assert.equal(problemOf(await h.call("list", { snapshot: null, cursor: null })), "overflowed");
  });

  test("duplicates, bad ids and odd sites are cleaned, one entry per item", async () => {
    const manyUrls = Array.from({ length: 100 }, (_, i) => ({ href: `https://site${i % 80}.example` }));
    const entries = [
      listedEntry(),
      listedEntry({ title: "Duplicate" }),
      listedEntry({ id: "-rf", title: "Bad id" }),
      listedEntry({ id: "x".repeat(65) }),
      { title: "No id" },
      listedEntry({ id: "nourl0000000000000000000001", urls: undefined, additional_information: undefined }),
      listedEntry({ id: "manyurls000000000000000001", urls: [...manyUrls, { href: `https://long.example/${"a".repeat(2100)}` }, { href: "https://bad .example" }, { label: "no href" }] }),
    ];
    const { h } = list(ok(entries));
    const { items } = await listAll(h);
    assert.deepEqual(items.map((item) => item.id), [ITEM_ID, "nourl0000000000000000000001", "manyurls000000000000000001"]);
    assert.equal(items[0].title, "Example");
    assert.deepEqual(items[1].urls, []);
    assert.equal(items[1].username, "");
    assert.equal(items[2].urls.length, 64);
    assert.equal(new Set(items[2].urls).size, 64);
  });

  test("unicode survives while control and direction characters and overlong text are dropped", async () => {
    const title = `Café \u{1F510} ‮gnp.exe\u0007${"\u{1F600}".repeat(2000)}`;
    const { h } = list(ok([listedEntry({ title, additional_information: "усер\u{1F464}" })]));
    const [item] = (await listAll(h)).items;
    assert.equal(Array.from(item.title).length, sdk.CREDENTIAL_LIMITS.itemTitleLength);
    assert.ok(item.title.startsWith("Café \u{1F510} gnp.exe\u{1F600}"));
    assert.equal(item.username, "усер\u{1F464}");
  });

  test("a vault of thousands pages under the result limit and loses nothing", async () => {
    const entries = Array.from({ length: 12_000 }, (_, i) =>
      listedEntry({ id: `item${String(i).padStart(10, "0")}`, title: `Login ${i} ${"é".repeat(40)}`, urls: [{ href: `https://site${i}.example/login` }, { href: `https://www.site${i}.example` }] }),
    );
    const { h } = list(ok(entries));
    const { items, pages } = await listAll(h);
    assert.equal(items.length, 12_000);
    assert.equal(new Set(items.map((item) => item.id)).size, 12_000);
    assert.ok(pages.length > 1);
    assert.equal(new Set(pages.map((page) => page.snapshot)).size, 1);
    for (const page of pages) assert.ok(Buffer.byteLength(JSON.stringify(page)) < sdk.CREDENTIAL_LIMITS.resultBytes);
  });

  test("locking mid-listing ends the call and the next call starts a fresh run", async () => {
    const { h, cli } = harness([oneAccount, ["item list*", { finishAfterMs: 30_000, stdout: "[]" }], ["signout*", ok("")]]);
    const pending = h.call("list", { snapshot: null, cursor: null });
    while (!cli.lines().some((line) => line.startsWith("item list"))) await h.advance(0);
    await h.lock();
    assert.deepEqual(await pending, { ok: false, error: { code: "stale" } });
    assert.equal((await h.call("state", { explicit: false })).result.state, "locked");
  });
});

describe("revealing", () => {
  const reveal = (item, extra = []) => harness([["item get * --format json --reveal*", typeof item === "function" ? item : ok(item)], ...extra]);
  const ask = (h, fields, id = ITEM_ID) => h.call("reveal", { id, fields });

  test("the password and username come from their field purposes", async () => {
    const { h, cli } = reveal(revealedEntry({ extraFields: [{ id: "other", type: "CONCEALED", label: "pin", value: "0000" }] }));
    assert.deepEqual((await ask(h, ["password"])).result, { password: PASSWORD });
    assert.deepEqual((await ask(h, ["username"])).result, { username: "me@example.com" });
    assert.deepEqual(cli.seen[0].launch.argv, ["item", "get", ITEM_ID, "--format", "json", "--reveal", "--account=ACCOUNTUUID1"]);
  });

  test("a login with no password has nothing to reveal", async () => {
    const { h } = reveal(revealedEntry({ password: null }));
    assert.deepEqual(failure(await ask(h, ["password"])), { code: "notFound" });
  });

  test("a code comes as its otpauth setup address when 1Password holds one", async () => {
    const { h, cli } = reveal(revealedEntry({ otp: { value: TOTP_URI, totp: "123456" } }));
    assert.deepEqual((await ask(h, ["totp"])).result, { totp: { uri: TOTP_URI } });
    assert.equal(cli.seen.length, 1);
  });

  test("without a readable setup address the code 1Password shows is used", async () => {
    const { h } = reveal(revealedEntry({ otp: { value: "steam://JBSWY3DPEHPK3PXP", totp: "R7K2M" } }));
    assert.deepEqual((await ask(h, ["totp"])).result, { totp: { code: "R7K2M" } });
  });

  test("a code field with neither is fetched with --otp", async () => {
    const { h, cli } = reveal(revealedEntry({ otp: {} }), [["item get * --otp*", ok("482913\n")]]);
    assert.deepEqual((await ask(h, ["totp"])).result, { totp: { code: "482913" } });
    assert.deepEqual(cli.seen[1].launch.argv, ["item", "get", ITEM_ID, "--otp", "--account=ACCOUNTUUID1"]);
  });

  test("a login without a code field has no code and never asks for one", async () => {
    const { h, cli } = reveal(revealedEntry());
    assert.deepEqual(failure(await ask(h, ["totp"])), { code: "notFound" });
    assert.equal(cli.seen.length, 1);
  });

  test("revealing password and code together gives only what's stored, without a live code", async () => {
    const withUri = reveal(revealedEntry({ otp: { value: TOTP_URI } }));
    assert.deepEqual((await ask(withUri.h, ["password", "totp"])).result, { password: PASSWORD, totp: { uri: TOTP_URI } });
    const withoutUri = reveal(revealedEntry({ otp: {} }));
    assert.deepEqual((await ask(withoutUri.h, ["password", "totp"])).result, { password: PASSWORD });
    assert.equal(withoutUri.cli.seen.length, 1);
  });

  for (const id of ["-rf", "a/b", "x".repeat(65), ""]) {
    test(`an id like ${JSON.stringify(id.slice(0, 8))} is not found without running op`, async () => {
      const { h, cli } = reveal(revealedEntry());
      assert.deepEqual(failure(await ask(h, ["password"], id)), { code: "notFound" });
      assert.equal(cli.seen.length, 0);
    });
  }

  for (const [name, reply, error] of [
    ["a deleted item", fail(`[ERROR] 2026/11/22 10:00:00 "${ITEM_ID}" isn't an item. Specify the item with its UUID, name, or domain.`), { code: "notFound" }],
    ["truncated JSON", ok('{"id":"abc","fields":[{"id'), { code: "failed", problem: "unreadable" }],
    ["a list instead of an item", ok("[]"), { code: "failed", problem: "unreadable" }],
  ]) {
    test(`${name} is ${error.problem ?? error.code}`, async () => {
      const { h } = reveal(() => reply);
      assert.deepEqual(failure(await ask(h, ["password"])), error);
    });
  }

  test("locked reveals nothing", async () => {
    const { h, cli } = harness([], locked);
    assert.deepEqual(failure(await ask(h, ["password"])), { code: "locked" });
    assert.equal(cli.seen.length, 0);
  });
});

const VAULTS = [
  { id: "vvvvvvvvvvvvvvvvvvvvvvvvvv", name: "Private", content_version: 4 },
  { id: "wwwwwwwwwwwwwwwwwwwwwwwwww", name: "Family", content_version: 9 },
];
const SHARED = [
  { id: "wwwwwwwwwwwwwwwwwwwwwwwwww", name: "Family" },
  { id: "xxxxxxxxxxxxxxxxxxxxxxxxxx", name: "Work" },
];
const CREATED = { id: ITEM_ID, title: "Example", vault: { id: "vvvvvvvvvvvvvvvvvvvvvvvvvv", name: "Private" }, category: "LOGIN" };
const LOGIN = { title: "Example", username: "me@example.com", password: PASSWORD, url: "https://example.com" };

describe("saving a login", () => {
  const save = (routes, context) => harness(routes, context).h.call("save", { login: LOGIN });

  test("it goes into the private vault with the password only on stdin, then is read back", async () => {
    const { h, cli } = harness([["vault list*", ok(VAULTS)], ["item create*", ok(CREATED)], ["item get*", ok(revealedEntry())]]);
    const answer = await h.call("save", { login: LOGIN });
    assert.deepEqual(answer.result, { id: ITEM_ID, title: "Example", username: "me@example.com", urls: ["https://example.com"], vault: "Private" });
    const create = cli.seen.find((entry) => entry.launch.verb === "item.create").launch;
    assert.deepEqual(create.argv, ["item", "create", "-", "--vault=vvvvvvvvvvvvvvvvvvvvvvvvvv", "--format=json", "--account=ACCOUNTUUID1"]);
    assert.equal(create.argv.join(" ").includes(PASSWORD), false);
    const template = JSON.parse(create.stdin);
    assert.deepEqual(template.fields.map((field) => [field.purpose, field.value]), [["USERNAME", "me@example.com"], ["PASSWORD", PASSWORD]]);
    assert.deepEqual(template.urls, [{ href: "https://example.com", primary: true }]);
    assert.ok(cli.lines().some((line) => line.startsWith(`item get ${ITEM_ID} --format json --reveal`)));
    assert.equal(cli.lines().some((line) => line.startsWith("item edit")), false);
  });

  test("a renamed personal vault is found by its type", async () => {
    const { h, cli } = harness([
      ["vault list*", ok(SHARED)],
      ["vault get xxxxxxxxxxxxxxxxxxxxxxxxxx*", ok({ id: "xxxxxxxxxxxxxxxxxxxxxxxxxx", type: "PERSONAL" })],
      ["vault get*", ok({ type: "USER_CREATED" })],
      ["item create*", ok(CREATED)],
      ["item get*", ok(revealedEntry())],
    ]);
    assert.equal((await h.call("save", { login: LOGIN })).ok, true);
    assert.ok(cli.lines().some((line) => line.startsWith("item create - --vault=xxxxxxxxxxxxxxxxxxxxxxxxxx")));
  });

  test("a vault list that says its type needs no vault get", async () => {
    const { h, cli } = harness([["vault list*", ok([{ id: "zzzzzzzzzzzzzzzzzzzzzzzzzz", name: "Mine", type: "PERSONAL" }, ...SHARED])], ["item create*", ok(CREATED)], ["item get*", ok(revealedEntry())]]);
    assert.equal((await h.call("save", { login: LOGIN })).ok, true);
    assert.equal(cli.lines().some((line) => line.startsWith("vault get")), false);
  });

  test("with only shared vaults nothing is saved", async () => {
    const { h, cli } = harness([["vault list*", ok(SHARED)], ["vault get*", ok({ type: "USER_CREATED" })], ["item create*", ok(CREATED)]]);
    assert.deepEqual(failure(await h.call("save", { login: LOGIN })), { code: "failed", problem: "unknownVault" });
    assert.equal(cli.lines().some((line) => line.startsWith("item create")), false);
  });

  test("at most twelve vaults are checked", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `vault${String(i).padStart(21, "0")}`, name: `Shared ${i}` }));
    const { h, cli } = harness([["vault list*", ok(many)], ["vault get*", ok({ type: "USER_CREATED" })]]);
    assert.equal(problemOf(await h.call("save", { login: LOGIN })), "unknownVault");
    assert.equal(cli.lines().filter((line) => line.startsWith("vault get")).length, 12);
  });

  test("a single shared vault takes the login", async () => {
    const { h, cli } = harness([["vault list*", ok([SHARED[1]])], ["vault get*", ok({ type: "USER_CREATED" })], ["item create*", ok(CREATED)], ["item get*", ok(revealedEntry())]]);
    assert.equal((await h.call("save", { login: LOGIN })).ok, true);
    assert.ok(cli.lines().some((line) => line.includes("--vault=xxxxxxxxxxxxxxxxxxxxxxxxxx")));
  });

  test("no vault at all is noVault", async () => {
    assert.equal(problemOf(await save([["vault list*", ok([])]])), "noVault");
  });

  test("a login made without its password is repaired with an edit", async () => {
    let reads = 0;
    const { h, cli } = harness([
      ["vault list*", ok(VAULTS)],
      ["item create*", ok(CREATED)],
      ["item get*", () => ok(reads++ === 0 ? revealedEntry({ password: null }) : revealedEntry())],
      ["item edit*", ok(revealedEntry())],
    ]);
    assert.equal((await h.call("save", { login: LOGIN })).ok, true);
    const edit = cli.seen.find((entry) => entry.launch.verb === "item.edit").launch;
    assert.deepEqual(edit.argv, ["item", "edit", ITEM_ID, "--format=json", "--account=ACCOUNTUUID1"]);
    assert.ok(JSON.parse(edit.stdin).fields.some((field) => field.purpose === "PASSWORD" && field.value === PASSWORD));
  });

  test("a login that stays without its password is reported, not claimed as saved", async () => {
    const bare = { id: ITEM_ID, fields: [] };
    const { h, cli } = harness([["vault list*", ok(VAULTS)], ["item create*", ok(CREATED)], ["item get*", ok(bare)], ["item edit*", ok(bare)]]);
    assert.equal(problemOf(await h.call("save", { login: LOGIN })), "incomplete");
    assert.ok(cli.lines().some((line) => line.startsWith(`item edit ${ITEM_ID}`)));
  });

  test("a create that answers nothing readable is savedNotReturned", async () => {
    assert.equal(problemOf(await save([["vault list*", ok(VAULTS)], ["item create*", ok("created")]])), "savedNotReturned");
  });

  test("locked saves nothing", async () => {
    const { h, cli } = harness([], locked);
    assert.deepEqual(failure(await h.call("save", { login: LOGIN })), { code: "locked" });
    assert.equal(cli.seen.length, 0);
  });
});

describe("editing a login", () => {
  const editRoutes = (stored, returned) => [["item get*", ok(stored)], ["item edit*", typeof returned === "function" ? returned : ok(returned)]];
  const sentTemplate = (cli) => JSON.parse(cli.seen.find((entry) => entry.launch.verb === "item.edit").launch.stdin);

  test("a new password replaces the old one and drops its strength details", async () => {
    const { h, cli } = harness(editRoutes(revealedEntry(), revealedEntry({ password: NEW_PASSWORD })));
    const answer = await h.call("edit", { id: ITEM_ID, change: { password: NEW_PASSWORD } });
    assert.equal(answer.result.id, ITEM_ID);
    const password = sentTemplate(cli).fields.find((field) => field.purpose === "PASSWORD");
    assert.deepEqual(password, { id: "password", type: "CONCEALED", purpose: "PASSWORD", label: "password", value: NEW_PASSWORD, reference: `op://Private/${ITEM_ID}/password` });
  });

  test("a new username is set and returned", async () => {
    const { h, cli } = harness(editRoutes(revealedEntry(), revealedEntry({ username: "new@example.com" })));
    const answer = await h.call("edit", { id: ITEM_ID, change: { username: "new@example.com" } });
    assert.equal(answer.result.username, "new@example.com");
    assert.equal(sentTemplate(cli).fields.find((field) => field.purpose === "USERNAME").value, "new@example.com");
  });

  test("a new address replaces the primary one, or becomes it", async () => {
    const urls = [{ href: "https://old.example" }, { href: "https://main.example", primary: true }];
    const changed = harness(editRoutes(revealedEntry({ urls }), revealedEntry({ urls: [urls[0], { href: "https://new.example", primary: true }] })));
    assert.equal((await changed.h.call("edit", { id: ITEM_ID, change: { url: "https://new.example" } })).ok, true);
    assert.deepEqual(sentTemplate(changed.cli).urls, [{ href: "https://old.example" }, { href: "https://new.example", primary: true }]);
    const added = harness(editRoutes(revealedEntry({ urls: [] }), revealedEntry({ urls: [{ href: "https://new.example", primary: true }] })));
    assert.equal((await added.h.call("edit", { id: ITEM_ID, change: { url: "https://new.example" } })).ok, true);
    assert.deepEqual(sentTemplate(added.cli).urls, [{ href: "https://new.example", primary: true }]);
  });

  test("removing the code drops every code field", async () => {
    const { h, cli } = harness(editRoutes(revealedEntry({ otp: { value: TOTP_URI } }), revealedEntry()));
    assert.equal((await h.call("edit", { id: ITEM_ID, change: { totp: "remove" } })).ok, true);
    assert.equal(sentTemplate(cli).fields.some((field) => field.type === "OTP"), false);
  });

  test("a change the edit's answer lacks is confirmed by reading the item again", async () => {
    let reads = 0;
    const { h } = harness([["item get*", () => ok(reads++ === 0 ? revealedEntry() : revealedEntry({ password: NEW_PASSWORD }))], ["item edit*", ok(revealedEntry())]]);
    assert.equal((await h.call("edit", { id: ITEM_ID, change: { password: NEW_PASSWORD } })).ok, true);
    assert.equal(reads, 2);
  });

  test("a change 1Password didn't keep is notTaken", async () => {
    const { h } = harness(editRoutes(revealedEntry(), revealedEntry()));
    assert.equal(problemOf(await h.call("edit", { id: ITEM_ID, change: { password: NEW_PASSWORD } })), "notTaken");
  });

  test("an edit that answers nothing readable is savedNotReturned", async () => {
    const { h } = harness(editRoutes(revealedEntry(), () => ok("ok")));
    assert.equal(problemOf(await h.call("edit", { id: ITEM_ID, change: { password: NEW_PASSWORD } })), "savedNotReturned");
  });

  for (const [name, stored, change] of [
    ["a document", revealedEntry({ category: "DOCUMENT" }), { password: NEW_PASSWORD }],
    ["an empty change", revealedEntry(), {}],
    ["an item op returns under another id", revealedEntry({ id: "someoneelse000000000000001" }), { password: NEW_PASSWORD }],
  ]) {
    test(`${name} can't be prepared and runs no edit`, async () => {
      const { h, cli } = harness(editRoutes(stored, revealedEntry()));
      assert.equal(problemOf(await h.call("edit", { id: ITEM_ID, change })), "cantPrepare");
      assert.equal(cli.lines().some((line) => line.startsWith("item edit")), false);
    });
  }

  test("a bad id is not found without running op", async () => {
    const { h, cli } = harness([]);
    assert.deepEqual(failure(await h.call("edit", { id: "--vault=x", change: { password: NEW_PASSWORD } })), { code: "notFound" });
    assert.equal(cli.seen.length, 0);
  });

  test("a deleted item is not found", async () => {
    const { h } = harness([["item get*", fail(`"${ITEM_ID}" isn't an item.`)]]);
    assert.deepEqual(failure(await h.call("edit", { id: ITEM_ID, change: { password: NEW_PASSWORD } })), { code: "notFound" });
  });

  test("locked edits nothing", async () => {
    const { h, cli } = harness([], locked);
    assert.deepEqual(failure(await h.call("edit", { id: ITEM_ID, change: { password: NEW_PASSWORD } })), { code: "locked" });
    assert.equal(cli.seen.length, 0);
  });
});

describe("adding a code", () => {
  const SECRET = "JBSWY3DPEHPK3PXP";
  const liveCode = () => referenceCode(base32Bytes(SECRET), Date.now());

  test("a login without one gains Ardia's code field, confirmed by the code 1Password computes", async () => {
    const { h, cli } = harness([["item get*", ok(revealedEntry())], ["item edit*", () => ok(revealedEntry({ otp: { id: "ardia-one-time-password", totp: liveCode() } }))]]);
    const answer = await h.call("addTotp", { id: ITEM_ID, uri: TOTP_URI });
    assert.equal(answer.ok, true);
    const added = JSON.parse(cli.seen[1].launch.stdin).fields.find((field) => field.type === "OTP");
    assert.deepEqual(added, { id: sdk.CODE_FIELD_ID, type: "OTP", label: "one-time password", value: TOTP_URI });
  });

  test("an existing code field takes the new address and loses its old code", async () => {
    const stored = revealedEntry({ otp: { value: "otpauth://totp/Old?secret=GEZDGNBVGY3TQOJQ", totp: "111111" } });
    const { h, cli } = harness([["item get*", ok(stored)], ["item edit*", ok(revealedEntry({ otp: { value: `otpauth://totp/Example:me@example.com?issuer=Example&secret=${SECRET.toLowerCase()}` } }))]]);
    assert.equal((await h.call("addTotp", { id: ITEM_ID, uri: TOTP_URI })).ok, true);
    const otps = JSON.parse(cli.seen[1].launch.stdin).fields.filter((field) => field.type === "OTP");
    assert.deepEqual(otps, [{ id: "TOTP_abc", section: { id: "add more" }, type: "OTP", label: "one-time password", value: TOTP_URI }]);
  });

  test("a code 1Password didn't keep is notTaken", async () => {
    const { h } = harness([["item get*", ok(revealedEntry())], ["item edit*", ok(revealedEntry({ otp: { totp: "000000" } }))]]);
    assert.equal(problemOf(await h.call("addTotp", { id: ITEM_ID, uri: TOTP_URI })), "notTaken");
  });
});
