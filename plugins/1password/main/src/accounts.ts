import { CREDENTIAL_LIMITS, SignIn, json, verbs, type Choice, type CredentialContext, type JsonRecord, type ProblemCode, type ProviderState, type SignInOutcome, type VerbResult } from "@ardia/plugin-sdk/credentials";
import { ACCOUNT_PREFERENCE, problemOf } from "./cli";

export type Account = { reference: string; names: string[]; uuid?: string; email?: string; url?: string };

const ACCOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.@_-]{0,319}$/;
const REFERENCE_KEYS = ["account_uuid", "shorthand", "url"];
const NAME_KEYS = ["account_uuid", "shorthand", "url", "email", "user_uuid"];

function accountOf(record: JsonRecord): Account | null {
  const reference = REFERENCE_KEYS.map((key) => json.string(record[key])).find((value) => value !== undefined && ACCOUNT_PATTERN.test(value));
  if (!reference) return null;
  const email = json.string(record.email);
  const url = json.string(record.url);
  const uuid = json.string(record.account_uuid);
  return {
    reference,
    names: NAME_KEYS.flatMap((key) => json.string(record[key]) ?? []),
    ...(uuid ? { uuid } : {}),
    ...(email ? { email } : {}),
    ...(url ? { url } : {}),
  };
}

type Listed = { accounts: Account[]; problem: null } | { accounts: []; problem: ProblemCode; detail?: string };

const CONFIG_NOTICE = /^Using configuration at non-standard location /;

function failureDetail(result: VerbResult, problem: ProblemCode): { detail?: string } {
  if (problem !== "failed") return {};
  const stderr = result.stderr.split(/\r?\n/).filter((line) => !CONFIG_NOTICE.test(line.trim())).join("\n");
  const detail = verbs.firstLine({ ...result, stderr });
  return detail ? { detail } : {};
}

export async function listAccounts(ctx: CredentialContext): Promise<Listed> {
  const result = await ctx.cli.verb("account.list");
  if (result.succeeded) {
    if (!Array.isArray(result.json)) return { accounts: [], problem: "unreadable" };
    const seen = new Set<string>();
    const accounts = json.list(result.json).flatMap((record) => {
      const account = accountOf(record);
      if (!account || seen.has(account.reference)) return [];
      seen.add(account.reference);
      return [account];
    });
    return { accounts, problem: null };
  }
  if (result.hints.includes("noAccounts")) return { accounts: [], problem: null };
  const problem = problemOf(result, ctx);
  return { accounts: [], problem, ...failureDetail(result, problem) };
}

export async function rememberedAccount(ctx: CredentialContext, accounts: readonly Account[]): Promise<Account | undefined> {
  const chosen = ctx.preferences.get(ACCOUNT_PREFERENCE);
  if (chosen) {
    const match = accounts.find((account) => account.names.includes(chosen));
    if (match) return match;
    await ctx.preferences.set(ACCOUNT_PREFERENCE, null);
  }
  return accounts.length === 1 ? accounts[0] : undefined;
}

function clampTitle(text: string): string {
  const characters = Array.from(text);
  return characters.length > CREDENTIAL_LIMITS.choiceTitleLength ? `${characters.slice(0, CREDENTIAL_LIMITS.choiceTitleLength - 3).join("")}...` : text;
}

export function accountChoices(accounts: readonly Account[]): Choice[] {
  const emails = accounts.map((account) => account.email ?? account.url ?? account.reference);
  return accounts.slice(0, CREDENTIAL_LIMITS.choices).map((account, index) => {
    const name = emails[index]!;
    const shared = emails.filter((email) => email === name).length > 1;
    const title = shared && account.url && account.url !== name ? `${name} on ${account.url}` : name;
    return { id: account.reference, title: clampTitle(title) };
  });
}

function serverOf(url: string): { url: string } {
  return { url: /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}` };
}

export async function providerState(ctx: CredentialContext): Promise<ProviderState> {
  const listed = await listAccounts(ctx);
  if (listed.problem) return { state: "unavailable", problem: listed.problem, ...(listed.detail ? { detail: listed.detail } : {}) };
  if (!listed.accounts.length) return { state: "signedOut", problem: "setupNeeded" };
  const account = await rememberedAccount(ctx, listed.accounts);
  if (!account) return { state: "signedOut" };
  return {
    state: ctx.session.current ? "unlocked" : "locked",
    ...(account.email ? { account: account.email } : {}),
    ...(account.url ? { server: serverOf(account.url) } : {}),
  };
}

export async function connect(ctx: CredentialContext, requested: string | undefined, waitingState: "signedOut" | "locked"): Promise<SignInOutcome> {
  const listed = await listAccounts(ctx);
  if (listed.problem) return SignIn.failed(listed.problem, { state: "unavailable", ...(listed.detail ? { detail: listed.detail } : {}) });
  if (!listed.accounts.length) return SignIn.failed("setupNeeded", { state: "signedOut" });
  let account: Account | undefined;
  if (requested) {
    account = listed.accounts.find((candidate) => candidate.names.includes(requested));
    if (!account) return SignIn.needs({ kind: "account", choices: accountChoices(listed.accounts) }, { state: waitingState });
  } else {
    account = await rememberedAccount(ctx, listed.accounts);
    if (!account) return SignIn.needs({ kind: "account", choices: accountChoices(listed.accounts) }, { state: waitingState });
  }
  await ctx.preferences.set(ACCOUNT_PREFERENCE, account.reference);
  const result = await ctx.cli.verb("connect", { account: account.reference });
  if (result.cancelled) return SignIn.cancelled("locked");
  if (result.succeeded) return SignIn.done();
  if (result.timedOut || result.hints.includes("approvalTimedOut")) return SignIn.failed("approvalTimedOut");
  if (result.hints.includes("dismissed")) return SignIn.failed("stayedLocked");
  if (result.hints.includes("appUnreachable")) return SignIn.failed("appUnreachable");
  if (result.hints.includes("setupNeeded")) return SignIn.failed("setupNeeded");
  const problem = problemOf(result, ctx);
  return SignIn.failed(problem, failureDetail(result, problem));
}

export async function signOut(ctx: CredentialContext): Promise<void> {
  const account = ctx.preferences.get(ACCOUNT_PREFERENCE);
  await ctx.cli.verb("signout", account ? { account } : {});
  await ctx.preferences.set(ACCOUNT_PREFERENCE, null);
}
