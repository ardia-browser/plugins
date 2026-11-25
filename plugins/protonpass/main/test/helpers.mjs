import { readFileSync } from "node:fs";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { bundleForTests } from "../build.mjs";

export const subject = await bundleForTests(fileURLToPath(new URL("./entry.ts", import.meta.url)));
export const manifest = JSON.parse(readFileSync(new URL("../../plugin.json", import.meta.url), "utf8"));

export const PASSWORD = "fixture-password-Q7x!";
export const NEW_PASSWORD = "new-fixture-password-9Kz";
export const TOTP_URI = "otpauth://totp/Example:me?secret=JBSWY3DPEHPK3PXP&issuer=Example&period=30";

export const vaultsJson = (vaults) => JSON.stringify({ vaults });
export const VAULTS = vaultsJson([
  { name: "Work", share_id: "shareWork1" },
  { name: "Personal", share_id: "sharePersonal1" },
]);

export function entry({ id = "item0001", title = "Example", username = "me", email, password = PASSWORD, urls = ["https://example.com"], totp, extraTotp, autofill, state = "Active", modified = 1767323045 } = {}) {
  const login = { username, password, urls };
  if (email !== undefined) login.email = email;
  if (totp !== undefined) login.totp_uri = totp;
  if (autofill !== undefined) login.autofill_urls = autofill;
  const content = { title, content: { Login: login } };
  if (extraTotp !== undefined) content.extra_fields = [{ name: "2FA", content: { Totp: extraTotp } }];
  return { id, state, modify_time: modified, content };
}

export const itemsJson = (...entries) => JSON.stringify({ items: entries });

const globToRegex = (pattern) => new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);

export function fakeCli(rules) {
  const compiled = rules.map(([pattern, reply]) => [globToRegex(pattern), reply]);
  return (launch) => {
    const line = launch.argv.join(" ");
    for (const [pattern, reply] of compiled) {
      if (pattern.test(line)) return typeof reply === "function" ? reply(launch) : reply;
    }
    return { status: 2, stderr: `error: no fake rule for ${line}` };
  };
}

const mockClock = { now: () => Date.now(), tick: (ms) => mock.timers.tick(ms) };

export function harness(rules, context = {}) {
  return subject.createCredentialHarness({ provider: subject.provider, manifest, cli: fakeCli(rules), context: { session: { key: null }, ...context }, timers: mockClock });
}

export const argvOf = (h) => h.launches.map((launch) => launch.argv.join(" "));

export const unlocked = { session: { key: null } };
export const locked = { session: null };
