import {
  CredentialError,
  SignIn,
  json,
  verbs,
  type CredentialContext,
  type CredentialProvider,
  type Item,
  type JsonRecord,
  type ListedItem,
  type ProviderState,
  type Revealed,
  type SecretHandle,
  type SignInOutcome,
  type VerbResult,
} from "@ardia/plugin-sdk/credentials";
import { approvalURL, createdId, itemId, listedItem, loginItem, loginOf, reference, usernameOf, vaultForNewItems, vaultsIn, type Reference, type Vault } from "./items";

const APPROVAL_WAIT_MS = 30_000;
const READ_TIMEOUT_MS = 90_000;
const LIST_DEADLINE_MS = 180_000;
const SHORTEST_LISTING_MS = 1_000;
const OWNER_REASON = "unlock Proton Pass";

const HINTS = {
  locked: ["session is locked", "sessionlocked"],
  signedOut: ["requires an authenticated client", "session has been invalidated", "log in again", "not logged in", "no session"],
  notFound: ["error retrieving item", "no totp fields", "is not a totp field", "invalid item reference", "item not found", "field does not exist"],
};

function check(result: VerbResult, ctx: CredentialContext) {
  verbs.check(result, HINTS, ctx.offline);
}

function requireUnlocked(ctx: CredentialContext) {
  if (!ctx.session.current) throw CredentialError.locked();
}

function readable(result: VerbResult) {
  if (result.json === null) throw CredentialError.failed("unreadable");
}

const secretField = (value: string | SecretHandle | undefined): SecretHandle | null => (value && typeof value !== "string" ? value : null);

const detailOf = (result: VerbResult) => {
  const line = verbs.firstLine(result);
  return line ? { detail: line } : {};
};

type Info = { fields: JsonRecord | undefined; result: VerbResult };

async function info(ctx: CredentialContext): Promise<Info> {
  const result = await ctx.cli.verb("info");
  return { fields: result.succeeded ? json.dict(result.json) : undefined, result };
}

const isSignedOut = (current: Info) => current.result.hints.includes("signedOut");
const hasSessionLock = (current: Info) => current.result.hints.includes("sessionLock");

async function vaults(ctx: CredentialContext): Promise<Vault[]> {
  const result = await ctx.cli.verb("vault.list");
  check(result, ctx);
  return vaultsIn(json.listAt(result.json, "vaults"));
}

async function listShare(ctx: CredentialContext, share: string, deadline: number, onEntry: (entry: JsonRecord) => void): Promise<void> {
  const attempt = async (showSecrets: boolean) => {
    const remaining = deadline - Date.now();
    if (remaining <= SHORTEST_LISTING_MS) throw CredentialError.failed("tooSlow");
    const entries: JsonRecord[] = [];
    const timeoutMs = Math.min(READ_TIMEOUT_MS, remaining);
    const result = await ctx.cli.verb(
      "item.list",
      { share, showSecrets },
      {
        timeoutMs,
        onItem(raw) {
          const entry = json.dict(raw);
          if (entry) entries.push(entry);
        },
      },
    );
    if (result.timedOut && timeoutMs < READ_TIMEOUT_MS) throw CredentialError.failed("tooSlow");
    return { result, entries };
  };
  let listed = await attempt(true);
  const { result } = listed;
  if (!result.succeeded && !result.timedOut && !result.cancelled && result.hints.includes("noShowSecrets")) listed = await attempt(false);
  check(listed.result, ctx);
  readable(listed.result);
  for (const entry of listed.entries) onEntry(entry);
}

type BrowserWait = { url: string } | { finished: VerbResult } | { failed: unknown } | { waited: true } | { cancelled: true };

function waitForApproval(ctx: CredentialContext, extraPassword: SecretHandle | null): Promise<BrowserWait> {
  return new Promise<BrowserWait>((resolve) => {
    let settled = false;
    const settle = (outcome: BrowserWait) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cancelling.dispose();
      resolve(outcome);
    };
    const timer = setTimeout(() => settle({ waited: true }), APPROVAL_WAIT_MS);
    const cancelling = ctx.signal.onCancel(() => settle({ cancelled: true }));
    ctx.cli
      .verb(
        "login.browser",
        { extraPassword: extraPassword ?? undefined },
        {
          onLine(line) {
            const url = approvalURL(line.text);
            if (url) settle({ url });
          },
        },
      )
      .then(
        (finished) => settle({ finished }),
        (failed) => settle({ failed }),
      );
  });
}

function loginFailure(result: VerbResult, ctx: CredentialContext, timedOut: "approvalTimedOut" | "timedOut"): SignInOutcome {
  if (result.cancelled) return SignIn.cancelled("signedOut");
  if (result.hints.includes("extraPassword")) return SignIn.failed("extraPassword", { state: "signedOut", field: "extraPassword" });
  if (result.timedOut) return SignIn.failed(timedOut, { state: "signedOut" });
  return SignIn.failed(verbs.problem(result, ctx.offline), { state: "signedOut", ...detailOf(result) });
}

async function browserSignIn(ctx: CredentialContext, extraPassword: SecretHandle | null): Promise<SignInOutcome> {
  const outcome = await waitForApproval(ctx, extraPassword);
  if ("url" in outcome) return SignIn.needs({ kind: "approval", url: outcome.url }, { state: "signedOut" });
  if ("cancelled" in outcome) return SignIn.cancelled("signedOut");
  if ("finished" in outcome && outcome.finished.succeeded) return SignIn.done();
  await ctx.cli.cancelSigningIn();
  if ("finished" in outcome) return loginFailure(outcome.finished, ctx, "approvalTimedOut");
  return SignIn.failed("didntStart", { state: "signedOut" });
}

async function tokenSignIn(ctx: CredentialContext, token: SecretHandle, extraPassword: SecretHandle | null): Promise<SignInOutcome> {
  const result = await ctx.cli.verb("login.token", { token, extraPassword: extraPassword ?? undefined });
  if (result.succeeded) return SignIn.done();
  if (!result.cancelled && !result.hints.includes("extraPassword") && result.hints.includes("rejected")) {
    return SignIn.failed("notAccepted", { state: "signedOut", field: "token" });
  }
  return loginFailure(result, ctx, "timedOut");
}

async function ownerUnlock(ctx: CredentialContext): Promise<SignInOutcome> {
  return (await ctx.owner.confirm(OWNER_REASON)) ? SignIn.done() : SignIn.failed("stayedLocked");
}

function signInRunState(ctx: CredentialContext): ProviderState {
  const run = ctx.cli.signInRun;
  if (run.state === "running") return { state: "signedOut", problem: "finishInBrowser" };
  if (run.state !== "failed") return { state: "signedOut" };
  if (run.hints.includes("extraPassword")) return { state: "signedOut", problem: "extraPassword" };
  if (run.timedOut) return { state: "signedOut", problem: "approvalTimedOut" };
  return { state: "signedOut", problem: "failed", ...(run.detail ? { detail: run.detail } : {}) };
}

async function revealTotp(ctx: CredentialContext, target: Reference, only: boolean): Promise<Revealed["totp"]> {
  const result = await ctx.cli.verb("item.totp", target);
  if (!result.succeeded && !only && verbs.mentions(result, HINTS.notFound)) return undefined;
  check(result, ctx);
  const code = json.string(json.dict(result.json)?.totp);
  return code ? { code } : undefined;
}

async function revealLogin(ctx: CredentialContext, target: Reference): Promise<JsonRecord | undefined> {
  const result = await ctx.cli.verb("item.view", target);
  check(result, ctx);
  readable(result);
  const root = json.dict(result.json);
  return loginOf(json.dict(root?.item) ?? root);
}

async function findSaved(ctx: CredentialContext, vault: Vault, login: { title: string; username: string; url: string }): Promise<Item | null> {
  const matches: Item[] = [];
  try {
    await listShare(ctx, vault.share, Date.now() + READ_TIMEOUT_MS, (entry) => {
      const item = loginItem(entry, vault.share, vault.name);
      if (item && item.title === login.title && item.username === login.username && item.urls.includes(login.url)) matches.push(item);
    });
  } catch (error) {
    if (CredentialError.is(error, "locked") || CredentialError.is(error, "signedOut")) throw error;
    return null;
  }
  return matches.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0] ?? null;
}

export const provider: CredentialProvider = {
  async state(_input, ctx) {
    const current = await info(ctx);
    if (current.fields) {
      const account = json.string(current.fields.email) ?? json.string(current.fields.username) ?? json.string(current.fields.personal_access_token_name);
      return { state: ctx.session.current ? "unlocked" : "locked", ...(account ? { account } : {}) };
    }
    if (hasSessionLock(current)) return { state: "locked", problem: "sessionLock" };
    if (isSignedOut(current)) return signInRunState(ctx);
    return { state: "unavailable", problem: current.result.succeeded ? "unreadable" : verbs.problem(current.result, ctx.offline), ...detailOf(current.result) };
  },

  async signIn(request, ctx) {
    const extraPassword = secretField(request.fields.extraPassword);
    if (request.method === "token") {
      const token = secretField(request.fields.token);
      return token ? tokenSignIn(ctx, token, extraPassword) : SignIn.needs({ kind: "field", field: "token" }, { state: "signedOut" });
    }
    if (request.method !== "browser") return SignIn.failed("failed", { state: "signedOut" });
    const current = await info(ctx);
    if (current.fields) return ownerUnlock(ctx);
    if (hasSessionLock(current)) return SignIn.failed("sessionLock");
    if (current.result.succeeded) return SignIn.failed("unreadable", { state: "unavailable" });
    return browserSignIn(ctx, extraPassword);
  },

  async unlock(_request, ctx) {
    const current = await info(ctx);
    if (current.fields) return ownerUnlock(ctx);
    if (hasSessionLock(current)) return SignIn.failed("sessionLock");
    if (isSignedOut(current)) return SignIn.failed("signInFirst", { state: "signedOut" });
    return SignIn.failed(current.result.succeeded ? "unreadable" : verbs.problem(current.result, ctx.offline), { state: "unavailable", ...detailOf(current.result) });
  },

  async signOut(_input, ctx) {
    await ctx.cli.cancelSigningIn();
    await ctx.cli.verb("logout");
  },

  async list(_request, ctx) {
    requireUnlocked(ctx);
    const deadline = Date.now() + LIST_DEADLINE_MS;
    const listed = new Map<string, ListedItem>();
    for (const vault of await vaults(ctx)) {
      await listShare(ctx, vault.share, deadline, (entry) => {
        const item = listedItem(entry, vault.share, vault.name);
        if (item && !listed.has(item.id)) listed.set(item.id, item);
      });
    }
    return [...listed.values()];
  },

  async reveal(request, ctx) {
    requireUnlocked(ctx);
    const target = reference(request.id);
    if (!target) throw CredentialError.notFound();
    const only = request.fields.length === 1;
    const revealed: Revealed = {};
    if (request.fields.includes("totp")) {
      const code = await revealTotp(ctx, target, only);
      if (code) revealed.totp = code;
    }
    const wanted = request.fields.filter((field): field is "username" | "password" => field !== "totp");
    if (wanted.length) {
      const login = await revealLogin(ctx, target);
      for (const field of wanted) {
        const value = field === "username" ? usernameOf(login) : json.string(login?.password);
        if (value) revealed[field] = value;
      }
    }
    if (only && Object.keys(revealed).length === 0) throw CredentialError.notFound();
    return revealed;
  },

  async save({ login }, ctx) {
    requireUnlocked(ctx);
    const choice = vaultForNewItems(await vaults(ctx));
    if ("problem" in choice) throw CredentialError.failed(choice.problem);
    const { vault } = choice;
    const isEmail = login.username.includes("@") && !/\s/.test(login.username);
    const template = { title: login.title, password: login.password, urls: [login.url], extra_fields: [], [isEmail ? "email" : "username"]: login.username };
    const result = await ctx.cli.verb("item.create", { share: vault.share, template });
    check(result, ctx);
    const created = createdId(result);
    if (created) {
      return { id: itemId(vault.share, created), title: login.title, username: login.username, urls: [login.url], hasTotp: false, ...(vault.name ? { vault: vault.name } : {}), updatedAt: Date.now() };
    }
    const found = await findSaved(ctx, vault, login);
    if (!found) throw CredentialError.failed("savedNotReturned");
    return found;
  },
};
