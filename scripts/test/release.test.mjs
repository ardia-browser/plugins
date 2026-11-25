import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateManifestV3 } from "@ardia/plugin-sdk/manifest";
import { expandAsset, findByTag, isNative, listPlugins, releaseAssets, releaseInfo } from "../lib.mjs";
import { DEFAULT_KID, SIG_SUFFIX, signAssets, verifyAssets } from "../official-sig.mjs";

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
    assets: [
      { platform: "macos-arm64", name: "cli-0.8.0-macos-arm64.tar.gz" },
      { platform: "linux-x64", name: "cli-0.8.0-linux-x64.tar.gz" },
    ],
  };
  const keys = () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    return { privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicPem: publicKey.export({ type: "spki", format: "pem" }).toString() };
  };
  const assets = () => {
    const dir = mkdtempSync(join(tmpdir(), "official-sig-"));
    for (const asset of info.assets) writeFileSync(join(dir, asset.name), `archive for ${asset.platform}`);
    return dir;
  };

  test("sign writes a bare 86-character signature per archive, and verify accepts it", async () => {
    const { privatePem, publicPem } = keys();
    const dir = assets();
    try {
      const signed = await signAssets(info, dir, privatePem);
      assert.equal(signed.length, 2);
      for (const entry of signed) {
        const sig = readFileSync(join(dir, `${entry.asset}${SIG_SUFFIX}`), "utf8").trim();
        assert.match(sig, /^[A-Za-z0-9_-]{86}$/);
        assert.equal(entry.kid, DEFAULT_KID);
        assert.equal(entry.payload.type, "ardia.official-native");
        assert.equal(entry.payload.id, "@ardia/cli");
        assert.match(entry.payload.sha256, /^[0-9a-f]{64}$/);
      }
      assert.deepEqual(await verifyAssets(info, dir, publicPem), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a changed archive, another key or another key id doesn't verify", async () => {
    const { privatePem, publicPem } = keys();
    const dir = assets();
    try {
      await signAssets(info, dir, privatePem);
      assert.equal((await verifyAssets(info, dir, keys().publicPem)).length, 2);
      assert.equal((await verifyAssets(info, dir, publicPem, "another-kid")).length, 2);
      writeFileSync(join(dir, info.assets[0].name), "swapped");
      const problems = await verifyAssets(info, dir, publicPem);
      assert.equal(problems.length, 1);
      assert.match(problems[0], /cli-0\.8\.0-macos-arm64\.tar\.gz/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("signing fails closed without the key, and when an archive is missing", async () => {
    const dir = assets();
    try {
      await assert.rejects(signAssets(info, dir, undefined), /refusing to release it without the official co-signature/);
      await assert.rejects(signAssets(info, dir, ""), /ARDIA_OFFICIAL_NATIVE_ED25519_PRIVATE_KEY/);
      rmSync(join(dir, info.assets[1].name));
      await assert.rejects(signAssets(info, dir, keys().privatePem), /has no cli-0\.8\.0-linux-x64\.tar\.gz/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
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
