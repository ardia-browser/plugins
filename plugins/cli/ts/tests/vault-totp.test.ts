import "./libc-loaded.ts";
import { fakeKeychain } from "./fake-keychain.ts";
import { readCredentials, recordAccount } from "../src/browse/auth/vault.ts";
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { base32Decode, freshCode, hotp, parseSeed, totpAt, type Clock } from "../src/browse/auth/totp.ts";
import { OTP_FIELDS, save, splitDigits, splitSecrets, tools } from "../src/browse/auth/vault.ts";
import { BrowseError } from "../src/browse/daemon-errors.ts";
import { maskSensitive, MASKED, sensitiveFacts, type FieldFacts } from "../src/browse/snapshot/mask.ts";
import { Node } from "../src/browse/snapshot/tree.ts";

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ardia-totp-")));
  fs.chmodSync(dir, 0o700);
  temps.push(dir);
  return dir;
}

const SHA1_SEED = { secret: Buffer.from("12345678901234567890"), digits: 8, period: 30, algorithm: "SHA1" };
const SHA256_SEED = { secret: Buffer.from("12345678901234567890123456789012"), digits: 8, period: 30, algorithm: "SHA256" };
const SHA512_SEED = { secret: Buffer.from("1234567890123456789012345678901234567890123456789012345678901234"), digits: 8, period: 30, algorithm: "SHA512" };

describe("one-time codes", () => {
  test("HOTP matches the RFC 4226 test values", () => {
    const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
    expected.forEach((code, counter) => expect(hotp(Buffer.from("12345678901234567890"), counter)).toBe(code));
  });

  test("TOTP matches the RFC 6238 test values for SHA-1, SHA-256 and SHA-512", () => {
    const rows: [number, string, string, string][] = [
      [59, "94287082", "46119246", "90693936"],
      [1111111109, "07081804", "68084774", "25091201"],
      [1111111111, "14050471", "67062674", "99943326"],
      [1234567890, "89005924", "91819424", "93441116"],
      [2000000000, "69279037", "90698825", "38618901"],
      [20000000000, "65353130", "77737706", "47863826"],
    ];
    for (const [time, sha1, sha256, sha512] of rows) {
      expect(totpAt(SHA1_SEED, time)).toBe(sha1);
      expect(totpAt(SHA256_SEED, time)).toBe(sha256);
      expect(totpAt(SHA512_SEED, time)).toBe(sha512);
    }
  });

  test("base32 secrets and otpauth links parse", () => {
    expect(base32Decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ").toString()).toBe("12345678901234567890");
    expect(base32Decode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq").toString()).toBe("12345678901234567890");
    const seed = parseSeed("otpauth://totp/Acme:ana?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Acme&digits=8&period=30&algorithm=SHA1");
    expect(seed.digits).toBe(8);
    expect(totpAt(seed, 59)).toBe("94287082");
    expect(() => parseSeed("otpauth://hotp/x?secret=GEZDGNBVGY3TQOJQ")).toThrow(BrowseError);
    expect(() => parseSeed("not base32 !!")).toThrow(BrowseError);
    expect(() => parseSeed("GEZDG")).toThrow(BrowseError);
  });

  test("a code with under 5 s left waits for the next window", async () => {
    const seed = parseSeed("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    let now = 1_000_000_017;
    const slept: number[] = [];
    const clock: Clock = { now: () => now, sleep: async (seconds) => { slept.push(seconds); now += seconds; } };
    const late = await freshCode(seed, clock);
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeCloseTo(3.05, 5);
    expect(late.code).toBe(totpAt(seed, 1_000_000_020));
    expect(late.remaining).toBeGreaterThanOrEqual(29);
    now = 1_000_000_005;
    const early = await freshCode(seed, clock);
    expect(slept).toHaveLength(1);
    expect(early.code).toBe(totpAt(seed, 1_000_000_005));
    expect(early.waited).toBe(0);
  });
});

describe("split one-digit boxes", () => {
  test("a six-box code goes one digit per box", () => {
    expect(splitDigits("042917", 6)).toEqual(["0", "4", "2", "9", "1", "7"]);
    expect(splitDigits("042917", 1)).toEqual(["042917"]);
    expect(() => splitDigits("042917", 4)).toThrow(BrowseError);
  });

  type Fake = Record<string, unknown> & { parentElement: FakeHolder | null };
  type FakeHolder = { parentElement: FakeHolder | null; inputs: Fake[]; querySelectorAll: () => Fake[]; contains: (node: Fake | FakeHolder) => boolean };

  function holder(parent: FakeHolder | null = null): FakeHolder {
    const made: FakeHolder = {
      parentElement: parent,
      inputs: [],
      querySelectorAll: () => made.inputs,
      contains: (node) => {
        for (let at: FakeHolder | null = node.parentElement; at !== null; at = at.parentElement) if (at === made) return true;
        return node === made;
      },
    };
    return made;
  }

  function input(parent: FakeHolder, fields: Record<string, unknown>): Fake {
    const made: Fake = { type: "text", maxLength: -1, disabled: false, readOnly: false, name: "", id: "", placeholder: "", autocomplete: "", labels: [], getAttribute: () => null, parentElement: parent, ...fields };
    for (let at: FakeHolder | null = parent; at !== null; at = at.parentElement) at.inputs.push(made);
    return made;
  }

  function detect(all: Fake[], digits = 6): Fake[] {
    const document = { querySelectorAll: () => all, body: {}, documentElement: {} };
    const run = new Function("document", "ardiaBrowse", "digits", `return (${OTP_FIELDS})(digits);`) as (document: unknown, browse: unknown, digits: number) => Fake[];
    return run(document, { visible: () => true }, digits);
  }

  test("six maxlength-1 boxes sharing one container are found in order", () => {
    const page = holder();
    const row = holder(page);
    const email = input(page, { name: "email", type: "email" });
    const boxes = Array.from({ length: 6 }, (_, index) => input(row, { maxLength: 1, type: "tel", id: `d${index}` }));
    expect(detect([email, ...boxes])).toEqual(boxes);
  });

  test("boxes wrapped one per cell still group", () => {
    const page = holder();
    const row = holder(page);
    const boxes = Array.from({ length: 6 }, (_, index) => input(holder(row), { maxLength: 1, id: `c${index}` }));
    expect(detect(boxes)).toEqual(boxes);
  });

  test("a split group must have exactly the code's digit count and a container of its own", () => {
    const page = holder();
    const four = Array.from({ length: 4 }, () => input(holder(page), { maxLength: 1 }));
    expect(detect(four)).toEqual([]);
    expect(detect(four, 4)).toEqual(four);
    const crowded = holder();
    const row = holder(crowded);
    const boxes = Array.from({ length: 6 }, () => input(row, { maxLength: 1 }));
    const extra = input(row, { name: "note" });
    expect(detect([...boxes, extra])).toEqual([]);
  });

  test("an explicit one-time-code field or a named code field wins over a box group", () => {
    const page = holder();
    const row = holder(page);
    const boxes = Array.from({ length: 6 }, () => input(row, { maxLength: 1 }));
    const coded = input(page, { autocomplete: "one-time-code" });
    expect(detect([...boxes, coded])).toEqual([coded]);
    const page2 = holder();
    const row2 = holder(page2);
    const boxes2 = Array.from({ length: 6 }, () => input(row2, { maxLength: 1 }));
    const named = input(page2, { name: "otp_code", type: "tel" });
    expect(detect([...boxes2, named])).toEqual([named]);
  });

  test("a single field is found by autocomplete, then by its name", () => {
    const page = holder();
    const plain = input(page, { name: "q" });
    const coded = input(page, { autocomplete: "one-time-code" });
    expect(detect([plain, coded])).toEqual([coded]);
    const page2 = holder();
    const named = input(page2, { name: "otp_code", type: "tel" });
    expect(detect([input(page2, { name: "search" }), named])).toEqual([named]);
    expect(detect([input(holder(), { name: "search" })])).toEqual([]);
  });
});

describe("saving a TOTP secret", () => {
  test("--totp-stdin with --password-stdin reads two lines and stores both", async () => {
    const dir = tempDir();
    const data = path.join(dir, "data");
    fs.mkdirSync(data, { mode: 0o700 });
    const keychain = fakeKeychain(dir);
    const before = tools.security;
    tools.security = keychain.tool;
    try {
      const meta = await save(
        data,
        "acme",
        { url: "https://acme.example/login", username: "ana", password_stdin: true, totp_stdin: true },
        { stdin: () => "pw-1\nGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ\n", isTTY: () => false, prompt: async () => "" },
      );
      expect(meta["totp"]).toEqual({ digits: 6, period: 30, algorithm: "SHA1" });
      expect(keychain.log().filter((line) => line.startsWith("add "))).toEqual([`add ${recordAccount(data, "acme", meta["generation"] as string)}`]);
      expect(await readCredentials(data, "acme", meta)).toEqual({ password: "pw-1", totp: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" });
    } finally {
      tools.security = before;
    }
  });

  test("splitting stdin needs both lines", () => {
    expect(splitSecrets("pw\r\nSEED\n", true, true)).toEqual({ password: "pw", totp: "SEED" });
    expect(splitSecrets("SEED\n", false, true)).toEqual({ password: null, totp: "SEED" });
    expect(() => splitSecrets("only-one", true, true)).toThrow();
  });
});

describe("snapshot masking", () => {
  function field(name: string, value: string, extra: [string, unknown][] = []): Node {
    const node = new Node("textbox", name, value, new Map(extra), 7);
    node.frame = "F";
    return node;
  }

  test("sensitive fields are masked by name, autocomplete or type, and their echoes too", async () => {
    const password = field("Password", "hunter22");
    const card = field("Card number", "4242424242424242");
    const cvc = field("CVC", "123");
    const otp = field("Enter code", "918273");
    const email = field("Email", "ana@example.com");
    const echo = new Node("StaticText", "Your code 918273 was sent");
    const facts = new Map<Node, FieldFacts | null>([
      [otp, { type: "text", autocomplete: "one-time-code", said: "" }],
      [email, { type: "email", autocomplete: "email", said: "email" }],
    ]);
    const masked = await maskSensitive([password, card, cvc, otp, email, echo], async (node) => facts.get(node) ?? { type: "text", autocomplete: "", said: "" });
    expect(masked).toBe(4);
    expect([password.value, card.value, cvc.value, otp.value]).toEqual([MASKED, MASKED, MASKED, MASKED]);
    expect(email.value).toBe("ana@example.com");
    expect(echo.name).toBe(`Your code ${MASKED} was sent`);
  });

  test("a field whose facts can't be read is masked", async () => {
    const unknown = field("Notes", "anything");
    const failing = field("Other", "value");
    await maskSensitive([unknown, failing], async (node) => {
      if (node === unknown) return null;
      throw new BrowseError("gone");
    });
    expect([unknown.value, failing.value]).toEqual([MASKED, MASKED]);
  });

  test("facts decide on type, autocomplete and the field's own words", () => {
    expect(sensitiveFacts({ type: "password" })).toBe(true);
    expect(sensitiveFacts({ autocomplete: "section-pay cc-csc" })).toBe(true);
    expect(sensitiveFacts({ said: "cardNumber" })).toBe(true);
    expect(sensitiveFacts({ said: "card_number" })).toBe(true);
    expect(sensitiveFacts({ said: "security-code" })).toBe(true);
    expect(sensitiveFacts({ said: "search" })).toBe(false);
    expect(sensitiveFacts({ secure: true })).toBe(true);
  });
});

describe("sensitive words stand alone", () => {
  test("short words need their own boundaries", async () => {
    const { SENSITIVE_NAME } = await import("../src/browse/snapshot/mask.ts");
    for (const said of ["PIN", "otp_code", "Card no", "cvv2", "2FA code", "mfa-token", "user ssn", "One-time code", "pwd"]) expect(SENSITIVE_NAME.test(said)).toBe(true);
    for (const said of ["spinner", "pinned", "notpad", "Nickname", "card note", "mfactory", "assn"]) expect(SENSITIVE_NAME.test(said)).toBe(false);
  });
});
