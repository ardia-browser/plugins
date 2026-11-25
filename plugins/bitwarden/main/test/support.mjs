import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bundleForTests } from "../build.mjs";

export const sdk = await bundleForTests(fileURLToPath(new URL("./entry.ts", import.meta.url)));

export const manifest = JSON.parse(readFileSync(new URL("../../plugin.json", import.meta.url), "utf8"));

export const GUID = "11111111-2222-3333-4444-555555555555";
export const OTHER_GUID = "66666666-7777-8888-9999-aaaaaaaaaaaa";
export const PASSWORD = "fixture-pw-1";
export const SESSION_KEY = "fixture-session-key-0001";
export const STORED_SESSION = "fixture-stored-session-0001";
export const CLIENT_SECRET = "fixture-client-secret-1";
export const SIGNED_OUT = JSON.stringify({ serverUrl: null, status: "unauthenticated" });
export const LOCKED = JSON.stringify({ serverUrl: null, userEmail: "me@example.com", status: "locked" });
export const UNLOCKED = JSON.stringify({ serverUrl: null, userEmail: "me@example.com", status: "unlocked" });

export const login = (overrides = {}, loginOverrides = {}) => ({
  id: GUID,
  type: 1,
  name: "Example",
  revisionDate: "2026-01-02T03:04:05.000Z",
  login: { username: "me", password: PASSWORD, uris: [{ uri: "https://example.com", match: null }], ...loginOverrides },
  ...overrides,
});

export function fakeCli(routes) {
  return (launch) => {
    const line = launch.argv.join(" ");
    for (const [pattern, reply] of routes) {
      if (typeof pattern === "string" ? line === pattern || line.startsWith(`${pattern} `) : pattern.test(line)) {
        return typeof reply === "function" ? reply(launch) : reply;
      }
    }
    return { status: 64, stderr: `unknown command: ${line}` };
  };
}

export function harness(routes, context = {}, extra = {}) {
  return sdk.createCredentialHarness({ provider: sdk.bitwarden, manifest: extra.manifest ?? manifest, cli: fakeCli(routes), context });
}

export const unlockedContext = (more = {}) => ({ session: { key: SESSION_KEY }, scratch: { syncedAt: String(Date.now()) }, ...more });

export async function listAll(h) {
  const items = [];
  let snapshot = null;
  let cursor = null;
  let pages = 0;
  for (;;) {
    const answer = await h.call("list", { snapshot, cursor });
    if (!answer.ok) return { answer, items, pages };
    pages += 1;
    items.push(...answer.result.items);
    snapshot = answer.result.snapshot;
    cursor = answer.result.cursor ?? null;
    if (cursor === null) return { answer, items, pages };
  }
}

export const argvOf = (h) => h.launches.map((launch) => launch.argv.join(" "));
