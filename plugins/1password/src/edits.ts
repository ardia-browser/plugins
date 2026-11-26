import { CREDENTIAL_LIMITS, CredentialError, json, origins, totp, type CredentialContext, type Item, type JsonRecord, type LoginChange, type VerbParams } from "@ardia-plugins/credential-provider";
import { check, isItemId, requireUnlocked, withAccount } from "./cli";
import { isOneTimeField, listedItem, purposeValue, revealedItem } from "./items";

export const CODE_FIELD_LABEL = "one-time password";

export const MOST_CODE_FIELDS_REMOVED = 4;
export const REMOVE_CODE_SLOTS = Array.from({ length: MOST_CODE_FIELDS_REMOVED }, (_, i) => `removeCode${i + 1}`);

const USERNAME_ASSIGNMENT = /^username=[^\u0000-\u001f\u007f-\u009f]*$/;
const FIELD_DELETION = /^[^\u0000-\u001f\u007f-\u009f[\]\-][^\u0000-\u001f\u007f-\u009f[\]]*\[delete\]$/;
const CONTROL_OR_SPACE = /[\s\u0000-\u001f\u007f-\u009f]/;
const NAMES_OP_RESERVES = new Set(["username", "password", "notesplain", "notes", "title", "url", "website"]);

const newCode = (change: LoginChange) => (change.totp === undefined || change.totp === "remove" ? undefined : change.totp.set);

export const carriesSecret = (change: LoginChange) => change.password !== undefined || newCode(change) !== undefined;

export const KEEPS_PASSKEY_DETAIL = "Change this login's password or one-time code in 1Password itself: op can only set them on the command line or by replacing the whole login, which can remove its passkey.";

export function holds(item: JsonRecord, change: LoginChange, now = Date.now()): boolean {
  const fields = json.dicts(item.fields);
  if (change.username !== undefined && (purposeValue(fields, "USERNAME") ?? "") !== change.username) return false;
  if (change.url !== undefined && !json.dicts(item.urls).some((url) => json.string(url.href) === change.url)) return false;
  if (change.password !== undefined && purposeValue(fields, "PASSWORD") !== change.password) return false;
  if (change.totp === "remove") return !fields.some(isOneTimeField);
  const uri = newCode(change);
  if (typeof uri === "string") {
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

function utf8Length(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const point = character.codePointAt(0)!;
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
  }
  return bytes;
}

const fitsIdSlot = (argument: string, shape: RegExp) => shape.test(argument) && utf8Length(argument) <= CREDENTIAL_LIMITS.idSlotLength;

const opName = (name: string) => name.replace(/\s/g, "").toLowerCase();

export function assignableUrl(url: string): boolean {
  if (!url || url.length > CREDENTIAL_LIMITS.urlLength || url.startsWith("-") || CONTROL_OR_SPACE.test(url) || !origins.isWebOrigin(url)) return false;
  const scheme = url.slice(0, url.indexOf(":")).toLowerCase();
  return scheme === "https" || (scheme === "http" && origins.isLocalHost(origins.host(url) ?? ""));
}

const namesField = (field: JsonRecord, name: string) => [field.label, field.id].some((text) => typeof text === "string" && opName(text) === name);

export function fieldDeletion(field: JsonRecord, fields: readonly JsonRecord[]): string | null {
  const label = json.string(field.label) ?? "";
  const name = opName(label);
  if (!name || NAMES_OP_RESERVES.has(name) || /[[\]]/.test(label)) return null;
  if (fields.some((other) => other !== field && namesField(other, name))) return null;
  const deletion = `${label.replace(/[\\.=]/g, (character) => `\\${character}`)}[delete]`;
  return fitsIdSlot(deletion, FIELD_DELETION) ? deletion : null;
}

function codeChanges(fields: readonly JsonRecord[], keepNamed: string | null): Record<string, string> | null {
  const codeFields = fields.filter(isOneTimeField);
  const kept = keepNamed === null ? [] : fields.filter((field) => namesField(field, keepNamed));
  if (kept.length > 1 || kept.some((field) => !isOneTimeField(field))) return null;
  const removed = codeFields.filter((field) => !kept.includes(field));
  if (removed.length > MOST_CODE_FIELDS_REMOVED) return null;
  const params: Record<string, string> = {};
  for (const [at, field] of removed.entries()) {
    const deletion = fieldDeletion(field, fields);
    if (!deletion) return null;
    params[REMOVE_CODE_SLOTS[at]!] = deletion;
  }
  return params;
}

export function assignments(item: JsonRecord, change: LoginChange): VerbParams | null {
  if ((json.string(item.category) ?? "LOGIN").toUpperCase() !== "LOGIN" || carriesSecret(change)) return null;
  const params: Record<string, string> = {};
  if (change.username !== undefined) {
    const username = `username=${change.username}`;
    if (!fitsIdSlot(username, USERNAME_ASSIGNMENT)) return null;
    params.username = username;
  }
  if (change.url !== undefined) {
    if (!assignableUrl(change.url)) return null;
    params.url = change.url;
  }
  if (change.totp === "remove") {
    const codes = codeChanges(json.dicts(item.fields), null);
    if (!codes) return null;
    Object.assign(params, codes);
  }
  return params;
}

export async function editItem(ctx: CredentialContext, id: string, change: LoginChange): Promise<Item> {
  requireUnlocked(ctx);
  if (!isItemId(id)) throw CredentialError.notFound();
  if (carriesSecret(change)) throw CredentialError.failed("cantPrepare", { detail: KEEPS_PASSKEY_DETAIL });
  const stored = await revealedItem(ctx, id);
  const params = json.string(stored.id) === id ? assignments(stored, change) : null;
  if (!params) throw CredentialError.failed("cantPrepare");
  if (Object.keys(params).length === 0) {
    const unchanged = listedItem(stored);
    if (!unchanged || change.totp !== "remove" || !holds(stored, change)) throw CredentialError.failed("cantPrepare");
    return unchanged;
  }
  const result = await ctx.cli.verb("item.assign", withAccount(ctx, { id, ...params }));
  check(result, ctx);
  const returned = json.dict(result.json);
  const saved = listedItem(returned);
  if (!returned || !saved) throw CredentialError.failed("savedNotReturned");
  if (!holds(returned, change) && !holds(await revealedItem(ctx, id), change)) throw CredentialError.failed("notTaken");
  return change.username !== undefined ? { ...saved, username: change.username } : saved;
}
