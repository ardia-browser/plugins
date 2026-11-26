import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateManifestV3 } from "@ardia/plugin-sdk/manifest";
import { expandAsset, findByTag, isNative, listPlugins, releaseAssets, releaseInfo } from "../lib.mjs";
import * as sdk from "@ardia/plugin-sdk/registry";
import { OFFICIAL_ARTIFACT_DOMAIN, SIG_SUFFIX, canonicalJson, officialArtifactMessage, signAssets, signOfficial, verifyAssets, verifyKeyFrom, verifyOfficial } from "../official-sig.mjs";

const OFFICIAL = ["ai", "cli", "compact-command-bar", "developer-mode", "1password", "bitwarden", "proton-pass"];
const plugins = listPlugins();

describe("every official plugin.json", () => {
  for (const plugin of plugins) {
    test(`${plugin.rel} is a manifest 3 @ardia plugin released from ardia-browser/plugins as ${plugin.name}-v<version>`, () => {
      const checked = validateManifestV3(plugin.manifest);
      assert.equal(checked.ok, true, JSON.stringify(checked.problems ?? []));
      assert.equal(plugin.manifest.manifest, 3);
      assert.equal(plugin.manifest.id, `@ardia/${plugin.name}`);
      assert.ok(OFFICIAL.includes(plugin.name), plugin.name);
      assert.equal(plugin.manifest.release.github, "ardia-browser/plugins");
      assert.equal(plugin.manifest.release.tagPrefix, `${plugin.name}-v`);
      assert.deepEqual(plugin.manifest.engines, { ardia: ">=0.3.0", sdk: "^3.0.0" });
      const info = releaseInfo(plugin);
      assert.equal(findByTag(info.tag, plugins).name, plugin.name);
      for (const asset of info.assets) assert.ok(asset.name.startsWith(`${plugin.name}-${plugin.manifest.version}`), asset.name);
    });
  }
});

test("cli is native, with one archive per platform it builds on", () => {
  const cli = plugins.find((plugin) => plugin.name === "cli");
  const info = releaseInfo(cli);
  assert.equal(info.native, true);
  assert.deepEqual(info.assets, [
    { platform: "macos-arm64", name: `cli-${cli.manifest.version}-macos-arm64.tar.gz` },
    { platform: "linux-x64", name: `cli-${cli.manifest.version}-linux-x64.tar.gz` },
  ]);
  assert.equal(cli.manifest.scope, "global");
});

test("manifest-only plugins are universal and not native", () => {
  for (const name of ["compact-command-bar", "developer-mode"]) {
    const info = releaseInfo(plugins.find((plugin) => plugin.name === name));
    assert.equal(info.native, false);
    assert.deepEqual(info.platforms, ["universal"]);
    assert.equal(info.assets[0].name, `${name}-${info.version}.tar.gz`);
  }
});

test("a tag whose version isn't plugin.json's is refused, and an unknown prefix too", () => {
  const cli = plugins.find((plugin) => plugin.name === "cli");
  assert.throws(() => findByTag("cli-v9.9.9", plugins), /names 9\.9\.9/);
  assert.throws(() => findByTag(`nope-v${cli.manifest.version}`, plugins), /no plugin's release.tagPrefix/);
  assert.throws(() => findByTag("cli-vnot-a-version", plugins), /no plugin's release.tagPrefix/);
});

test("asset templates expand {name}, {version} and {platform}, and prereleases are prereleases", () => {
  assert.equal(expandAsset("{name}-{version}-{platform}.tar.gz", { name: "x", version: "1.0.0-beta.1", platform: "linux-x64" }), "x-1.0.0-beta.1-linux-x64.tar.gz");
  const manifest = { id: "@ardia/x", version: "1.2.0-rc.1", release: { github: "a/b", tagPrefix: "x-v" } };
  assert.deepEqual(releaseAssets(manifest), [{ platform: "universal", name: "x-1.2.0-rc.1.tar.gz" }]);
  assert.equal(releaseInfo({ name: "x", rel: "plugins/x", manifest }).prerelease, true);
});

test("native means a sidecar, programs or full control, as the registry ranks it", () => {
  assert.equal(isNative({ sidecar: { run: ["sidecar/server.mjs"] } }), true);
  assert.equal(isNative({ contributes: { programs: [{ name: "x", path: "bin/x" }] } }), true);
  assert.equal(isNative({ permissions: { control: true } }), true);
  assert.equal(isNative({ permissions: { control: false }, contributes: { programs: [] } }), false);
  assert.equal(isNative({ main: "dist/index.js" }), false);
});

describe("official native co-signatures", () => {
  const info = {
    id: "@ardia/cli",
    version: "0.8.0",
    tag: "cli-v0.8.0",
    assets: [
      { platform: "macos-arm64", name: "cli-0.8.0-macos-arm64.tar.gz" },
      { platform: "linux-x64", name: "cli-0.8.0-linux-x64.tar.gz" },
    ],
  };
  const keys = () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    return { privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(), raw: publicKey.export({ format: "jwk" }).x };
  };
  const assets = () => {
    const dir = mkdtempSync(join(tmpdir(), "official-sig-"));
    for (const asset of info.assets) writeFileSync(join(dir, asset.name), `archive for ${asset.platform}`);
    return dir;
  };
  const claims = [
    { id: "@ardia/cli", version: "0.8.0", platform: "macos-arm64", sha256: "a".repeat(64) },
    { id: "@ardia/1password", version: "1.0.0-beta.2", platform: "universal", sha256: "0123456789abcdef".repeat(4) },
    { id: "@ardia/proton-pass", version: "10.20.30", platform: "windows-x64", sha256: "f".repeat(64) },
  ];

  test("the signed message is byte for byte @ardia/plugin-sdk/registry's officialArtifactMessage", () => {
    assert.equal(OFFICIAL_ARTIFACT_DOMAIN, sdk.OFFICIAL_ARTIFACT_DOMAIN);
    for (const claim of claims) {
      const ours = officialArtifactMessage(claim);
      assert.deepEqual(new Uint8Array(ours), sdk.officialArtifactMessage(claim));
      assert.equal(ours.toString("utf8"), `ardia-official-native-v1\n{"id":"${claim.id}","platform":"${claim.platform}","sha256":"${claim.sha256}","v":1,"version":"${claim.version}"}`);
    }
    for (const value of [{ b: [1, true, null, "é\u2028"], a: { z: 0, y: -0 } }, ["x", { "": 1 }], "\ud83d\ude00"]) assert.equal(canonicalJson(value), sdk.canonicalJson(value));
    assert.throws(() => canonicalJson("\ud83d"), /lone surrogate/);
  });

  test("our signatures verify with the SDK's verifyOfficialArtifact, and the SDK's verify with ours, bit for bit the same", async () => {
    const { privatePem, publicPem, raw } = keys();
    for (const claim of claims) {
      const ours = signOfficial(claim, privatePem);
      const theirs = await sdk.signOfficialArtifact(claim, privatePem);
      assert.equal(ours, theirs);
      assert.match(ours, /^[A-Za-z0-9_-]{86}$/);
      assert.deepEqual(await sdk.verifyOfficialArtifact(claim, ours, { official: publicPem }), { ok: true, kid: "official" });
      assert.deepEqual(verifyOfficial(claim, theirs, publicPem), { ok: true });
      assert.deepEqual(verifyOfficial(claim, theirs, raw), { ok: true });
      assert.equal(verifyOfficial({ ...claim, sha256: "b".repeat(64) }, ours, publicPem).ok, false);
      assert.equal((await sdk.verifyOfficialArtifact({ ...claim, version: "9.9.9" }, ours, { official: publicPem })).ok, false);
    }
  });

  test("only well-formed @ardia claims are signed", () => {
    const { privatePem } = keys();
    for (const [change, reason] of [
      [{ id: "@octo/cli" }, /only @ardia/],
      [{ version: "1.0" }, /semver/],
      [{ platform: "amiga" }, /platform/],
      [{ sha256: "A".repeat(64) }, /sha256/],
    ]) {
      assert.throws(() => signOfficial({ ...claims[0], ...change }, privatePem), reason);
      assert.equal(verifyOfficial({ ...claims[0], ...change }, "A".repeat(86), keys().publicPem).ok, false);
    }
  });

  test("sign writes a bare 86-character signature per archive, and verify accepts it under the published key", () => {
    const { privatePem, publicPem } = keys();
    const dir = assets();
    try {
      const signed = signAssets(info, dir, privatePem);
      assert.equal(signed.length, 2);
      for (const entry of signed) {
        const sig = readFileSync(join(dir, `${entry.asset}${SIG_SUFFIX}`), "utf8");
        assert.match(sig, /^[A-Za-z0-9_-]{86}\n$/);
        assert.deepEqual(Object.keys(entry.claim).sort(), ["id", "platform", "sha256", "version"]);
        assert.equal(entry.claim.id, "@ardia/cli");
      }
      assert.deepEqual(verifyAssets(info, dir, publicPem), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a changed archive, a .sha256 that disagrees or another key doesn't verify", () => {
    const { privatePem, publicPem } = keys();
    const dir = assets();
    try {
      signAssets(info, dir, privatePem);
      assert.equal(verifyAssets(info, dir, keys().publicPem).length, 2);
      writeFileSync(join(dir, info.assets[0].name), "swapped");
      const problems = verifyAssets(info, dir, publicPem);
      assert.equal(problems.length, 1);
      assert.match(problems[0], /cli-0\.8\.0-macos-arm64\.tar\.gz/);
      writeFileSync(join(dir, `${info.assets[1].name}.sha256`), `${"0".repeat(64)}  ${info.assets[1].name}\n`);
      assert.throws(() => signAssets(info, dir, privatePem), /its \.sha256 says/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("signing fails closed without the key, and when an archive is missing", () => {
    const dir = assets();
    try {
      assert.throws(() => signAssets(info, dir, undefined), /refusing to release it without the official co-signature/);
      assert.throws(() => signAssets(info, dir, ""), /ARDIA_OFFICIAL_NATIVE_ED25519_PRIVATE_KEY/);
      assert.throws(() => signAssets(info, dir, "not a pem"), /PKCS #8 PEM/);
      rmSync(join(dir, info.assets[1].name));
      assert.throws(() => signAssets(info, dir, keys().privatePem), /has no cli-0\.8\.0-linux-x64\.tar\.gz/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("verify needs the published public key, and takes the private key's half only with --allow-private-fallback", () => {
    const { privatePem, publicPem } = keys();
    assert.throws(() => verifyKeyFrom({ ARDIA_OFFICIAL_NATIVE_ED25519_PRIVATE_KEY: privatePem }, false), /ARDIA_OFFICIAL_NATIVE_ED25519_PUBLIC_KEY/);
    assert.equal(verifyKeyFrom({ ARDIA_OFFICIAL_NATIVE_ED25519_PUBLIC_KEY: publicPem, ARDIA_OFFICIAL_NATIVE_ED25519_PRIVATE_KEY: keys().privatePem }, true), publicPem);
    assert.equal(verifyKeyFrom({ ARDIA_OFFICIAL_NATIVE_ED25519_PRIVATE_KEY: privatePem }, true).trim(), publicPem.trim());
  });

  test("the command line signs and verifies a real tag, and refuses to verify with only the private key", () => {
    const { privatePem, publicPem } = keys();
    const tag = releaseInfo(findByTag(`cli-v${plugins.find((p) => p.name === "cli").manifest.version}`));
    const dir = mkdtempSync(join(tmpdir(), "official-sig-cli-"));
    try {
      for (const asset of tag.assets) writeFileSync(join(dir, asset.name), asset.name);
      const script = new URL("../official-sig.mjs", import.meta.url).pathname;
      const run = (args, env) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
      assert.equal(run(["sign", tag.tag, dir], {}).status, 1);
      assert.equal(run(["sign", tag.tag, dir], { ARDIA_OFFICIAL_NATIVE_ED25519_PRIVATE_KEY: privatePem }).status, 0);
      const refused = run(["verify", tag.tag, dir], { ARDIA_OFFICIAL_NATIVE_ED25519_PRIVATE_KEY: privatePem });
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /ARDIA_OFFICIAL_NATIVE_ED25519_PUBLIC_KEY/);
      assert.equal(run(["verify", tag.tag, dir], { ARDIA_OFFICIAL_NATIVE_ED25519_PUBLIC_KEY: publicPem }).status, 0);
      assert.equal(run(["verify", tag.tag, dir, "--allow-private-fallback"], { ARDIA_OFFICIAL_NATIVE_ED25519_PRIVATE_KEY: privatePem }).status, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("official-sig.mjs and lib.mjs import only node built-ins, so the signing job installs nothing", () => {
    for (const file of ["../official-sig.mjs", "../lib.mjs"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      const imports = [...source.matchAll(/^import[^"']*["']([^"']+)["']/gm)].map((match) => match[1]);
      assert.ok(imports.length > 0, file);
      for (const name of imports) assert.ok(name.startsWith("node:") || name === "./lib.mjs", `${file} imports ${name}`);
      assert.doesNotMatch(source, /\bimport\s*\(/, file);
    }
  });
});

test("release-info finds a plugin in a checkout with only some plugins", () => {
  const root = mkdtempSync(join(tmpdir(), "release-info-"));
  try {
    mkdirSync(join(root, "plugins", "x"), { recursive: true });
    writeFileSync(join(root, "plugins", "x", "plugin.json"), JSON.stringify({ id: "@ardia/x", version: "1.0.0", release: { github: "a/b", tagPrefix: "x-v", asset: "x-{version}.tar.gz" } }));
    const local = listPlugins(root);
    assert.equal(findByTag("x-v1.0.0", local).name, "x");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
