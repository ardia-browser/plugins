import {
  CREDENTIAL_LIMITS,
  base64url,
  json,
  totp,
  uuids,
  type Item,
  type ItemPasskey,
  type JsonRecord,
  type JsonValue,
  type ListedItem,
  type LoginChange,
  type NewPasskey,
  type UrlMatch,
} from "@ardia/plugin-sdk/credentials";

const LOGIN_TYPE = 1;
const LONGEST_CREDENTIAL_ID = 1023;
const LONGEST_USER_HANDLE = 64;
const LONGEST_PRIVATE_KEY = 512;
const LONGEST_RP_ID = 253;
const HIDDEN_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g;

export const isGuid = (id: string) => id.length === 36 && /^[0-9a-fA-F-]+$/.test(id);

function utf8Length(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0;
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
  }
  return bytes;
}

export function clipped(text: string, mostBytes: number): string {
  const plain = text.replace(HIDDEN_CHARACTERS, "").trim();
  if (utf8Length(plain) <= mostBytes) return plain;
  let kept = "";
  let bytes = 0;
  for (const character of plain) {
    const size = utf8Length(character);
    if (bytes + size > mostBytes) break;
    kept += character;
    bytes += size;
  }
  return kept.trimEnd();
}

export const fits = (text: string, mostBytes: number) => utf8Length(text) <= mostBytes && !new RegExp(HIDDEN_CHARACTERS.source).test(text);

export function urlMatch(match: number | undefined): UrlMatch | null {
  if (match === undefined || match === 1) return "host";
  if (match === 2 || match === 3) return "exact";
  if (match === 4 || match === 5) return null;
  return "";
}

export function credentialIdBytes(text: string): Uint8Array | null {
  if (text.startsWith("b64.")) return base64url.decode(text.slice(4), LONGEST_CREDENTIAL_ID);
  return text.length === 36 ? uuids.bytes(text) : null;
}

export function isRelyingPartyDomain(text: string): boolean {
  if (!text || text.length > LONGEST_RP_ID || text.startsWith(".") || text.endsWith(".") || text.includes("..")) return false;
  if (!/^[a-z0-9.-]+$/.test(text) || /^[0-9.]+$/.test(text)) return false;
  return text.split(".").every((label) => label.length <= 63 && !label.startsWith("-") && !label.endsWith("-"));
}

export function passkeyMetadata(entry: JsonRecord): ItemPasskey | null {
  if ((json.string(entry.keyType) ?? "public-key") !== "public-key" || json.string(entry.keyAlgorithm) !== "ECDSA" || json.string(entry.keyCurve) !== "P-256") return null;
  const rawId = json.string(entry.credentialId);
  const id = rawId ? credentialIdBytes(rawId) : null;
  const rpId = json.string(entry.rpId)?.toLowerCase();
  if (!id || !rpId || !isRelyingPartyDomain(rpId)) return null;
  const discoverable = typeof entry.discoverable === "string" ? entry.discoverable === "true" : (json.bool(entry.discoverable) ?? false);
  return {
    credentialId: base64url.encode(id),
    rpId,
    userName: clipped(json.string(entry.userName) ?? "", CREDENTIAL_LIMITS.passkeyNameLength),
    displayName: clipped(json.string(entry.userDisplayName) ?? "", CREDENTIAL_LIMITS.passkeyNameLength),
    discoverable,
    counter: json.int(entry.counter) ?? 0,
  };
}

export type PasskeyMaterial = { meta: ItemPasskey; der: string; userHandle: string };

export function passkeyMaterial(entry: JsonRecord): PasskeyMaterial | null {
  const meta = passkeyMetadata(entry);
  const der = json.string(entry.keyValue);
  const userHandle = json.string(entry.userHandle);
  if (!meta || !der || !userHandle) return null;
  const key = base64url.decode(der, LONGEST_PRIVATE_KEY);
  const handle = base64url.decode(userHandle, LONGEST_USER_HANDLE);
  if (!key || key.length === 0 || !handle || handle.length === 0) return null;
  return { meta, der, userHandle };
}

export function loginOf(entry: JsonRecord | undefined): JsonRecord | null {
  const login = json.dict(entry?.login);
  if (!entry || !login || json.int(entry.type) !== LOGIN_TYPE) return null;
  return login;
}

export function loginItem(entry: JsonRecord | undefined): Item | null {
  const login = loginOf(entry);
  const id = json.string(entry?.id);
  if (!entry || !login || !id || !isGuid(id)) return null;
  if (json.int(entry.reprompt) === 1 || json.string(entry.deletedDate) || json.string(entry.archivedDate)) return null;
  const urls: string[] = [];
  const matches: UrlMatch[] = [];
  for (const uri of json.dicts(login.uris)) {
    const address = json.string(uri.uri);
    const mode = urlMatch(json.int(uri.match));
    if (!address || mode === null || !fits(address, CREDENTIAL_LIMITS.urlLength)) continue;
    if (urls.length >= CREDENTIAL_LIMITS.urlsPerItem) break;
    urls.push(address);
    matches.push(mode);
  }
  const code = json.string(login.totp);
  const passkeys = json
    .dicts(login.fido2Credentials)
    .flatMap((entry) => passkeyMetadata(entry) ?? [])
    .slice(0, CREDENTIAL_LIMITS.passkeysPerItem);
  const favorite = json.bool(entry.favorite);
  const updatedAt = json.milliseconds(entry.revisionDate);
  const period = code ? totp.period(code) : undefined;
  return {
    id,
    title: clipped(json.string(entry.name) ?? "", CREDENTIAL_LIMITS.itemTitleLength),
    username: clipped(json.string(login.username) ?? "", CREDENTIAL_LIMITS.usernameLength),
    urls,
    hasTotp: code !== undefined,
    ...(period !== undefined ? { totpPeriod: period } : {}),
    ...(json.string(entry.organizationId) ? { vault: "Organization" } : {}),
    ...(favorite !== undefined ? { favorite } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(matches.some((match) => match !== "") ? { urlMatch: matches } : {}),
    ...(passkeys.length ? { passkeys } : {}),
  };
}

export function listedItem(entry: JsonRecord | undefined): ListedItem | null {
  const item = loginItem(entry);
  const login = loginOf(entry);
  if (!item || !login) return null;
  const password = json.string(login.password);
  const code = json.string(login.totp);
  const secrets = {
    ...(password && fits(password, CREDENTIAL_LIMITS.passwordLength) ? { password } : {}),
    ...(code && fits(code, CREDENTIAL_LIMITS.passwordLength) && totp.parse(code) ? { totp: code } : {}),
  };
  return Object.keys(secrets).length ? { ...item, secrets } : item;
}

const isEmptyChange = (change: LoginChange) => change.username === undefined && change.password === undefined && change.url === undefined && change.totp === undefined;

export function editedItem(item: JsonRecord, change: LoginChange): JsonRecord | null {
  const login = loginOf(item);
  if (!login || isEmptyChange(change)) return null;
  const next: JsonRecord = { ...login };
  if (change.username !== undefined) next.username = change.username === "" ? null : change.username;
  if (change.password !== undefined) next.password = change.password;
  if (change.url !== undefined) {
    const uris = Array.isArray(login.uris) ? [...(login.uris as unknown[])] : [];
    const first = json.dict(uris[0]);
    if (first) {
      const { uriChecksum: _checksum, ...rest } = first;
      uris[0] = { ...rest, uri: change.url };
    } else if (uris.length === 0) uris.push({ uri: change.url, match: null });
    else uris[0] = { uri: change.url, match: null };
    next.uris = uris;
  }
  if (change.totp === "remove") next.totp = null;
  else if (change.totp) next.totp = change.totp.set;
  return { ...item, login: next };
}

export function newLoginItem(title: string, url: string, login: JsonRecord): JsonValue {
  return {
    type: LOGIN_TYPE,
    name: title,
    notes: null,
    favorite: false,
    folderId: null,
    organizationId: null,
    reprompt: 0,
    fields: [],
    login: { uris: [{ uri: url, match: null }], totp: null, ...login },
  } as JsonValue;
}

export function passkeyJson(credential: NewPasskey): JsonRecord | null {
  const uuid = uuids.bytes(credential.credentialUuid);
  if (!uuid || credential.privateKey.format !== "pkcs8" || !base64url.decode(credential.privateKey.der, LONGEST_PRIVATE_KEY)) return null;
  const handle = base64url.decode(credential.userHandle, LONGEST_USER_HANDLE);
  if (!handle || handle.length === 0 || !isRelyingPartyDomain(credential.rpId)) return null;
  return {
    credentialId: uuids.string(uuid),
    keyType: "public-key",
    keyAlgorithm: "ECDSA",
    keyCurve: "P-256",
    keyValue: credential.privateKey.der,
    rpId: credential.rpId,
    rpName: credential.rpName || credential.rpId,
    userHandle: credential.userHandle,
    userName: credential.userName,
    userDisplayName: credential.displayName,
    counter: "0",
    discoverable: "true",
    creationDate: new Date(credential.createdAt).toISOString(),
  };
}

export const passkeysOf = (login: JsonRecord) => json.dicts(login.fido2Credentials);
