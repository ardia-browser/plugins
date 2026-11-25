import { CredentialError, json, type CredentialContext } from "@ardia/plugin-sdk/credentials";
import { listAccounts, rememberedAccount } from "./accounts";
import { check, isItemId, requireUnlocked, withAccount } from "./cli";

export const APP_LINK_PREFIX = "https://start.1password.com/open/i?";

const ACCOUNT_UUID = /^[A-Za-z0-9]{1,64}$/;
const SIGN_IN_HOST = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/;

export type LinkParts = { account: string; vault: string; item: string; signInAddress: string };

export function signInHost(address: string): string | null {
  const host = address.trim().toLowerCase().replace(/^https:\/\//, "").replace(/\/+$/, "");
  return SIGN_IN_HOST.test(host) && host.length <= 253 ? host : null;
}

export function privateLink({ account, vault, item, signInAddress }: LinkParts): string | null {
  const host = signInHost(signInAddress);
  if (!host || !ACCOUNT_UUID.test(account) || !isItemId(vault) || !isItemId(item)) return null;
  return `${APP_LINK_PREFIX}a=${account}&v=${vault}&i=${item}&h=${host}`;
}

export async function itemLink(ctx: CredentialContext, item: string): Promise<{ url: string }> {
  requireUnlocked(ctx);
  if (!isItemId(item)) throw CredentialError.notFound();
  const listed = await listAccounts(ctx);
  if (listed.problem) throw CredentialError.failed(listed.problem, listed.detail ? { detail: listed.detail } : {});
  const account = await rememberedAccount(ctx, listed.accounts);
  if (!account?.uuid || !account.url) throw CredentialError.failed("unreadable");
  const result = await ctx.cli.verb("item.link", withAccount(ctx, { id: item }));
  check(result, ctx);
  const stored = json.dict(result.json);
  const vault = json.string(json.dict(stored?.vault)?.id);
  const url = json.string(stored?.id) === item && vault ? privateLink({ account: account.uuid, vault, item, signInAddress: account.url }) : null;
  if (!url) throw CredentialError.failed("unreadable");
  return { url };
}
