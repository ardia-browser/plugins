import "../libc-loaded.ts";
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { credential, saveRegistry } from "../../src/browse/auth/providers.ts";
import { login, loginHooks } from "../../src/browse/auth/vault.ts";
import { BrowseError } from "../../src/browse/daemon-errors.ts";
import { browseDir, closeFd } from "../../src/browse/paths.ts";

const MARK = "PROVIDER-TEXT-5e2d";

function provider(body: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ardia-d7prov-")));
  const dir = path.join(root, "bin");
  fs.mkdirSync(dir);
  const command = path.join(dir, "provider");
  fs.writeFileSync(command, `#!/bin/sh\ncat > /dev/null\n${body}\n`, { mode: 0o700 });
  closeFd(browseDir(root));
  saveRegistry(root, [{ name: "vault", package: "p", version: "1", spec: "p@1", command, capabilities: ["credential.read"] }]);
  return root;
}

function reply(data: string, success = "true"): string {
  return `echo '{"protocol": "agent-browser.plugin.v1", "success": ${success}, "data": ${data}}'`;
}

async function failure(root: string): Promise<BrowseError> {
  const error = await credential(root, "vault", `item-${MARK}`, null).catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(BrowseError);
  return error as BrowseError;
}

const MALFORMED = "Credential provider vault sent a malformed reply";

describe("credential reply validation", () => {
  test("success must be exactly true", async () => {
    expect((await failure(provider(reply('{"password": "pw"}', '"yes"')))).text).toBe(MALFORMED);
    expect((await failure(provider(reply('{"password": "pw"}', "1")))).text).toBe(MALFORMED);
    expect((await failure(provider(reply('{"password": "pw"}', "false")))).text).toBe("Credential provider vault returned an error");
  });

  test("a nonzero exit is a failure even with a success reply", async () => {
    expect((await failure(provider(`${reply('{"password": "pw"}')}; exit 3`))).text).toBe("Credential provider vault returned an error");
  });

  test("an explicit null for an optional field is malformed", async () => {
    expect((await failure(provider(reply('{"password": "pw", "username": null}')))).text).toBe(MALFORMED);
  });

  test("a missing or empty password reads as malformed, without the item", async () => {
    for (const data of ['{"username": "u"}', '{"password": ""}', '{"password": 7}']) {
      const error = await failure(provider(reply(data)));
      expect(error.text).toBe(MALFORMED);
      expect(error.text).not.toContain(MARK);
    }
  });

  test("a URL or selector that can't be used is malformed, and never echoed", async () => {
    for (const data of [
      `{"password": "pw", "url": "https://x.example:99999/${MARK}"}`,
      `{"password": "pw", "url": "http://${MARK}.example/"}`,
      `{"password": "pw", "url": "javascript:${MARK}"}`,
      `{"password": "pw", "usernameSelector": "#a\\\\u0007${MARK}"}`,
      `{"password": "pw", "submitSelector": ""}`,
    ]) {
      const error = await failure(provider(reply(data)));
      expect(error.text).toBe(MALFORMED);
      expect(JSON.stringify([error.text, error.data])).not.toContain(MARK);
    }
  });
});

describe("provider data in later errors", () => {
  test("a provider selector that matches nothing isn't repeated in the error", async () => {
    const root = provider(reply(`{"password": "pw", "url": "https://x.example/", "username": "u", "usernameSelector": "#gone-${MARK}", "passwordSelector": "#pw"}`));
    const element = { frame: "F", objectId: "O", backendId: 1, label: "#pw" };
    const page = {
      mainFrame: "F",
      frames: new Map([["F", { origin: "https://x.example" }]]),
      refreshFrames: async () => new Map(),
      call: async () => true,
      loader: () => "L",
    };
    const state = {
      dataRoot: root,
      locate: async (selector: string) => {
        if (selector === "#pw") return [page, element];
        throw new BrowseError(`Element not found: ${selector}. Verify the selector`, null, "not_found");
      },
    };
    loginHooks.actions = { typeInto: async () => {}, click: async () => {}, pressEnter: async () => {} };
    loginHooks.currentOrNew = async () => page as never;
    try {
      const error = (await login({ state, options: {}, humanize: false, timeout: 1 } as never, ["prof", "--credential-provider", "vault"]).catch((thrown: unknown) => thrown)) as BrowseError;
      expect(error).toBeInstanceOf(BrowseError);
      expect(error.text).not.toContain(MARK);
      expect(error.text).toContain("Credential provider vault");
    } finally {
      loginHooks.actions = null;
      loginHooks.currentOrNew = null;
    }
  });
});
