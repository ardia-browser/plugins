import { afterEach, beforeEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { entry, harness, itemsJson, subject, vaultsJson } from "./helpers.mjs";

const FIXTURE = readFileSync(new URL("./fixtures/passkeys.json", import.meta.url), "utf8");
const FIXTURE_ITEMS = JSON.parse(FIXTURE).items;
const ONE_VAULT = vaultsJson([{ name: "Personal", share_id: "sharePk0001" }]);
const PASSKEY_FIELDS = ["counter", "credentialId", "discoverable", "displayName", "rpId", "userName"];

beforeEach(() => mock.timers.enable({ apis: ["Date"], now: 1_767_400_000_000 }));
afterEach(() => mock.timers.reset());

async function listAll(h) {
  const items = [];
  let answer = await h.call("list", { snapshot: null, cursor: null });
  for (;;) {
    assert.equal(answer.ok, true, JSON.stringify(answer));
    items.push(...answer.result.items);
    if (!answer.result.cursor) return items;
    answer = await h.call("list", { snapshot: answer.result.snapshot, cursor: answer.result.cursor });
  }
}

const listing = (stdout) => harness([["vault list*", { stdout: ONE_VAULT }], ["item list*", { stdout }]]);
const passkeysById = (items) => Object.fromEntries(items.map((item) => [item.id.split("/")[1], item.passkeys]));
const rawPasskeys = (id) => FIXTURE_ITEMS.find((item) => item.id === id).content.content.Login.passkeys;
const idOf = (bytes) => Buffer.from(bytes).toString("base64url");

function expected(raw, overrides = {}) {
  return { credentialId: idOf(raw.credential_id), rpId: raw.rp_id.toLowerCase(), userName: raw.user_name, displayName: raw.user_display_name, discoverable: true, counter: 0, ...overrides };
}

function passkeyEntry(id, passkeys, extra = {}) {
  const base = entry({ id, urls: ["https://webauthn.io"] });
  base.content.content.Login.passkeys = passkeys;
  Object.assign(base.content.content.Login, extra);
  return base;
}

function rawPasskey(overrides = {}) {
  return { key_id: "k", content: [...randomBytes(190)], domain: "webauthn.io", rp_id: "webauthn.io", rp_name: "webauthn.io", user_name: "sam", user_display_name: "Sam", user_id: [...randomBytes(16)], create_time: 1773480413, note: "", credential_id: [...randomBytes(16)], user_handle: [...randomBytes(32)], creation_data: null, ...overrides };
}

describe("passkeys on listed logins", () => {
  test("pass-cli's passkeys list as metadata on their login, and logins without any list as before", async () => {
    const byId = passkeysById(await listAll(listing(FIXTURE)));
    assert.deepEqual(byId.pkMany0001, rawPasskeys("pkMany0001").map((raw) => expected(raw)));
    assert.equal(byId.pkNone0001, undefined);
    assert.equal(byId.pkNone0002, undefined);
    assert.deepEqual(byId.pkHuge0001, [expected(rawPasskeys("pkHuge0001")[0])]);
  });

  test("a passkey keeps its own lowercased rpId when it differs from the login's URL", async () => {
    const items = await listAll(listing(FIXTURE));
    const other = items.find((item) => item.id === "sharePk0001/pkOther001");
    assert.deepEqual(other.urls, ["https://accounts.example.com/login"]);
    assert.deepEqual(other.passkeys, [expected(rawPasskeys("pkOther001")[0], { rpId: "example.com" })]);
    assert.equal(passkeysById(items).pkMany0001[2].rpId, "example.com");
  });

  test("passkeys with a malformed id or rpId drop, and the rest of the login still lists", async () => {
    const items = await listAll(listing(FIXTURE));
    const bad = items.find((item) => item.id === "sharePk0001/pkBad00001");
    assert.equal(bad.title, "Malformed ids");
    assert.equal(bad.secrets.password, "fixture-pw-pkBad00001");
    const kept = rawPasskeys("pkBad00001").find((raw) => raw.user_name === "kept");
    assert.deepEqual(bad.passkeys, [expected(kept)]);
  });

  test("a duplicate passkey lists once on its login, and a copy on another login lists there too", async () => {
    const byId = passkeysById(await listAll(listing(FIXTURE)));
    const [dupe, , unique] = rawPasskeys("pkDupe0001");
    assert.deepEqual(byId.pkDupe0001, [expected(dupe), expected(unique)]);
    assert.deepEqual(byId.pkDupe0002, [expected(dupe)]);
  });

  const SYMBOLS = Buffer.from(Array.from({ length: 17 }, (_, index) => [0xfb, 0xef, 0xff][index % 3]));
  const PLAIN = Buffer.from(Array.from({ length: 20 }, (_, index) => index + 1));
  const ids = [
    ["standard padded base64", SYMBOLS.toString("base64"), SYMBOLS.toString("base64url")],
    ["unpadded base64url", PLAIN.toString("base64url"), PLAIN.toString("base64url")],
    ["mixed alphabets", `-${SYMBOLS.toString("base64").slice(1)}`, null],
    ["base64url with padding", `${SYMBOLS.toString("base64url")}=`, null],
    ["standard base64 without its padding", SYMBOLS.toString("base64").replace(/=+$/, ""), null],
    ["standard base64 with too much padding", `${SYMBOLS.toString("base64")}==`, null],
    ["non-canonical trailing bits", `${SYMBOLS.toString("base64url").slice(0, -1)}9`, null],
    ["whitespace", ` ${PLAIN.toString("base64url")}`, null],
    ["too few bytes", idOf(PLAIN.subarray(0, 15)), null],
    ["too many bytes", idOf(Buffer.alloc(385, 7)), null],
    ["a number", 1234567890123456, null],
    ["an object", { 0: 1 }, null],
  ];
  for (const [name, credentialId, want] of ids) {
    test(`a credential id given as ${name} ${want === null ? "drops" : "lists as base64url"}`, async () => {
      const [item] = await listAll(listing(itemsJson(passkeyEntry("strId0001", [rawPasskey({ credential_id: credentialId })]))));
      assert.deepEqual(item.passkeys?.map((passkey) => passkey.credentialId), want === null ? undefined : [want]);
    });
  }

  for (const [name, rpId] of [
    ["a Kelvin sign that lowercases to k", "Kexample.com"],
    ["a trailing dot", "example.com."],
    ["a label over 63 characters", `${"a".repeat(64)}.com`],
    ["a hyphen at a label edge", "-example.com"],
    ["a port", "example.com:443"],
    ["a non-string", 7],
  ]) {
    test(`an rpId with ${name} drops`, async () => {
      const [item] = await listAll(listing(itemsJson(passkeyEntry("rpBad0001", [rawPasskey({ rp_id: rpId })]))));
      assert.equal(item.passkeys, undefined);
    });
  }

  test("names lose control and direction characters and are clipped, and a login keeps at most the host's passkey count", async () => {
    const many = Array.from({ length: 40 }, (_, index) => rawPasskey({ user_name: `sam\u0007‮${index}`, user_display_name: `${"D".repeat(400)}\u0000` }));
    const [item] = await listAll(listing(itemsJson(passkeyEntry("names0001", many))));
    assert.equal(item.passkeys.length, subject.CREDENTIAL_LIMITS.passkeysPerItem);
    assert.equal(item.passkeys[3].userName, "sam3");
    assert.equal(item.passkeys[3].displayName, "D".repeat(subject.CREDENTIAL_LIMITS.passkeyNameLength));
  });

  test("no private key bytes reach the listing under any field, wherever pass-cli puts the blob", async () => {
    const blob = [...randomBytes(4096)];
    const blobText = Buffer.from(blob).toString("base64");
    const passkeys = [
      rawPasskey({ content: blob }),
      rawPasskey({ content: blobText, key: blob, private_key: blobText, extensions: { content: blob, prf: { content: blob } }, creation_data: { content: blob, os_name: blobText } }),
      rawPasskey({ content: { c: blob, v: 1 }, keyValue: Buffer.from(blob).toString("base64url") }),
    ];
    const odd = passkeyEntry("blob00001", passkeys, { content: blob, private_key: blobText });
    odd.content.extra_fields = [{ name: "key", content: { Hidden: { content: blobText } } }];
    odd.passkey_content = blob;
    const items = await listAll(listing(JSON.stringify({ items: [odd, ...FIXTURE_ITEMS] })));
    const listed = items.find((item) => item.id === "sharePk0001/blob00001");
    assert.equal(listed.passkeys.length, 3);
    for (const item of items) for (const passkey of item.passkeys ?? []) assert.deepEqual(Object.keys(passkey).sort(), PASSKEY_FIELDS);
    const output = JSON.stringify(items);
    const blobs = [blob, ...FIXTURE_ITEMS.flatMap((item) => item.content.content.Login.passkeys.map((raw) => raw.content))];
    for (const bytes of blobs) {
      const buffer = Buffer.from(bytes);
      const middle = buffer.subarray(8, 40);
      for (const form of [middle.toString("base64url"), middle.toString("base64").slice(0, 40), middle.toString("hex"), [...middle].join(","), [...middle].join(", ")]) {
        assert.equal(output.includes(form), false, `blob bytes leaked as ${form}`);
      }
    }
  });
});

describe("passkeys in a very large vault", () => {
  function vault(size, everyNth) {
    const items = [];
    for (let index = 0; index < size; index++) {
      const id = `big${String(index).padStart(7, "0")}`;
      const login = passkeyEntry(id, index % everyNth === 0 ? [rawPasskey({ credential_id: [...randomBytes(16)] })] : []);
      items.push(login);
    }
    return itemsJson(...items);
  }

  async function timed(stdout) {
    const h = listing(stdout);
    const started = performance.now();
    const items = await listAll(h);
    return { items, ms: performance.now() - started };
  }

  test("50,000 logins with about 3,000 passkeys list in linear time", async () => {
    const small = vault(5_000, 17);
    const large = vault(50_000, 17);
    await timed(small);
    const few = await timed(small);
    const many = await timed(large);
    assert.equal(many.items.length, 50_000);
    assert.equal(many.items.reduce((total, item) => total + (item.passkeys?.length ?? 0), 0), Math.ceil(50_000 / 17));
    assert.ok(many.ms < 20_000, `listing took ${Math.round(many.ms)} ms`);
    assert.ok(many.ms / few.ms < 30, `10x the logins took ${(many.ms / few.ms).toFixed(1)}x as long`);
  });
});
