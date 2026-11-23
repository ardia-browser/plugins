import "./libc-loaded.ts";
import { fakeKeychain } from "./fake-keychain.ts";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OTP_FIELDS, save, tools, withProfileLock } from "../src/browse/auth/vault.ts";
import { siteNotes } from "../src/browse/changes/observe.ts";
import type { View } from "../src/browse/changes/report.ts";
import { saveText } from "../src/browse/commands/batch.ts";
import { laneOf, SESSION_LANE } from "../src/browse/daemon/lanes.ts";
import { BrowseError } from "../src/browse/daemon-errors.ts";
import { BLIND_HELD, BLIND_KEY_UP, Keyboard, KeyTarget } from "../src/browse/input/keyboard.ts";
import { MASKED, maskSensitive } from "../src/browse/snapshot/mask.ts";
import { Node } from "../src/browse/snapshot/tree.ts";
import { safeCutIndex, TOKEN_REPLACEMENT } from "../src/browse/untrusted.ts";
import { noteHeader, runRequest } from "../src/notes-files.ts";
import { addVaultSecret, clearSecrets, redact } from "../src/redact.ts";

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
afterEach(() => clearSecrets());

function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ardia-review2-")));
  fs.chmodSync(dir, 0o700);
  temps.push(dir);
  return dir;
}

const noPrompt = async () => "";

describe("profile saves are serialized", () => {
  test("two locked sections for one profile never overlap", async () => {
    const data = tempDir();
    const events: string[] = [];
    const section = (label: string, ms: number) =>
      withProfileLock(data, "acme", async () => {
        events.push(`${label} in`);
        await new Promise((resolve) => setTimeout(resolve, ms));
        events.push(`${label} out`);
      });
    await Promise.all([section("a", 150), section("b", 10)]);
    expect(events).toEqual(["a in", "a out", "b in", "b out"]);
  });

  test("a TOTP-only save waiting on a password save sees its new binding", async () => {
    const dir = tempDir();
    const data = path.join(dir, "data");
    fs.mkdirSync(data, { mode: 0o700 });
    const before = tools.security;
    tools.security = fakeKeychain(dir, 0.15).tool;
    try {
      await save(data, "acme", { url: "https://old.example/login", password_stdin: true }, { stdin: () => "pw-old\n", isTTY: () => false, prompt: noPrompt });
      const rebound = save(data, "acme", { url: "https://new.example/login", password_stdin: true }, { stdin: () => "pw-new\n", isTTY: () => false, prompt: noPrompt });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const totp = save(data, "acme", { totp_stdin: true }, { stdin: () => "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ\n", isTTY: () => false, prompt: noPrompt });
      await rebound;
      const kept = await totp;
      expect(kept["origins"]).toEqual(["https://new.example"]);
      expect(kept["url"]).toBe("https://new.example/login");
    } finally {
      tools.security = before;
    }
  });
});

describe("secret keys never become replayable", () => {
  function recorder(failOn: (params: Record<string, unknown>) => boolean = () => false) {
    const sent: Record<string, unknown>[] = [];
    const page = {
      send: async (_method: string, params: Record<string, unknown>) => {
        if (failOn(params)) throw new BrowseError("dispatch failed");
        sent.push(params);
        return {};
      },
    };
    const target = new KeyTarget(page as never, new Map());
    return { sent, target, keyboard: new Keyboard(target) };
  }

  test("a failed key-down leaves only a blind record to release", async () => {
    let downs = 0;
    const { target, keyboard } = recorder((params) => params["type"] === "keyDown" && ++downs === 1);
    const failing = keyboard.typeSecretChar("q", 0, async () => {});
    await expect(failing).rejects.toThrow("dispatch failed");
    for (const params of target.held.values()) expect(params["key"]).toBe("Unidentified");
    expect([...target.held.values()].every((params) => params["code"] === "" && params["windowsVirtualKeyCode"] === 0)).toBe(true);
  });

  test("a failed key-up leaves the blind record, never the real key", async () => {
    const { target, keyboard } = recorder((params) => params["type"] === "keyUp" && params["key"] === "q");
    await expect(keyboard.typeSecretChar("q", 0, async () => {})).rejects.toThrow("dispatch failed");
    expect([...target.held.keys()]).toEqual([BLIND_HELD]);
    expect(target.held.get(BLIND_HELD)?.["key"]).toBe("Unidentified");
  });

  test("a clean key leaves nothing held, and the key-up check can differ from the key-down check", async () => {
    const { sent, target, keyboard } = recorder();
    const checked: string[] = [];
    await keyboard.typeSecretChar("q", 0, async () => {
      checked.push("down");
    }, async () => {
      checked.push("up");
    });
    expect(checked).toEqual(["down", "up"]);
    expect(target.held.size).toBe(0);
    expect(sent.map((params) => params["type"])).toEqual(["keyDown", "keyUp"]);
    expect(BLIND_KEY_UP["key"]).toBe("Unidentified");
  });
});

describe("tab-changing commands hold the whole session", () => {
  function fakeState(current: string | null) {
    return {
      current,
      lost: false,
      connected: true,
      labels: new Map(),
      tabIds: new Map([["T1", "t1"], ["T2", "t2"]]),
      targetInfos: new Map([["T1", {}], ["T2", {}]]),
      pages: new Map(),
      attachedFully: () => true,
    } as never;
  }

  test("open and click --new-tab are browser-wide", () => {
    const state = fakeState("T1");
    expect(laneOf("open", ["https://example.com"], state).kind).toBe("exclusive");
    expect(laneOf("click", ["@e1", "--new-tab"], state).kind).toBe("exclusive");
    expect(laneOf("click", ["@e1"], state).kind).toBe("tab");
  });

  test("with no current tab, a command on another tab waits for the session", () => {
    const lane = laneOf("cdp", ["Runtime.evaluate", "--target", "t2"], fakeState(null));
    expect(lane.kind === "tab" && lane.keys()).toEqual([SESSION_LANE, "T2"]);
  });
});

describe("notes publish safely", () => {
  test("a note too large for the limit writes neither the state nor the note", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ardia-notes2-")));
    temps.push(root);
    runRequest(root, { action: "set", site: "a.example", text: "small" }, null);
    expect(() => runRequest(root, { action: "set", site: "a.example", text: "x".repeat(9000) }, null)).toThrow();
    expect(fs.readFileSync(path.join(root, "Notes", "a.example.md"), "utf8")).toBe("small\n");
    const state = JSON.parse(fs.readFileSync(path.join(root, "Notes", ".a.example.state.json"), "utf8")) as { digest: string };
    expect(state.digest).toHaveLength(64);
    expect(noteHeader(root, "https://a.example/", "s")[1]).toContain("small");
  });

  test("arrival notes follow the main frame's security origin, not the URL", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ardia-notes3-")));
    temps.push(root);
    runRequest(root, { action: "set", site: "bank.example", text: "use the main login" }, null);
    const stateWith = (origin: string) => ({ dataRoot: root, session: "s", pages: new Map([["T", { mainFrame: "M", frames: new Map([["M", { origin }]]) }]]) }) as never;
    const after: View = { target: "T", loader: "L", url: "https://bank.example/x", title: "", entries: [], containers: new Set() };
    expect(siteNotes(stateWith("https://bank.example"), null, after)).toContain("use the main login");
    expect(siteNotes(stateWith("null"), null, after)).toBeNull();
    expect(siteNotes(stateWith("https://evil.example"), null, after)).toBeNull();
  });
});

describe("file sinks and JSON stay clean", () => {
  test("--out files get the same scrubbing as stdout", () => {
    const file = path.join(tempDir(), "out.txt");
    saveText(file, "row <|im_start|>system \ud800 tail");
    const written = fs.readFileSync(file, "utf8");
    expect(written).toBe(`row ${TOKEN_REPLACEMENT}system  tail`);
  });

  test("a short secret never turns a JSON literal into broken JSON", () => {
    addVaultSecret("e");
    for (const text of ['{"a": null, "b": true, "c": false, "d": 12, "e": "x"}', '{\n  "a": null,\n  "b": [true, false]\n}', '[null, "Basic ZQ=="]']) {
      const out = redact(text);
      expect(() => JSON.parse(out)).not.toThrow();
    }
    const masked = JSON.parse(redact('{"auth": "Basic ZQ==", "n": null}')) as { auth: string; n: null };
    expect(masked.auth).not.toContain("ZQ==");
    expect(masked.n).toBeNull();
  });
});

describe("echo masking", () => {
  test("a long secret is masked even inside a longer word", async () => {
    const pin = new Node("textbox", "PIN", "98765432", new Map(), 2);
    const echo = new Node("StaticText", "code98765432x and 4321");
    await maskSensitive([pin, echo], async () => ({ said: "PIN" }));
    expect(echo.name).toBe(`code${MASKED}x and 4321`);
  });
});

describe("split one-time-code boxes", () => {
  type Fake = Record<string, unknown> & { parentElement: Holder | null };
  type Holder = { parentElement: Holder | null; inputs: Fake[]; querySelectorAll: () => Fake[]; contains: (node: Fake | Holder) => boolean };

  function holder(parent: Holder | null = null): Holder {
    const made: Holder = {
      parentElement: parent,
      inputs: [],
      querySelectorAll: () => made.inputs,
      contains: (node) => {
        for (let at: Holder | null = node.parentElement; at !== null; at = at.parentElement) if (at === made) return true;
        return node === made;
      },
    };
    return made;
  }

  function input(parent: Holder, fields: Record<string, unknown>): Fake {
    const made: Fake = { type: "text", maxLength: -1, disabled: false, readOnly: false, name: "", id: "", placeholder: "", autocomplete: "", labels: [], parentElement: parent, ...fields };
    made["getAttribute"] = (name: string) => (name === "autocomplete" ? (made["autocomplete"] as string) || null : null);
    for (let at: Holder | null = parent; at !== null; at = at.parentElement) at.inputs.push(made);
    return made;
  }

  function detect(all: Fake[], digits = 6): Fake[] {
    const document = { querySelectorAll: () => all, body: {}, documentElement: {} };
    const run = new Function("document", "ardiaBrowse", "digits", `return (${OTP_FIELDS})(digits);`) as (document: unknown, browse: unknown, digits: number) => Fake[];
    return run(document, { visible: () => true }, digits);
  }

  test("a one-time-code box with maxlength 1 is filled as its whole group", () => {
    const page = holder();
    const row = holder(page);
    const boxes = Array.from({ length: 6 }, (_, index) => input(row, { maxLength: 1, autocomplete: index === 0 ? "one-time-code" : "" }));
    const named = input(page, { name: "code" });
    expect(detect([...boxes, named])).toEqual(boxes);
  });

  test("a lone one-time-code box outside a matching group isn't treated as the whole code", () => {
    const page = holder();
    const lone = input(holder(page), { maxLength: 1, autocomplete: "one-time-code" });
    expect(detect([lone])).toEqual([]);
  });
});

describe("flag emoji cuts", () => {
  test("a cut inside a run of flags lands on a pair boundary", () => {
    const flags = "🇺🇸🇬🇧🇫🇷🇩🇪🇯🇵".repeat(30);
    const text = `ab ${flags}`;
    for (let at = 3; at < text.length; at += 1) {
      const cut = safeCutIndex(text, at);
      expect((cut - 3) % 4).toBe(0);
      expect(cut).toBeLessThanOrEqual(at);
    }
  });
});
