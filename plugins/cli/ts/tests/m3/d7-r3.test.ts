import "../libc-loaded.ts";
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { credential, saveRegistry } from "../../src/browse/auth/providers.ts";
import { run, RunTimedOut } from "../../src/browse/auth/run.ts";
import * as runModule from "../../src/browse/auth/run.ts";
import { login, loginHooks } from "../../src/browse/auth/vault.ts";
import { cmdSet, setHooks } from "../../src/browse/commands/settings.ts";
import { BrowseError } from "../../src/browse/daemon-errors.ts";
import { render } from "../../src/browse/daemon/render.ts";
import { buildFlow } from "../../src/browse/flows/flows.ts";
import { browseDir, closeFd } from "../../src/browse/paths.ts";
import * as script from "../../src/browse/script/script.ts";

function tempDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ardia-d7r3-")));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

describe("set credentials takes the password as an opaque positional", () => {
  const page = { targetId: "T" };
  const state = { page: async () => page, attached: null, current: "T", tabId: () => "t1" };

  test("dash-prefixed usernames and passwords reach the setter untouched", async () => {
    const seen: [string, string][] = [];
    const realCredentials = setHooks.credentials;
    setHooks.credentials = async (_ctx, _page, user, password) => {
      seen.push([user, password]);
    };
    try {
      for (const argv of [["credentials", "alice", "-x"], ["credentials", "--foo", "--bar"], ["auth", "-u", "-1"]]) {
        await cmdSet({ state, options: {} } as never, argv);
      }
      expect(seen).toEqual([["alice", "-x"], ["--foo", "--bar"], ["-u", "-1"]]);
    } finally {
      setHooks.credentials = realCredentials;
    }
  });

  test("a usage error names the expected form, never the arguments", async () => {
    for (const argv of [["credentials", "-x"], ["credentials"], ["auth", "--foo"]]) {
      const error = (await cmdSet({ state, options: {} } as never, argv).catch((thrown: unknown) => thrown)) as BrowseError;
      expect(error.text).toBe(`Usage: ardia browse set ${argv[0]} <user> <pass>`);
    }
  });
});

describe("script errors name the call, not its arguments", () => {
  test("a failed call is reported by its index and command", () => {
    const text = script.errorText({ kind: "error", message: "it failed", name: "Error", line: 2, command: ["set", "credentials", "alice", "sk-r3-secret"] }, "a\nb\nc", [
      ["get", "url"],
      ["set", "credentials", "alice", "sk-r3-secret"],
    ]);
    expect(text).toBe("line 2: it failed (in call 2, `set credentials`)");
    expect(text).not.toContain("sk-r3-secret");
  });
});

describe("answer codes come from a fixed set", () => {
  test("a code that isn't one of the daemon's own becomes a generic one, in the answer and in JSON", () => {
    const [, out] = render({ json: true }, null, new BrowseError("x", null, "sk-r3-code-secret"));
    expect(out).not.toContain("sk-r3-code-secret");
    expect(JSON.parse(out).code).toBe("failed");
    const [, kept] = render({ json: true }, null, new BrowseError("x", null, "stale_ref"));
    expect(JSON.parse(kept).code).toBe("stale_ref");
  });

  test("a code a script throws becomes script_failed", () => {
    expect(script.scriptCode("sk-r3-thrown")).toBe("script_failed");
    expect(script.scriptCode("not_found")).toBe("not_found");
    expect(script.scriptCode(null)).toBe("script_failed");
  });
});

describe("flows never keep userinfo", () => {
  test("a captured URL with a user and password is saved without them", () => {
    const body = JSON.stringify({ items: [{ id: 1 }] });
    const steps = [
      {
        seq: 1,
        command: ["open", "https://alice:sk-r3-flow@www.example.com/search?q=shoes"],
        before: "about:blank",
        replay: ["open", "https://alice:sk-r3-flow@www.example.com/search?q=shoes"],
        url: "https://www.example.com/search?q=shoes",
        ok: true,
        origins: [],
        unkept: [],
        requests: [
          { id: "s1r1", method: "GET", url: "https://bob:sk-r3-flow@www.example.com/api?q=shoes", type: "Fetch", status: 200, mime: "application/json", headers: {}, strippedAuth: false, kind: "json", bytes: body.length, text: body },
          { id: "s1r2", method: "GET", url: "https://www.example.com/api2?q=shoes", type: "Fetch", status: 200, mime: "application/json", headers: {}, strippedAuth: false, kind: "json", bytes: body.length, text: body },
        ],
      },
    ];
    const [flow, report] = buildFlow("search", steps as never);
    expect(JSON.stringify([flow, report])).not.toContain("sk-r3-flow");
    expect(JSON.stringify([flow, report])).not.toContain("alice");
  });
});

describe("provider replies", () => {
  function provider(data: string): string {
    const root = tempDir();
    const dir = path.join(root, "bin");
    fs.mkdirSync(dir);
    const command = path.join(dir, "provider");
    fs.writeFileSync(command, `#!/bin/sh\ncat > /dev/null\necho '{"protocol": "agent-browser.plugin.v1", "success": true, "data": ${data}}'\n`, { mode: 0o700 });
    closeFd(browseDir(root));
    saveRegistry(root, [{ name: "vault", package: "p", version: "1", spec: "p@1", command, capabilities: ["credential.read"] }]);
    return root;
  }

  test("a URL without a host, and selectors that are blank or carry control or format characters, are malformed", async () => {
    for (const data of [
      '{"password": "pw", "url": "https:"}',
      '{"password": "pw", "url": "https://"}',
      '{"password": "pw", "url": "https:///path"}',
      '{"password": "pw", "submitSelector": "   "}',
      '{"password": "pw", "passwordSelector": "#a\\u0085b"}',
      '{"password": "pw", "usernameSelector": "#a\\u200bb"}',
    ]) {
      const error = (await credential(provider(data), "vault", "i", null).catch((thrown: unknown) => thrown)) as BrowseError;
      expect(error.text).toBe("Credential provider vault sent a malformed reply");
    }
  });

  test("every later login error on the provider path is one fixed sentence", async () => {
    const root = provider('{"password": "pw-r3", "url": "https://x.example/", "username": "u", "usernameSelector": "#user", "passwordSelector": "#pw"}');
    const element = { frame: "F", objectId: "O", backendId: 1, label: "#pw" };
    const page = { mainFrame: "F", frames: new Map([["F", { origin: "https://x.example" }]]), refreshFrames: async () => new Map(), call: async () => true, loader: () => "L" };
    const state = {
      dataRoot: root,
      locate: async (selector: string) => {
        if (selector === "#pw") return [page, element];
        throw new BrowseError("anything at all, quoted \" or not", null, "not_found");
      },
    };
    const realLogin = { ...loginHooks };
    loginHooks.actions = { typeInto: async () => {}, click: async () => {}, pressEnter: async () => {} };
    loginHooks.currentOrNew = async () => page as never;
    try {
      const error = (await login({ state, options: {}, humanize: false, timeout: 1 } as never, ["prof", "--credential-provider", "vault"]).catch((thrown: unknown) => thrown)) as BrowseError;
      expect(error.text).toBe("Credential provider vault: the login didn't finish (not_found)");
    } finally {
      Object.assign(loginHooks, realLogin);
    }
  });
});

describe("helper groups and the daemon's exit", () => {
  test("exiting kills every live helper group, even one that ignores TERM", async () => {
    const dir = tempDir();
    const pidFile = path.join(dir, "pid");
    const runner = path.join(dir, "exit.ts");
    const source = path.resolve(import.meta.dir, "../../src/browse/auth/run.ts");
    fs.writeFileSync(
      runner,
      `import { run } from ${JSON.stringify(source)};\n` +
        `run(["/bin/sh", "-c", "trap '' TERM; (trap '' TERM; sleep 30) & echo $! > ${pidFile}; wait"], { timeout: 60 }).catch(() => {});\n` +
        `const end = Date.now() + 5000; while (!require("node:fs").existsSync(${JSON.stringify(pidFile)}) && Date.now() < end) await Bun.sleep(20);\n` +
        "process.exit(0);\n",
    );
    expect(spawnSync(process.execPath, [runner], { timeout: 20000 }).status).toBe(0);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    expect(await until(() => !alive(pid), 2000)).toBe(true);
  });

  test("a group is signalled only inside its window: one TERM at the stop, a KILL only if it outlives the grace, then it is forgotten", async () => {
    const sent: [number, string][] = [];
    const real = process.kill.bind(process);
    process.kill = ((pid: number, signal?: string | number) => {
      if (pid < 0 && signal !== 0 && signal !== undefined) sent.push([pid, String(signal)]);
      return real(pid, signal as never);
    }) as typeof process.kill;
    try {
      const dir = tempDir();
      const pidFile = path.join(dir, "pid");
      await expect(run(["/bin/sh", "-c", `sleep 30 & echo $! > ${pidFile}; exit 0`], { timeout: 0.3, grace: 0.2 })).rejects.toBeInstanceOf(RunTimedOut);
      expect(await until(() => !alive(Number(fs.readFileSync(pidFile, "utf8"))), 2000)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(sent.map(([, signal]) => signal)).toEqual(["SIGTERM"]);
      expect(runModule.liveGroups()).toEqual([]);
      const before = sent.length;
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(sent.length).toBe(before);
      await expect(run(["/bin/sh", "-c", "trap '' TERM; sleep 30"], { timeout: 0.2, grace: 0.2 })).rejects.toBeInstanceOf(RunTimedOut);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(sent.slice(before).map(([, signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
      expect(runModule.liveGroups()).toEqual([]);
    } finally {
      process.kill = real;
    }
  });
});

describe("script errors name only the resolved command", () => {
  test("a failed single-string call names `set credentials`, never its arguments, in the text and in JSON", () => {
    const raw = ["set credentials alice sk-final-secret"];
    const calls = [["get", "url"], raw];
    const message = { kind: "error", message: "nope", name: "Error", line: 1, command: raw };
    const text = script.errorText(message, "x", calls);
    expect(text).toBe("line 1: nope (in call 2, `set credentials`)");
    expect(script.commandName(raw)).toBe("set credentials");
    expect(script.commandName(["set", "auth", "-x", "y"])).toBe("set auth");
    expect(script.commandName(["click", "#a"])).toBe("click");
    expect(script.commandName(["frobnicate sk-final-secret"])).toBe("unknown command");
    expect(script.commandName(["'unclosed sk-final-secret"])).toBe("unknown command");
    expect(JSON.stringify(script.failureData(message, calls))).not.toContain("sk-final-secret");
  });
});

describe("script calls that don't parse or name no command", () => {
  test("they get fixed errors that never echo the call", () => {
    const secret = "pw-Q7'zz-final";
    for (const given of [[`set credentials alice ${secret}`], [`set credentials alice pw"${secret}`], [`nosuch ${secret}`]]) {
      expect(script.refusedCall(given)).toEqual({ ok: false, error: "that call couldn't be parsed", code: "usage" });
    }
    expect(script.refusedCall(["frobnicate", secret])).toEqual({ ok: false, error: "unknown command", code: "usage" });
    expect(script.refusedCall(["get title"])).toBeNull();
    expect(script.refusedCall(["set", "credentials", "alice", secret])).toBeNull();
    const raw = [`set credentials alice ${secret}`];
    const text = script.errorText({ kind: "error", message: "that call couldn't be parsed", name: "Error", line: 1, command: raw }, "x", [raw]);
    expect(text).toBe("line 1: that call couldn't be parsed (in call 1, `unknown command`)");
    expect(JSON.stringify(script.failureData({ command: raw }, [raw]))).not.toContain("Q7");
  });
});

describe("the native group table", () => {
  test("a group the full table refuses is killed, counted and fails the run", async () => {
    const { registerGroup, unregisterGroup } = await import("../../src/libc.ts");
    const fakes: number[] = [];
    for (let pid = 900_000; fakes.length < 300; pid += 1) {
      if (registerGroup(pid) !== 0) break;
      fakes.push(pid);
    }
    try {
      const before = runModule.groupStats.untracked;
      await expect(run(["/bin/sh", "-c", "exit 0"], { timeout: 5 })).rejects.toBeInstanceOf(runModule.SpawnFailed);
      expect(runModule.groupStats.untracked).toBe(before + 1);
      expect(runModule.liveGroups()).toEqual([]);
    } finally {
      for (const pid of fakes) unregisterGroup(pid);
    }
    expect(fakes.length).toBe(256);
  });
});
