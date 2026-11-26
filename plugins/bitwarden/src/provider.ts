import {
  CredentialError,
  SignIn,
  json,
  origins,
  verbs,
  type CodeMethod,
  type CredentialContext,
  type CredentialProvider,
  type Item,
  type JsonRecord,
  type JsonValue,
  type ListedItem,
  type ListedPasskey,
  type LoginChange,
  type PasskeyKey,
  type ProblemCode,
  type ProviderState,
  type Revealed,
  type SecretHandle,
  type ServerRef,
  type SignInOutcome,
  type VerbResult,
} from "@ardia-plugins/credential-provider";
import { editedItem, isGuid, listedItem, loginItem, loginOf, newLoginItem, passkeyJson, passkeyMaterial, passkeyMetadata, passkeysOf } from "./items";

export const SYNC_INTERVAL_MS = 300_000;
export const SYNCED_AT = "syncedAt";
const PREMIUM_HINTS = ["premium"];
const TWO_STEP_METHODS: readonly CodeMethod[] = [
  { id: "0", title: "Authenticator App" },
  { id: "1", title: "Email", sendsCode: true },
  { id: "3", title: "YubiKey OTP" },
];
const TWO_STEP_METHOD_IDS = TWO_STEP_METHODS.map((method) => method.id);
const HINTS = {
  locked: ["vault is locked", "session key is invalid", "invalid session"],
  signedOut: ["you are not logged in", "not logged in"],
  notFound: ["not found", "no password available", "no totp available", "no username available", "not a login", "more than one result"],
};
const MASTER_PASSWORD = { kind: "field", field: "masterPassword" } as const;
const US_SERVER = /^(https?:\/\/)?(vault\.)?bitwarden\.com\/?$/i;
const EU_SERVER = /^(https?:\/\/)?(vault\.)?bitwarden\.eu\/?$/i;

const isEmail = (text: string) => text.includes("@") && !text.startsWith("-") && !/\s/.test(text) && text.length <= 320;
const isCode = (text: string) => /^[A-Za-z0-9]{1,64}$/.test(text);
const hinted = (result: VerbResult, hint: string) => result.hints.includes(hint);
const secretField = (value: string | undefined): string | null => (value ? value : null);
const textField = (value: string | undefined): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

function unlockedKey(ctx: CredentialContext): SecretHandle {
  const key = ctx.session.current?.key;
  if (!key) throw CredentialError.locked();
  return key;
}

function stopIfCancelled(ctx: CredentialContext, result?: VerbResult) {
  if (ctx.signal.cancelled || result?.cancelled) throw CredentialError.failed("cancelled");
}

function check(result: VerbResult, ctx: CredentialContext) {
  if (!result.succeeded && verbs.mentions(result, PREMIUM_HINTS)) throw CredentialError.failed("premiumNeeded");
  verbs.check(result, HINTS, ctx.offline);
}

function failureOf(result: VerbResult, ctx: CredentialContext): { problem: ProblemCode; detail?: string } {
  const problem = result.succeeded ? "unreadable" : verbs.problem(result, ctx.offline);
  const line = verbs.firstLine(result);
  return problem === "failed" && line ? { problem, detail: line } : { problem };
}

type Status = { fields: JsonRecord; problem: null; detail?: undefined; cancelled: false } | { fields: null; problem: ProblemCode; detail?: string; cancelled: boolean };

async function readStatus(ctx: CredentialContext, session: SecretHandle | null): Promise<Status> {
  const result = await ctx.cli.verb("status", { session: session ?? undefined });
  if (result.cancelled) return { fields: null, problem: "cancelled", cancelled: true };
  if (!result.succeeded) return { fields: null, ...failureOf(result, ctx), cancelled: false };
  const fields = json.dict(result.json);
  return fields ? { fields, problem: null, cancelled: false } : { fields: null, problem: "unreadable", cancelled: false };
}

const statusOf = (fields: JsonRecord) => json.string(fields.status) ?? "";
const isLoggedIn = (fields: JsonRecord) => ["locked", "unlocked"].includes(statusOf(fields));

export function serverRef(url: string | undefined): ServerRef {
  if (!url || US_SERVER.test(url)) return { preset: "us" };
  if (EU_SERVER.test(url)) return { preset: "eu" };
  return { url };
}

function selfHostedUrl(text: string): string | null {
  const trimmed = text.trim().replace(/\/+$/, "");
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(trimmed)?.[1]?.toLowerCase();
  const host = origins.host(trimmed);
  if (!host || /\s/.test(trimmed) || /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(trimmed)) return null;
  if (scheme === "https") return trimmed;
  if (scheme === "http" && origins.isLocalHost(host)) return trimmed;
  return null;
}

async function applyServer(ctx: CredentialContext, server: ServerRef | null): Promise<ProblemCode | null> {
  let verb = "config.server.us";
  let url: string | undefined;
  if (server && "url" in server) {
    if (US_SERVER.test(server.url.trim())) verb = "config.server.us";
    else if (EU_SERVER.test(server.url.trim())) verb = "config.server.eu";
    else {
      const value = selfHostedUrl(server.url);
      if (!value) return "badServer";
      verb = "config.server.url";
      url = value;
    }
  } else if (server?.preset === "eu") verb = "config.server.eu";
  else if (server && server.preset !== "us") return "badServer";
  const result = await ctx.cli.verb(verb, url ? { url } : {});
  if (result.succeeded) return null;
  if (result.cancelled) return "cancelled";
  return hinted(result, "logoutRequired") ? "signOutFirst" : verbs.problem(result, ctx.offline);
}

async function unlockWithPassword(ctx: CredentialContext, password: string): Promise<SignInOutcome> {
  const result = await ctx.cli.verb("unlock", { password });
  if (result.cancelled) return SignIn.cancelled("locked");
  if (result.unlocked) return SignIn.done();
  if (hinted(result, "signedOut")) return SignIn.failed("signInFirst", { state: "signedOut" });
  if (hinted(result, "wrongPassword")) return SignIn.needs(MASTER_PASSWORD, { problem: "wrongPassword" });
  const failure = failureOf(result, ctx);
  return SignIn.failed(failure.problem, { detail: failure.detail });
}

async function unlockWithStoredSession(ctx: CredentialContext): Promise<SignInOutcome> {
  const stored = ctx.touchID && ctx.session.hasStored ? await ctx.session.takeStored("unlock Bitwarden") : null;
  if (!stored) return SignIn.needs(MASTER_PASSWORD);
  const current = await readStatus(ctx, stored);
  if (current.cancelled) return SignIn.cancelled("locked");
  if (!current.fields) return SignIn.failed(current.problem, { detail: current.detail });
  const status = statusOf(current.fields);
  if (status === "locked" || status === "unauthenticated") {
    await ctx.session.dropStored();
    return SignIn.needs(MASTER_PASSWORD, { problem: "lockedSinceLastUnlock" });
  }
  if (status !== "unlocked") return SignIn.failed("unreadable");
  return SignIn.done({ session: stored });
}

async function apiKeySignIn(ctx: CredentialContext, clientId: string, clientSecret: string, password: string | null): Promise<SignInOutcome> {
  const result = await ctx.cli.verb("login.apiKey", { clientId, clientSecret });
  if (result.cancelled) return SignIn.cancelled("signedOut");
  if (!result.succeeded && !hinted(result, "alreadyLoggedIn")) {
    if (verbs.mentions(result, ["organization"])) return SignIn.failed("organizationKey", { state: "signedOut", field: "clientId" });
    if (hinted(result, "rejected")) return SignIn.failed("notAccepted", { state: "signedOut", field: "clientSecret" });
    const failure = failureOf(result, ctx);
    return SignIn.failed(failure.problem, { state: "signedOut", detail: failure.detail });
  }
  if (!password) return SignIn.needs(MASTER_PASSWORD, { problem: "unlockNext" });
  return unlockWithPassword(ctx, password);
}

async function passwordSignIn(ctx: CredentialContext, email: string, password: string, method: string | undefined, code: string | undefined): Promise<SignInOutcome> {
  if (method !== undefined && !TWO_STEP_METHOD_IDS.includes(method)) return SignIn.failed("chooseMethod", { state: "signedOut" });
  if (code !== undefined && !isCode(code)) return SignIn.needs({ kind: "code", ...(method ? { method } : {}) }, { problem: "badCode", state: "signedOut" });
  if (code === undefined && method !== undefined && method !== "1") return SignIn.needs({ kind: "code", method }, { state: "signedOut" });
  const result = await ctx.cli.verb("login.password", { email, password, method, code });
  if (result.cancelled) return SignIn.cancelled("signedOut");
  if (result.unlocked) return SignIn.done();
  if (hinted(result, "alreadyLoggedIn")) return unlockWithPassword(ctx, password);
  if (hinted(result, "noProvider")) return SignIn.needs({ kind: "code", methods: TWO_STEP_METHODS }, { state: "signedOut" });
  if (hinted(result, "codeRequired")) {
    if (code !== undefined) return SignIn.failed("needsApiKey", { state: "signedOut" });
    if (method === undefined) return SignIn.needs({ kind: "code", methods: TWO_STEP_METHODS }, { problem: "codeOrNewDevice", state: "signedOut" });
    return SignIn.needs({ kind: "code", method }, { state: "signedOut" });
  }
  if (hinted(result, "wrongCredentials")) return SignIn.failed("wrongCredentials", { state: "signedOut", field: "masterPassword" });
  if (hinted(result, "wrongCode") && code !== undefined) return SignIn.needs({ kind: "code", ...(method ? { method } : {}) }, { problem: "wrongCode", state: "signedOut" });
  const failure = failureOf(result, ctx);
  return SignIn.failed(failure.problem, { state: "signedOut", detail: failure.detail });
}

async function itemRecord(ctx: CredentialContext, session: SecretHandle, id: string): Promise<JsonRecord> {
  const result = await ctx.cli.verb("get.item", { session, id });
  check(result, ctx);
  return json.record(result.json);
}

async function listAll(ctx: CredentialContext, session: SecretHandle, onEntry: (entry: JsonRecord) => void) {
  const result = await ctx.cli.verb(
    "list.items",
    { session },
    {
      onItem(raw) {
        const entry = json.dict(raw);
        if (entry) onEntry(entry);
      },
    },
  );
  stopIfCancelled(ctx, result);
  check(result, ctx);
  if (!Array.isArray(result.json) && result.items === 0) throw CredentialError.failed("unreadable");
}

async function syncIfDue(ctx: CredentialContext, session: SecretHandle) {
  if (ctx.offline) return;
  const now = Date.now();
  const last = Number(ctx.scratch.get(SYNCED_AT) ?? "0");
  if (now - last < SYNC_INTERVAL_MS) return;
  const sync = await ctx.cli.verb("sync", { session });
  stopIfCancelled(ctx, sync);
  if (sync.succeeded) await ctx.scratch.set(SYNCED_AT, String(now));
  else if (verbs.mentions(sync, [...HINTS.locked, ...HINTS.signedOut])) check(sync, ctx);
}

async function editLogin(ctx: CredentialContext, id: string, change: LoginChange): Promise<Item> {
  const session = unlockedKey(ctx);
  if (!isGuid(id)) throw CredentialError.notFound();
  const entry = await itemRecord(ctx, session, id);
  if (!json.dict(entry.login)) throw CredentialError.notFound();
  const edited = json.string(entry.id)?.toLowerCase() === id.toLowerCase() ? editedItem(entry, change) : null;
  if (!edited) throw CredentialError.failed("cantPrepare");
  const result = await ctx.cli.verb("edit.item", { session, id, item: edited as JsonValue });
  check(result, ctx);
  const saved = loginItem(json.dict(result.json));
  if (saved) return saved;
  const reread = await ctx.cli.verb("get.item", { session, id });
  const again = reread.succeeded ? loginItem(json.dict(reread.json)) : null;
  if (!again) throw CredentialError.failed("savedNotReturned");
  return again;
}

const sameUrl = (item: Item, url: string) => item.urls.includes(url) || item.urls.some((saved) => origins.host(saved) === origins.host(url));

export const bitwarden: CredentialProvider = {
  async state(_input, ctx): Promise<ProviderState> {
    const current = await readStatus(ctx, ctx.session.current?.key ?? null);
    if (!current.fields) return { state: "unavailable", problem: current.problem, ...(current.detail ? { detail: current.detail } : {}) };
    const server = serverRef(json.string(current.fields.serverUrl));
    const account = json.string(current.fields.userEmail);
    const withAccount = account ? { account } : {};
    switch (statusOf(current.fields)) {
      case "unlocked":
        return { state: ctx.session.current?.key ? "unlocked" : "locked", server, ...withAccount };
      case "locked":
        return { state: "locked", server, ...withAccount };
      default:
        return { state: "signedOut", server };
    }
  },

  async signIn(request, ctx) {
    const current = await readStatus(ctx, null);
    if (current.cancelled) return SignIn.cancelled("signedOut");
    if (!current.fields) return SignIn.failed(current.problem, { state: "unavailable", detail: current.detail });
    const password = secretField(request.fields.masterPassword);
    if (isLoggedIn(current.fields)) return password ? unlockWithPassword(ctx, password) : SignIn.needs(MASTER_PASSWORD);
    if (request.server) {
      const problem = await applyServer(ctx, request.server);
      if (problem === "cancelled") return SignIn.cancelled("signedOut");
      if (problem) return SignIn.failed(problem, { state: "signedOut", field: "server" });
    }
    if (request.method === "apiKey") {
      const clientId = secretField(request.fields.clientId);
      const clientSecret = secretField(request.fields.clientSecret);
      if (!clientId) return SignIn.needs({ kind: "field", field: "clientId" }, { state: "signedOut" });
      if (!clientSecret) return SignIn.needs({ kind: "field", field: "clientSecret" }, { state: "signedOut" });
      return apiKeySignIn(ctx, clientId, clientSecret, password);
    }
    const email = textField(request.fields.email);
    if (!email || !isEmail(email)) return SignIn.needs({ kind: "field", field: "email" }, { state: "signedOut" });
    if (!password) return SignIn.needs(MASTER_PASSWORD, { state: "signedOut" });
    return passwordSignIn(ctx, email, password, request.codeMethod, request.code?.replace(/\s/g, ""));
  },

  async unlock(request, ctx) {
    return request.password ? unlockWithPassword(ctx, request.password) : unlockWithStoredSession(ctx);
  },

  async signOut(_input, ctx) {
    await ctx.cli.verb("logout", { session: ctx.session.current?.key ?? undefined });
  },

  async configure(request, ctx) {
    const current = await readStatus(ctx, null);
    if (current.cancelled) throw CredentialError.failed("cancelled");
    if (current.fields && isLoggedIn(current.fields)) throw CredentialError.failed("signOutFirst", { field: "server" });
    const problem = await applyServer(ctx, request.server);
    if (problem) throw CredentialError.failed(problem, { field: "server" });
  },

  async list(_request, ctx) {
    const session = unlockedKey(ctx);
    await syncIfDue(ctx, session);
    const listed: ListedItem[] = [];
    const seen = new Set<string>();
    await listAll(ctx, session, (entry) => {
      const item = listedItem(entry);
      if (!item || seen.has(item.id)) return;
      seen.add(item.id);
      listed.push(item);
    });
    return listed;
  },

  async reveal(request, ctx) {
    const session = unlockedKey(ctx);
    if (!isGuid(request.id)) throw CredentialError.notFound();
    const revealed: Revealed = {};
    const several = request.fields.length > 1;
    for (const field of request.fields) {
      const result = await ctx.cli.verb("get.field", { session, field, id: request.id });
      stopIfCancelled(ctx, result);
      if (!result.succeeded && several && verbs.mentions(result, [...HINTS.notFound, ...PREMIUM_HINTS])) continue;
      check(result, ctx);
      const value = result.lines.join("\n");
      if (!value) continue;
      if (field === "totp") revealed.totp = value.includes("://") ? { uri: value } : { code: value.trim() };
      else revealed[field] = value;
    }
    return revealed;
  },

  async save({ login }, ctx) {
    const session = unlockedKey(ctx);
    const item = newLoginItem(login.title, login.url, { username: login.username, password: login.password });
    const result = await ctx.cli.verb("create.item", { session, item });
    check(result, ctx);
    const saved = loginItem(json.dict(result.json));
    if (saved) return saved;
    const found: Item[] = [];
    try {
      await listAll(ctx, session, (entry) => {
        const candidate = loginItem(entry);
        if (candidate && candidate.title === login.title && candidate.username === login.username && sameUrl(candidate, login.url)) found.push(candidate);
      });
    } catch (error) {
      if (CredentialError.is(error, "locked") || CredentialError.is(error, "signedOut")) throw error;
    }
    const match = found.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
    if (!match) throw CredentialError.failed("savedNotReturned");
    return match;
  },

  addTotp: ({ id, uri }, ctx) => editLogin(ctx, id, { totp: { set: uri } }),

  edit: ({ id, change }, ctx) => editLogin(ctx, id, change),

  passkeys: {
    async list({ rpId }, ctx) {
      const session = unlockedKey(ctx);
      const wanted = rpId?.toLowerCase() ?? null;
      const found: ListedPasskey[] = [];
      await listAll(ctx, session, (entry) => {
        const item = loginItem(entry);
        const login = loginOf(entry);
        if (!item || !login) return;
        for (const raw of passkeysOf(login)) {
          const meta = passkeyMetadata(raw);
          if (meta && (wanted === null || meta.rpId === wanted)) found.push({ ...meta, item: item.id });
        }
      });
      return found;
    },

    async get({ item, credentialId, rpId }, ctx): Promise<PasskeyKey | null> {
      const session = unlockedKey(ctx);
      if (!isGuid(item)) throw CredentialError.notFound();
      const login = loginOf(await itemRecord(ctx, session, item));
      if (!login) throw CredentialError.notFound();
      for (const entry of passkeysOf(login)) {
        const material = passkeyMaterial(entry);
        if (!material || material.meta.credentialId !== credentialId || material.meta.rpId !== rpId || material.meta.counter !== 0) continue;
        return { credentialId, rpId, privateKey: { format: "pkcs8", der: material.der }, userHandle: material.userHandle, counter: 0 };
      }
      return null;
    },

    async save({ credential, attachTo, title, url }, ctx) {
      const session = unlockedKey(ctx);
      const passkey = passkeyJson(credential);
      if (!passkey) throw CredentialError.failed("cantPrepare");
      if (attachTo && isGuid(attachTo)) {
        const current = await itemRecord(ctx, session, attachTo);
        const login = loginOf(current);
        const existing = login && Array.isArray(login.fido2Credentials) ? login.fido2Credentials : [];
        if (login && existing.length === 0) {
          const updated = { ...current, login: { ...login, fido2Credentials: [passkey] } } as JsonValue;
          check(await ctx.cli.verb("edit.item", { session, id: attachTo, item: updated }), ctx);
          return { item: attachTo };
        }
      }
      const item = newLoginItem(title, url, { username: credential.userName, password: null, fido2Credentials: [passkey] } as JsonRecord);
      const result = await ctx.cli.verb("create.item", { session, item });
      check(result, ctx);
      const created = json.string(json.dict(result.json)?.id);
      if (!created || !isGuid(created)) throw CredentialError.failed("savedNotReturned");
      return { item: created };
    },
  },
};
