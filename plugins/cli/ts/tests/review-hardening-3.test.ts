import "./libc-loaded.ts";
import { fakeKeychain } from "./fake-keychain.ts";
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { login, loginHooks, save, tools, withProfileLock } from "../src/browse/auth/vault.ts";
import { withSignal } from "../src/browse/cdp/cancel.ts";
import { safeCode } from "../src/browse/codes.ts";
import { parseConfig } from "../src/browse/daemon/config.ts";
import { Daemon } from "../src/browse/daemon/server.ts";
import { closeFd } from "../src/browse/paths.ts";
import { MASKED, maskEchoes } from "../src/browse/snapshot/mask.ts";
import { Node } from "../src/browse/snapshot/tree.ts";
import { EVICT_TOKEN, withRegistry } from "../src/browse/session.ts";
import { dumps } from "../src/json.ts";
import { addVaultSecret, clearSecrets, redact, redactJson } from "../src/redact.ts";
import { save as saveOut } from "../src/browse/outfile.ts";
import { config, quietWatchdog, type Scratch, scratch } from "./m3/daemon-helpers.ts";

setDefaultTimeout(30_000);
const temps: string[] = [];
const made: Scratch[] = [];
afterAll(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  for (const found of made.splice(0)) found.done();
});
afterEach(() => clearSecrets());

function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ardia-review3-")));
  fs.chmodSync(dir, 0o700);
  temps.push(dir);
  return dir;
}

const noPrompt = async () => "";
const SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("login reads one locked snapshot of the profile", () => {
  test("metadata, password and TOTP secret are read together, after a concurrent save lets go", async () => {
    const dir = tempDir();
    const data = path.join(dir, "data");
    fs.mkdirSync(data, { mode: 0o700 });
    const keychain = fakeKeychain(dir);
    const finds = () => keychain.log().filter((line) => line.startsWith("find ")).length;
    const beforeTool = tools.security;
    const beforePage = loginHooks.currentOrNew;
    tools.security = keychain.tool;
    try {
      await save(data, "acme", { url: "https://acme.example/login", password_stdin: true, totp_stdin: true }, { stdin: () => `pw\n${SEED}\n`, isTTY: () => false, prompt: noPrompt });
      let released = false;
      const holder = withProfileLock(data, "acme", async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        released = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      let readsBeforeRelease = -1;
      loginHooks.currentOrNew = async () => {
        throw new Error("stop before the page");
      };
      const ctx = { state: { dataRoot: data }, humanize: false, timeout: 5, options: {} } as never;
      const attempt = login(ctx, ["acme"]).catch((error: unknown) => error);
      await new Promise((resolve) => setTimeout(resolve, 150));
      readsBeforeRelease = finds();
      await holder;
      const outcome = await attempt;
      expect(released).toBe(true);
      expect(readsBeforeRelease).toBe(0);
      expect((outcome as Error).message).toBe("stop before the page");
      expect(finds()).toBe(1);
    } finally {
      tools.security = beforeTool;
      loginHooks.currentOrNew = beforePage;
    }
  });
});

describe("an eviction close checks its reservation inside the daemon", () => {
  test("a stale token is refused with session_busy, the current one closes", async () => {
    const found = scratch();
    made.push(found);
    const daemon = quietWatchdog(new Daemon(parseConfig(dumps(config(found.data, "a-victim", {}, 9), "spaced"))));
    try {
      const token = Math.trunc(Date.now() / 1000) * 1000 + 42;
      withRegistry({ fd: daemon.dirFd }, (registry) => ({ registry: { ...registry, sessions: { [daemon.key]: 1 }, reserved: { [daemon.key]: token } }, value: null }));
      const stale = await withSignal(null, () => daemon.execute({ argv: ["close"], options: { json: true, [EVICT_TOKEN]: String(token + 1) } }));
      expect(stale[0]).toBe(1);
      expect(stale[1]).toContain('"code":"session_busy"');
      expect(daemon.stopping).toBe(false);
      const current = await withSignal(null, () => daemon.execute({ argv: ["close"], options: { [EVICT_TOKEN]: String(token) } }));
      expect(current[0]).toBe(0);
      expect(daemon.stopping).toBe(true);
    } finally {
      closeFd(daemon.lockFd);
    }
  });
});

describe("short secrets in snapshots and JSON", () => {
  test("3- and 4-character secrets are masked as whole words, numeric or not", () => {
    const echo = new Node("StaticText", "pin abc, abcd and xabc; code 4321 vs 54321");
    maskEchoes([echo], ["abc", "4321"]);
    expect(echo.name).toBe(`pin ${MASKED}, abcd and xabc; code ${MASKED} vs 54321`);
    const long = new Node("StaticText", "tokenhunter22x");
    maskEchoes([long], ["hunter22"]);
    expect(long.name).toBe(`token${MASKED}x`);
  });

  test("a one-character secret leaves a JSON --out file valid", () => {
    addVaultSecret("e");
    addVaultSecret("2");
    for (const text of ["true\n", "false", "null", "12\n", " 3.25e2 ", '"value"', "[true, 12, null]", '{"a": 12, "b": false}']) {
      const out = redactJson(text);
      expect(() => JSON.parse(out)).not.toThrow();
    }
    expect(redactJson("true\n")).toBe("true\n");
    expect(JSON.parse(redactJson("12\n"))).toBe("***");
    const file = path.join(tempDir(), "value.json");
    saveOut(file, "12\n");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toBe("***");
    expect(redact("12")).toBe("1***");
  });
});

describe("error codes", () => {
  test("profile_busy and session_busy survive to --json", () => {
    expect(safeCode("profile_busy")).toBe("profile_busy");
    expect(safeCode("session_busy")).toBe("session_busy");
  });
});
