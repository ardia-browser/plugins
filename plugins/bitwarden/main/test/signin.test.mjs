import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CLIENT_SECRET, LOCKED, PASSWORD, SESSION_KEY, SIGNED_OUT, STORED_SESSION, UNLOCKED, argvOf, harness } from "./support.mjs";

const EMAIL = "me@example.com";
const signedOut = ["status", { stdout: SIGNED_OUT }];
const passwordRequest = (h, more = {}) => ({ method: "password", step: "start", fields: { email: EMAIL, masterPassword: h.secret(PASSWORD) }, ...more });
const apiKeyRequest = (h, withPassword = true) => ({
  method: "apiKey",
  step: "start",
  fields: { clientId: h.secret("user.abc"), clientSecret: h.secret(CLIENT_SECRET), ...(withPassword ? { masterPassword: h.secret(PASSWORD) } : {}) },
});
const twoStepMethods = [
  { id: "0", title: "Authenticator App" },
  { id: "1", title: "Email", sendsCode: true },
  { id: "3", title: "YubiKey OTP" },
];

describe("state", () => {
  test("reads signed out, locked and unlocked from bw status", async () => {
    const out = await harness([signedOut]).call("state", { explicit: false });
    assert.deepEqual(out.result, { state: "signedOut", server: { preset: "us" } });
    const locked = await harness([["status", { stdout: LOCKED }]]).call("state", { explicit: false });
    assert.deepEqual(locked.result, { state: "locked", server: { preset: "us" }, account: EMAIL });
    const unlocked = await harness([["status", { stdout: UNLOCKED }]], { session: { key: SESSION_KEY } }).call("state", { explicit: false });
    assert.deepEqual(unlocked.result, { state: "unlocked", server: { preset: "us" }, account: EMAIL });
  });

  test("an unlocked bw without a session in Ardia is locked for Ardia", async () => {
    const answer = await harness([["status", { stdout: UNLOCKED }]]).call("state", { explicit: false });
    assert.equal(answer.result.state, "locked");
  });

  test("names the server: US and EU presets, or the self-hosted address", async () => {
    const server = async (serverUrl) => (await harness([["status", { stdout: JSON.stringify({ serverUrl, status: "locked" }) }]]).call("state", { explicit: false })).result.server;
    assert.deepEqual(await server("https://vault.bitwarden.com"), { preset: "us" });
    assert.deepEqual(await server("https://vault.bitwarden.eu"), { preset: "eu" });
    assert.deepEqual(await server("https://vault.example.com"), { url: "https://vault.example.com" });
  });

  test("an unreadable, crashed, outdated or missing bw is unavailable with the reason", async () => {
    const state = async (reply, launchFails = false) =>
      (await harness([["status", launchFails ? () => Promise.reject(new Error("no bw")) : reply]]).call("state", { explicit: true })).result;
    assert.deepEqual(await state({ stdout: "not json" }), { state: "unavailable", problem: "unreadable" });
    assert.deepEqual(await state({ status: 1, stderr: "node crashed" }), { state: "unavailable", problem: "failed", detail: "node crashed" });
    assert.deepEqual(await state({ status: 1, stderr: "error: unknown option '--nointeraction'" }), { state: "unavailable", problem: "outdated" });
    assert.deepEqual(await state(null, true), { state: "unavailable", problem: "notLaunched" });
  });
});

describe("sign in with email and master password", () => {
  test("keeps the session key bw prints, with a Touch ID copy, and never puts the password in argv", async () => {
    const h = harness([signedOut, ["login", { stdout: `${SESSION_KEY}\n` }]], { touchID: true });
    const answer = await h.call("signIn", passwordRequest(h));
    assert.deepEqual(answer, { ok: true, result: { ok: true } });
    assert.deepEqual(h.session, { key: SESSION_KEY });
    assert.equal(h.storedSession, SESSION_KEY);
    assert.deepEqual(argvOf(h), ["status --nointeraction", `login ${EMAIL} --passwordenv ARDIA_BW_PASSWORD --raw --nointeraction`]);
    assert.ok(!h.launches.some((launch) => launch.argv.join(" ").includes(PASSWORD)));
  });

  test("without Touch ID the session stays in memory only", async () => {
    const h = harness([signedOut, ["login", { stdout: SESSION_KEY }]]);
    await h.call("signIn", passwordRequest(h));
    assert.deepEqual(h.session, { key: SESSION_KEY });
    assert.equal(h.storedSession, null);
  });

  test("an account bw already knows unlocks with the same password instead", async () => {
    const h = harness([["status", { stdout: LOCKED }], ["unlock", { stdout: SESSION_KEY }]]);
    const answer = await h.call("signIn", passwordRequest(h));
    assert.equal(answer.result.ok, true);
    assert.deepEqual(argvOf(h), ["status --nointeraction", "unlock --passwordenv ARDIA_BW_PASSWORD --raw --nointeraction"]);
  });

  test("bw saying it's already logged in reuses the typed password to unlock", async () => {
    const h = harness([signedOut, ["login", { status: 1, stderr: "You are already logged in as me@example.com." }], ["unlock", { stdout: SESSION_KEY }]]);
    const answer = await h.call("signIn", passwordRequest(h));
    assert.equal(answer.result.ok, true);
    assert.equal(h.launches.at(-1).env.ARDIA_BW_PASSWORD, PASSWORD);
  });

  test("a wrong email or password says so and stays signed out", async () => {
    const h = harness([signedOut, ["login", { status: 1, stderr: "Username or password is incorrect. Try again." }]]);
    const answer = await h.call("signIn", passwordRequest(h));
    assert.deepEqual(answer.result, { ok: false, problem: "wrongCredentials", state: "signedOut", field: "masterPassword" });
    assert.equal(h.session, null);
  });

  test("asks for the email or password the sheet left out, without running bw login", async () => {
    const h = harness([signedOut]);
    const noEmail = await h.call("signIn", { method: "password", step: "start", fields: { email: "not an email", masterPassword: h.secret(PASSWORD) } });
    assert.deepEqual(noEmail.result, { ok: false, need: { kind: "field", field: "email" }, state: "signedOut" });
    const noPassword = await h.call("signIn", { method: "password", step: "start", fields: { email: EMAIL } });
    assert.deepEqual(noPassword.result, { ok: false, need: { kind: "field", field: "masterPassword" }, state: "signedOut" });
    assert.ok(!argvOf(h).some((line) => line.startsWith("login")));
  });

  test("offline, a server bw can't reach says you're offline; online, it says check the address", async () => {
    const reply = { status: 1, stderr: "FetchError: request to https://vault.bitwarden.com failed, reason: getaddrinfo ENOTFOUND vault.bitwarden.com" };
    const offline = harness([signedOut, ["login", reply]], { offline: true });
    assert.equal((await offline.call("signIn", passwordRequest(offline))).result.problem, "offline");
    const online = harness([signedOut, ["login", reply]]);
    assert.equal((await online.call("signIn", passwordRequest(online))).result.problem, "unreachable");
  });

  test("other bw errors pass their first line on, with the password redacted", async () => {
    const h = harness([signedOut, ["login", { status: 1, stderr: `\u001b[31mError: master password ${PASSWORD} rejected by policy\u001b[0m\nstack` }]]);
    const answer = await h.call("signIn", passwordRequest(h));
    assert.equal(answer.result.problem, "failed");
    assert.equal(answer.result.detail, "master password [hidden] rejected by policy");
  });
});

describe("two-step login", () => {
  test("bw asking for a method offers authenticator, email and YubiKey", async () => {
    const h = harness([signedOut, ["login", { status: 1, stderr: "No provider selected." }]]);
    const answer = await h.call("signIn", passwordRequest(h));
    assert.deepEqual(answer.result, { ok: false, need: { kind: "code", methods: twoStepMethods }, state: "signedOut" });
  });

  test("the first code request covers new-device verification", async () => {
    const h = harness([signedOut, ["login", { status: 1, stderr: "Code is required." }]]);
    const answer = await h.call("signIn", passwordRequest(h));
    assert.deepEqual(answer.result, { ok: false, need: { kind: "code", methods: twoStepMethods }, problem: "codeOrNewDevice", state: "signedOut" });
  });

  test("choosing the authenticator or YubiKey asks for the code before running bw again", async () => {
    for (const method of ["0", "3"]) {
      const h = harness([signedOut]);
      const answer = await h.call("signIn", passwordRequest(h, { step: "code", codeMethod: method }));
      assert.deepEqual(answer.result, { ok: false, need: { kind: "code", method }, state: "signedOut" });
      assert.deepEqual(argvOf(h), ["status --nointeraction"]);
    }
  });

  test("choosing email runs bw so Bitwarden sends the code, then asks for it", async () => {
    const h = harness([signedOut, ["login", { status: 1, stderr: "Code is required." }]]);
    const answer = await h.call("signIn", passwordRequest(h, { step: "code", codeMethod: "1" }));
    assert.deepEqual(answer.result, { ok: false, need: { kind: "code", method: "1" }, state: "signedOut" });
    assert.equal(argvOf(h)[1], `login ${EMAIL} --passwordenv ARDIA_BW_PASSWORD --raw --nointeraction --method=1`);
  });

  test("a code signs in with --method and --code, spaces taken out", async () => {
    const h = harness([signedOut, ["login", { stdout: SESSION_KEY }]]);
    const answer = await h.call("signIn", passwordRequest(h, { step: "code", codeMethod: "0", code: "123 456" }));
    assert.equal(answer.result.ok, true);
    assert.equal(argvOf(h)[1], `login ${EMAIL} --passwordenv ARDIA_BW_PASSWORD --raw --nointeraction --method=0 --code=123456`);
  });

  test("a wrong code asks for a new one", async () => {
    const h = harness([signedOut, ["login", { status: 1, stderr: "Invalid code. Two-step token is invalid." }]]);
    const answer = await h.call("signIn", passwordRequest(h, { step: "code", codeMethod: "0", code: "000000" }));
    assert.deepEqual(answer.result, { ok: false, need: { kind: "code", method: "0" }, problem: "wrongCode", state: "signedOut" });
  });

  test("a code bw still won't take means a new-device check, so the API key is the way in", async () => {
    const h = harness([signedOut, ["login", { status: 1, stderr: "Code is required." }]]);
    const answer = await h.call("signIn", passwordRequest(h, { step: "code", code: "123456" }));
    assert.deepEqual(answer.result, { ok: false, problem: "needsApiKey", state: "signedOut" });
  });

  test("a malformed code or an unknown method never reaches bw", async () => {
    const h = harness([signedOut]);
    const badCode = await h.call("signIn", passwordRequest(h, { step: "code", codeMethod: "0", code: "12-34!" }));
    assert.deepEqual(badCode.result, { ok: false, need: { kind: "code", method: "0" }, problem: "badCode", state: "signedOut" });
    const badMethod = await h.call("signIn", passwordRequest(h, { step: "code", codeMethod: "7", code: "123456" }));
    assert.deepEqual(badMethod.result, { ok: false, problem: "chooseMethod", state: "signedOut" });
    assert.ok(!argvOf(h).some((line) => line.startsWith("login")));
  });
});

describe("sign in with an API key", () => {
  test("logs in with the key, then unlocks with the master password", async () => {
    const h = harness([signedOut, ["login --apikey", { stdout: "You are logged in!" }], ["unlock", { stdout: SESSION_KEY }]]);
    const answer = await h.call("signIn", apiKeyRequest(h));
    assert.equal(answer.result.ok, true);
    assert.deepEqual(argvOf(h), ["status --nointeraction", "login --apikey --nointeraction", "unlock --passwordenv ARDIA_BW_PASSWORD --raw --nointeraction"]);
    assert.equal(h.launches[1].env.BW_CLIENTSECRET, CLIENT_SECRET);
    assert.deepEqual(h.session, { key: SESSION_KEY });
  });

  test("without the master password it says signed in and asks for it", async () => {
    const h = harness([signedOut, ["login --apikey", { stdout: "You are logged in!" }]]);
    const answer = await h.call("signIn", apiKeyRequest(h, false));
    assert.deepEqual(answer.result, { ok: false, need: { kind: "field", field: "masterPassword" }, problem: "unlockNext" });
  });

  test("a refused key or an organization key says which", async () => {
    const rejected = harness([signedOut, ["login --apikey", { status: 1, stderr: "invalid_client" }]]);
    assert.deepEqual((await rejected.call("signIn", apiKeyRequest(rejected))).result, { ok: false, problem: "notAccepted", state: "signedOut", field: "clientSecret" });
    const organization = harness([signedOut, ["login --apikey", { status: 1, stderr: "Organization API keys can't log in." }]]);
    assert.deepEqual((await organization.call("signIn", apiKeyRequest(organization))).result, { ok: false, problem: "organizationKey", state: "signedOut", field: "clientId" });
  });

  test("asks for a missing client ID or secret", async () => {
    const h = harness([signedOut]);
    const answer = await h.call("signIn", { method: "apiKey", step: "start", fields: { clientId: h.secret("user.abc") } });
    assert.deepEqual(answer.result, { ok: false, need: { kind: "field", field: "clientSecret" }, state: "signedOut" });
  });
});

describe("servers", () => {
  test("a self-hosted server is set before signing in, https or loopback http", async () => {
    for (const [url, expected] of [
      ["https://vault.example.com/", "https://vault.example.com"],
      ["http://localhost:8080", "http://localhost:8080"],
    ]) {
      const h = harness([signedOut, ["config server", { stdout: "Saved setting `config`." }], ["login", { stdout: SESSION_KEY }]]);
      const answer = await h.call("signIn", passwordRequest(h, { server: { url } }));
      assert.equal(answer.result.ok, true);
      assert.equal(argvOf(h)[1], `config server ${expected} --nointeraction`);
    }
  });

  test("the EU preset and the US preset are fixed commands", async () => {
    const eu = harness([signedOut, ["config server", {}], ["login", { stdout: SESSION_KEY }]]);
    await eu.call("signIn", passwordRequest(eu, { server: { preset: "eu" } }));
    assert.equal(argvOf(eu)[1], "config server https://vault.bitwarden.eu --nointeraction");
    const us = harness([signedOut, ["config server", {}]]);
    await us.call("configure", { server: { preset: "us" } });
    assert.equal(argvOf(us)[1], "config server bitwarden.com --nointeraction");
  });

  test("plain http to a remote host is refused before bw runs", async () => {
    const h = harness([signedOut]);
    const answer = await h.call("signIn", passwordRequest(h, { server: { url: "http://vault.example.com" } }));
    assert.deepEqual(answer.result, { ok: false, problem: "badServer", state: "signedOut", field: "server" });
    assert.deepEqual(argvOf(h), ["status --nointeraction"]);
  });

  test("changing the server while signed in asks to sign out first", async () => {
    const h = harness([["status", { stdout: LOCKED }]]);
    const answer = await h.call("configure", { server: { url: "https://vault.example.com" } });
    assert.deepEqual(answer.error, { code: "failed", problem: "signOutFirst", field: "server" });
    const told = harness([signedOut, ["config server", { status: 1, stderr: "Logout required before server config update." }]]);
    assert.deepEqual((await told.call("configure", { server: { preset: "eu" } })).error, { code: "failed", problem: "signOutFirst", field: "server" });
  });
});

describe("unlock and lock", () => {
  test("the master password unlocks and keeps the new session", async () => {
    const h = harness([["unlock", { stdout: SESSION_KEY }]]);
    const answer = await h.call("unlock", { password: h.secret(PASSWORD) });
    assert.equal(answer.result.ok, true);
    assert.deepEqual(h.session, { key: SESSION_KEY });
  });

  test("a wrong master password asks again; a signed-out bw asks to sign in", async () => {
    const wrong = harness([["unlock", { status: 1, stderr: "Invalid master password." }]]);
    assert.deepEqual((await wrong.call("unlock", { password: wrong.secret(PASSWORD) })).result, { ok: false, need: { kind: "field", field: "masterPassword" }, problem: "wrongPassword" });
    const out = harness([["unlock", { status: 1, stderr: "You are not logged in." }]]);
    assert.deepEqual((await out.call("unlock", { password: out.secret(PASSWORD) })).result, { ok: false, problem: "signInFirst", state: "signedOut" });
  });

  test("a typed password is spent once bw takes it, so it can't be replayed", async () => {
    const h = harness([["unlock", { stdout: SESSION_KEY }]]);
    const typed = h.secret(PASSWORD);
    assert.equal((await h.call("unlock", { password: typed })).result.ok, true);
    const again = await h.call("unlock", { password: typed });
    assert.equal(again.ok, false);
    assert.deepEqual(h.refused.at(-1), { verb: "unlock", reason: `${typed.$secret} was used or has ended.` });
    assert.equal(h.launches.length, 1);
  });

  test("Touch ID reuses the stored session when bw says it's still unlocked", async () => {
    const h = harness([["status", { stdout: UNLOCKED }]], { touchID: true, storedSession: STORED_SESSION });
    const answer = await h.call("unlock", { password: null });
    assert.deepEqual(answer, { ok: true, result: { ok: true } });
    assert.deepEqual(h.session, { key: STORED_SESSION });
    assert.equal(h.launches[0].env.BW_SESSION, STORED_SESSION);
    assert.equal(h.storedSession, STORED_SESSION);
  });

  test("a stored session bw locked or signed out is dropped and the password is asked for", async () => {
    for (const status of ["locked", "unauthenticated"]) {
      const h = harness([["status", { stdout: JSON.stringify({ status }) }]], { touchID: true, storedSession: STORED_SESSION });
      const answer = await h.call("unlock", { password: null });
      assert.deepEqual(answer.result, { ok: false, need: { kind: "field", field: "masterPassword" }, problem: "lockedSinceLastUnlock" });
      assert.equal(h.storedSession, null);
      assert.equal(h.session, null);
    }
  });

  test("a status that can't be trusted keeps the stored session for the next try", async () => {
    for (const reply of [{ status: 1, stderr: "node crashed" }, { stdout: "<html>502</html>" }, { stdout: JSON.stringify({ status: "weird" }) }]) {
      const h = harness([["status", reply]], { touchID: true, storedSession: STORED_SESSION });
      const answer = await h.call("unlock", { password: null });
      assert.equal(answer.result.ok, false);
      assert.equal(h.storedSession, STORED_SESSION);
      assert.equal(h.session, null);
    }
  });

  test("without Touch ID or a stored session, unlock asks for the master password", async () => {
    const h = harness([], { touchID: false, storedSession: STORED_SESSION });
    const answer = await h.call("unlock", { password: null });
    assert.deepEqual(answer.result, { ok: false, need: { kind: "field", field: "masterPassword" } });
    assert.equal(h.launches.length, 0);
  });

  test("a lock runs bw lock with the session, then forgets it", async () => {
    const h = harness([["lock", { stdout: "Your vault is locked." }]], { session: { key: SESSION_KEY } });
    await h.lock();
    assert.deepEqual(argvOf(h), ["lock --nointeraction"]);
    assert.equal(h.launches[0].env.BW_SESSION, SESSION_KEY);
    assert.equal(h.session, null);
  });

  test("with Touch ID on, a lock leaves bw unlocked so the stored session still works", async () => {
    const h = harness([], { session: { key: SESSION_KEY }, touchID: true, storedSession: SESSION_KEY });
    await h.lock();
    assert.equal(h.launches.length, 0);
    assert.equal(h.session, null);
    assert.equal(h.storedSession, SESSION_KEY);
  });

  test("sign out runs bw logout and forgets every session", async () => {
    const h = harness([["logout", { stdout: "You have logged out." }]], { session: { key: SESSION_KEY }, touchID: true, storedSession: SESSION_KEY });
    const answer = await h.call("signOut", {});
    assert.equal(answer.ok, true);
    assert.deepEqual(argvOf(h), ["logout --nointeraction"]);
    assert.equal(h.launches[0].env.BW_SESSION, SESSION_KEY);
    assert.equal(h.session, null);
    assert.equal(h.storedSession, null);
  });
});

describe("cancelling", () => {
  test("closing the sheet mid sign-in stops bw login and leaves nothing signed in", async () => {
    const h = harness([signedOut, ["login", { stdout: SESSION_KEY, finishAfterMs: 30_000 }]], { touchID: true });
    const pending = h.call("signIn", passwordRequest(h));
    await h.advance(1_000);
    await h.cancel();
    assert.deepEqual(await pending, { ok: false, error: { code: "cancelled" } });
    await h.advance(60_000);
    assert.equal(h.session, null);
    assert.equal(h.storedSession, null);
    assert.deepEqual(argvOf(h), ["status --nointeraction", `login ${EMAIL} --passwordenv ARDIA_BW_PASSWORD --raw --nointeraction`]);
  });

  test("a session bw prints after a lock is dropped, and a later unlock keeps its own", async () => {
    const h = harness([["unlock", { stdout: SESSION_KEY, finishAfterMs: 1_000 }]], { touchID: true });
    const pending = h.call("unlock", { password: h.secret(PASSWORD) });
    await h.advance(10);
    await h.lock();
    assert.deepEqual(await pending, { ok: false, error: { code: "stale" } });
    await h.advance(5_000);
    assert.equal(h.session, null);
    assert.equal(h.storedSession, null);
    const after = h.call("unlock", { password: h.secret(PASSWORD) });
    await h.advance(5_000);
    assert.equal((await after).ok, true);
    assert.deepEqual(h.session, { key: SESSION_KEY });
    assert.equal(h.runs, 2);
  });

  test("a bw login that never answers times out as a sign-in failure", async () => {
    const h = harness([signedOut, ["login", { stdout: SESSION_KEY, finishAfterMs: 120_000 }]]);
    const pending = h.call("signIn", passwordRequest(h));
    await h.advance(61_000);
    assert.deepEqual((await pending).result, { ok: false, problem: "timedOut", state: "signedOut" });
    assert.equal(h.session, null);
  });
});
