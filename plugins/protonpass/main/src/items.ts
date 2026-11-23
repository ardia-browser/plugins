import { CREDENTIAL_LIMITS, json, origins, totp, type Item, type JsonRecord, type ListedItem, type VerbResult } from "@ardia/plugin-sdk/credentials";

export const APPROVAL_HOSTS = ["proton.me"];

const IDENTIFIER = /^[A-Za-z0-9_=+-]{1,200}$/;
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g;

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

const isClean = (text: string, longest: number) => text.length <= longest && !new RegExp(UNSAFE_CHARACTERS.source).test(text);

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
  return {
    id: itemId(share, id),
    title: displayText(json.string(content.title) ?? "", CREDENTIAL_LIMITS.itemTitleLength),
    username,
    urls,
    hasTotp: code !== undefined,
    ...(period !== undefined ? { totpPeriod: period } : {}),
    ...(vaultName ? { vault: vaultName } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
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
