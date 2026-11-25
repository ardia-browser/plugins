import { CredentialError, verbs, type CredentialContext, type RunHints, type VerbParams, type VerbResult } from "@ardia/plugin-sdk/credentials";

export const ACCOUNT_PREFERENCE = "account";

export const HINTS: RunHints = {
  locked: [
    "not signed in",
    "not currently signed in",
    "authorization prompt dismissed",
    "authorization timeout",
    "authorization denied",
    "session expired",
    "signin is required",
    "sign in again",
  ],
  signedOut: ["no accounts configured"],
  notFound: [
    "isn't an item",
    "could not get item",
    "could not find item",
    "no item found",
    "does not have a field",
    "more than one item",
    "isn't a valid",
    "no one-time password",
  ],
};

export const APP_UNREACHABLE_HINTS = ["cannot connect", "connect to the 1password app", "desktop app"];

const OUTDATED_HINTS = ["unknown flag", "unknown shorthand flag"];

const ITEM_ID = /^[A-Za-z0-9]{1,64}$/;

export const isItemId = (id: string) => ITEM_ID.test(id);

export function withAccount(ctx: CredentialContext, params: VerbParams = {}): VerbParams {
  const account = ctx.preferences.get(ACCOUNT_PREFERENCE);
  return account ? { ...params, account } : params;
}

export function requireUnlocked(ctx: CredentialContext): void {
  if (!ctx.session.current) throw CredentialError.locked();
}

const ranAndFailed = (result: VerbResult) => !result.succeeded && result.launched && !result.cancelled && !result.timedOut && !result.overflowed;

export function check(result: VerbResult, ctx: CredentialContext): void {
  if (ranAndFailed(result) && !verbs.mentions(result, HINTS.locked ?? [])) {
    if (verbs.mentions(result, APP_UNREACHABLE_HINTS)) throw CredentialError.failed("appUnreachable");
    if (verbs.mentions(result, OUTDATED_HINTS)) throw CredentialError.failed("outdated");
  }
  verbs.check(result, HINTS, ctx.offline);
}

export function problemOf(result: VerbResult, ctx: CredentialContext) {
  if (ranAndFailed(result) && verbs.mentions(result, OUTDATED_HINTS)) return "outdated" as const;
  return verbs.problem(result, ctx.offline);
}
