import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./load.mjs";

const { totp } = await load("index");

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32(text) {
  let bits = "";
  for (const byte of Buffer.from(text, "ascii")) bits += byte.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i < bits.length; i += 5) out += BASE32[Number.parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  return out;
}

const SEEDS = {
  SHA1: "12345678901234567890",
  SHA256: "12345678901234567890123456789012",
  SHA512: "1234567890123456789012345678901234567890123456789012345678901234",
};

const VECTORS = [
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1111111111, "14050471", "67062674", "99943326"],
  [1234567890, "89005924", "91819424", "93441116"],
  [2000000000, "69279037", "90698825", "38618901"],
  [20000000000, "65353130", "77737706", "47863826"],
];

test("codes match RFC 6238's test vectors for SHA-1, SHA-256 and SHA-512", () => {
  for (const [seconds, ...codes] of VECTORS) {
    ["SHA1", "SHA256", "SHA512"].forEach((algorithm, i) => {
      const secret = totp.parse(`otpauth://totp/Test?secret=${base32(SEEDS[algorithm])}&digits=8&algorithm=${algorithm}`);
      assert.ok(secret, algorithm);
      assert.equal(totp.code(secret, seconds * 1000), codes[i], `${algorithm} at ${seconds}`);
    });
  }
});

test("bare secrets, periods, Steam codes and bad input", () => {
  const plain = totp.parse(base32(SEEDS.SHA1));
  assert.deepEqual([plain.period, plain.digits, plain.algorithm], [30, 6, "SHA1"]);
  assert.equal(totp.code(plain, 59000), "287082");
  assert.equal(totp.period("otpauth://totp/x?secret=GEZDGNBV&period=60"), 60);
  assert.match(totp.code(totp.parse(`steam://${base32(SEEDS.SHA1)}`), 59000), /^[2-9B-Y]{5}$/);
  assert.equal(totp.parse("otpauth://hotp/x?secret=GEZDGNBV"), null);
  assert.equal(totp.parse("otpauth://totp/x?secret=GEZDGNBV&digits=4"), null);
  assert.equal(totp.parse("https://example.com"), null);
  assert.ok(totp.same(`otpauth://totp/a?secret=${base32(SEEDS.SHA1)}`, base32(SEEDS.SHA1).toLowerCase()));
});
