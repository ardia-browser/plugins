import { afterEach, beforeEach, describe, mock, test } from "node:test";
import assert from "node:assert/strict";
import { argvOf, harness, locked, subject } from "./helpers.mjs";

const SIGNED_OUT = { status: 1, stderr: "Error: This operation requires an authenticated client" };
const INFO = { stdout: JSON.stringify({ email: "fixture@example.com", username: "fixture", personal_access_token_name: null }) };
const APPROVAL = "https://account.proton.me/authorize?code=abc";
const browser = (fields = {}) => ({ method: "browser", step: "start", fields });
const token = (fields) => ({ method: "token", step: "start", fields });
const stdout = (text) => ({ stream: "stdout", text });

beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_767_000_000_000 }));
afterEach(() => mock.timers.reset());

describe("browser sign-in", () => {
  test("hands back the first proton.me link, skipping other links, trailing punctuation and look-alike hosts", async () => {
    const h = harness([
      ["info*", SIGNED_OUT],
      ["login", { lines: [stdout("Docs: https://protonpass.github.io/pass-cli/"), stdout("Try https://proton.me.evil.example/x"), stdout(`Open ${APPROVAL}. Then wait.`)], finishAfterMs: 600_000 }],
    ], locked);
    const answer = await h.call("signIn", browser());
    assert.deepEqual(answer, { ok: true, result: { ok: false, need: { kind: "approval", url: APPROVAL }, state: "signedOut" } });
  });

  test("keeps pass-cli running after the call and signs in when the browser approves", async () => {
    const h = harness([
      ["info*", SIGNED_OUT],
      ["login", { lines: [stdout(`Open ${APPROVAL}`)], finishAfterMs: 120_000 }],
    ], locked);
    await h.call("signIn", browser());
    assert.equal(h.signInRun.state, "running");
    assert.equal(h.running, 1);
    const waiting = await h.call("state", { explicit: false });
    assert.deepEqual(waiting.result, { state: "signedOut", problem: "finishInBrowser" });
    await h.advance(120_000);
    assert.equal(h.signInRun.state, "succeeded");
    assert.deepEqual(h.session, { key: null });
  });

  test("stops after the old 660 s and reports that Proton didn't confirm in time", async () => {
    const h = harness([
      ["info*", SIGNED_OUT],
      ["login", { lines: [stdout(`Open ${APPROVAL}`)], finishAfterMs: 2_000_000 }],
    ], locked);
    await h.call("signIn", browser());
    await h.advance(659_000);
    assert.equal(h.signInRun.state, "running");
    await h.advance(2_000);
    assert.equal(h.signInRun.timedOut, true);
    assert.equal(h.session, null);
    const after = await h.call("state", { explicit: true });
    assert.deepEqual(after.result, { state: "signedOut", problem: "approvalTimedOut" });
  });

  test("a later extra password refusal shows on the provider's state", async () => {
    const h = harness([
      ["info*", SIGNED_OUT],
      ["login", { lines: [stdout(`Open ${APPROVAL}`)], status: 1, stderr: "Error: this account has an extra password set", finishAfterMs: 5_000 }],
    ], locked);
    await h.call("signIn", browser());
    await h.advance(5_000);
    const after = await h.call("state", { explicit: true });
    assert.deepEqual(after.result, { state: "signedOut", problem: "extraPassword" });
  });

  test("passes the extra password to login in its environment and hides it from output", async () => {
    const h = harness([
      ["info*", SIGNED_OUT],
      ["login", { lines: [stdout("using extra-secret-77"), stdout(`Open ${APPROVAL}`)], finishAfterMs: 50_000 }],
    ], locked);
    const extra = h.secret("extra-secret-77");
    await h.call("signIn", browser({ extraPassword: extra }));
    const login = h.launches.find((launch) => launch.verb === "login.browser");
    assert.equal(login.env.PROTON_PASS_EXTRA_PASSWORD, "extra-secret-77");
    assert.deepEqual(login.argv, ["login"]);
  });

  test("a login that ends at once with an extra password error asks for it again", async () => {
    const h = harness([
      ["info*", SIGNED_OUT],
      ["login", { status: 1, stderr: "Error: Extra password required" }],
    ], locked);
    const answer = await h.call("signIn", browser());
    assert.deepEqual(answer.result, { ok: false, problem: "extraPassword", state: "signedOut", field: "extraPassword" });
  });

  test("a login that signs in without a link, from a session pass-cli already holds, is done", async () => {
    const h = harness([["info*", SIGNED_OUT], ["login", { stdout: "Logged in\n" }]], locked);
    const answer = await h.call("signIn", browser());
    assert.deepEqual(answer.result, { ok: true });
    assert.deepEqual(h.session, { key: null });
  });

  test("no link in 30 s stops pass-cli and says it didn't start", async () => {
    const h = harness([["info*", SIGNED_OUT], ["login", { lines: [stdout("Starting...")], finishAfterMs: 600_000 }]], locked);
    const pending = h.call("signIn", browser());
    await h.advance(31_000);
    assert.deepEqual((await pending).result, { ok: false, problem: "didntStart", state: "signedOut" });
    assert.equal(h.running, 0);
    assert.equal(h.signInRun.state, "none");
  });

  test("offline, a failed login says so", async () => {
    const h = harness([["info*", SIGNED_OUT], ["login", { status: 1, stderr: "error: getaddrinfo ENOTFOUND pass-api.proton.me" }]], { ...locked, offline: true });
    assert.equal((await h.call("signIn", browser())).result.problem, "offline");
  });

  test("an unreachable server says so with the address hint", async () => {
    const h = harness([["info*", SIGNED_OUT], ["login", { status: 1, stderr: "error: connection refused (ECONNREFUSED)" }]], locked);
    assert.equal((await h.call("signIn", browser())).result.problem, "unreachable");
  });

  test("cancelling the sheet while waiting for the link stops login and signs nothing in", async () => {
    const h = harness([["info*", SIGNED_OUT], ["login", { lines: [stdout("Starting...")], finishAfterMs: 600_000 }]], locked);
    const pending = h.call("signIn", browser());
    await h.advance(1_000);
    await h.cancel();
    assert.deepEqual(await pending, { ok: false, error: { code: "cancelled" } });
    assert.equal(h.running, 0);
    assert.equal(h.session, null);
  });

  test("a pass-cli that is already signed in asks the owner before unlocking", async () => {
    for (const confirms of [true, false]) {
      const h = harness([["info*", INFO]], { ...locked, ownerConfirms: confirms });
      const answer = await h.call("signIn", browser());
      assert.deepEqual(answer.result, confirms ? { ok: true } : { ok: false, problem: "stayedLocked" });
      assert.deepEqual(h.session, confirms ? { key: null } : null);
      assert.deepEqual(h.confirmations, ["unlock Proton Pass"]);
      assert.deepEqual(argvOf(h), ["info --output=json"]);
    }
  });

  test("a session lock tells the owner to run pass-cli session unlock", async () => {
    const h = harness([["info*", { status: 1, stderr: "Error: Session is locked" }]], locked);
    assert.deepEqual((await h.call("signIn", browser())).result, { ok: false, problem: "sessionLock" });
  });

  test("an info reply that isn't JSON makes Proton Pass unavailable", async () => {
    const h = harness([["info*", { stdout: "Welcome to pass-cli" }]], locked);
    assert.deepEqual((await h.call("signIn", browser())).result, { ok: false, problem: "unreadable", state: "unavailable" });
  });
});

describe("access token sign-in", () => {
  test("signs in with the token and the extra password in the environment", async () => {
    const h = harness([["login", { stdout: "Logged in as fixture@example.com\n" }]], locked);
    const answer = await h.call("signIn", token({ token: h.secret("pat-123456"), extraPassword: h.secret("extra-987") }));
    assert.deepEqual(answer.result, { ok: true });
    assert.deepEqual(h.session, { key: null });
    assert.equal(h.launches[0].env.PROTON_PASS_PERSONAL_ACCESS_TOKEN, "pat-123456");
    assert.equal(h.launches[0].env.PROTON_PASS_EXTRA_PASSWORD, "extra-987");
  });

  const failures = [
    ["a rejected token", { status: 1, stderr: "Error: Invalid access token" }, { ok: false, problem: "notAccepted", state: "signedOut", field: "token" }],
    ["an expired token", { status: 1, stderr: "Error: token expired" }, { ok: false, problem: "notAccepted", state: "signedOut", field: "token" }],
    ["an account with an extra password", { status: 1, stderr: "Error: invalid extra password" }, { ok: false, problem: "extraPassword", state: "signedOut", field: "extraPassword" }],
    ["an unknown error", { status: 3, stderr: "Error: Something broke at pat-123456" }, { ok: false, problem: "failed", state: "signedOut", detail: "Something broke at [hidden]" }],
    ["a login that never answers", { timedOut: true }, { ok: false, problem: "timedOut", state: "signedOut" }],
  ];
  for (const [name, reply, expected] of failures) {
    test(`${name}`, async () => {
      const h = harness([["login", reply]], locked);
      assert.deepEqual((await h.call("signIn", token({ token: h.secret("pat-123456") }))).result, expected);
      assert.equal(h.session, null);
    });
  }

  test("a token method without a token asks for it", async () => {
    const h = harness([], locked);
    assert.deepEqual((await h.call("signIn", token({}))).result, { ok: false, need: { kind: "field", field: "token" }, state: "signedOut" });
    assert.equal(h.launches.length, 0);
  });

  test("a typed token is spent once pass-cli accepts it", async () => {
    const h = harness([["login", { stdout: "ok\n" }]], locked);
    const typed = h.secret("pat-123456");
    await h.call("signIn", token({ token: typed }));
    const again = await h.call("signIn", token({ token: typed }));
    assert.equal(again.ok, false);
    assert.equal(h.refused.length, 1);
  });

  test("cancelling a token sign-in stops pass-cli and leaves nothing signed in", async () => {
    const h = harness([["login", { finishAfterMs: 60_000 }]], locked);
    const pending = h.call("signIn", token({ token: h.secret("pat-123456") }));
    await h.advance(1_000);
    await h.cancel();
    assert.deepEqual(await pending, { ok: false, error: { code: "cancelled" } });
    assert.equal(h.running, 0);
    assert.equal(h.session, null);
  });
});

describe("unlock", () => {
  test("is an owner check over the signed-in pass-cli", async () => {
    const yes = harness([["info*", INFO]], locked);
    assert.deepEqual((await yes.call("unlock", { password: null })).result, { ok: true });
    assert.deepEqual(yes.session, { key: null });
    const no = harness([["info*", INFO]], { ...locked, ownerConfirms: false });
    assert.deepEqual((await no.call("unlock", { password: null })).result, { ok: false, problem: "stayedLocked" });
    assert.equal(no.session, null);
  });

  const failures = [
    ["signed out", SIGNED_OUT, { ok: false, problem: "signInFirst", state: "signedOut" }],
    ["a session lock", { status: 1, stderr: "sessionLocked: run pass-cli session unlock" }, { ok: false, problem: "sessionLock" }],
    ["pass-cli missing", { launched: false }, { ok: false, problem: "notLaunched", state: "unavailable" }],
    ["an unreadable info", { stdout: "{\"email\":" }, { ok: false, problem: "unreadable", state: "unavailable" }],
  ];
  for (const [name, reply, expected] of failures) {
    test(`with ${name}`, async () => {
      const rules = reply.launched === false ? [["info*", () => Promise.reject(new Error("ENOENT"))]] : [["info*", reply]];
      const h = harness(rules, locked);
      assert.deepEqual((await h.call("unlock", { password: null })).result, expected);
      assert.equal(h.confirmations.length, 0);
    });
  }
});

describe("state", () => {
  test("names the account and follows the session", async () => {
    const open = harness([["info*", INFO]]);
    assert.deepEqual((await open.call("state", { explicit: false })).result, { state: "unlocked", account: "fixture@example.com" });
    const closed = harness([["info*", INFO]], locked);
    assert.deepEqual((await closed.call("state", { explicit: false })).result, { state: "locked", account: "fixture@example.com" });
  });

  test("a token session without an email names the token", async () => {
    const h = harness([["info*", { stdout: JSON.stringify({ personal_access_token_name: "Ardia on my Mac" }) }]]);
    assert.equal((await h.call("state", { explicit: false })).result.account, "Ardia on my Mac");
  });

  const states = [
    ["signed out", SIGNED_OUT, { state: "signedOut" }],
    ["an invalidated session", { status: 1, stderr: "Session has been invalidated, please log in again" }, { state: "signedOut" }],
    ["a session lock", { status: 1, stderr: "Error: session is locked" }, { state: "locked", problem: "sessionLock" }],
    ["an unreadable reply", { stdout: "nothing" }, { state: "unavailable", problem: "unreadable" }],
    ["an unknown failure", { status: 2, stderr: "Error: keyring unavailable" }, { state: "unavailable", problem: "failed", detail: "keyring unavailable" }],
    ["an old pass-cli", { status: 2, stderr: "error: unrecognized subcommand 'info'... please update" }, { state: "unavailable", problem: "outdated", detail: "unrecognized subcommand 'info'... please update" }],
  ];
  for (const [name, reply, expected] of states) {
    test(`with ${name}`, async () => {
      assert.deepEqual((await harness([["info*", reply]]).call("state", { explicit: true })).result, expected);
    });
  }

  test("pass-cli not installed or not starting is unavailable", async () => {
    const h = harness([["info*", () => Promise.reject(new Error("ENOENT"))]]);
    assert.deepEqual((await h.call("state", { explicit: true })).result, { state: "unavailable", problem: "notLaunched" });
  });
});

describe("sign out", () => {
  test("stops a browser sign-in in progress, then logs out", async () => {
    const h = harness([
      ["info*", SIGNED_OUT],
      ["login", { lines: [stdout(`Open ${APPROVAL}`)], finishAfterMs: 600_000 }],
      ["logout", { stdout: "Logged out\n" }],
    ], locked);
    await h.call("signIn", browser());
    assert.equal(h.running, 1);
    assert.deepEqual(await h.call("signOut", {}), { ok: true, result: null });
    assert.equal(h.running, 0);
    assert.equal(argvOf(h).at(-1), "logout");
  });
});

