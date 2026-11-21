import "../libc-loaded.ts";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runRequest } from "../../src/notes-files.ts";
import { call, credential, pluginEnv, resolveSpec, runTool, saveRegistry } from "../../src/browse/auth/providers.ts";
import { commandLine, quote, readSecret, security, storeSecret, tools } from "../../src/browse/auth/vault.ts";
import { buildParams, ParamsError, pyLoads, strictJson } from "../../src/browse/cdp/params.ts";
import { BrowseError } from "../../src/browse/daemon-errors.ts";
import { load, listing, remove, save, validate } from "../../src/browse/flows/flows.ts";
import { browseDir, closeFd, takeLock } from "../../src/browse/paths.ts";
import { Registry } from "../../src/browse/state/registry.ts";
import { evaluateIsolated, ISOLATED_EVAL } from "../../src/browse/commands/pagejs.ts";
import { workerSource } from "../../src/browse/script/script.ts";
import { scratch, type Scratch } from "./daemon-helpers.ts";
import { spawnSync } from "node:child_process";
import { run, RunTimedOut, signalGroup } from "../../src/browse/auth/run.ts";
import { Cancelled, withSignal } from "../../src/browse/cdp/cancel.ts";
import { wireParams } from "../../src/browse/cdp/params.ts";
import { allow } from "../../src/browse/commands/permissions.ts";
import { decodeScript, readScript } from "../../src/browse/commands/setup.ts";
import { parseParams } from "../../src/browse/flows/flows.ts";
import { login, loginHooks } from "../../src/browse/auth/vault.ts";
import { cmdSet, setHooks } from "../../src/browse/commands/settings.ts";

setDefaultTimeout(30_000);
const made: Scratch[] = [];
const temps: string[] = [];

afterAll(() => {
  for (const found of made.splice(0)) found.done();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ardia-d7-")));
  temps.push(dir);
  return dir;
}

function stub(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  return file;
}

describe("Keychain calls", () => {
  test("the secret goes only to stdin: argv is just -i, env carries nothing new", async () => {
    const dir = tempDir();
    const seen = path.join(dir, "seen");
    tools.security = stub(dir, "security", `printf '%s\\n' "$@" > "${seen}.argv"; env > "${seen}.env"; cat > "${seen}.stdin"; printf 'pw\\n'`);
    try {
      await storeSecret("site", 'hunter"2\\x');
      expect(fs.readFileSync(`${seen}.argv`, "utf8")).toBe("-i\n");
      expect(fs.readFileSync(`${seen}.stdin`, "utf8")).toBe(
        'add-generic-password "-U" "-a" "site" "-s" "dev.ardia.browse.auth" "-l" "Ardia browse: site" "-w" "hunter\\"2\\\\x"\n',
      );
      expect(fs.readFileSync(`${seen}.env`, "utf8")).not.toContain("hunter");
      expect(await readSecret("site", false)).toBe("pw");
    } finally {
      tools.security = "/usr/bin/security";
    }
  });

  test("an item security can't find counts as a failure, whatever its exit status", async () => {
    const dir = tempDir();
    tools.security = stub(dir, "security", "cat > /dev/null; echo 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.' >&2; exit 0");
    try {
      expect(await security(["find-generic-password", "-a", "x"])).toEqual([1, ""]);
      await expect(readSecret("x", false)).rejects.toThrow("No password for x in the Keychain; save it again with `ardia browse auth save x ...`");
    } finally {
      tools.security = "/usr/bin/security";
    }
  });

  test("a stuck security is killed at the deadline with Python's message", async () => {
    const dir = tempDir();
    tools.security = stub(dir, "security", "sleep 30");
    tools.timeout = 0.3;
    try {
      await expect(security(["find-generic-password"])).rejects.toThrow("The Keychain didn't answer in time (is a Keychain prompt waiting?)");
    } finally {
      tools.security = "/usr/bin/security";
      tools.timeout = 20;
    }
  });

  test("a missing program reports its strerror", async () => {
    tools.security = "/nonexistent/security";
    try {
      await expect(security(["x"])).rejects.toThrow("Couldn't run /usr/bin/security: No such file or directory");
    } finally {
      tools.security = "/usr/bin/security";
    }
  });

  test("control characters and line breaks are refused before anything runs", () => {
    expect(() => quote("a\nb")).toThrow("Secrets and names can't contain control characters or line breaks");
    expect(() => quote("a\u007fb")).toThrow(BrowseError);
    expect(commandLine(["find-generic-password", "-a", "é"])).toBe('find-generic-password "-a" "é"\n');
  });

  test("a utf8 profile's hex answer is decoded", async () => {
    const dir = tempDir();
    tools.security = stub(dir, "security", `cat > /dev/null; printf '%s\\n' "${Buffer.from("pässword", "utf8").toString("hex")}"`);
    try {
      expect(await readSecret("x", true)).toBe("pässword");
      expect(await readSecret("x", false)).toBe(Buffer.from("pässword", "utf8").toString("hex"));
    } finally {
      tools.security = "/usr/bin/security";
    }
  });
});

describe("credential providers", () => {
  function plugin(body: string): { root: string; dir: string } {
    const root = tempDir();
    const dir = path.join(root, "bin");
    fs.mkdirSync(dir);
    const command = stub(dir, "provider", body);
    closeFd(browseDir(root));
    saveRegistry(root, [{ name: "vault", package: "p", version: "1", spec: "p@1", command, capabilities: ["credential.read"] }]);
    return { root, dir };
  }

  test("the plugin gets the request on stdin, its own folder as cwd and no ARDIA_ or AGENT_BROWSER_ variables", async () => {
    process.env["ARDIA_SECRET_TEST"] = "leak";
    process.env["AGENT_BROWSER_TEST"] = "leak";
    try {
      const { root, dir } = plugin(`cat > "$PWD/request.json"; env > "$PWD/env.txt"; printf 'noise\\n{"protocol": "agent-browser.plugin.v1", "success": true, "data": {"password": "pw", "username": "u"}}\\n'`);
      const data = await credential(root, "vault", "item", "https://x.example");
      expect(data).toEqual({ password: "pw", username: "u" });
      expect(JSON.parse(fs.readFileSync(path.join(dir, "request.json"), "utf8"))).toEqual({
        protocol: "agent-browser.plugin.v1",
        capability: "credential.read",
        type: "credential.read",
        request: { item: "item", url: "https://x.example" },
      });
      const env = fs.readFileSync(path.join(dir, "env.txt"), "utf8");
      expect(env).not.toContain("ARDIA_SECRET_TEST");
      expect(env).not.toContain("AGENT_BROWSER_TEST");
      expect(Object.keys(pluginEnv()).some((key) => key.startsWith("ARDIA_"))).toBe(false);
    } finally {
      delete process.env["ARDIA_SECRET_TEST"];
      delete process.env["AGENT_BROWSER_TEST"];
    }
  });

  test("bad answers get Python's messages", async () => {
    expect(call(plugin("cat > /dev/null; echo nope").root, "vault", "credential.read", {})).rejects.toThrow("Plugin 'vault' returned invalid JSON");
    expect(call(plugin("cat > /dev/null").root, "vault", "credential.read", {})).rejects.toThrow("Plugin 'vault' returned invalid JSON");
    expect(call(plugin(`cat > /dev/null; echo '{"protocol": "v0"}'`).root, "vault", "credential.read", {})).rejects.toThrow(
      "Plugin 'vault' used unsupported protocol 'v0'",
    );
    expect(call(plugin(`cat > /dev/null; echo '{"protocol": "agent-browser.plugin.v1", "success": false, "error": "locked"}'`).root, "vault", "credential.read", {})).rejects.toThrow(
      "Plugin 'vault' failed: locked",
    );
    expect(credential(plugin(`cat > /dev/null; echo '{"protocol": "agent-browser.plugin.v1", "success": true, "data": {}}'`).root, "vault", "i", null)).rejects.toThrow(
      "Credential provider vault sent a malformed reply",
    );
    expect(call(plugin("cat > /dev/null").root, "vault", "other.cap", {})).rejects.toThrow("Plugin vault doesn't declare other.cap (it declares credential.read)");
    expect(call(plugin("cat > /dev/null").root, "nobody", "credential.read", {})).rejects.toThrow("No plugin named nobody");
  });

  test("a plugin that never answers is killed at its deadline", async () => {
    const started = performance.now();
    await expect(call(plugin("sleep 30").root, "vault", "credential.read", {}, 0.3)).rejects.toThrow("Plugin vault didn't answer in 0.3s");
    expect(performance.now() - started).toBeLessThan(5000);
  });

  test("only the first MiB of an answer is read", async () => {
    const { root } = plugin(`cat > /dev/null; head -c 1100000 /dev/zero | tr '\\0' x; echo '{"protocol": "agent-browser.plugin.v1", "success": true}'`);
    await expect(call(root, "vault", "credential.read", {})).rejects.toThrow("returned invalid JSON");
  });

  test("tools run without a shell, report a missing tool and a failure's stderr tail", async () => {
    await expect(runTool(["definitely-not-a-tool-d7", "x"])).rejects.toThrow("definitely-not-a-tool-d7 isn't installed");
    await expect(runTool(["/bin/sh", "-c", "echo bad >&2; exit 3"])).rejects.toThrow("/bin/sh -c echo bad >&2; exit 3 failed: bad");
    expect(await runTool(["/bin/echo", "$HOME;", "`id`"])).toBe("$HOME; `id`\n");
  });

  test("a GitHub ref resolves through git ls-remote to a full commit", async () => {
    const dir = tempDir();
    stub(dir, "git", `[ "$1" = ls-remote ] && [ "$2" = https://github.com/own/repo ] && [ "$3" = main ] && printf '%s\\tref\\n' 0123456789abcdef0123456789abcdef01234567`);
    const before = process.env["PATH"];
    process.env["PATH"] = `${dir}:${before}`;
    try {
      expect(await resolveSpec("own/repo#main")).toEqual(["github:own/repo#0123456789abcdef0123456789abcdef01234567", "repo", "0123456789abcdef0123456789abcdef01234567"]);
      await expect(resolveSpec("own/other")).rejects.toThrow("git ls-remote https://github.com/own/other failed");
    } finally {
      process.env["PATH"] = before;
    }
  });
});

describe("tab holds", () => {
  test("a hold is visible to other sessions while it runs and gone after, even when the work fails", async () => {
    const found = scratch();
    made.push(found);
    const fd = browseDir(found.data);
    const held = takeLock(`${"a".repeat(24)}.lock`, fd);
    const heldOther = takeLock(`${"b".repeat(24)}.lock`, fd);
    try {
      const mine = new Registry(fd, "a".repeat(24), "one");
      const other = new Registry(fd, "b".repeat(24), "two");
      await mine.holding("inst", "T1", async () => {
        expect(other.others("inst")[1].get("T1")).toEqual(["one"]);
        expect(other.reserveClose("inst", "T1")).toBe(false);
      });
      expect(other.others("inst")[1].get("T1")).toBeUndefined();
      await expect(
        mine.holding("inst", "T2", async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(other.others("inst")[1].get("T2")).toBeUndefined();
      expect(other.reserveClose("inst", "T3")).toBe(true);
      await expect(mine.holding("inst", "T3", async () => 1)).rejects.toThrow("That tab can't be used: session two is closing it");
    } finally {
      closeFd(held);
      closeFd(heldOther);
      closeFd(fd);
    }
  });
});

describe("params", () => {
  test("strict JSON refuses what Python refuses", () => {
    expect(() => strictJson('{"a": 1, "a": 2}', "--params")).toThrow('--params has the key "a" twice');
    expect(() => strictJson("[" .repeat(65) + "]".repeat(65), "--params")).toThrow("--params is nested deeper than 64 levels");
    expect(() => strictJson("[".repeat(5000) + "]".repeat(5000), "--params")).toThrow("--params is nested deeper than 64 levels");
    expect(() => strictJson('{"a": "\\ud800"}', "--params")).toThrow("--params has a lone surrogate (\\ud800), which isn't valid Unicode");
    expect(() => buildParams(null, ["a:=[1,]"], "")).toThrow(ParamsError);
    expect(pyLoads('{"a": NaN, "a": 2}')).toEqual(new Map([["a", 2n]]));
  });
});

describe("flow store", () => {
  const flow = () => ({
    version: 1,
    name: "search",
    description: "find é",
    site: "example.com",
    origin: "https://www.example.com",
    startUrl: "https://www.example.com/s?q={{q}}",
    hosts: ["https://www.example.com"],
    createdAt: "2026-01-01T00:00:00Z",
    createdBy: { tool: "ardia browse", version: "1" },
    params: [{ name: "q", example: "shoes", source: "query" }],
    output: "s1r1",
    verified: true,
    steps: [
      {
        seq: 1,
        command: ["open", "https://www.example.com/s?q={{q}}"],
        url: "https://www.example.com/s?q={{q}}",
        ok: true,
        requests: [{ id: "s1r1", method: "GET", url: "https://www.example.com/api?q={{q}}", headers: {}, kind: "json", expect: { status: 200, signature: {}, bytes: 3, list: null, itemFields: [] } }],
      },
    ],
  });

  test("save, load, list and remove go through the private folder, one space of indent like Python", () => {
    const root = tempDir();
    const saved = save(root, validate(flow()));
    expect(saved).toBe(`${root}/Flows/example.com/search.json`);
    const text = fs.readFileSync(saved, "utf8");
    expect(text.startsWith('{\n "version": 1,\n "name": "search",\n "description": "find é"')).toBe(true);
    expect(fs.statSync(saved).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(saved)).mode & 0o777).toBe(0o700);
    expect(load(root, "example.com", "search")["steps"][0]["requests"][0]["id"]).toBe("s1r1");
    expect(listing(root).map((row) => row["name"])).toEqual(["search"]);
    expect(remove(root, "example.com", "search")).toBe(true);
    expect(remove(root, "example.com", "search")).toBe(false);
  });

  test("a flow folder that is a link is refused", () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, "elsewhere"), { mode: 0o700 });
    fs.symlinkSync(path.join(root, "elsewhere"), path.join(root, "Flows"));
    expect(() => save(root, validate(flow()))).toThrow(BrowseError);
  });
});

describe("notes files", () => {
  test("set, append, get, list and rm", () => {
    const root = tempDir();
    expect(runRequest(root, { action: "set", site: "example.com", text: "one" }, null).text).toBe("✓ Saved the notes for example.com (4 of 8,192 bytes)");
    expect(runRequest(root, { action: "append", site: "example.com", text: "two" }, null).text).toBe("✓ Added to the notes for example.com (8 of 8,192 bytes)");
    expect(runRequest(root, { action: "get", site: null, text: null }, "https://example.com/x").text).toBe("one\ntwo");
    expect(runRequest(root, { action: "list", site: null, text: null }, null).text).toMatch(/^example\.com {2}8 bytes {2}\d{4}-\d\d-\d\d \d\d:\d\d$/u);
    expect(() => runRequest(root, { action: "set", site: "example.com", text: "x".repeat(9000) }, null)).toThrow("Notes for example.com would be 9,001 bytes");
    expect(runRequest(root, { action: "rm", site: "example.com", text: null }, null).text).toBe("✓ Removed the notes for example.com");
    expect(() => runRequest(root, { action: "get", site: null, text: null }, "about:blank")).toThrow("isn't a web page (about:blank)");
  });
});

describe("script and eval sources", () => {
  test("the worker's line offset counts its own lines, as Python's does", () => {
    const [code, offset] = workerSource("return 1");
    expect(code.split("\n")[offset]).toBe("return 1");
    expect(code.endsWith("//# sourceURL=ardia-script.js")).toBe(true);
  });

  test("isolated eval runs on the world handle, never a numeric context", async () => {
    const sent: [string, Record<string, unknown>][] = [];
    const page = {
      mainFrame: "F",
      frames: new Map([["F", { id: "F", loader: "L" }]]),
      worlds: new Map(),
      loader: () => "L",
      worldOf: async () => ({ frame: "F", loader: "L", context: 7, handle: "H" }),
      send: async (method: string, params: Record<string, unknown>) => {
        sent.push([method, params]);
        return { result: { type: "number", value: 2 } };
      },
    };
    expect(await evaluateIsolated(page as never, "1 + 1")).toBe(2);
    expect(sent).toEqual([
      ["Runtime.callFunctionOn", { functionDeclaration: ISOLATED_EVAL, objectId: "H", arguments: [{ value: "1 + 1" }], returnByValue: true, awaitPromise: true, userGesture: false }],
    ]);
  });
});


function alivePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gone(pid: number, ms = 3000): Promise<boolean> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (!alivePid(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !alivePid(pid);
}

describe("subprocess lifetime", () => {
  test("a leader that forked a child holding stdout and exited is settled at its deadline, and the child is killed", async () => {
    const dir = tempDir();
    const pidFile = path.join(dir, "pid");
    const started = performance.now();
    await expect(run(["/bin/sh", "-c", `sleep 30 & echo $! > ${pidFile}; exit 0`], { timeout: 0.4, grace: 0.2 })).rejects.toBeInstanceOf(RunTimedOut);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(await gone(Number(fs.readFileSync(pidFile, "utf8")))).toBe(true);
  });

  test("a cancel after the leader exited also kills its orphan", async () => {
    const dir = tempDir();
    const pidFile = path.join(dir, "pid");
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Cancelled()), 300);
    await expect(withSignal(controller.signal, () => run(["/bin/sh", "-c", `sleep 30 & echo $! > ${pidFile}; exit 0`], { timeout: 30, grace: 0.2 }))).rejects.toBeInstanceOf(Cancelled);
    expect(await gone(Number(fs.readFileSync(pidFile, "utf8")))).toBe(true);
  });

  test("a leader still running at the deadline has its whole group killed, children included", async () => {
    const dir = tempDir();
    const pidFile = path.join(dir, "pid");
    await expect(run(["/bin/sh", "-c", `sleep 30 & echo $! > ${pidFile}; wait`], { timeout: 0.4, grace: 0.2 })).rejects.toBeInstanceOf(RunTimedOut);
    expect(await gone(Number(fs.readFileSync(pidFile, "utf8")))).toBe(true);
  });

  test("a cancel settles the same way and leaves no process", async () => {
    const dir = tempDir();
    const pidFile = path.join(dir, "pid");
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Cancelled()), 300);
    const started = performance.now();
    await expect(withSignal(controller.signal, () => run(["/bin/sh", "-c", `sleep 30 & echo $! > ${pidFile}; wait`], { timeout: 30, grace: 0.2 }))).rejects.toBeInstanceOf(Cancelled);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(await gone(Number(fs.readFileSync(pidFile, "utf8")))).toBe(true);
  });

  test("a group that ignores SIGTERM is killed after the grace", async () => {
    const dir = tempDir();
    const pidFile = path.join(dir, "pid");
    await expect(run(["/bin/sh", "-c", `trap '' TERM; (trap '' TERM; sleep 30) & echo $! > ${pidFile}; wait`], { timeout: 0.3, grace: 0.3 })).rejects.toBeInstanceOf(RunTimedOut);
    expect(await gone(Number(fs.readFileSync(pidFile, "utf8")))).toBe(true);
  });

  test("each run is its own process group", async () => {
    const ran = await run(["/bin/sh", "-c", "ps -o pgid= -p $$; echo $$"], { timeout: 5 });
    const [pgid, pid] = ran.stdout.toString().trim().split(/\s+/u);
    expect(pgid).toBe(pid);
    expect(Number(pgid)).not.toBe(process.pid);
    expect(signalGroup(Number(pid), 0)).toBe(false);
  });
});

describe("credential provider boundary", () => {
  function provider(body: string): string {
    const root = tempDir();
    const dir = path.join(root, "bin");
    fs.mkdirSync(dir);
    const command = stub(dir, "provider", body);
    closeFd(browseDir(root));
    saveRegistry(root, [{ name: "vault", package: "p", version: "1", spec: "p@1", command, capabilities: ["credential.read"] }]);
    return root;
  }

  test("only the allowlisted environment reaches a provider", async () => {
    process.env["D7_FAKE_SECRET"] = "sk-fake-secret-0000";
    process.env["GITHUB_TOKEN"] = "ghp_fake";
    process.env["LC_ALL"] = "C";
    try {
      const root = provider(`cat > /dev/null; env > "$PWD/env.txt"; echo '{"protocol": "agent-browser.plugin.v1", "success": true, "data": {"password": "pw"}}'`);
      await credential(root, "vault", "i", null);
      const env = fs.readFileSync(path.join(root, "bin", "env.txt"), "utf8");
      expect(env).not.toContain("sk-fake-secret-0000");
      expect(env).not.toContain("GITHUB_TOKEN");
      expect(env).toContain("LC_ALL=C");
      expect(env).toContain(`PATH=${process.env["PATH"]}`);
    } finally {
      delete process.env["D7_FAKE_SECRET"];
      delete process.env["GITHUB_TOKEN"];
      delete process.env["LC_ALL"];
    }
  });

  test("provider text never reaches the answer", async () => {
    const leak = "sk-fake-secret-1111";
    const cases: [string, string][] = [
      [`echo '{"protocol": "agent-browser.plugin.v1", "success": false, "error": "${leak}"}'`, "Credential provider vault returned an error"],
      [`echo '{"protocol": "${leak}", "success": true}'`, "Credential provider vault sent a malformed reply"],
      [`echo '${leak}'`, "Credential provider vault sent a malformed reply"],
      [`echo '{"protocol": "agent-browser.plugin.v1", "success": true, "data": {"password": "pw", "url": ["${leak}"]}}'`, "Credential provider vault sent a malformed reply"],
      [`echo '{"protocol": "agent-browser.plugin.v1", "success": true, "data": {"password": 7}}'`, "Credential provider vault sent a malformed reply"],
    ];
    for (const [body, said] of cases) {
      const error = (await credential(provider(`cat > /dev/null; ${body}`), "vault", "i", null).catch((thrown: unknown) => thrown)) as BrowseError;
      expect(error).toBeInstanceOf(BrowseError);
      expect(error.text).toBe(said);
      expect(JSON.stringify([error.text, error.data])).not.toContain(leak);
    }
  });

  test("a well-formed reply keeps only the known string fields", async () => {
    const root = provider(`cat > /dev/null; echo '{"protocol": "agent-browser.plugin.v1", "success": true, "data": {"password": "pw", "username": "u", "url": "https://x.example", "extra": 1}}'`);
    expect({ ...(await credential(root, "vault", "i", null)) }).toEqual({ password: "pw", username: "u", url: "https://x.example" });
  });
});

describe("permission grants compose", () => {
  test("each permission is its own override, so a later grant keeps the earlier ones", async () => {
    const sent: [string, unknown][] = [];
    const browser = { send: async (method: string, params: unknown) => (sent.push([method, params]), {}) };
    await allow(browser as never, "https://a.example", ["geolocation"]);
    await allow(browser as never, "https://a.example", ["notifications", "clipboard", "clipboard"]);
    expect(sent.map(([method]) => method)).toEqual(Array(4).fill("Browser.setPermission"));
    expect(sent.map(([, params]) => (params as { permission: { name: string } }).permission.name)).toEqual(["geolocation", "notifications", "clipboard-read", "clipboard-write"]);
  });
});

describe("init-script files", () => {
  test("a FIFO is refused at once instead of blocking the daemon", async () => {
    const dir = tempDir();
    const fifo = path.join(dir, "pipe.js");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    const started = performance.now();
    await expect(readScript(fifo)).rejects.toThrow(`--init-script ${fifo} isn't a regular file`);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("an oversized script is refused, a missing one reads like Python", async () => {
    const dir = tempDir();
    const big = path.join(dir, "big.js");
    fs.writeFileSync(big, Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));
    await expect(readScript(big)).rejects.toThrow("is over 4 MB");
    await expect(readScript(path.join(dir, "none.js"))).rejects.toThrow(`[Errno 2] No such file or directory: '${dir}/none.js'`);
  });

  test("decoding keeps a BOM and turns CRLF and CR into LF, as Python's text read does", () => {
    expect(decodeScript(Buffer.from("\ufeffa\r\nb\rc\n", "utf8"), "x")).toBe("\ufeffa\nb\nc\n");
  });
});

describe("cdp params on the wire", () => {
  test("integers past 2^53 are sent exactly", () => {
    const params = buildParams('{"n": 123456789012345678901234567890, "m": -9007199254740993, "s": 1, "f": 1.5}', [], "");
    expect(JSON.stringify(wireParams(params as never))).toBe('{"n":123456789012345678901234567890,"m":-9007199254740993,"s":1,"f":1.5}');
  });

  test("a __proto__ param is an ordinary key", () => {
    const given = parseParams(["__proto__=x", "q=1"]);
    expect(Object.hasOwn(given, "__proto__")).toBe(true);
    expect(given["__proto__"]).toBe("x");
  });
});

describe("credentials never echoed", () => {
  test("auth login's errors on the provider path never carry the password or provider text", async () => {
    const secret = "sk-d7-login-secret-91c2";
    const root = tempDir();
    const dir = path.join(root, "bin");
    fs.mkdirSync(dir);
    const command = stub(dir, "provider", `cat > /dev/null; echo '{"protocol": "agent-browser.plugin.v1", "success": true, "data": {"password": "${secret}", "url": "https://x.example/"}}'`);
    closeFd(browseDir(root));
    saveRegistry(root, [{ name: "vault", package: "p", version: "1", spec: "p@1", command, capabilities: ["credential.read"] }]);
    const page = { mainFrame: "F", frames: new Map([["F", { origin: "https://x.example" }]]), refreshFrames: async () => new Map() };
    const state = { dataRoot: root, locate: async () => { throw new BrowseError(`nothing typed ${secret}`); } };
    const realLogin = { ...loginHooks };
    loginHooks.actions = { typeInto: async () => {}, click: async () => {}, pressEnter: async () => {} };
    loginHooks.currentOrNew = async () => page as never;
    try {
      const error = (await login({ state, options: {}, humanize: false, timeout: 0.3 } as never, ["prof", "--credential-provider", "vault"]).catch((thrown: unknown) => thrown)) as BrowseError;
      expect(error).toBeInstanceOf(BrowseError);
      expect(JSON.stringify([error.text, error.data, error.code])).not.toContain(secret);
    } finally {
      Object.assign(loginHooks, realLogin);
    }
  });

  test("set credentials' errors never carry the password", async () => {
    const secret = "sk-d7-set-secret-4b1e";
    const state = { page: async () => { throw new BrowseError("no tab"); } };
    for (const argv of [["credentials", "alice", secret], ["credentials", secret], ["auth", "-x", secret]]) {
      const error = (await cmdSet({ state, options: {} } as never, argv).catch((thrown: unknown) => thrown)) as BrowseError;
      expect(JSON.stringify([error.text, error.data])).not.toContain(secret);
    }
  });
});
