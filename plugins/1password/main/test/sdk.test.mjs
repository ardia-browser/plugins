import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { sdk } from "./support.mjs";
import { referenceCode } from "./support-totp.mjs";

const RFC_KEYS = {
  SHA1: Buffer.from("12345678901234567890"),
  SHA256: Buffer.from("12345678901234567890123456789012"),
  SHA512: Buffer.from("1234567890123456789012345678901234567890123456789012345678901234"),
};
const RFC_CODES = [
  [59, { SHA1: "94287082", SHA256: "46119246", SHA512: "90693936" }],
  [1111111109, { SHA1: "07081804", SHA256: "68084774", SHA512: "25091201" }],
  [20000000000, { SHA1: "65353130", SHA256: "77737706", SHA512: "47863826" }],
];

describe("the vendored SDK's one-time codes", () => {
  test("match RFC 6238 for SHA-1, SHA-256 and SHA-512", () => {
    for (const [seconds, codes] of RFC_CODES) {
      for (const [algorithm, code] of Object.entries(codes)) {
        assert.equal(sdk.totp.code({ secret: new Uint8Array(RFC_KEYS[algorithm]), period: 30, digits: 8, algorithm }, seconds * 1000), code, `${algorithm} at ${seconds}`);
      }
    }
  });

  test("HMAC agrees with node's for keys longer than a block", () => {
    for (const [algorithm, name] of [["SHA1", "sha1"], ["SHA256", "sha256"], ["SHA512", "sha512"]]) {
      const key = randomBytes(200);
      const message = randomBytes(77);
      assert.deepEqual(Buffer.from(sdk.hmac(algorithm, new Uint8Array(key), new Uint8Array(message))), createHmac(name, key).update(message).digest(), algorithm);
    }
  });

  test("an otpauth address parses its secret, period, digits and algorithm", () => {
    const parsed = sdk.totp.parse("otpauth://totp/Ex:me?secret=jbsw%20y3dp-ehpk3pxp&period=60&digits=8&algorithm=SHA256&issuer=Ex");
    assert.deepEqual({ ...parsed, secret: Buffer.from(parsed.secret).toString("hex") }, { secret: "48656c6c6f21deadbeef", period: 60, digits: 8, algorithm: "SHA256" });
    assert.equal(sdk.totp.code(parsed, 1_763_800_000_000), referenceCode(Buffer.from(parsed.secret), 1_763_800_000_000, { period: 60, digits: 8, algorithm: "sha256" }));
  });

  test("addresses it can't use are refused", () => {
    for (const uri of ["otpauth://hotp/Ex?secret=JBSWY3DPEHPK3PXP", "otpauth://totp/Ex?secret=not!base32", "otpauth://totp/Ex?secret=JBSWY3DPEHPK3PXP&period=1", "https://example.com/?secret=JBSWY3DPEHPK3PXP", ""]) {
      assert.equal(sdk.totp.parse(uri), null, uri);
    }
  });

  test("a Steam address reads as a five-character Steam code", () => {
    const parsed = sdk.totp.parse("otpauth://totp/Ex?secret=JBSWY3DPEHPK3PXP&digits=5&issuer=Steam");
    assert.deepEqual({ steam: parsed?.steam, digits: parsed?.digits }, { steam: true, digits: 5 });
  });

  test("the same secret in two spellings is the same code", () => {
    assert.ok(sdk.totp.same("otpauth://totp/A?secret=JBSWY3DPEHPK3PXP&issuer=A", "otpauth://totp/B?issuer=B&secret=jbswy3dpehpk3pxp"));
    assert.ok(sdk.totp.same("JBSWY3DPEHPK3PXP", "otpauth://totp/B?secret=JBSWY3DPEHPK3PXP"));
    assert.equal(sdk.totp.same("otpauth://totp/A?secret=JBSWY3DPEHPK3PXP", "otpauth://totp/A?secret=JBSWY3DPEHPK3PXP&period=60"), false);
  });
});

describe("the vendored SDK's paging", () => {
  test("keeps every page under the page budget and every item in order", () => {
    const items = Array.from({ length: 5000 }, (_, i) => ({ id: `i${i}`, title: "\u{1F510}".repeat(100), username: "u", urls: [] }));
    const pages = sdk.pageItems(items);
    assert.ok(pages.length > 1);
    assert.deepEqual(pages.flat().map((item) => item.id), items.map((item) => item.id));
    for (const page of pages) assert.ok(Buffer.byteLength(JSON.stringify(page)) <= sdk.CREDENTIAL_LIMITS.pageBytes);
  });
});
