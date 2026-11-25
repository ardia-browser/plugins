import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { affected } from "../lib.mjs";
import { notify, webhookRequest } from "../notify-registry.mjs";
import { packFolder } from "../pack-folder.mjs";

const scratch = () => mkdtempSync(join(tmpdir(), "plugins-scripts-"));

describe("pack-folder", () => {
  const folder = (root) => {
    const dir = join(root, "cli");
    mkdirSync(join(dir, "bin"), { recursive: true });
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "plugin.json"), "{}\n");
    writeFileSync(join(dir, "dist", "index.js"), "void 0;\n");
    writeFileSync(join(dir, "bin", "ardia"), "#!/bin/sh\n");
    chmodSync(join(dir, "bin", "ardia"), 0o700);
    chmodSync(join(dir, "plugin.json"), 0o600);
    return dir;
  };

  test("packs the same bytes every time, sorted under the root with normalized modes and owners", () => {
    const root = scratch();
    try {
      const dir = folder(root);
      const first = packFolder(dir, join(root, "a.tar.gz"));
      writeFileSync(join(dir, "plugin.json"), "{}\n");
      const second = packFolder(dir, join(root, "b.tar.gz"));
      assert.equal(first.sha256, second.sha256);
      assert.deepEqual(readFileSync(join(root, "a.tar.gz")), readFileSync(join(root, "b.tar.gz")));
      assert.equal(readFileSync(join(root, "a.tar.gz.sha256"), "utf8"), `${first.sha256}  a.tar.gz\n`);
      const listing = spawnSync("tar", ["-tvzf", join(root, "a.tar.gz")], { encoding: "utf8" }).stdout.trim().split("\n");
      const names = spawnSync("tar", ["-tzf", join(root, "a.tar.gz")], { encoding: "utf8" }).stdout.trim().split("\n");
      assert.deepEqual(names, ["cli/", "cli/bin/", "cli/bin/ardia", "cli/dist/", "cli/dist/index.js", "cli/plugin.json"]);
      assert.match(listing.find((line) => line.endsWith("cli/bin/ardia")), /^-rwxr-xr-x/);
      assert.match(listing.find((line) => line.endsWith("cli/plugin.json")), /^-rw-r--r--/);
      for (const line of listing) assert.match(line, /\s0\s+0\s|root|wheel|\s0\/0\s/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("matches ardia-plugin pack byte for byte on a manifest-only plugin", () => {
    const root = scratch();
    try {
      const dir = join(root, "developer-mode");
      mkdirSync(dir);
      const manifest = readFileSync(new URL("../../plugins/developer-mode/plugin.json", import.meta.url));
      writeFileSync(join(dir, "plugin.json"), manifest);
      const ours = packFolder(dir, join(root, "ours.tar.gz"));
      const cli = new URL("../../node_modules/.bin/ardia-plugin", import.meta.url).pathname;
      const done = spawnSync(cli, ["pack", dir, "--out", join(root, "theirs.tar.gz"), "--json", "--quiet"], { encoding: "utf8" });
      assert.equal(done.status, 0, done.stderr);
      assert.equal(JSON.parse(done.stdout).sha256, ours.sha256);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses symlinks", () => {
    const root = scratch();
    try {
      const dir = folder(root);
      symlinkSync("ardia", join(dir, "bin", "python3"));
      assert.throws(() => packFolder(dir, join(root, "a.tar.gz")), /bin\/python3 is a symlink/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("which plugins a change touches", () => {
  const plugins = [
    { name: "cli", packageJson: { dependencies: { "@ardia/plugin-sdk": "^3.0.0" } } },
    { name: "1password", packageJson: { dependencies: { "@ardia-plugins/credential-provider": "workspace:*" } } },
    { name: "bitwarden", packageJson: { dependencies: { "@ardia-plugins/credential-provider": "workspace:*" } } },
    { name: "ai", packageJson: { devDependencies: { "@ardia-plugins/testing": "workspace:*" } } },
    { name: "developer-mode", packageJson: null },
  ];
  const packages = [
    { rel: "packages/testing", packageJson: { name: "@ardia-plugins/testing" } },
    { rel: "packages/credential-provider", packageJson: { name: "@ardia-plugins/credential-provider", devDependencies: { "@ardia-plugins/testing": "workspace:*" } } },
  ];
  const touched = (...paths) => affected(paths, plugins, packages);

  test("a plugin's own files touch only it, and cli's docs and bench touch nothing", () => {
    assert.deepEqual(touched("plugins/developer-mode/plugin.json"), { plugins: ["developer-mode"], shared: false, packages: false });
    assert.deepEqual(touched("plugins/cli/docs/cli.md", "plugins/cli/bench/tasks.json", "plugins/cli/README.md"), { plugins: [], shared: false, packages: false });
    assert.deepEqual(touched("plugins/cli/ts/src/index.ts"), { plugins: ["cli"], shared: false, packages: false });
    assert.deepEqual(touched(".github/release/sign-macos.sh"), { plugins: ["cli"], shared: false, packages: false });
    assert.deepEqual(touched("README.md", "install.sh", "LICENSE"), { plugins: [], shared: false, packages: false });
  });

  test("a workspace package touches the plugins that depend on it, through other packages too", () => {
    assert.deepEqual(touched("packages/credential-provider/src/index.ts").plugins, ["1password", "bitwarden"]);
    assert.deepEqual(touched("packages/testing/src/index.mjs").plugins, ["1password", "bitwarden", "ai"]);
  });

  test("shared files touch everything", () => {
    for (const path of ["package.json", "pnpm-workspace.yaml", ".pnpmfile.cjs", "scripts/lib.mjs", ".github/workflows/ci.yml", ".github/actions/setup/action.yml", "packages/new-thing/x.ts"]) {
      assert.deepEqual(touched(path), { plugins: ["cli", "1password", "bitwarden", "ai", "developer-mode"], shared: true, packages: true }, path);
    }
  });
});

describe("notify-registry", () => {
  test("signs the body as GitHub does, so the platform's X-Hub-Signature-256 check passes", async () => {
    const secret = "registry-webhook-test-secret";
    const seen = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        seen.push({ headers: req.headers, body, url: req.url });
        const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
        res.writeHead(req.headers["x-hub-signature-256"] === expected ? 202 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify({ queued: ["@ardia/cli"] }));
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${server.address().port}/api/v1/registry/webhook/github`;
      const result = await notify("ardia-browser/plugins", "cli-v0.8.0", { ARDIA_REGISTRY_WEBHOOK_URL: url, ARDIA_REGISTRY_WEBHOOK_SECRET: secret });
      assert.equal(result.sent, true);
      assert.equal(result.status, 202);
      assert.equal(seen[0].url, "/api/v1/registry/webhook/github");
      assert.equal(seen[0].headers["x-github-event"], "release");
      assert.ok(seen[0].headers["x-github-delivery"]);
      assert.deepEqual(JSON.parse(seen[0].body), { action: "published", repository: { full_name: "ardia-browser/plugins" }, release: { tag_name: "cli-v0.8.0" } });
      await assert.rejects(notify("ardia-browser/plugins", "cli-v0.8.0", { ARDIA_REGISTRY_WEBHOOK_URL: url, ARDIA_REGISTRY_WEBHOOK_SECRET: "wrong" }), /answered 401/);
    } finally {
      server.close();
    }
  });

  test("does nothing without both settings, and refuses plain http to other hosts", async () => {
    assert.equal((await notify("a/b", "x-v1.0.0", {})).sent, false);
    assert.equal((await notify("a/b", "x-v1.0.0", { ARDIA_REGISTRY_WEBHOOK_URL: "https://example.com/" })).sent, false);
    await assert.rejects(notify("a/b", "x-v1.0.0", { ARDIA_REGISTRY_WEBHOOK_URL: "http://example.com/hook", ARDIA_REGISTRY_WEBHOOK_SECRET: "s" }), /isn't an https URL/);
    assert.match(webhookRequest("a/b", "t", "s", "d").headers["x-hub-signature-256"], /^sha256=[0-9a-f]{64}$/);
  });
});
