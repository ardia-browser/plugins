import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { SESSION_KEY, UNLOCKED, harness, manifest, sdk } from "./support.mjs";

const ascii = (text) => Uint8Array.from(Buffer.from(text, "ascii"));

describe("one-time codes", () => {
  test("match the RFC 6238 vectors for SHA-1, SHA-256 and SHA-512", () => {
    const keys = { SHA1: "12345678901234567890", SHA256: "12345678901234567890123456789012", SHA512: "1234567890123456789012345678901234567890123456789012345678901234" };
    const vectors = [
      [59, { SHA1: "94287082", SHA256: "46119246", SHA512: "90693936" }],
      [1111111109, { SHA1: "07081804", SHA256: "68084774", SHA512: "25091201" }],
      [20000000000, { SHA1: "65353130", SHA256: "77737706", SHA512: "47863826" }],
    ];
    for (const [seconds, codes] of vectors) {
      for (const [algorithm, code] of Object.entries(codes)) {
        assert.equal(sdk.totp.code({ secret: ascii(keys[algorithm]), period: 30, digits: 8, algorithm }, seconds * 1000), code, `${algorithm} at ${seconds}`);
      }
    }
  });

  test("parse otpauth, Steam and bare secrets the way Ardia's Swift parser did", () => {
    assert.deepEqual(sdk.totp.parse("otpauth://totp/x?secret=GEZDGNBV&digits=8&period=60&algorithm=SHA256"), { secret: Uint8Array.from([0x31, 0x32, 0x33, 0x34, 0x35]), period: 60, digits: 8, algorithm: "SHA256" });
    assert.equal(sdk.totp.parse("JBSW Y3DP-EHPK3PXP").digits, 6);
    assert.equal(sdk.totp.code(sdk.totp.parse("steam://JBSWY3DPEHPK3PXP"), 0).length, 5);
    for (const refused of ["otpauth://hotp/x?secret=JBSWY3DP", "otpauth://totp/x?secret=JBSWY3DP&period=1", "otpauth://totp/x?secret=JBSWY3DP&digits=9", "https://example.com", "not base32!", ""]) {
      assert.equal(sdk.totp.parse(refused), null, refused);
    }
    assert.equal(sdk.totp.period("otpauth://totp/x?secret=JBSWY3DP&period=45"), 45);
    assert.equal(sdk.totp.period("JBSWY3DP"), undefined);
  });
});

describe("encodings", () => {
  test("base64url and UUIDs round-trip and refuse what isn't theirs", () => {
    const bytes = Uint8Array.from({ length: 33 }, (_, n) => n * 7);
    assert.equal(sdk.base64url.encode(bytes), Buffer.from(bytes).toString("base64url"));
    assert.deepEqual(sdk.base64url.decode(Buffer.from(bytes).toString("base64url")), bytes);
    assert.equal(sdk.base64url.decode("abc="), null);
    assert.equal(sdk.base64url.decode("a"), null);
    assert.equal(sdk.base64url.decode("AAAA", 2), null);
    const uuid = "0b5a7c3e-9d2f-4e6a-8b1c-2d3e4f5a6b7c";
    assert.equal(sdk.uuids.string(sdk.uuids.bytes(uuid.toUpperCase())), uuid);
    assert.equal(sdk.uuids.bytes("0b5a7c3e9d2f4e6a8b1c2d3e4f5a6b7c"), null);
  });
});

describe("credentials protocol", () => {
  test("hello says credentials protocol 1 and ready lists the provider's handlers", async () => {
    const h = harness([["status", { stdout: UNLOCKED }]], { session: { key: SESSION_KEY } });
    await h.call("state", { explicit: false });
    const hello = h.lines.find((line) => line.method === "hello");
    assert.deepEqual(hello.params, { protocol: 2, sdk: "2.1.0", credentials: 1 });
    const ready = h.lines.find((line) => line.method === "ready");
    assert.deepEqual(ready.params.credentialProvider.handlers, sdk.credentialHandlersOf(sdk.bitwarden));
    assert.deepEqual(
      h.lines.filter((line) => typeof line.method === "string").map((line) => line.method),
      ["hello", "ready", "credentials.verb", "result"],
    );
  });

  test("an Ardia that speaks another credentials protocol gets no calls answered", async () => {
    const h = sdk.createCredentialHarness({ provider: sdk.bitwarden, manifest, cli: () => ({}), helloCredentials: 3 });
    assert.deepEqual(await h.call("state", { explicit: false }), { ok: false, error: { code: "stopped" } });
    assert.ok(!h.lines.some((line) => line.method === "ready"));
  });

  test("a handler that throws something unexpected answers as a failure with its message", async () => {
    const provider = { ...sdk.bitwarden, state: () => { throw new Error("boom\nsecond line"); } };
    const h = sdk.createCredentialHarness({ provider, manifest, cli: () => ({}) });
    assert.deepEqual(await h.call("state", { explicit: false }), { ok: false, error: { code: "failed", problem: "failed", detail: "boom" } });
  });

  test("a result that carries a handle anywhere but a sign-in's session is refused", async () => {
    const provider = { ...sdk.bitwarden, state: (_input, ctx) => ({ state: "unlocked", detail: ctx.session.current.key }) };
    const h = sdk.createCredentialHarness({ provider, manifest, cli: () => ({}), context: { session: { key: SESSION_KEY } } });
    assert.deepEqual(await h.call("state", { explicit: false }), { ok: false, error: { code: "invalid" } });
  });

  test("pages stay under the page size even when one item is large", () => {
    const items = Array.from({ length: 30 }, (_, n) => ({ id: String(n), title: "t".repeat(n === 3 ? 500_000 : 40_000), username: "", urls: [] }));
    const pages = sdk.pageItems(items);
    assert.equal(pages.flat().length, 30);
    for (const page of pages) assert.ok(page.length === 1 || Buffer.byteLength(JSON.stringify(page)) <= sdk.CREDENTIAL_LIMITS.pageBytes);
  });
});

describe("the built bundle", () => {
  test("dist/main.js speaks the protocol inside a bare JavaScript context", async () => {
    const sent = [];
    let deliver = () => {};
    const waiting = [];
    const next = (predicate) =>
      new Promise((resolve, reject) => {
        const found = sent.find(predicate);
        if (found) return resolve(found);
        const timer = setTimeout(() => reject(new Error(`no line matched; sent ${JSON.stringify(sent)}`)), 3000);
        waiting.push({ predicate, resolve: (line) => (clearTimeout(timer), resolve(line)) });
      });
    const bridge = {
      send(line) {
        const message = JSON.parse(line);
        sent.push(message);
        for (const waiter of waiting.splice(0)) if (waiter.predicate(message)) waiter.resolve(message);
        else waiting.push(waiter);
      },
      onLine: (listener) => (deliver = listener),
    };
    const code = readFileSync(fileURLToPath(new URL("../dist/main.js", import.meta.url)), "utf8");
    vm.runInContext(code, vm.createContext({ __ardiaBridge: bridge }), { filename: "main.js" });
    const hello = await next((line) => line.method === "hello");
    deliver(JSON.stringify({ id: hello.id, result: { app: "Ardia", protocol: 2, plugin: "bitwarden", credentials: { protocol: 1, supported: [1], provider: "bitwarden" } } }));
    const ready = await next((line) => line.method === "ready");
    assert.deepEqual(ready.params.credentialProvider.handlers, sdk.credentialHandlersOf(sdk.bitwarden));
    deliver(JSON.stringify({ id: ready.id, result: { ok: true } }));
    deliver(JSON.stringify({ call: "v1", kind: "credentials", name: "state", input: { explicit: true }, deadline: 45000, context: { epoch: "e1", session: { key: { $secret: "h1" } }, cli: { name: "bw" } } }));
    const verb = await next((line) => line.method === "credentials.verb");
    assert.deepEqual(verb.params, { call: "v1", verb: "status", params: { session: { $secret: "h1" } } });
    deliver(JSON.stringify({ id: verb.id, result: { verb: "status", status: 0, launched: true, succeeded: true, stderr: "", hints: [], json: JSON.parse(UNLOCKED), lines: [], items: 0 } }));
    const result = await next((line) => line.method === "result");
    assert.deepEqual(result.params, { call: "v1", result: { state: "unlocked", server: { preset: "us" }, account: "me@example.com" } });
  });
});
