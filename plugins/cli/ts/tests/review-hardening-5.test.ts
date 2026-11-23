import "./libc-loaded.ts";
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deleteSecret, frameOwnerFocused, loadMeta, readCredentials, remove, save, storeSecret, tools, totpAccount } from "../src/browse/auth/vault.ts";
import { render, Result } from "../src/browse/daemon/render.ts";
import { writePrivateJson } from "../src/browse/paths.ts";
import { saveAnswer, textForFile } from "../src/browse/save-answer.ts";
import { type AutoRegistry, useAutoSession, withoutSession } from "../src/browse/session.ts";
import { type Value } from "../src/json.ts";
import { addVaultSecret, clearSecrets, Secrets } from "../src/redact.ts";
import { fakeKeychain } from "./fake-keychain.ts";

setDefaultTimeout(30_000);
const temps: string[] = [];
const originalTool = tools.security;
afterAll(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  clearSecrets();
  tools.security = originalTool;
});

function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ardia-review5-")));
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

async function legacyProfile(data: string): Promise<void> {
  await save(data, "seed", { url: "https://acme.example/login", password_stdin: true }, piped("x\n"));
  const folder = fs.openSync(path.join(data, "Browse", "auth"), "r");
  try {
    const totp = new Map<string, Value>([["digits", 6n], ["period", 30n], ["algorithm", "SHA1"]]);
    writePrivateJson("acme.json", folder, new Map<string, Value>([["name", "acme"], ["url", "https://acme.example/login"], ["origins", ["https://acme.example"]], ["totp", totp], ["utf8", false]]));
  } finally {
    fs.closeSync(folder);
  }
}

describe("legacy profiles shared by two data folders", () => {
  test("migrating or deleting one folder's profile never breaks the other's", async () => {
    const dir = tempDir();
    const keychain = fakeKeychain(dir);
    tools.security = keychain.tool;
    const first = dataDir(dir, "one");
    const second = dataDir(dir, "two");
    await legacyProfile(first);
    await legacyProfile(second);
    await storeSecret("acme", "legacy-pw");
    await storeSecret(totpAccount("acme"), SEED);
    await save(first, "acme", { totp_stdin: true }, piped(`${SEED}\n`));
    expect(typeof loadMeta(first, "acme")["generation"]).toBe("string");
    expect(await readCredentials(second, "acme", loadMeta(second, "acme"))).toEqual({ password: "legacy-pw", totp: SEED });
    await remove(first, "acme");
    expect(await readCredentials(second, "acme", loadMeta(second, "acme"))).toEqual({ password: "legacy-pw", totp: SEED });
    await remove(second, "acme");
    expect(keychain.items()).toContain("acme");
    expect(keychain.items()).toContain(totpAccount("acme"));
  });
});

describe("Keychain deletions are checked", () => {
  test("a refused deletion keeps the profile and says so", async () => {
    const dir = tempDir();
    const keychain = fakeKeychain(dir);
    tools.security = keychain.tool;
    const data = dataDir(dir, "data");
    await save(data, "acme", { url: "https://acme.example/login", password_stdin: true }, piped("pw\n"));
    const refusing = path.join(dir, "refusing");
    fs.writeFileSync(refusing, "#!/bin/sh\ncat > /dev/null\necho 'security: SecKeychainItemDelete: returned -25244' >&2\n", { mode: 0o700 });
    tools.security = refusing;
    await expect(remove(data, "acme")).rejects.toThrow("refused to delete");
    expect(loadMeta(data, "acme")["name"]).toBe("acme");
  });

  test("an item that's already gone counts as deleted", async () => {
    const dir = tempDir();
    const missing = path.join(dir, "missing");
    fs.writeFileSync(missing, "#!/bin/sh\ncat > /dev/null\necho 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.' >&2\n", { mode: 0o700 });
    tools.security = missing;
    await expect(deleteSecret("gone")).resolves.toBeUndefined();
  });
});

describe("password rotation keeps the second factor", () => {
  test("a password-only save keeps the TOTP secret, and --no-totp drops it", async () => {
    const dir = tempDir();
    tools.security = fakeKeychain(dir).tool;
    const data = dataDir(dir, "data");
    await save(data, "acme", { url: "https://acme.example/login", password_stdin: true, totp_stdin: true }, piped(`pw-1\n${SEED}\n`));
    const rotated = await save(data, "acme", { url: "https://acme.example/login", password_stdin: true }, piped("pw-2\n"));
    expect(rotated["totp"]).toEqual({ digits: 6, period: 30, algorithm: "SHA1" });
    expect(await readCredentials(data, "acme", loadMeta(data, "acme"))).toEqual({ password: "pw-2", totp: SEED });
    const dropped = await save(data, "acme", { url: "https://acme.example/login", password_stdin: true, no_totp: true }, piped("pw-3\n"));
    expect(dropped["totp"]).toBeNull();
    expect(await readCredentials(data, "acme", loadMeta(data, "acme"))).toEqual({ password: "pw-3", totp: null });
  });
});

describe("get text --out to a .json file", () => {
  test("a masked scraped number is saved as a JSON string, unwrapped", () => {
    addVaultSecret("2");
    const [, wrapped] = render({ content_boundaries: true, out_only: true }, new Result({}, "12", true), null, "get");
    expect(wrapped).not.toContain("UNTRUSTED_PAGE_CONTENT");
    const file = path.join(tempDir(), "price.json");
    const answer = new Map<string, Value>([["exit", 0n], ["out", wrapped], ["err", ""]]);
    const printer = { out: () => {}, err: () => {} } as never;
    const call = { metrics: new Map(), noteErrorCode: () => {} } as never;
    saveAnswer(answer, new Secrets(), printer, call, "get", file);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toBe("1***");
    expect(textForFile("a.json", '{"a": 1}\n')).toBe('{"a": 1}\n');
    expect(textForFile("a.txt", "1***\n")).toBe("1***\n");
    expect(render({ content_boundaries: true }, new Result({}, "12", true), null, "get")[1]).toContain("UNTRUSTED_PAGE_CONTENT");
  });
});

describe("nested frame focus", () => {
  function chain(active: Record<string, number>) {
    const frames = new Map([
      ["M", { parent: null }],
      ["A", { parent: "M" }],
      ["B", { parent: "A" }],
    ]);
    const owners: Record<string, number> = { A: 1, B: 2 };
    return {
      mainFrame: "M",
      frames,
      sessionFor: () => null,
      send: async (_method: string, params: { frameId: string }) => ({ backendNodeId: owners[params.frameId] }),
      resolveBackend: async (id: number, frame: string) => ({ id, frame }),
      call: async (_fn: string, [element]: [{ id: number; frame: string }], options: { frame: string }) => active[options.frame] === element.id,
    } as never;
  }

  test("a field two frames deep is focused when each ancestor focuses the next frame", async () => {
    expect(await frameOwnerFocused(chain({ M: 1, A: 2 }), "B")).toBe(true);
    expect(await frameOwnerFocused(chain({ M: 1, A: 2 }), "A")).toBe(true);
  });

  test("a break anywhere in the chain fails", async () => {
    expect(await frameOwnerFocused(chain({ M: 2, A: 2 }), "B")).toBe(false);
    expect(await frameOwnerFocused(chain({ M: 1, A: 9 }), "B")).toBe(false);
  });
});

describe("the automatic session cap is strict", () => {
  function full(live: Set<string>): AutoRegistry {
    const sessions: Record<string, number> = {};
    for (let index = 0; index < 8; index += 1) {
      sessions[`k-${index}`] = 1000 + index;
      live.add(`k-${index}`);
    }
    return { sessions, evicted: {} };
  }

  test("two new sessions at once each evict exactly one other", () => {
    const live = new Set<string>();
    const first = useAutoSession(full(live), "k-x", 5000, (key) => live.has(key), 8, () => 5_000_001);
    expect(first.evict.map((victim) => victim.id)).toEqual(["k-0"]);
    const second = useAutoSession(first.registry, "k-y", 5001, (key) => live.has(key), 8, () => 5_001_002);
    expect(second.evict.map((victim) => victim.id)).toEqual(["k-1"]);
    expect(second.overCap).toBe(false);
  });

  test("with every other session starting, a new one is refused rather than over the cap", () => {
    const registry: AutoRegistry = { sessions: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`s-${index}`, 4990])), evicted: {} };
    const used = useAutoSession(registry, "s-new", 5000, () => false);
    expect(used.overCap).toBe(true);
    expect(Object.keys(used.registry.sessions)).toHaveLength(8);
  });

  test("a session that is already running or starting is never refused", () => {
    const live = new Set<string>();
    const registry = full(live);
    expect(useAutoSession(registry, "k-3", 5000, (key) => live.has(key)).overCap).toBe(false);
    const starting = { ...registry, sessions: { ...registry.sessions, "k-new": 4999 } };
    expect(useAutoSession(starting, "k-new", 5000, (key) => live.has(key)).overCap).toBe(false);
  });

  test("a caller whose victim refused withdraws its own registration", () => {
    const registry: AutoRegistry = { sessions: { a: 1, b: 2 }, evicted: {} };
    expect(Object.keys(withoutSession(registry, "b").sessions)).toEqual(["a"]);
  });
});
