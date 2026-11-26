import { CredentialError, json, type CredentialContext, type Item, type JsonRecord, type JsonValue, type NewLogin } from "@ardia-plugins/credential-provider";
import { check, isItemId, requireUnlocked, withAccount } from "./cli";
import { holds } from "./edits";
import { listedItem, revealedItem } from "./items";

const PERSONAL_VAULT_NAMES = new Set(["private", "personal", "employee"]);
const PERSONAL_VAULT_TYPES = new Set(["PERSONAL", "PRIVATE", "EMPLOYEE"]);
const MOST_VAULTS_CHECKED = 12;

const isPersonalType = (vault: JsonRecord) => PERSONAL_VAULT_TYPES.has((json.string(vault.type) ?? "").toUpperCase());

export async function vaultForNewItems(ctx: CredentialContext): Promise<string> {
  const listed = await ctx.cli.verb("vault.list", withAccount(ctx));
  check(listed, ctx);
  const vaults = json.list(listed.json).filter((vault) => isItemId(json.string(vault.id) ?? ""));
  const ids = vaults.map((vault) => json.string(vault.id)!);
  const named = vaults.find((vault) => PERSONAL_VAULT_NAMES.has((json.string(vault.name) ?? "").toLowerCase()));
  if (named) return json.string(named.id)!;
  const typed = vaults.find(isPersonalType);
  if (typed) return json.string(typed.id)!;
  for (const id of ids.slice(0, MOST_VAULTS_CHECKED)) {
    const detail = await ctx.cli.verb("vault.get", withAccount(ctx, { id }));
    const vault = detail.succeeded ? json.dict(detail.json) : undefined;
    if (vault && isPersonalType(vault)) return id;
  }
  if (ids.length === 1) return ids[0]!;
  throw CredentialError.failed(ids.length ? "unknownVault" : "noVault");
}

function newLoginTemplate(login: NewLogin): JsonRecord {
  return {
    title: login.title,
    category: "LOGIN",
    fields: [
      { id: "username", type: "STRING", purpose: "USERNAME", label: "username", value: login.username },
      { id: "password", type: "CONCEALED", purpose: "PASSWORD", label: "password", value: login.password },
    ],
    urls: [{ href: login.url, primary: true }],
  };
}

function withCredentials(item: JsonRecord, login: NewLogin): JsonRecord | null {
  if ((json.string(item.category) ?? "LOGIN").toUpperCase() !== "LOGIN") return null;
  const fields = json.dicts(item.fields).map((field) => ({ ...field }));
  for (const wanted of newLoginTemplate(login).fields as JsonRecord[]) {
    const at = fields.findIndex((field) => json.string(field.purpose) === wanted.purpose);
    if (at < 0) fields.push(wanted);
    else {
      const { password_details: _details, entropy: _entropy, ...kept } = fields[at]!;
      fields[at] = { ...kept, value: wanted.value };
    }
  }
  return { ...item, fields };
}

async function confirmCredentials(ctx: CredentialContext, id: string, login: NewLogin) {
  const wanted = { username: login.username, password: login.password };
  const stored = await revealedItem(ctx, id);
  if (holds(stored, wanted)) return;
  const repair = json.string(stored.id) === id ? withCredentials(stored, login) : null;
  if (!repair) throw CredentialError.failed("incomplete");
  check(await ctx.cli.verb("item.replace", withAccount(ctx, { id, template: repair as JsonValue })), ctx);
  if (!holds(await revealedItem(ctx, id), wanted)) throw CredentialError.failed("incomplete");
}

export async function saveLogin(ctx: CredentialContext, login: NewLogin): Promise<Item> {
  requireUnlocked(ctx);
  const vault = await vaultForNewItems(ctx);
  const result = await ctx.cli.verb("item.create", withAccount(ctx, { vault, template: newLoginTemplate(login) as JsonValue }));
  check(result, ctx);
  const created = listedItem(json.dict(result.json));
  if (!created) throw CredentialError.failed("savedNotReturned");
  await confirmCredentials(ctx, created.id, login);
  return { ...created, username: created.username || login.username, urls: created.urls.length ? created.urls : [login.url] };
}
