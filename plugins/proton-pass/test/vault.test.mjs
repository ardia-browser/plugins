import { afterEach, beforeEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import { NEW_PASSWORD, PASSWORD, TOTP_URI, VAULTS, argvOf, entry, harness, itemsJson, locked, subject, vaultsJson } from "./helpers.mjs";

const FIRST = { snapshot: null, cursor: null };
const listed = itemsJson(entry());
const NOT_FOUND = { status: 1, stderr: "Error: Item not found" };

beforeEach(() => mock.timers.enable({ apis: ["Date"], now: 1_767_400_000_000 }));
afterEach(() => mock.timers.reset());

async function listAll(h) {
  const items = [];
  let answer = await h.call("list", FIRST);
  let pages = 1;
  for (;;) {
    assert.equal(answer.ok, true, JSON.stringify(answer));
    items.push(...answer.result.items);
    if (!answer.result.cursor) return { items, pages, snapshot: answer.result.snapshot };
    answer = await h.call("list", { snapshot: answer.result.snapshot, cursor: answer.result.cursor });
    pages += 1;
  }
}

describe("list", () => {
  test("lists each vault's logins with share/item ids, vault names and secrets", async () => {
    const h = harness([
      ["vault list*", { stdout: VAULTS }],
      ["item list --share-id=shareWork1*", { stdout: itemsJson(entry({ id: "work0001", title: "Jira", totp: TOTP_URI })) }],
      ["item list --share-id=sharePersonal1*", { stdout: listed }],
    ]);
    const { items } = await listAll(h);
    assert.deepEqual(items, [
      { id: "shareWork1/work0001", title: "Jira", username: "me", urls: ["https://example.com"], hasTotp: true, totpPeriod: 30, vault: "Work", updatedAt: 1767323045000, secrets: { password: PASSWORD, totp: TOTP_URI } },
      { id: "sharePersonal1/item0001", title: "Example", username: "me", urls: ["https://example.com"], hasTotp: false, vault: "Personal", updatedAt: 1767323045000, secrets: { password: PASSWORD } },
    ]);
    assert.ok(argvOf(h).slice(1).every((line) => line.endsWith("--show-secrets")));
  });

  test("reads every vault past an update notice", async () => {
    const h = harness([["vault list*", { stdout: `A new version of pass-cli is available [1.5.0]\n${VAULTS}` }], ["item list*", { stdout: listed }]]);
    assert.equal((await listAll(h)).items.length, 2);
  });

  test("a pass-cli without --show-secrets still lists logins, without their secrets", async () => {
    const h = harness([
      ["vault list*", { stdout: VAULTS }],
      ["item list*--show-secrets", { status: 2, stderr: "error: unexpected argument '--show-secrets' found" }],
      ["item list*", { stdout: itemsJson(entry({ password: "" })) }],
    ]);
    const { items } = await listAll(h);
    assert.equal(items.length, 2);
    assert.ok(items.every((item) => item.secrets === undefined));
    assert.equal(argvOf(h).filter((line) => !line.endsWith("--show-secrets") && line.startsWith("item list")).length, 2);
  });

  test("a pass-cli too old for item list says to update it", async () => {
    const h = harness([["vault list*", { stdout: VAULTS }], ["item list*", { status: 2, stderr: "error: unknown command 'item'" }]]);
    assert.deepEqual(await h.call("list", FIRST), { ok: false, error: { code: "failed", problem: "outdated" } });
  });

  const unreadable = [
    ["a vault list that isn't JSON", [["vault list*", { stdout: "Error loading vaults" }]]],
    ["a truncated vault list", [["vault list*", { stdout: VAULTS.slice(0, 40) }]]],
    ["a vault list without vaults", [["vault list*", { stdout: "{\"shares\":[]}" }]]],
    ["an item list that isn't JSON", [["vault list*", { stdout: VAULTS }], ["item list*", { stdout: "Loading..." }]]],
    ["a truncated item list", [["vault list*", { stdout: VAULTS }], ["item list*", { stdout: listed.slice(0, 60) }]]],
  ];
  for (const [name, rules] of unreadable) {
    test(`${name} is unreadable`, async () => {
      assert.deepEqual(await harness(rules).call("list", FIRST), { ok: false, error: { code: "failed", problem: "unreadable" } });
    });
  }

  test("an empty vault and no vaults list nothing", async () => {
    const empty = harness([["vault list*", { stdout: vaultsJson([{ name: "Personal", share_id: "s1" }]) }], ["item list*", { stdout: itemsJson() }]]);
    assert.deepEqual((await listAll(empty)).items, []);
    const none = harness([["vault list*", { stdout: vaultsJson([]) }]]);
    assert.deepEqual((await listAll(none)).items, []);
    assert.deepEqual(argvOf(none), ["vault list --output=json"]);
  });

  test("a huge vault pages through thousands of logins", async () => {
    const many = Array.from({ length: 6000 }, (_, index) => entry({ id: `item${String(index).padStart(6, "0")}`, title: `Site ${index} ${"x".repeat(100)}` }));
    const h = harness([["vault list*", { stdout: vaultsJson([{ name: "Personal", share_id: "s1" }]) }], ["item list*", { stdout: itemsJson(...many) }]]);
    const { items, pages } = await listAll(h);
    assert.equal(items.length, 6000);
    assert.equal(new Set(items.map((item) => item.id)).size, 6000);
    assert.ok(pages > 1);
  });

  test("duplicate vaults and duplicate items list once", async () => {
    const h = harness([
      ["vault list*", { stdout: vaultsJson([{ name: "Personal", share_id: "s1" }, { name: "Personal", share_id: "s1" }]) }],
      ["item list*", { stdout: itemsJson(entry(), entry()) }],
    ]);
    assert.equal((await listAll(h)).items.length, 1);
    assert.equal(argvOf(h).filter((line) => line.startsWith("item list")).length, 1);
  });

  test("logins with no URL, many URLs and autofill URLs keep what fills", async () => {
    const urls = Array.from({ length: 80 }, (_, index) => `https://site${index}.example`);
    const h = harness([
      ["vault list*", { stdout: vaultsJson([{ name: "Personal", share_id: "s1" }]) }],
      ["item list*", {
        stdout: itemsJson(
          entry({ id: "nourl0001", urls: [] }),
          entry({ id: "many00001", urls }),
          entry({ id: "auto00001", urls: ["https://a.example"], autofill: [{ url: "https://b.example", mode: "Always" }, { url: "https://c.example", mode: "Never" }, { url: "https://a.example" }] }),
          entry({ id: "long00001", urls: [`https://${"l".repeat(2100)}.example`, "https://ok.example"] }),
        ),
      }],
    ]);
    const byId = Object.fromEntries((await listAll(h)).items.map((item) => [item.id, item.urls]));
    assert.deepEqual(byId["s1/nourl0001"], []);
    assert.equal(byId["s1/many00001"].length, subject.CREDENTIAL_LIMITS.urlsPerItem);
    assert.deepEqual(byId["s1/auto00001"], ["https://a.example", "https://b.example"]);
    assert.deepEqual(byId["s1/long00001"], ["https://ok.example"]);
  });

  test("unicode and very long fields stay within the host's limits", async () => {
    const h = harness([
      ["vault list*", { stdout: vaultsJson([{ name: `Fämïly ${"v".repeat(400)}`, share_id: "s1" }]) }],
      ["item list*", {
        stdout: itemsJson(
          entry({ id: "uni000001", title: "Banque \u{1F3E6} ‮evil‬", username: "josé@exemple.fr", password: "päss\u{1F511}" }),
          entry({ id: "long00001", title: "t".repeat(3000), password: "p".repeat(5000) }),
          entry({ id: "user00001", username: "u".repeat(2000) }),
        ),
      }],
    ]);
    const items = Object.fromEntries((await listAll(h)).items.map((item) => [item.id, item]));
    assert.equal(items["s1/uni000001"].title, "Banque \u{1F3E6} evil");
    assert.equal(items["s1/uni000001"].username, "josé@exemple.fr");
    assert.equal(items["s1/uni000001"].secrets.password, "päss\u{1F511}");
    assert.equal(items["s1/uni000001"].vault.length, subject.CREDENTIAL_LIMITS.vaultNameLength);
    assert.equal(items["s1/long00001"].title.length, subject.CREDENTIAL_LIMITS.itemTitleLength);
    assert.equal(items["s1/long00001"].secrets, undefined);
    assert.equal(items["s1/user00001"], undefined);
  });

  test("TOTP comes from the login or an extra field, and only a readable one is cached", async () => {
    const h = harness([
      ["vault list*", { stdout: vaultsJson([{ name: "Personal", share_id: "s1" }]) }],
      ["item list*", {
        stdout: itemsJson(
          entry({ id: "direct001", totp: TOTP_URI }),
          entry({ id: "extra0001", extraTotp: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=60" }),
          entry({ id: "bare00001", totp: "not a uri" }),
          entry({ id: "broken001", totp: "not!base32" }),
          entry({ id: "plain0001" }),
        ),
      }],
    ]);
    const items = Object.fromEntries((await listAll(h)).items.map((item) => [item.id, item]));
    assert.equal(items["s1/direct001"].secrets.totp, TOTP_URI);
    assert.equal(items["s1/extra0001"].totpPeriod, 60);
    assert.equal(items["s1/bare00001"].secrets.totp, "not a uri");
    assert.equal(items["s1/broken001"].hasTotp, true);
    assert.equal(items["s1/broken001"].secrets.totp, undefined);
    assert.equal(items["s1/plain0001"].hasTotp, false);
  });

  test("skips items that aren't active logins or have unusable ids", async () => {
    const h = harness([
      ["vault list*", { stdout: vaultsJson([{ name: "Personal", share_id: "s1" }, { name: "Bad", share_id: "bad/share" }]) }],
      ["item list*", { stdout: JSON.stringify({ items: [entry({ state: "Trashed" }), { id: "note00001", content: { title: "Note", content: { Note: {} } } }, entry({ id: "bad id" }), entry({ id: "keep00001" })] }) }],
    ]);
    assert.deepEqual((await listAll(h)).items.map((item) => item.id), ["s1/keep00001"]);
    assert.equal(argvOf(h).filter((line) => line.startsWith("item list")).length, 1);
  });

  test("locked, it runs nothing", async () => {
    const h = harness([], locked);
    assert.deepEqual(await h.call("list", FIRST), { ok: false, error: { code: "locked" } });
    assert.equal(h.launches.length, 0);
  });

  const failures = [
    ["a signed-out pass-cli", { status: 1, stderr: "Error: not logged in" }, { code: "signedOut" }],
    ["a session lock", { status: 1, stderr: "Error: session is locked" }, { code: "locked" }],
    ["no network", { status: 1, stderr: "error: network error: fetch failed" }, { code: "failed", problem: "unreachable" }],
    ["a vault list that never answers", { timedOut: true }, { code: "failed", problem: "timedOut" }],
  ];
  for (const [name, reply, expected] of failures) {
    test(`with ${name}`, async () => {
      assert.deepEqual(await harness([["vault list*", reply]]).call("list", FIRST), { ok: false, error: expected });
    });
  }

  test("offline, a network failure says you're offline", async () => {
    const h = harness([["vault list*", { status: 1, stderr: "error: getaddrinfo ENOTFOUND" }]], { session: { key: null }, offline: true });
    assert.deepEqual(await h.call("list", FIRST), { ok: false, error: { code: "failed", problem: "offline" } });
  });

  test("one login bigger than the host reads overflows the listing", async () => {
    const huge = entry({ id: "huge00001", title: "h".repeat(1_100_000) });
    const h = harness([["vault list*", { stdout: vaultsJson([{ name: "Personal", share_id: "s1" }]) }], ["item list*", { stdout: itemsJson(huge) }]]);
    assert.deepEqual(await h.call("list", FIRST), { ok: false, error: { code: "failed", problem: "overflowed" } });
  });

});

describe("reveal", () => {
  const view = (login) => ({ stdout: JSON.stringify({ item: { id: "item0001", content: { title: "Example", content: { Login: login } } } }) });

  test("reads the password and username with item view", async () => {
    const h = harness([["item view*", view({ username: "", email: "me@example.com", password: PASSWORD })]]);
    assert.deepEqual((await h.call("reveal", { id: "sharePersonal1/item0001", fields: ["username", "password"] })).result, { username: "me@example.com", password: PASSWORD });
    assert.deepEqual(argvOf(h), ["item view --share-id=sharePersonal1 --item-id=item0001 --output=json"]);
  });

  test("reads the current code with item totp", async () => {
    const h = harness([["item totp*", { stdout: "{\"totp\":\"123456\"}" }]]);
    assert.deepEqual((await h.call("reveal", { id: "s1/item0001", fields: ["totp"] })).result, { totp: { code: "123456" } });
    assert.deepEqual(argvOf(h), ["item totp --share-id=s1 --item-id=item0001 --field=totp --output=json"]);
  });

  test("a login without TOTP still reveals its password", async () => {
    const h = harness([["item totp*", { status: 1, stderr: "Error: No TOTP fields found" }], ["item view*", view({ username: "me", password: PASSWORD })]]);
    assert.deepEqual((await h.call("reveal", { id: "s1/item0001", fields: ["password", "totp"] })).result, { password: PASSWORD });
  });

  const missing = [
    ["a code from a login without TOTP", [["item totp*", { status: 1, stderr: "Error: no TOTP fields" }]], ["totp"]],
    ["an empty password", [["item view*", view({ username: "me", password: "" })]], ["password"]],
    ["an item that isn't a login", [["item view*", { stdout: JSON.stringify({ item: { content: { content: { Note: {} } } } }) }]], ["password"]],
    ["a deleted item", [["item view*", NOT_FOUND]], ["password"]],
  ];
  for (const [name, rules, fields] of missing) {
    test(`${name} is not found`, async () => {
      assert.deepEqual(await harness(rules).call("reveal", { id: "s1/item0001", fields }), { ok: false, error: { code: "notFound" } });
    });
  }

  test("an id without a share, or with option-like parts, runs nothing", async () => {
    for (const id of ["item0001", "s1/", "/item0001", "-s/item", "s1/i 1"]) {
      const h = harness([]);
      assert.deepEqual(await h.call("reveal", { id, fields: ["password"] }), { ok: false, error: { code: "notFound" } });
      assert.equal(h.launches.length, 0);
    }
  });

  test("locked or signed out, it says so", async () => {
    assert.deepEqual(await harness([], locked).call("reveal", { id: "s1/i1", fields: ["password"] }), { ok: false, error: { code: "locked" } });
    const out = harness([["item view*", { status: 1, stderr: "requires an authenticated client" }]]);
    assert.deepEqual(await out.call("reveal", { id: "s1/i1", fields: ["password"] }), { ok: false, error: { code: "signedOut" } });
  });

  test("an unreadable view is an error, not a missing password", async () => {
    assert.deepEqual(await harness([["item view*", { stdout: "{\"item\":" }]]).call("reveal", { id: "s1/i1", fields: ["password"] }), { ok: false, error: { code: "failed", problem: "unreadable" } });
  });
});

describe("save", () => {
  const login = { title: "Example", username: "me", password: NEW_PASSWORD, url: "https://example.com" };

  test("creates the login from a template in the personal vault", async () => {
    const h = harness([["vault list*", { stdout: VAULTS }], ["item create*", { stdout: JSON.stringify({ id: "newItem01" }) }]]);
    const answer = await h.call("save", { login });
    assert.deepEqual(answer.result, { id: "sharePersonal1/newItem01", title: "Example", username: "me", urls: ["https://example.com"], hasTotp: false, vault: "Personal", updatedAt: 1_767_400_000_000 });
    const create = h.launches.find((launch) => launch.verb === "item.create");
    assert.deepEqual(create.argv, ["item", "create", "login", "--share-id=sharePersonal1", "--from-template=-"]);
    assert.deepEqual(JSON.parse(create.stdin), { title: "Example", username: "me", password: NEW_PASSWORD, urls: ["https://example.com"], extra_fields: [] });
  });

  test("an email user name goes in the email field", async () => {
    const h = harness([["vault list*", { stdout: VAULTS }], ["item create*", { stdout: "{\"item_id\":\"newItem01\"}" }]]);
    await h.call("save", { login: { ...login, username: "me@example.com" } });
    const template = JSON.parse(h.launches.at(-1).stdin);
    assert.equal(template.email, "me@example.com");
    assert.equal(template.username, undefined);
  });

  test("an id printed on the last line is used", async () => {
    const h = harness([["vault list*", { stdout: VAULTS }], ["item create*", { stdout: "Creating item...\nItem created: Kx7b2_Qz9w==\n" }]]);
    assert.equal((await h.call("save", { login })).result.id, "sharePersonal1/Kx7b2_Qz9w==");
  });

  test("output that names no id finds the new login in its vault", async () => {
    const h = harness([
      ["vault list*", { stdout: VAULTS }],
      ["item create*", { stdout: "Item created successfully" }],
      ["item list*", { stdout: itemsJson(entry({ id: "older0001", modified: 1000 }), entry({ id: "item0001", modified: 1767323045 }), entry({ id: "other0001", title: "Other" })) }],
    ]);
    const answer = await h.call("save", { login });
    assert.equal(answer.result.id, "sharePersonal1/item0001");
    assert.ok(argvOf(h).at(-1).startsWith("item list --share-id=sharePersonal1"));
  });

  test("when the new login can't be found again it says to check Proton Pass", async () => {
    const h = harness([["vault list*", { stdout: VAULTS }], ["item create*", { stdout: "Done." }], ["item list*", { stdout: itemsJson() }]]);
    assert.deepEqual(await h.call("save", { login }), { ok: false, error: { code: "failed", problem: "savedNotReturned" } });
  });

  const choices = [
    ["only shared vaults", [{ name: "Work", share_id: "shareWork1" }, { name: "Family", share_id: "shareFamily1" }], { problem: "unknownVault" }],
    ["no vaults", [], { problem: "noVault" }],
    ["one vault", [{ name: "Mine", share_id: "shareMine1" }], { share: "shareMine1" }],
    ["one owned vault among shared ones", [{ name: "Work", share_id: "w1", owner: false }, { name: "Mine", share_id: "m1", owner: true }], { share: "m1" }],
    ["a vault not shared", [{ name: "Work", share_id: "w1", shared: true }, { name: "Mine", share_id: "m1", shared: false }], { share: "m1" }],
  ];
  for (const [name, vaults, expected] of choices) {
    test(`with ${name}`, async () => {
      const h = harness([["vault list*", { stdout: vaultsJson(vaults) }], ["item create*", { stdout: "{\"id\":\"newItem01\"}" }]]);
      const answer = await h.call("save", { login });
      if (expected.problem) {
        assert.deepEqual(answer, { ok: false, error: { code: "failed", problem: expected.problem } });
        assert.equal(h.launches.length, 1);
      } else {
        assert.equal(answer.result.id, `${expected.share}/newItem01`);
      }
    });
  }

  test("a refused create never shows the password", async () => {
    const h = harness([["vault list*", { stdout: VAULTS }], ["item create*", { status: 1, stderr: `Error: invalid template near "${NEW_PASSWORD}"` }]]);
    const answer = await h.call("save", { login });
    assert.deepEqual(answer, { ok: false, error: { code: "failed", problem: "failed", detail: 'invalid template near "[hidden]"' } });
  });

  test("locked, signed out or session locked, it says so", async () => {
    assert.deepEqual(await harness([], locked).call("save", { login }), { ok: false, error: { code: "locked" } });
    const out = harness([["vault list*", { status: 1, stderr: "Error: no session" }]]);
    assert.deepEqual(await out.call("save", { login }), { ok: false, error: { code: "signedOut" } });
    const sessionLock = harness([["vault list*", { stdout: VAULTS }], ["item create*", { status: 1, stderr: "Error: session is locked" }]]);
    assert.deepEqual(await sessionLock.call("save", { login }), { ok: false, error: { code: "locked" } });
  });

  test("signed out while finding the saved login is reported, not hidden", async () => {
    const h = harness([["vault list*", { stdout: VAULTS }], ["item create*", { stdout: "ok" }], ["item list*", { status: 1, stderr: "Error: not logged in" }]]);
    assert.deepEqual(await h.call("save", { login }), { ok: false, error: { code: "signedOut" } });
  });
});

describe("calls Proton Pass doesn't offer", () => {
  for (const [name, input] of [
    ["edit", { id: "s1/i1", change: { password: "x" } }],
    ["addTotp", { id: "s1/i1", uri: TOTP_URI }],
    ["configure", { server: null }],
    ["passkeys.get", { item: "s1/i1", credentialId: "c", rpId: "example.com" }],
    ["passkeys.save", { credential: {}, attachTo: null, title: "t", url: "https://example.com" }],
  ]) {
    test(`${name} is unsupported and runs nothing`, async () => {
      const h = harness([]);
      assert.deepEqual(await h.call(name, input), { ok: false, error: { code: "unsupported" } });
      assert.equal(h.launches.length, 0);
    });
  }
});
