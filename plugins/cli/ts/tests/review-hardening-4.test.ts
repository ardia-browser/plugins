import "./libc-loaded.ts";
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadMeta, otpFrames, readCredentials, recordAccount, save, scopeOf, storeSecret, tools, totpAccount } from "../src/browse/auth/vault.ts";
import { withSignal } from "../src/browse/cdp/cancel.ts";
import { saveText } from "../src/browse/commands/batch.ts";
import { parseConfig } from "../src/browse/daemon/config.ts";
import { TabScheduler } from "../src/browse/daemon/scheduler.ts";
import { Daemon } from "../src/browse/daemon/server.ts";
import { content, save as saveOut } from "../src/browse/outfile.ts";
import { closeFd, writePrivateJson } from "../src/browse/paths.ts";
import { type AutoRegistry, EVICT_TOKEN, RESERVATION_TTL, reservationHolds, useAutoSession, withRegistry } from "../src/browse/session.ts";
import { MASKED, maskEchoes } from "../src/browse/snapshot/mask.ts";
import { Node } from "../src/browse/snapshot/tree.ts";
import { dumps, type Value } from "../src/json.ts";
import { addVaultSecret, clearSecrets } from "../src/redact.ts";
import { fakeKeychain } from "./fake-keychain.ts";
import { config, quietWatchdog, type Scratch, scratch } from "./m3/daemon-helpers.ts";

setDefaultTimeout(30_000);
const temps: string[] = [];
const made: Scratch[] = [];
const originalTool = tools.security;
afterAll(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  for (const found of made.splice(0)) found.done();
});
afterEach(() => {
  clearSecrets();
  tools.security = originalTool;
});

function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ardia-review4-")));
  fs.chmodSync(dir, 0o700);
  temps.push(dir);
  return dir;
}

function dataDir(parent: string, name: string): string {
  const data = path.join(parent, name);
  fs.mkdirSync(data, { mode: 0o700 });
  return data;
}

const noPrompt = async () => "";
const SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const piped = (text: string) => ({ stdin: () => text, isTTY: () => false, prompt: noPrompt });

describe("Keychain records are scoped to the data folder and published atomically", () => {
  test("two data folders with the same profile name keep separate secrets", async () => {
    const dir = tempDir();
    const keychain = fakeKeychain(dir);
    tools.security = keychain.tool;
    const first = dataDir(dir, "one");
    const second = dataDir(dir, "two");
    await save(first, "acme", { url: "https://acme.example/login", password_stdin: true }, piped("pw-one\n"));
    await save(second, "acme", { url: "https://acme.example/login", password_stdin: true }, piped("pw-two\n"));
    expect(scopeOf(first)).not.toBe(scopeOf(second));
    expect((await readCredentials(first, "acme", loadMeta(first, "acme"))).password).toBe("pw-one");
    expect((await readCredentials(second, "acme", loadMeta(second, "acme"))).password).toBe("pw-two");
    expect(keychain.items()).toHaveLength(2);
  });

  test("a new save replaces the old record only after its metadata is committed", async () => {
    const dir = tempDir();
    const keychain = fakeKeychain(dir);
    tools.security = keychain.tool;
    const data = dataDir(dir, "data");
    await save(data, "acme", { url: "https://acme.example/login", password_stdin: true, totp_stdin: true }, piped(`pw-1\n${SEED}\n`));
    const first = loadMeta(data, "acme");
    const authFolder = path.join(data, "Browse", "auth");
    fs.chmodSync(authFolder, 0o500);
    try {
      await expect(save(data, "acme", { url: "https://other.example/login", password_stdin: true }, piped("pw-2\n"))).rejects.toThrow();
    } finally {
      fs.chmodSync(authFolder, 0o700);
    }
    const kept = loadMeta(data, "acme");
    expect(kept["generation"]).toBe(first["generation"]);
    expect(await readCredentials(data, "acme", kept)).toEqual({ password: "pw-1", totp: SEED });
    expect(keychain.items()).toEqual([recordAccount(data, "acme", first["generation"] as string)]);
    await save(data, "acme", { totp_stdin: true }, piped(`${SEED}\n`));
    const next = loadMeta(data, "acme");
    expect(next["generation"]).not.toBe(first["generation"]);
    expect(keychain.items()).toEqual([recordAccount(data, "acme", next["generation"] as string)]);
    expect(await readCredentials(data, "acme", next)).toEqual({ password: "pw-1", totp: SEED });
  });

  test("a failed Keychain write leaves the old profile whole", async () => {
    const dir = tempDir();
    const keychain = fakeKeychain(dir);
    tools.security = keychain.tool;
    const data = dataDir(dir, "data");
    await save(data, "acme", { url: "https://acme.example/login", password_stdin: true }, piped("pw-1\n"));
    const refusing = path.join(dir, "refusing");
    fs.writeFileSync(refusing, "#!/bin/sh\ncat > /dev/null\necho 'security: SecKeychainItemCreateFromContent: returned -25299' >&2\n", { mode: 0o700 });
    tools.security = refusing;
    await expect(save(data, "acme", { url: "https://evil.example/login", password_stdin: true }, piped("pw-2\n"))).rejects.toThrow("refused");
    tools.security = keychain.tool;
    const kept = loadMeta(data, "acme");
    expect(kept["origins"]).toEqual(["https://acme.example"]);
    expect((await readCredentials(data, "acme", kept)).password).toBe("pw-1");
  });

  test("a profile saved before records existed is read and then migrated", async () => {
    const dir = tempDir();
    const keychain = fakeKeychain(dir);
    tools.security = keychain.tool;
    const data = dataDir(dir, "data");
    await save(data, "seed", { url: "https://acme.example/login", password_stdin: true }, piped("x\n"));
    const folder = fs.openSync(path.join(data, "Browse", "auth"), "r");
    try {
      const totp = new Map<string, Value>([["digits", 6n], ["period", 30n], ["algorithm", "SHA1"]]);
      writePrivateJson("acme.json", folder, new Map<string, Value>([["name", "acme"], ["url", "https://acme.example/login"], ["origins", ["https://acme.example"]], ["totp", totp], ["utf8", false]]));
    } finally {
      fs.closeSync(folder);
    }
    await storeSecret("acme", "legacy-pw");
    await storeSecret(totpAccount("acme"), SEED);
    expect(await readCredentials(data, "acme", loadMeta(data, "acme"))).toEqual({ password: "legacy-pw", totp: SEED });
    await save(data, "acme", { totp_stdin: true }, piped(`${SEED}\n`));
    const migrated = loadMeta(data, "acme");
    expect(typeof migrated["generation"]).toBe("string");
    expect(await readCredentials(data, "acme", migrated)).toEqual({ password: "legacy-pw", totp: SEED });
    expect(keychain.items()).toContain("acme");
    expect(keychain.items()).toContain(totpAccount("acme"));
  });
});

describe("JSON --out files stay valid after masking", () => {
  test("the top-level writer encodes a masked string result as JSON", () => {
    addVaultSecret("2");
    const file = path.join(tempDir(), "result.json");
    const [text] = content("eval", new Map<string, Value>([["result", "***"]]), file);
    saveOut(file, text);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toBe("***");
    const [raw] = content("eval", new Map<string, Value>([["result", '{"a": 1}']]), file);
    expect(raw).toBe('{"a": 1}');
    const [plain] = content("eval", new Map<string, Value>([["result", "***"]]), path.join(tempDir(), "result.txt"));
    expect(plain).toBe("***");
  });

  test("the batch writer keeps a masked number valid JSON", () => {
    addVaultSecret("2");
    const file = path.join(tempDir(), "line.json");
    const [text] = content("eval", new Map<string, Value>([["result", 12n]]), file);
    saveText(file, text);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toBe("***");
    const plain = path.join(tempDir(), "line.txt");
    saveText(plain, "12");
    expect(fs.readFileSync(plain, "utf8")).toBe("1***");
  });
});

describe("eviction reservations", () => {
  test("an expired reservation no longer holds", () => {
    const now = 10_000;
    const fresh = now * 1000 + 5;
    const old = (now - RESERVATION_TTL - 1) * 1000 + 5;
    const registry: AutoRegistry = { sessions: {}, evicted: {}, reserved: { k: fresh, j: old } };
    expect(reservationHolds(registry, "k", String(fresh), now)).toBe(true);
    expect(reservationHolds(registry, "j", String(old), now)).toBe(false);
  });

  test("the victim daemon refuses a close whose reservation expired while it waited", async () => {
    const found = scratch();
    made.push(found);
    const daemon = quietWatchdog(new Daemon(parseConfig(dumps(config(found.data, "a-old", {}, 9), "spaced"))));
    try {
      const token = (Math.trunc(Date.now() / 1000) - RESERVATION_TTL - 5) * 1000 + 7;
      withRegistry({ fd: daemon.dirFd }, (registry) => ({ registry: { ...registry, sessions: { [daemon.key]: 1 }, reserved: { [daemon.key]: token } }, value: null }));
      const answer = await withSignal(null, () => daemon.execute({ argv: ["close"], options: { json: true, [EVICT_TOKEN]: String(token) } }));
      expect(answer[0]).toBe(1);
      expect(answer[1]).toContain('"code":"session_busy"');
      expect(daemon.stopping).toBe(false);
    } finally {
      closeFd(daemon.lockFd);
    }
  });

  test("entries are daemon keys, so live daemons of other namespaces and endpoints are kept", () => {
    const registry: AutoRegistry = { sessions: { "key-other-namespace": 1, "key-other-endpoint": 2, "key-dead": 3 }, evicted: {} };
    const live = new Set(["key-other-namespace", "key-other-endpoint"]);
    const used = useAutoSession(registry, "key-mine", 10_000, (key) => live.has(key));
    expect(Object.keys(used.registry.sessions).sort()).toEqual(["key-mine", "key-other-endpoint", "key-other-namespace"]);
  });
});

describe("the scheduler", () => {
  test("an idle tab runs at once while another tab has a holder and a waiter", async () => {
    const lock = new TabScheduler();
    const held = await lock.enter(() => ["T1"]);
    const queued = lock.enter(() => ["T1"], 5);
    const started = performance.now();
    const idle = await lock.enter(() => ["T2"], 0.5);
    expect(idle).not.toBeNull();
    expect(performance.now() - started).toBeLessThan(100);
    idle?.release();
    held?.release();
    (await queued)?.release();
    expect(lock.locked).toBe(false);
  });

  test("a waiting browser-wide command still holds later tabs back", async () => {
    const lock = new TabScheduler();
    const held = await lock.enter(() => ["T1"]);
    const wide = lock.acquire(5);
    expect(await lock.enter(() => ["T2"], 0.1)).toBeNull();
    held?.release();
    expect(await wide).toBe(true);
    lock.release();
  });
});

describe("one-time code frames", () => {
  const page = (main: string, frames: [string, string][]) => ({ mainFrame: main, frames: new Map(frames.map(([id, origin]) => [id, { origin }])) }) as never;
  const allowed = new Set(["https://acme.example", "https://login.acme.example"]);

  test("allowed child frames are searched after the main frame", () => {
    expect(otpFrames(page("M", [["M", "https://acme.example"], ["C", "https://login.acme.example"], ["X", "https://ads.example"]]), allowed)).toEqual(["M", "C"]);
  });

  test("nothing is searched when the main frame isn't allowed", () => {
    expect(otpFrames(page("M", [["M", "https://evil.example"], ["C", "https://acme.example"]]), allowed)).toEqual([]);
  });
});

describe("short echo boundaries are Unicode-aware", () => {
  test("letters, marks, digits and underscores of any script join a short secret", () => {
    const echo = new Node("StaticText", "١123 abć abc_def abc def 123");
    maskEchoes([echo], ["123", "abc"]);
    expect(echo.name).toBe(`١123 abć abc_def ${MASKED} def ${MASKED}`);
  });
});
