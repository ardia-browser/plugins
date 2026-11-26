#!/usr/bin/env node
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PLATFORMS, SEMVER, findByTag, isMain, releaseInfo } from "./lib.mjs";

export const OFFICIAL_ARTIFACT_DOMAIN = "ardia-official-native-v1\n";
export const SIG_SUFFIX = ".official-sig";
const OFFICIAL_SCOPE = "@ardia/";
const ID = /^@[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9-]{0,39}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SIG = /^[A-Za-z0-9_-]{86}$/;
const RAW_KEY = /^[A-Za-z0-9+/_-]{43}=?$/;

const HELP = `usage: node scripts/official-sig.mjs sign <tag> <assets dir>
       node scripts/official-sig.mjs verify <tag> <assets dir> [--allow-private-fallback]

sign co-signs each archive <tag>'s plugin.json release declares, found in <assets dir>, with Ardia's official native
key $ARDIA_OFFICIAL_NATIVE_ED25519_PRIVATE_KEY (an Ed25519 PKCS #8 PEM), and refuses to run without it. The signed
bytes are the UTF-8 of
  "ardia-official-native-v1\\n" + canonicalJson({ v: 1, id, version, platform, sha256 })
(@ardia/plugin-sdk/registry officialArtifactMessage), and <asset>${SIG_SUFFIX} holds the signature as the bare
86-character unpadded base64url string the registry carries as officialSig.
verify checks every <asset>${SIG_SUFFIX} against $ARDIA_OFFICIAL_NATIVE_ED25519_PUBLIC_KEY (an SPKI PEM, or the 32 raw
key bytes in base64 or base64url). Only --allow-private-fallback, for a local check, lets it take the public half of
$ARDIA_OFFICIAL_NATIVE_ED25519_PRIVATE_KEY instead.
It uses node:crypto, node:fs and node:path only, so the release job that holds the key installs no packages.
`;

function encodeString(text) {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      throw new TypeError("canonicalJson can't encode a lone surrogate");
    }
    if (code >= 0xdc00 && code <= 0xdfff) throw new TypeError("canonicalJson can't encode a lone surrogate");
  }
  return JSON.stringify(text);
}

export function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonicalJson can't encode a non-finite number");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value === "string") return encodeString(value);
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${encodeString(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new TypeError(`canonicalJson can't encode a ${typeof value}`);
}

export function claimProblem(claim) {
  if (typeof claim?.id !== "string" || !ID.test(claim.id)) return "id must be a scoped plugin id like @ardia/cli";
  if (!claim.id.startsWith(OFFICIAL_SCOPE)) return "only @ardia/* plugins carry an official signature";
  if (typeof claim.version !== "string" || !SEMVER.test(claim.version)) return "version must be a semver version";
  if (!PLATFORMS.includes(claim.platform)) return "platform isn't one Ardia builds for";
  if (typeof claim.sha256 !== "string" || !SHA256.test(claim.sha256)) return "sha256 must be 64 lowercase hex digits";
  return null;
}

export function officialArtifactMessage(claim) {
  const problem = claimProblem(claim);
  if (problem) throw new Error(problem);
  return Buffer.from(OFFICIAL_ARTIFACT_DOMAIN + canonicalJson({ v: 1, id: claim.id, version: claim.version, platform: claim.platform, sha256: claim.sha256 }), "utf8");
}

function privateKeyOf(pem) {
  if (typeof pem !== "string" || !pem.includes("-----BEGIN PRIVATE KEY-----")) throw new Error("The private key must be an Ed25519 PKCS #8 PEM (-----BEGIN PRIVATE KEY-----).");
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("The private key isn't an Ed25519 key.");
  return key;
}

export function publicKeyOf(text) {
  const trimmed = String(text ?? "").trim();
  let key;
  if (trimmed.includes("-----BEGIN PUBLIC KEY-----")) key = createPublicKey(trimmed);
  else if (RAW_KEY.test(trimmed)) {
    const raw = Buffer.from(trimmed.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (raw.length !== 32) throw new Error("A raw Ed25519 public key is 32 bytes.");
    key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
  } else throw new Error("The public key must be an SPKI PEM (-----BEGIN PUBLIC KEY-----) or 32 raw bytes in base64.");
  if (key.asymmetricKeyType !== "ed25519") throw new Error("The public key isn't an Ed25519 key.");
  return key;
}

export function signOfficial(claim, privateKeyPem) {
  return sign(null, officialArtifactMessage(claim), privateKeyOf(privateKeyPem)).toString("base64url");
}

export function verifyOfficial(claim, sig, publicKey) {
  const problem = claimProblem(claim);
  if (problem) return { ok: false, reason: problem };
  if (typeof sig !== "string" || !SIG.test(sig)) return { ok: false, reason: "The official signature isn't 64 bytes of unpadded base64url" };
  try {
    const key = typeof publicKey === "string" ? publicKeyOf(publicKey) : publicKey;
    return verify(null, officialArtifactMessage(claim), key, Buffer.from(sig, "base64url")) ? { ok: true } : { ok: false, reason: "The signature doesn't match" };
  } catch (error) {
    return { ok: false, reason: `The official signature couldn't be checked: ${error.message}` };
  }
}

export function assetClaim(info, asset, file) {
  const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
  const listed = `${file}.sha256`;
  if (existsSync(listed)) {
    const recorded = readFileSync(listed, "utf8").trim().split(/\s+/)[0];
    if (recorded !== sha256) throw new Error(`${asset.name} is ${sha256}, and its .sha256 says ${recorded}`);
  }
  return { id: info.id, version: info.version, platform: asset.platform, sha256 };
}

export function signAssets(info, dir, privateKeyPem) {
  if (!privateKeyPem) {
    throw new Error(`${info.id} is a native plugin, and ARDIA_OFFICIAL_NATIVE_ED25519_PRIVATE_KEY isn't set to its Ed25519 PKCS #8 PEM: refusing to release it without the official co-signature`);
  }
  const signed = [];
  for (const asset of info.assets) {
    const file = join(dir, asset.name);
    if (!existsSync(file)) throw new Error(`${dir} has no ${asset.name}`);
    const claim = assetClaim(info, asset, file);
    const sig = signOfficial(claim, privateKeyPem);
    writeFileSync(`${file}${SIG_SUFFIX}`, `${sig}\n`);
    signed.push({ asset: asset.name, claim, sig });
  }
  return signed;
}

export function verifyAssets(info, dir, publicKey) {
  const key = publicKeyOf(publicKey);
  const problems = [];
  for (const asset of info.assets) {
    const file = join(dir, asset.name);
    const sigFile = `${file}${SIG_SUFFIX}`;
    if (!existsSync(file) || !existsSync(sigFile)) {
      problems.push(`${asset.name}: ${existsSync(file) ? `no ${asset.name}${SIG_SUFFIX}` : "missing"}`);
      continue;
    }
    try {
      const result = verifyOfficial(assetClaim(info, asset, file), readFileSync(sigFile, "utf8").trim(), key);
      if (!result.ok) problems.push(`${asset.name}: ${result.reason}`);
    } catch (error) {
      problems.push(`${asset.name}: ${error.message}`);
    }
  }
  return problems;
}

export function verifyKeyFrom(env, allowPrivateFallback) {
  if (env.ARDIA_OFFICIAL_NATIVE_ED25519_PUBLIC_KEY) return env.ARDIA_OFFICIAL_NATIVE_ED25519_PUBLIC_KEY;
  if (allowPrivateFallback && env.ARDIA_OFFICIAL_NATIVE_ED25519_PRIVATE_KEY) {
    return createPublicKey(privateKeyOf(env.ARDIA_OFFICIAL_NATIVE_ED25519_PRIVATE_KEY)).export({ type: "spki", format: "pem" }).toString();
  }
  throw new Error("set ARDIA_OFFICIAL_NATIVE_ED25519_PUBLIC_KEY to verify: the signatures are checked against the published key, never the signing key");
}

export function main(argv, env = process.env) {
  const allowPrivateFallback = argv.includes("--allow-private-fallback");
  const args = argv.filter((arg) => arg !== "--allow-private-fallback");
  const [command, tag, dir] = args;
  if (!command || command === "-h" || command === "--help") {
    process.stdout.write(HELP);
    return command ? 0 : 64;
  }
  if (!["sign", "verify"].includes(command) || !tag || !dir || args.length !== 3 || (allowPrivateFallback && command !== "verify")) {
    process.stderr.write(HELP);
    return 64;
  }
  try {
    const info = releaseInfo(findByTag(tag));
    if (command === "sign") {
      for (const entry of signAssets(info, resolve(dir), env.ARDIA_OFFICIAL_NATIVE_ED25519_PRIVATE_KEY)) {
        process.stdout.write(`signed ${entry.asset} (${entry.claim.platform}): ${entry.claim.sha256}\n`);
      }
      return 0;
    }
    const problems = verifyAssets(info, resolve(dir), verifyKeyFrom(env, allowPrivateFallback));
    if (problems.length) throw new Error(`official signatures don't verify:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.stdout.write(`every ${SIG_SUFFIX} for ${info.tag} verifies\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`official-sig: ${error.message}\n`);
    return 1;
  }
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
