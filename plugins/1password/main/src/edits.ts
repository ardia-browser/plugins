import { CredentialError, json, totp, type CredentialContext, type Item, type JsonRecord, type JsonValue, type LoginChange } from "@ardia/plugin-sdk/credentials";
import { check, isItemId, requireUnlocked, withAccount } from "./cli";
import { isOneTimeField, listedItem, purposeValue, revealedItem } from "./items";

export const CODE_FIELD_ID = "ardia-one-time-password";

const USERNAME_FIELD = { id: "username", type: "STRING", purpose: "USERNAME", label: "username" };
const PASSWORD_FIELD = { id: "password", type: "CONCEALED", purpose: "PASSWORD", label: "password" };

const isEmptyChange = (change: LoginChange) =>
  change.username === undefined && change.password === undefined && change.url === undefined && change.totp === undefined;

export function holds(item: JsonRecord, change: LoginChange, now = Date.now()): boolean {
  const fields = json.dicts(item.fields);
  if (change.username !== undefined && (purposeValue(fields, "USERNAME") ?? "") !== change.username) return false;
  if (change.password !== undefined && purposeValue(fields, "PASSWORD") !== change.password) return false;
  if (change.url !== undefined && !json.dicts(item.urls).some((url) => json.string(url.href) === change.url)) return false;
  if (change.totp === "remove") return !fields.some(isOneTimeField);
  if (change.totp) {
    const uri = change.totp.set;
    const wanted = totp.parse(uri);
    if (!wanted) return false;
    const codes = new Set([-1, 0, 1].map((step) => totp.code(wanted, now + step * wanted.period * 1000)));
    return fields.filter(isOneTimeField).some((field) => {
      if (typeof field.value === "string" && totp.same(field.value, uri)) return true;
      const code = json.string(field.totp);
      return code !== undefined && codes.has(code);
    });
  }
  return true;
}

function setPurpose(fields: JsonRecord[], purpose: string, value: string, added: JsonRecord) {
  const at = fields.findIndex((field) => json.string(field.purpose) === purpose);
  if (at >= 0) fields[at] = { ...fields[at], value };
  else fields.push({ ...added, value });
}

export function editedTemplate(item: JsonRecord, change: LoginChange): JsonRecord | null {
  if (isEmptyChange(change) || (json.string(item.category) ?? "LOGIN").toUpperCase() !== "LOGIN") return null;
  let fields: JsonRecord[] = json.dicts(item.fields).map((field) => ({ ...field }));
  if (change.username !== undefined) setPurpose(fields, "USERNAME", change.username, USERNAME_FIELD);
  if (change.password !== undefined) {
    setPurpose(fields, "PASSWORD", change.password, PASSWORD_FIELD);
    const at = fields.findIndex((field) => json.string(field.purpose) === "PASSWORD");
    const { password_details: _details, entropy: _entropy, ...rest } = fields[at]!;
    fields[at] = rest;
  }
  if (change.totp === "remove") fields = fields.filter((field) => !isOneTimeField(field));
  else if (change.totp) {
    const uri = change.totp.set;
    const at = fields.findIndex(isOneTimeField);
    if (at >= 0) {
      const { totp: _code, ...rest } = fields[at]!;
      fields[at] = { ...rest, value: uri };
    } else fields.push({ id: CODE_FIELD_ID, type: "OTP", label: "one-time password", value: uri });
  }
  const edited: JsonRecord = { ...item, fields };
  if (change.url !== undefined) {
    const urls = json.dicts(item.urls).map((url) => ({ ...url }));
    const primary = urls.findIndex((url) => json.bool(url.primary) === true);
    const at = primary >= 0 ? primary : urls.length ? 0 : -1;
    if (at >= 0) urls[at] = { ...urls[at], href: change.url };
    edited.urls = at >= 0 ? urls : [{ href: change.url, primary: true }];
  }
  return edited;
}

export async function editItem(ctx: CredentialContext, id: string, change: LoginChange): Promise<Item> {
  requireUnlocked(ctx);
  if (!isItemId(id)) throw CredentialError.notFound();
  const template = await revealedItem(ctx, id);
  const edited = json.string(template.id) === id ? editedTemplate(template, change) : null;
  if (!edited) throw CredentialError.failed("cantPrepare");
  const result = await ctx.cli.verb("item.edit", withAccount(ctx, { id, template: edited as JsonValue }));
  check(result, ctx);
  const returned = json.dict(result.json);
  const saved = listedItem(returned);
  if (!returned || !saved) throw CredentialError.failed("savedNotReturned");
  if (!holds(returned, change) && !holds(await revealedItem(ctx, id), change)) throw CredentialError.failed("notTaken");
  return change.username !== undefined ? { ...saved, username: change.username } : saved;
}
