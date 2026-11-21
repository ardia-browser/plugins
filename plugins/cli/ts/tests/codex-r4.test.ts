import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import "./libc-loaded.ts";
import { type JsonObject, object } from "../src/json.ts";
import { cleanEvent } from "../src/telemetry-schema.ts";
import { readConsent } from "../src/telemetry.ts";
import { cliVersion } from "../src/version.ts";
import * as control from "../src/control.ts";

const INSTALL = "0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0";
const scratch = fs.realpathSync(fs.mkdtempSync(path.join("/tmp", "codex-r4-")));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
let counter = 0;

function consentRoot(body: Buffer): string {
  counter += 1;
  const root = path.join(scratch, `c${counter}`);
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "telemetry.json"), body, { mode: 0o600 });
  return root;
}

const plain = (extra = "") => `{"sharing": true, "installId": "${INSTALL}"${extra}}`;

function withRawBytes(before: string, raw: number[], after: string): Buffer {
  return Buffer.concat([Buffer.from(before, "utf8"), Buffer.from(raw), Buffer.from(after, "utf8")]);
}

function utf16(text: string, bigEndian: boolean, swapIn?: [number, number]): Buffer {
  const units = [...Array(text.length).keys()].map((index) => text.charCodeAt(index));
  if (swapIn !== undefined) units.splice(swapIn[0], 1, swapIn[1]);
  const out = Buffer.alloc(units.length * 2);
  units.forEach((unit, index) => (bigEndian ? out.writeUInt16BE(unit, index * 2) : out.writeUInt16LE(unit, index * 2)));
  return out;
}

function utf32(codes: number[]): Buffer {
  const out = Buffer.alloc(codes.length * 4);
  codes.forEach((code, index) => out.writeUInt32LE(code, index * 4));
  return out;
}

describe("consent encoding", () => {
  test("raw UTF-8 surrogate bytes in an unrelated field give no consent", () => {
    const body = withRawBytes(`{"sharing": true, "installId": "${INSTALL}", "note": "`, [0xed, 0xa0, 0x80], `"}`);
    expect(readConsent(consentRoot(body))).toBeUndefined();
  });

  test("a paired surrogate encoded as two UTF-8 surrogates gives no consent", () => {
    const body = withRawBytes(`{"sharing": true, "installId": "${INSTALL}", "note": "`, [0xed, 0xa0, 0xbd, 0xed, 0xb8, 0x80], `"}`);
    expect(readConsent(consentRoot(body))).toBeUndefined();
  });

  test("BOM-less UTF-16 with a lone surrogate gives no consent", () => {
    const text = plain(`, "note": "x"`);
    const at = text.lastIndexOf("x");
    expect(readConsent(consentRoot(utf16(text, false, [at, 0xd800])))).toBeUndefined();
    expect(readConsent(consentRoot(utf16(text, true, [at, 0xdc00])))).toBeUndefined();
  });

  test("BOM-less UTF-32 with a surrogate code point gives no consent", () => {
    const text = plain(`, "note": "x"`);
    const codes = [...text].map((char) => char.codePointAt(0) as number);
    codes[text.lastIndexOf("x")] = 0xd800;
    expect(readConsent(consentRoot(utf32(codes)))).toBeUndefined();
  });

  test("well-formed UTF-8, UTF-16 and UTF-32 consent, astral characters included, is still read", () => {
    const text = plain(`, "note": "café \u{1f600}"`);
    expect(readConsent(consentRoot(Buffer.from(text, "utf8")))?.get("installId")).toBe(INSTALL);
    expect(readConsent(consentRoot(utf16(text, false)))?.get("installId")).toBe(INSTALL);
    expect(readConsent(consentRoot(utf16(text, true)))?.get("installId")).toBe(INSTALL);
    expect(readConsent(consentRoot(utf32([...text].map((char) => char.codePointAt(0) as number))))?.get("installId")).toBe(INSTALL);
  });
});

describe("cli_version at upload", () => {
  test("a record whose spooled cli_version is invalid still gets the running build's", () => {
    for (const spooled of ["not a version", "1.2", "", "9.9.9"]) {
      const record = object([
        ["event", "cli_command"],
        ["uuid", INSTALL],
        ["timestamp", "2026-11-20T12:00:00Z"],
        ["distinct_id", "local"],
        ["properties", object([["cli_version", spooled]])],
      ]);
      expect(((cleanEvent(record) as JsonObject).get("properties") as JsonObject).get("cli_version")).toBe(cliVersion());
    }
  });

  test("a record without cli_version doesn't gain one", () => {
    const record = object([
      ["event", "cli_command"],
      ["uuid", INSTALL],
      ["timestamp", "2026-11-20T12:00:00Z"],
      ["distinct_id", "local"],
      ["properties", object([["command", "tabs"]])],
    ]);
    expect(((cleanEvent(record) as JsonObject).get("properties") as JsonObject).has("cli_version")).toBe(false);
  });
});

describe("interrupt subscriptions", () => {
  test("each connection's subscription is its own, so one ending doesn't unsubscribe another", () => {
    const subscribe = (control as unknown as { interruptSubscription?: () => (wake: (() => void) | undefined) => void }).interruptSubscription;
    const wakeAll = (control as unknown as { wakeInterruptWaiters?: () => void }).wakeInterruptWaiters;
    expect(typeof subscribe).toBe("function");
    expect(typeof wakeAll).toBe("function");
    const first = (subscribe as () => (wake: (() => void) | undefined) => void)();
    const second = (subscribe as () => (wake: (() => void) | undefined) => void)();
    const woken: string[] = [];
    first(() => woken.push("first"));
    second(() => woken.push("second"));
    first(undefined);
    (wakeAll as () => void)();
    expect(woken).toEqual(["second"]);
    second(undefined);
    (wakeAll as () => void)();
    expect(woken).toEqual(["second"]);
  });
});
