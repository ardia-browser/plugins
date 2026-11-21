import "../libc-loaded.ts";
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runPlugin, saveRegistry } from "../../src/browse/auth/providers.ts";
import { BrowseError } from "../../src/browse/daemon-errors.ts";
import { browseDir, closeFd } from "../../src/browse/paths.ts";

const MARK = "PLUGIN-TEXT-91c4";

function plugin(body: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ardia-m2b-run-")));
  const dir = path.join(root, "bin");
  fs.mkdirSync(dir);
  const command = path.join(dir, "plugin");
  fs.writeFileSync(command, `#!/bin/sh\ncat > /dev/null\n${body}\n`, { mode: 0o700 });
  closeFd(browseDir(root));
  saveRegistry(root, [{ name: "tool", package: "p", version: "1", spec: "p@1", command, capabilities: ["command.run"] }]);
  return root;
}

function reply(rest: string): string {
  return `echo '{"protocol": "agent-browser.plugin.v1", ${rest}}'`;
}

async function failure(root: string): Promise<BrowseError> {
  const error = await runPlugin(root, "tool", "command.run", { a: 1 }).catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(BrowseError);
  return error as BrowseError;
}

const MALFORMED = "Plugin tool sent a malformed reply";
const FAILED = "Plugin tool returned an error";

describe("plugin run boundary", () => {
  test("a well-formed reply gives its data", async () => {
    expect(await runPlugin(plugin(reply('"success": true, "data": {"n": 1}')), "tool", "command.run", {})).toEqual({ n: 1 });
  });

  test("the plugin's error text never reaches the message", async () => {
    const error = await failure(plugin(reply(`"success": false, "error": "${MARK}"`)));
    expect(error.text).toBe(FAILED);
    expect(error.code).toBe("plugin_failed");
    expect(JSON.stringify([error.text, error.data])).not.toContain(MARK);
  });

  test("an unknown protocol, invalid JSON, extra keys and a truthy success that isn't true are malformed", async () => {
    for (const body of [
      `echo '{"protocol": "${MARK}", "success": true}'`,
      `echo '${MARK}'`,
      reply(`"success": true, "data": 1, "${MARK}": 1`),
      reply('"success": 1, "data": 1'),
      reply('"success": "yes", "data": 1'),
    ]) {
      const error = await failure(plugin(body));
      expect(error.text).toBe(MALFORMED);
      expect(JSON.stringify([error.text, error.data])).not.toContain(MARK);
    }
  });

  test("a nonzero exit fails even with a success reply", async () => {
    expect((await failure(plugin(`${reply('"success": true, "data": 1')}; exit 4`))).text).toBe(FAILED);
  });

  test("the plugin sees only the allowlisted environment", async () => {
    process.env.ARDIA_SECRET_FOR_TEST = MARK;
    try {
      const data = await runPlugin(plugin(`printf '{"protocol": "agent-browser.plugin.v1", "success": true, "data": "%s"}' "$ARDIA_SECRET_FOR_TEST"`), "tool", "command.run", {});
      expect(data).toBe("");
    } finally {
      delete process.env.ARDIA_SECRET_FOR_TEST;
    }
  });

  test("a plugin that outlives its timeout is killed with its process group", async () => {
    const root = plugin(`(sleep 30 &) ; echo $$ > "${"$(dirname \"$0\")"}/pid"; sleep 30`);
    const error = await runPlugin(root, "tool", "command.run", {}, 0.5).catch((thrown: unknown) => thrown);
    expect((error as BrowseError).text).toBe("Plugin tool didn't answer in 0.5s");
    await Bun.sleep(800);
    const pid = Number(fs.readFileSync(path.join(root, "bin", "pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
