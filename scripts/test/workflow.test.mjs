import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (name) => readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8");

function jobsOf(text) {
  const lines = text.split("\n");
  const start = lines.indexOf("jobs:");
  assert.ok(start >= 0, "the workflow has jobs");
  const jobs = new Map();
  let current = null;
  for (const line of lines.slice(start + 1)) {
    const named = /^  ([a-z0-9-]+):$/.exec(line);
    if (named) {
      current = named[1];
      jobs.set(current, []);
    } else if (current && (line.startsWith("    ") || line === "")) jobs.get(current).push(line);
    else if (line && !line.startsWith(" ")) current = null;
  }
  return new Map([...jobs].map(([name, body]) => [name, body.join("\n")]));
}

const release = read("release-plugin.yml");
const jobs = jobsOf(release);
const SECRET = "secrets.ARDIA_OFFICIAL_NATIVE_ED25519_PRIVATE_KEY";

test("the official signing key reaches the publish job and no other", () => {
  assert.ok(jobs.has("publish"));
  for (const [name, body] of jobs) assert.equal(body.includes(SECRET), name === "publish", name);
  assert.equal(release.split(SECRET).length - 1, 1);
  assert.equal(read("ci.yml").includes("ARDIA_OFFICIAL_NATIVE_ED25519_PRIVATE_KEY"), false);
});

test("the publish job runs only for a real publish from its tag", () => {
  const body = jobs.get("publish");
  const condition = /^    if: (.+)$/m.exec(body)?.[1] ?? "";
  assert.match(condition, /needs\.resolve\.outputs\.publish == 'true'/);
  assert.match(condition, /startsWith\(github\.ref, 'refs\/tags\/'\)/);
  assert.match(body, /\[ "\$REF" = "refs\/tags\/\$TAG" \]/);
  assert.match(body, /ref: refs\/tags\/\$\{\{ needs\.resolve\.outputs\.tag \}\}/);
});

test("the publish job installs no packages and takes no package override", () => {
  const body = jobs.get("publish");
  for (const forbidden of ["pnpm", "npm install", "npm ci", "./.github/actions/setup", "ARDIA_PACKAGES", "ardia_packages", "bun "]) {
    assert.equal(body.includes(forbidden), false, forbidden);
  }
  assert.match(body, /sparse-checkout-cone-mode: false/);
  const sparse = /sparse-checkout: \|\n((?: {12}.+\n)+)/.exec(body)?.[1].trim().split(/\s+/) ?? [];
  assert.deepEqual(sparse, ["/scripts/official-sig.mjs", "/scripts/lib.mjs", "/scripts/notify-registry.mjs", "/plugins/*/plugin.json"]);
  assert.match(body, /node scripts\/official-sig\.mjs sign/);
  assert.match(body, /ARDIA_OFFICIAL_NATIVE_ED25519_PRIVATE_KEY='' node scripts\/official-sig\.mjs verify/);
  assert.match(body, /vars\.ARDIA_OFFICIAL_NATIVE_ED25519_PUBLIC_KEY/);
  assert.doesNotMatch(body, /--allow-private-fallback/);
});

test("package overrides live only on the jobs that build, never at the workflow level", () => {
  const head = release.slice(0, release.indexOf("\njobs:"));
  assert.equal(head.includes("ARDIA_PACKAGES"), false);
  for (const [name, body] of jobs) {
    const overrides = body.includes("ARDIA_PACKAGES") || body.includes("./.github/actions/setup");
    assert.equal(overrides, ["pack", "cli-build", "cli-build-signed-macos"].includes(name), name);
  }
});

test("dry runs rehearse the co-signature with a throwaway key and never upload a signature", () => {
  const body = jobs.get("assemble");
  assert.match(body, /generateKeyPairSync\("ed25519"\)/);
  assert.match(body, /only the publish job signs/);
  assert.doesNotMatch(body, /secrets\./);
});
