import { CREDENTIAL_LIMITS, CredentialError, json, origins, totp, type CredentialContext, type Item, type JsonRecord, type JsonValue, type LoginChange, type VerbParams } from "@ardia-plugins/credential-provider";
import { check, isItemId, requireUnlocked, withAccount } from "./cli";
import { isOneTimeField, listedItem, purposeValue, revealedItem } from "./items";

export const CODE_FIELD_LABEL = "one-time password";

export const MOST_CODE_FIELDS_REMOVED = 4;
export const REMOVE_CODE_SLOTS = Array.from({ length: MOST_CODE_FIELDS_REMOVED }, (_, i) => `removeCode${i + 1}`);

const USERNAME_ASSIGNMENT = /^username=[^\u0000-\u001f\u007f-\u009f]*$/;
const FIELD_DELETION = /^[^\u0000-\u001f\u007f-\u009f[\]\-][^\u0000-\u001f\u007f-\u009f[\]]*\[delete\]$/;
const CONTROL_OR_SPACE = /[\s\u0000-\u001f\u007f-\u009f]/;
const BREAKS = /[\n\r\0]/;
const NAMES_OP_RESERVES = new Set(["username", "password", "notesplain", "notes", "title", "url", "website"]);

const newCode = (change: LoginChange) => (change.totp === undefined || change.totp === "remove" ? undefined : change.totp.set);

export const carriesSecret = (change: LoginChange) => change.password !== undefined || newCode(change) !== undefined;

const mentionsPasskey = (value: unknown) => typeof value === "string" && /passkey/i.test(value);

export function holdsPasskey(item: JsonRecord): boolean {
  if (item.passkey !== undefined || item.passkeys !== undefined) return true;
  return json.dicts(item.fields).some((field) => mentionsPasskey(field.type) || mentionsPasskey(field.purpose) || mentionsPasskey(field.id));
}

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

const takesSecret = (value: string, most: number) => value.length > 0 && !BREAKS.test(value) && utf8Length(value) <= most;

function withValue(fields: JsonRecord[], purpose: string, value: string, fresh: JsonRecord) {
  const at = fields.findIndex((field) => json.string(field.purpose) === purpose);
  if (at < 0) fields.push({ ...fresh, value });
  else {
    const { password_details: _details, entropy: _entropy, ...kept } = fields[at]!;
    fields[at] = { ...kept, value };
  }
}

export function editedTemplate(item: JsonRecord, change: LoginChange): JsonRecord | null {
  if ((json.string(item.category) ?? "LOGIN").toUpperCase() !== "LOGIN") return null;
  let fields = json.dicts(item.fields).map((field) => ({ ...field }));
  let urls = json.dicts(item.urls).map((url) => ({ ...url }));
  if (change.username !== undefined) {
    if (!fitsIdSlot(`username=${change.username}`, USERNAME_ASSIGNMENT)) return null;
    withValue(fields, "USERNAME", change.username, { id: "username", type: "STRING", purpose: "USERNAME", label: "username" });
  }
  if (change.password !== undefined) {
    if (!takesSecret(change.password, CREDENTIAL_LIMITS.passwordLength)) return null;
    withValue(fields, "PASSWORD", change.password, { id: "password", type: "CONCEALED", purpose: "PASSWORD", label: "password" });
  }
  if (change.url !== undefined) {
    if (!assignableUrl(change.url)) return null;
    const primary = urls.findIndex((url) => url.primary === true);
    if (primary >= 0) urls[primary] = { ...urls[primary], href: change.url };
    else urls = [{ href: change.url, primary: true }, ...urls];
  }
  if (change.totp !== undefined) {
    const setting = newCode(change);
    if (setting !== undefined && (!takesSecret(setting, CREDENTIAL_LIMITS.secretBytes) || !totp.parse(setting))) return null;
    const label = opName(CODE_FIELD_LABEL);
    if (setting !== undefined && fields.some((field) => !isOneTimeField(field) && namesField(field, label))) return null;
    fields = fields.filter((field) => !isOneTimeField(field));
    if (setting !== undefined) fields.push({ id: "TOTP_ardia", type: "OTP", label: CODE_FIELD_LABEL, value: setting });
  }
  return { ...item, fields, urls };
}

function prepared(ctx: CredentialContext, id: string, stored: JsonRecord, change: LoginChange) {
  if (!carriesSecret(change)) {
    const params = assignments(stored, change);
    return params ? { verb: "item.assign", params: withAccount(ctx, { id, ...params }), empty: Object.keys(params).length === 0 } : null;
  }
  if (holdsPasskey(stored)) return null;
  const template = editedTemplate(stored, change);
  return template ? { verb: "item.replace", params: withAccount(ctx, { id, template: template as JsonValue }), empty: false } : null;
}

export async function editItem(ctx: CredentialContext, id: string, change: LoginChange): Promise<Item> {
  requireUnlocked(ctx);
  if (!isItemId(id)) throw CredentialError.notFound();
  const stored = await revealedItem(ctx, id);
  const edit = json.string(stored.id) === id ? prepared(ctx, id, stored, change) : null;
  if (!edit) throw CredentialError.failed("cantPrepare");
  if (edit.empty) {
    const unchanged = listedItem(stored);
    if (!unchanged || change.totp !== "remove" || !holds(stored, change)) throw CredentialError.failed("cantPrepare");
    return unchanged;
  }
  const result = await ctx.cli.verb(edit.verb, edit.params);
  check(result, ctx);
  const returned = json.dict(result.json);
  const saved = listedItem(returned);
  if (!returned || !saved) throw CredentialError.failed("savedNotReturned");
  if (!holds(returned, change) && !holds(await revealedItem(ctx, id), change)) throw CredentialError.failed("notTaken");
  return change.username !== undefined ? { ...saved, username: change.username } : saved;
}
