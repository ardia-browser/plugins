import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { GUID, OTHER_GUID, argvOf, harness, login, sdk, unlockedContext } from "./support.mjs";

const CREDENTIAL_UUID = "0b5a7c3e-9d2f-4e6a-8b1c-2d3e4f5a6b7c";
const CREDENTIAL_ID = sdk.base64url.encode(sdk.uuids.bytes(CREDENTIAL_UUID));
const KEY = sdk.base64url.encode(Uint8Array.from({ length: 138 }, (_, n) => n));
const USER_HANDLE = sdk.base64url.encode(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]));
const decodedStdin = (launch) => JSON.parse(Buffer.from(launch.stdin, "base64").toString("utf8"));

const fido2 = (overrides = {}) => ({
  credentialId: CREDENTIAL_UUID,
  keyType: "public-key",
  keyAlgorithm: "ECDSA",
  keyCurve: "P-256",
  keyValue: KEY,
  rpId: "Example.com",
  rpName: "Example",
  userHandle: USER_HANDLE,
  userName: "me@example.com",
  userDisplayName: "Me",
  counter: "0",
  discoverable: "true",
  creationDate: "2026-01-02T03:04:05.000Z",
  ...overrides,
});
const withPasskeys = (passkeys, overrides = {}) => login(overrides, { fido2Credentials: passkeys });
const metadata = { credentialId: CREDENTIAL_ID, rpId: "example.com", userName: "me@example.com", displayName: "Me", discoverable: true, counter: 0 };

const newPasskey = {
  credentialId: CREDENTIAL_ID,
  credentialUuid: CREDENTIAL_UUID.toUpperCase(),
  privateKey: { format: "pkcs8", der: KEY },
  publicKey: "BPublicKey",
  rpId: "example.com",
  rpName: "",
  userHandle: USER_HANDLE,
  userName: "me@example.com",
  displayName: "Me",
  createdAt: Date.parse("2026-03-04T05:06:07.089Z"),
};

describe("listing passkeys", () => {
  test("gives metadata only, for the relying party asked about", async () => {
    const entries = [withPasskeys([fido2()]), withPasskeys([fido2({ rpId: "other.org", credentialId: "b64.AQID" })], { id: OTHER_GUID })];
    const h = harness([["list items", { stdout: JSON.stringify(entries) }]], unlockedContext());
    const answer = await h.call("passkeys.list", { rpId: "example.com" });
    assert.deepEqual(answer.result, [{ ...metadata, item: GUID }]);
    assert.ok(!JSON.stringify(answer.result).includes(KEY));
    const all = await h.call("passkeys.list", { rpId: null });
    assert.deepEqual(
      all.result.map((passkey) => [passkey.item, passkey.credentialId]),
      [
        [GUID, CREDENTIAL_ID],
        [OTHER_GUID, "AQID"],
      ],
    );
  });

  test("the vault listing carries the same metadata and never the private key", async () => {
    const h = harness([["list items", { stdout: JSON.stringify([withPasskeys([fido2(), fido2({ keyCurve: "P-384" }), fido2({ rpId: "999" })])]) }]], unlockedContext());
    const answer = await h.call("list", { snapshot: null, cursor: null });
    assert.deepEqual(answer.result.items[0].passkeys, [metadata]);
    assert.ok(!JSON.stringify(answer.result).includes(KEY));
  });
});

describe("getting a passkey's key", () => {
  const get = (entries, request = {}) =>
    harness([["get item", { stdout: JSON.stringify(entries) }]], unlockedContext()).call("passkeys.get", { item: GUID, credentialId: CREDENTIAL_ID, rpId: "example.com", ...request });

  test("returns the key and user handle of the matching credential", async () => {
    const answer = await get(withPasskeys([fido2({ credentialId: "b64.AQID" }), fido2()]));
    assert.deepEqual(answer.result, { credentialId: CREDENTIAL_ID, rpId: "example.com", privateKey: { format: "pkcs8", der: KEY }, userHandle: USER_HANDLE, counter: 0 });
  });

  test("nothing for a used counter, another site, a broken key or handle, or another credential", async () => {
    for (const passkey of [fido2({ counter: "4" }), fido2({ rpId: "other.org" }), fido2({ keyValue: "not base64!" }), fido2({ userHandle: "" }), fido2({ credentialId: "b64.AQID" })]) {
      assert.equal((await get(withPasskeys([passkey]))).result, null);
    }
  });

  test("an item id that isn't Bitwarden's is not found without running bw", async () => {
    const h = harness([], unlockedContext());
    assert.deepEqual((await h.call("passkeys.get", { item: "x", credentialId: CREDENTIAL_ID, rpId: "example.com" })).error, { code: "notFound" });
    assert.equal(h.launches.length, 0);
  });
});

describe("saving a passkey", () => {
  test("attaches it to the chosen login when that login has none", async () => {
    const h = harness([["get item", { stdout: JSON.stringify(login()) }], ["edit item", { stdout: "{}" }]], unlockedContext());
    const answer = await h.call("passkeys.save", { credential: newPasskey, attachTo: GUID, title: "Example", url: "https://example.com" });
    assert.deepEqual(answer.result, { item: GUID });
    const sent = decodedStdin(h.launches[1]);
    assert.deepEqual(sent.login.fido2Credentials, [
      {
        credentialId: CREDENTIAL_UUID,
        keyType: "public-key",
        keyAlgorithm: "ECDSA",
        keyCurve: "P-256",
        keyValue: KEY,
        rpId: "example.com",
        rpName: "example.com",
        userHandle: USER_HANDLE,
        userName: "me@example.com",
        userDisplayName: "Me",
        counter: "0",
        discoverable: "true",
        creationDate: "2026-03-04T05:06:07.089Z",
      },
    ]);
    assert.equal(sent.login.password, login().login.password);
  });

  test("makes a new login when the chosen one already has a passkey", async () => {
    const h = harness([["get item", { stdout: JSON.stringify(withPasskeys([fido2()])) }], ["create item", { stdout: JSON.stringify({ id: OTHER_GUID }) }]], unlockedContext());
    const answer = await h.call("passkeys.save", { credential: newPasskey, attachTo: GUID, title: "Example", url: "https://example.com" });
    assert.deepEqual(answer.result, { item: OTHER_GUID });
    assert.deepEqual(argvOf(h), [`get item ${GUID} --nointeraction`, "create item --nointeraction"]);
    const created = decodedStdin(h.launches[1]);
    assert.equal(created.name, "Example");
    assert.equal(created.login.password, null);
    assert.equal(created.login.username, "me@example.com");
    assert.deepEqual(created.login.uris, [{ uri: "https://example.com", match: null }]);
  });

  test("a new login bw doesn't name is reported, and a credential Ardia can't store is refused", async () => {
    const unnamed = harness([["create item", { stdout: "{}" }]], unlockedContext());
    assert.deepEqual((await unnamed.call("passkeys.save", { credential: newPasskey, attachTo: null, title: "Example", url: "https://example.com" })).error, {
      code: "failed",
      problem: "savedNotReturned",
    });
    const bad = harness([], unlockedContext());
    for (const credential of [{ ...newPasskey, credentialUuid: "nope" }, { ...newPasskey, userHandle: "" }, { ...newPasskey, privateKey: { format: "raw", der: KEY } }]) {
      assert.deepEqual((await bad.call("passkeys.save", { credential, attachTo: null, title: "Example", url: "https://example.com" })).error, { code: "failed", problem: "cantPrepare" });
    }
    assert.equal(bad.launches.length, 0);
  });
});
