import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import { parseConfig } from "../../src/browse/daemon/config.ts";
import { Daemon } from "../../src/browse/daemon/server.ts";
import { daemonEnvironment } from "../../src/browse/daemon/spawn.ts";
import { credentialId, pluginSessionKey } from "../../src/browse/plugin/key.ts";
import { dumps, type Value } from "../../src/json.ts";
import { ask, config, type Scratch, scratch, socketFile, until } from "./daemon-helpers.ts";
import { CREDENTIAL, OTHER_CREDENTIAL } from "./plugin-world.ts";

setDefaultTimeout(30_000);
const home = process.cwd();
const made: Scratch[] = [];
const running: { daemon: Daemon; done: Promise<number> }[] = [];

afterEach(async () => {
  for (const { daemon, done } of running.splice(0)) {
    daemon.beginStop();
    await done;
  }
  process.chdir(home);
  for (const found of made.splice(0)) found.done();
});

async function started(daemon: Daemon, found: Scratch): Promise<Daemon> {
  running.push({ daemon, done: daemon.run() });
  await until(() => fs.existsSync(socketFile(found.data, daemon.key)), 5000);
  return daemon;
}

function pluginDaemon(found: Scratch): Daemon {
  const settings = new Map<string, Value>([
    ["session", "plugin-ai"], ["namespace", ""], ["key", pluginSessionKey("", CREDENTIAL, "plugin-ai")], ["data_root", found.data],
    ["ws", "ws://127.0.0.1:9/devtools/browser/x"], ["port", null], ["data_dir", null], ["endpoint_label", null],
    ["idle_timeout_ms", null], ["debug", true], ["no_auto_dialog", false], ["pin_tab", null], ["plugin", credentialId(CREDENTIAL)],
  ]);
  return new Daemon(parseConfig(dumps(settings, "spaced")));
}

function fresh(): Scratch {
  const found = scratch();
  made.push(found);
  return found;
}

const NOSY = { no_auto_dialog: true, pin_tab: true, json: true };
const CALLER = { name: "someone", app: "Something" };

describe("a credential refusal touches nothing and says nothing more", () => {
  test("a plugin daemon answers a wrong or missing credential with exit 77 plugin_refused and no other field", async () => {
    const found = fresh();
    const daemon = await started(pluginDaemon(found), found);
    for (const credential of [OTHER_CREDENTIAL, undefined, "p.short"]) {
      const answer = await ask(found.data, daemon.key, ["snapshot", "-c"], NOSY, credential === undefined ? { caller: CALLER } : { credential, caller: CALLER });
      expect(Object.keys(answer).sort()).toEqual(["code", "err", "exit", "out"]);
      expect(answer).toMatchObject({ exit: 77, code: "plugin_refused", err: "" });
      expect(JSON.parse(String(answer["out"]))).toMatchObject({ success: false, data: null, code: "plugin_refused" });
    }
    const session = daemon.plugin;
    expect(session?.autoDialog).toBe(true);
    expect(session?.credential).toBe(null);
    expect(daemon.state.autoDialog).toBe(true);
    expect(daemon.state.pinTab).toBe(false);
    expect(daemon.state.caller ?? null).toBe(null);
  });

  test("an owner daemon refuses a credential-bearing request before any state change", async () => {
    const found = fresh();
    const daemon = await started(new Daemon(parseConfig(dumps(config(found.data, "owner"), "spaced"))), found);
    const answer = await ask(found.data, daemon.key, ["snapshot", "-c"], NOSY, { credential: CREDENTIAL, caller: CALLER });
    expect(Object.keys(answer).sort()).toEqual(["code", "err", "exit", "out"]);
    expect(answer).toMatchObject({ exit: 77, code: "plugin_refused" });
    expect(daemon.state.autoDialog).toBe(true);
    expect(daemon.state.pinTab).toBe(false);
    expect(daemon.state.caller ?? null).toBe(null);
  });
});

describe("the spawn environment", () => {
  test("every ARDIA_PLUGIN_ variable and the plugin-mode switch are dropped, whatever their names", () => {
    const env = { PATH: "/usr/bin", ARDIA_PLUGIN_CREDENTIAL_FD: "4", ARDIA_PLUGIN_ENDPOINT: "ws://x", ARDIA_PLUGIN_SOMETHING_NEW: "secret", ARDIA_BROWSE_FOR_PLUGIN: "1", ARDIA_PLUGINLESS: "kept" };
    for (const plugin of [credentialId(CREDENTIAL), null]) {
      const settings = new Map<string, Value>([["ws", "ws://127.0.0.1:9/devtools/browser/x"], ["plugin", plugin]]);
      const { env: kept } = daemonEnvironment(settings, env);
      expect(Object.keys(kept).sort()).toEqual(["ARDIA_PLUGINLESS", "PATH"]);
    }
  });
});
