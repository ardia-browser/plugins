import { CREDENTIAL_LIMITS, base64url, json, origins, totp, type Item, type ItemPasskey, type JsonRecord, type ListedItem, type VerbResult } from "@ardia-plugins/credential-provider";

export const APPROVAL_HOSTS = ["proton.me"];

const IDENTIFIER = /^[A-Za-z0-9_=+-]{1,200}$/;
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g;
const HAS_UNSAFE_CHARACTER = new RegExp(UNSAFE_CHARACTERS.source);
const SHORTEST_CREDENTIAL_ID = 16;
const LONGEST_CREDENTIAL_ID = 384;
const LONGEST_RP_ID = 253;
const URL_SAFE_BASE64 = /^[A-Za-z0-9_-]+$/;
const STANDARD_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const RP_ID_CHARACTERS = /^[A-Za-z0-9.-]+$/;
const ALL_DIGITS_AND_DOTS = /^[0-9.]+$/;

export const isIdentifier = (text: string) => IDENTIFIER.test(text);

export type Reference = { share: string; item: string };

export function reference(id: string): Reference | null {
  const slash = id.indexOf("/");
  if (slash < 0) return null;
  const share = id.slice(0, slash);
  const item = id.slice(slash + 1);
  const addressable = (part: string) => isIdentifier(part) && !part.startsWith("-");
  return addressable(share) && addressable(item) ? { share, item } : null;
}

export const itemId = (share: string, item: string) => `${share}/${item}`;

export function loginOf(item: JsonRecord | undefined): JsonRecord | undefined {
  return json.dict(json.dict(json.dict(item?.content)?.content)?.Login);
}

export function totpUri(item: JsonRecord): string | undefined {
  const content = json.dict(item.content);
  if (!content) return undefined;
  const direct = json.string(loginOf(item)?.totp_uri);
  if (direct) return direct;
  return json.dicts(content.extra_fields).flatMap((field) => json.string(json.dict(field.content)?.Totp) ?? [])[0];
}

export function usernameOf(login: JsonRecord | undefined): string | undefined {
  return json.string(login?.username) ?? json.string(login?.email);
}

function displayText(text: string, longest: number): string {
  const plain = text.replace(UNSAFE_CHARACTERS, "");
  return plain.length > longest ? plain.slice(0, longest) : plain;
}

const isClean = (text: string, longest: number) => text.length <= longest && !HAS_UNSAFE_CHARACTER.test(text);

const fitsCredentialId = (length: number) => length >= SHORTEST_CREDENTIAL_ID && length <= LONGEST_CREDENTIAL_ID;

function byteArray(value: readonly unknown[]): Uint8Array | null {
  if (!fitsCredentialId(value.length)) return null;
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index++) {
    const byte = value[index];
    if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) return null;
    bytes[index] = byte;
  }
  return bytes;
}

function base64Bytes(text: string): Uint8Array | null {
  if (text.length > Math.ceil(LONGEST_CREDENTIAL_ID / 3) * 4) return null;
  let urlSafe: string;
  if (URL_SAFE_BASE64.test(text)) urlSafe = text;
  else if (STANDARD_BASE64.test(text) && text.length % 4 === 0) urlSafe = text.replace(/=+$/, "").replaceAll("+", "-").replaceAll("/", "_");
  else return null;
  const bytes = base64url.decode(urlSafe, LONGEST_CREDENTIAL_ID);
  return bytes && fitsCredentialId(bytes.length) && base64url.encode(bytes) === urlSafe ? bytes : null;
}

function credentialIdBytes(value: unknown): Uint8Array | null {
  if (Array.isArray(value)) return byteArray(value);
  return typeof value === "string" ? base64Bytes(value) : null;
}

function relyingParty(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > LONGEST_RP_ID || !RP_ID_CHARACTERS.test(value)) return null;
  const rpId = value.toLowerCase();
  if (rpId.startsWith(".") || rpId.endsWith(".") || rpId.includes("..") || ALL_DIGITS_AND_DOTS.test(rpId)) return null;
  return rpId.split(".").every((label) => label.length <= 63 && !label.startsWith("-") && !label.endsWith("-")) ? rpId : null;
}

function passkeyOf(passkey: JsonRecord): ItemPasskey | null {
  const id = credentialIdBytes(passkey.credential_id);
  const rpId = relyingParty(passkey.rp_id);
  if (!id || !rpId) return null;
  return {
    credentialId: base64url.encode(id),
    rpId,
    userName: displayText(json.string(passkey.user_name) ?? "", CREDENTIAL_LIMITS.passkeyNameLength),
    displayName: displayText(json.string(passkey.user_display_name) ?? "", CREDENTIAL_LIMITS.passkeyNameLength),
    discoverable: true,
    counter: 0,
  };
}

function passkeysOf(login: JsonRecord): ItemPasskey[] {
  const listed = login.passkeys;
  if (!Array.isArray(listed) || listed.length === 0) return [];
  const kept: ItemPasskey[] = [];
  const seen = new Set<string>();
  for (const candidate of listed) {
    if (kept.length >= CREDENTIAL_LIMITS.passkeysPerItem) break;
    const record = json.dict(candidate);
    const passkey = record ? passkeyOf(record) : null;
    if (!passkey) continue;
    const key = `${passkey.rpId} ${passkey.credentialId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(passkey);
  }
  return kept;
}

function addUrl(urls: string[], url: string | undefined) {
  if (!url || urls.includes(url) || urls.length >= CREDENTIAL_LIMITS.urlsPerItem) return;
  if (isClean(url, CREDENTIAL_LIMITS.urlLength)) urls.push(url);
}

export function loginItem(entry: JsonRecord, share: string, vault: string | undefined): Item | null {
  const id = json.string(entry.id);
  const content = json.dict(entry.content);
  const login = loginOf(entry);
  if (!id || !isIdentifier(id) || !content || !login) return null;
  const state = json.string(entry.state);
  if (state && state !== "Active") return null;
  const username = usernameOf(login) ?? "";
  if (!isClean(username, CREDENTIAL_LIMITS.usernameLength)) return null;
  const urls: string[] = [];
  for (const url of json.strings(login.urls)) addUrl(urls, url);
  for (const autofill of json.dicts(login.autofill_urls)) {
    if (json.string(autofill.mode) !== "Never") addUrl(urls, json.string(autofill.url));
  }
  const code = totpUri(entry);
  const period = code ? totp.period(code) : undefined;
  const updatedAt = json.milliseconds(entry.modify_time);
  const vaultName = vault ? displayText(vault, CREDENTIAL_LIMITS.vaultNameLength) : "";
  const passkeys = passkeysOf(login);
  return {
    id: itemId(share, id),
    title: displayText(json.string(content.title) ?? "", CREDENTIAL_LIMITS.itemTitleLength),
    username,
    urls,
    hasTotp: code !== undefined,
    ...(period !== undefined ? { totpPeriod: period } : {}),
    ...(vaultName ? { vault: vaultName } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(passkeys.length ? { passkeys } : {}),
  };
}

export function listedItem(entry: JsonRecord, share: string, vault: string | undefined): ListedItem | null {
  const item = loginItem(entry, share, vault);
  if (!item) return null;
  const password = loginOf(entry)?.password;
  const code = totpUri(entry);
  const secrets = {
    ...(typeof password === "string" && password && password.length <= CREDENTIAL_LIMITS.passwordLength ? { password } : {}),
    ...(code && code.length <= CREDENTIAL_LIMITS.passwordLength && totp.parse(code) ? { totp: code } : {}),
  };
  return Object.keys(secrets).length ? { ...item, secrets } : item;
}

export type Vault = { share: string; name: string | undefined; record: JsonRecord };

export function vaultsIn(records: JsonRecord[]): Vault[] {
  const seen = new Set<string>();
  const found: Vault[] = [];
  for (const record of records) {
    const share = json.string(record.share_id);
    if (!share || !isIdentifier(share) || seen.has(share)) continue;
    seen.add(share);
    found.push({ share, name: json.string(record.name), record });
  }
  return found;
}

export type VaultChoice = { vault: Vault } | { problem: "noVault" | "unknownVault" };

export function vaultForNewItems(vaults: Vault[]): VaultChoice {
  const personal = vaults.find((vault) => (vault.name ?? "").toLowerCase() === "personal");
  if (personal) return { vault: personal };
  const owned = vaults.filter(({ record }) => (json.bool(record.owner) ?? json.bool(record.is_owner)) === true || json.bool(record.shared) === false);
  if (owned.length === 1) return { vault: owned[0]! };
  if (vaults.length === 1) return { vault: vaults[0]! };
  return { problem: vaults.length ? "unknownVault" : "noVault" };
}

function printedId(record: JsonRecord | undefined): string | null {
  for (const key of ["item_id", "id"]) {
    const id = json.string(record?.[key]) ?? json.string(json.dict(record?.item)?.[key]);
    if (id && isIdentifier(id)) return id;
  }
  return null;
}

function jsonIn(text: string): JsonRecord | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return undefined;
  try {
    return json.dict(JSON.parse(text.slice(start, end + 1)));
  } catch {
    return undefined;
  }
}

function lastWord(lines: readonly string[]): string | null {
  const last = lines.filter((line) => line.trim()).at(-1) ?? "";
  const word = last.trim().split(/[ :]/).at(-1) ?? "";
  return isIdentifier(word) && word.length >= 8 && /[0-9_=+-]/.test(word) ? word : null;
}

export function createdId(result: Pick<VerbResult, "lines">): string | null {
  return printedId(jsonIn(result.lines.join("\n"))) ?? lastWord(result.lines);
}

const URL_IN_TEXT = /https:\/\/[^\s"'<>]+/g;

export function approvalURL(text: string): string | null {
  for (const match of text.match(URL_IN_TEXT) ?? []) {
    const candidate = match.replace(/[.,;:!?)\]}]+$/, "");
    if (origins.hostIn(candidate, APPROVAL_HOSTS)) return candidate;
  }
  return null;
}
