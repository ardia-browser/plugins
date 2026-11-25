#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, envelopeMessage, signEnvelope, verifyEnvelope } from "@ardia/plugin-sdk/registry";
import { findByTag, releaseInfo } from "./lib.mjs";

export const PAYLOAD_TYPE = "ardia.official-native";
export const DEFAULT_KID = "ardia-official-native-1";
export const SIG_SUFFIX = ".official-sig";
const SIG_PATTERN = /^[A-Za-z0-9_-]{86}$/;

const HELP = `usage: node scripts/official-sig.mjs sign <tag> <assets dir>
       node scripts/official-sig.mjs verify <tag> <assets dir>

sign co-signs each archive <tag>'s plugin.json release declares, found in <assets dir>, with Ardia's official native
key: $ARDIA_OFFICIAL_NATIVE_ED25519_PRIVATE_KEY, an Ed25519 PKCS #8 PEM, under the key id
$ARDIA_OFFICIAL_NATIVE_KEY_ID (default ${DEFAULT_KID}). It refuses to run without the key. Each signature is the
ardia-registry-v1 envelope signature (@ardia/plugin-sdk/registry signEnvelope: Ed25519 over "ardia-registry-v1\\n" and
the canonical JSON of { v: 1, kid, payload }) of the payload
  { type: "${PAYLOAD_TYPE}", id, version, platform, asset, sha256, sizeBytes }
and <asset>${SIG_SUFFIX} holds it as the bare 86-character base64url string the registry carries as officialSig.
verify checks every <asset>${SIG_SUFFIX} against $ARDIA_OFFICIAL_NATIVE_ED25519_PUBLIC_KEY (an SPKI PEM or 32 raw bytes
of base64), or the public half of the private key when only that is set.
`;

export function assetPayload(info, asset, file) {
  const data = readFileSync(file);
  return {
    type: PAYLOAD_TYPE,
    id: info.id,
    version: info.version,
    platform: asset.platform,
    asset: asset.name,
    sha256: createHash("sha256").update(data).digest("hex"),
    sizeBytes: data.length,
  };
}

export function signedMessage(kid, payload) {
  return Buffer.from(envelopeMessage(kid, payload)).toString("utf8");
}

export async function signAssets(info, dir, privateKeyPem, kid = DEFAULT_KID) {
  if (!privateKeyPem || !privateKeyPem.includes("PRIVATE KEY")) {
    throw new Error(`${info.id} is a native plugin, and ARDIA_OFFICIAL_NATIVE_ED25519_PRIVATE_KEY isn't set to its Ed25519 PKCS #8 PEM: refusing to release it without the official co-signature`);
  }
  const signed = [];
  for (const asset of info.assets) {
    const file = join(dir, asset.name);
    if (!existsSync(file)) throw new Error(`${dir} has no ${asset.name}`);
    const payload = assetPayload(info, asset, file);
    const envelope = await signEnvelope(payload, kid, privateKeyPem);
    if (!SIG_PATTERN.test(envelope.sig)) throw new Error(`the signature for ${asset.name} isn't 86 characters of base64url`);
    writeFileSync(`${file}${SIG_SUFFIX}`, `${envelope.sig}\n`);
    signed.push({ asset: asset.name, platform: asset.platform, kid, sig: envelope.sig, payload, message: canonicalJson({ v: 1, kid, payload }) });
  }
  return signed;
}

export async function verifyAssets(info, dir, publicKey, kid = DEFAULT_KID) {
  const problems = [];
  for (const asset of info.assets) {
    const file = join(dir, asset.name);
    const sigFile = `${file}${SIG_SUFFIX}`;
    if (!existsSync(file) || !existsSync(sigFile)) {
      problems.push(`${asset.name}: ${existsSync(file) ? `no ${basename(sigFile)}` : "missing"}`);
      continue;
    }
    const sig = readFileSync(sigFile, "utf8").trim();
    const result = await verifyEnvelope({ v: 1, kid, sig, payload: assetPayload(info, asset, file) }, { [kid]: publicKey });
    if (!result.ok) problems.push(`${asset.name}: ${result.reason}`);
  }
  return problems;
}

async function publicKeyFromEnv(env) {
  if (env.ARDIA_OFFICIAL_NATIVE_ED25519_PUBLIC_KEY) return env.ARDIA_OFFICIAL_NATIVE_ED25519_PUBLIC_KEY;
  if (!env.ARDIA_OFFICIAL_NATIVE_ED25519_PRIVATE_KEY) return null;
  const { createPrivateKey, createPublicKey } = await import("node:crypto");
  return createPublicKey(createPrivateKey(env.ARDIA_OFFICIAL_NATIVE_ED25519_PRIVATE_KEY)).export({ type: "spki", format: "pem" }).toString();
}

async function main(argv, env = process.env) {
  const [command, tag, dir] = argv;
  if (!command || command === "-h" || command === "--help") {
    process.stdout.write(HELP);
    return command ? 0 : 64;
  }
  if (!["sign", "verify"].includes(command) || !tag || !dir || argv.length !== 3) {
    process.stderr.write(HELP);
    return 64;
  }
  const kid = env.ARDIA_OFFICIAL_NATIVE_KEY_ID || DEFAULT_KID;
  try {
    const info = releaseInfo(findByTag(tag));
    if (command === "sign") {
      for (const entry of await signAssets(info, resolve(dir), env.ARDIA_OFFICIAL_NATIVE_ED25519_PRIVATE_KEY, kid)) {
        process.stdout.write(`signed ${entry.asset} (${entry.platform}) with ${entry.kid}: ${entry.payload.sha256}\n`);
      }
      return 0;
    }
    const key = await publicKeyFromEnv(env);
    if (!key) throw new Error("set ARDIA_OFFICIAL_NATIVE_ED25519_PUBLIC_KEY (or the private key) to verify");
    const problems = await verifyAssets(info, resolve(dir), key, kid);
    if (problems.length) throw new Error(`official signatures don't verify:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.stdout.write(`every ${SIG_SUFFIX} for ${info.tag} verifies under ${kid}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`official-sig: ${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
