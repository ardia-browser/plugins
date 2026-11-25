import { CREDENTIAL_LIMITS, CredentialError, json, totp, verbs, type CredentialContext, type Item, type JsonRecord, type RevealRequest, type Revealed } from "@ardia-plugins/credential-provider";
import { check, isItemId, requireUnlocked, withAccount } from "./cli";

const HIDDEN_CHARACTERS = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g;

function cleanText(value: unknown, longest: number): string {
  const text = json.string(value);
  if (!text) return "";
  const plain = text.replace(HIDDEN_CHARACTERS, "");
  if (plain.length <= longest) return plain;
  const characters = Array.from(plain);
  return characters.length <= longest ? plain : characters.slice(0, longest).join("");
}

function urlsOf(entry: JsonRecord): string[] {
  const urls: string[] = [];
  for (const url of json.dicts(entry.urls)) {
    const href = json.string(url.href)?.trim();
    if (!href || href.length > CREDENTIAL_LIMITS.urlLength || /[\s\u0000-\u001f\u007f-\u009f]/.test(href) || urls.includes(href)) continue;
    urls.push(href);
    if (urls.length === CREDENTIAL_LIMITS.urlsPerItem) break;
  }
  return urls;
}

export function listedItem(entry: JsonRecord | undefined): Item | null {
  const id = json.string(entry?.id);
  if (!entry || !id || !isItemId(id)) return null;
  const vault = cleanText(json.dict(entry.vault)?.name, CREDENTIAL_LIMITS.vaultNameLength);
  const favorite = json.bool(entry.favorite);
  const updatedAt = json.milliseconds(entry.updated_at);
  return {
    id,
    title: cleanText(entry.title, CREDENTIAL_LIMITS.itemTitleLength),
    username: cleanText(entry.additional_information, CREDENTIAL_LIMITS.usernameLength),
    urls: urlsOf(entry),
    ...(vault ? { vault } : {}),
    ...(favorite !== undefined ? { favorite } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}

export async function listItems(ctx: CredentialContext): Promise<Item[]> {
  requireUnlocked(ctx);
  const items: Item[] = [];
  const seen = new Set<string>();
  const result = await ctx.cli.verb("item.list", withAccount(ctx), {
    onItem(raw) {
      const item = listedItem(json.dict(raw));
      if (!item || seen.has(item.id)) return;
      seen.add(item.id);
      items.push(item);
    },
  });
  check(result, ctx);
  if (!Array.isArray(result.json)) throw CredentialError.failed("unreadable");
  return items;
}

export async function revealedItem(ctx: CredentialContext, id: string): Promise<JsonRecord> {
  requireUnlocked(ctx);
  if (!isItemId(id)) throw CredentialError.notFound();
  const result = await ctx.cli.verb("item.reveal", withAccount(ctx, { id }));
  check(result, ctx);
  return json.record(result.json);
}

export const isOneTimeField = (field: JsonRecord) => (json.string(field.type) ?? "").toUpperCase() === "OTP";

export function purposeValue(fields: readonly JsonRecord[], purpose: "USERNAME" | "PASSWORD"): string | undefined {
  const value = fields.find((field) => json.string(field.purpose) === purpose)?.value;
  return typeof value === "string" ? value : undefined;
}

function setupURI(fields: readonly JsonRecord[]): string | undefined {
  return fields
    .filter(isOneTimeField)
    .map((field) => (typeof field.value === "string" ? field.value.trim() : ""))
    .find((value) => value.toLowerCase().startsWith("otpauth://") && totp.parse(value) !== null);
}

async function oneTimeCode(ctx: CredentialContext, id: string, fields: readonly JsonRecord[]): Promise<Revealed["totp"]> {
  const otpFields = fields.filter(isOneTimeField);
  const shown = otpFields.map((field) => json.string(field.totp)).find((code) => code !== undefined);
  if (shown) return { code: shown };
  if (!otpFields.length) return undefined;
  const result = await ctx.cli.verb("item.otp", withAccount(ctx, { id }));
  check(result, ctx);
  const fetched = verbs.firstLine(result);
  return fetched ? { code: fetched } : undefined;
}

export async function reveal(ctx: CredentialContext, request: RevealRequest): Promise<Revealed> {
  const fields = json.dicts((await revealedItem(ctx, request.id)).fields);
  const single = request.fields.length === 1;
  const revealed: Revealed = {};
  for (const field of request.fields) {
    if (field === "totp") {
      const uri = setupURI(fields);
      const code = uri ? { uri } : single ? await oneTimeCode(ctx, request.id, fields) : undefined;
      if (code) revealed.totp = code;
      continue;
    }
    const value = purposeValue(fields, field === "username" ? "USERNAME" : "PASSWORD");
    if (value) revealed[field] = value;
  }
  if (single && Object.keys(revealed).length === 0) throw CredentialError.notFound();
  return revealed;
}
