import { createHash, timingSafeEqual } from "node:crypto";

export const CREDENTIAL = /^p\.[A-Za-z0-9_-]{43}$/u;
export const CREDENTIAL_ID = /^[0-9a-f]{32}$/u;
const TOKEN_SERVER = /^ws:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/devtools\/browser\/[A-Za-z0-9._-]{1,128}$/u;

export function credentialId(credential: string): string {
  return createHash("sha256").update(Buffer.from(credential, "utf8")).digest("hex").slice(0, 32);
}

export function pluginEndpointKey(credential: string): string {
  return `plugin:${credentialId(credential)}`;
}

export function pluginSessionKey(namespace: string, credential: string, session: string): string {
  const raw = `${namespace}\0${pluginEndpointKey(credential)}\0${session}\0plugin`;
  return createHash("sha256").update(Buffer.from(raw, "utf8")).digest("hex").slice(0, 24);
}

export function sameCredential(credential: string, id: string): boolean {
  if (!CREDENTIAL.test(credential) || !CREDENTIAL_ID.test(id)) return false;
  return timingSafeEqual(Buffer.from(credentialId(credential), "utf8"), Buffer.from(id, "utf8"));
}

export function tokenServer(endpoint: string): boolean {
  const port = TOKEN_SERVER.exec(endpoint)?.[1];
  return port !== undefined && Number(port) <= 65535;
}

export function withToken(endpoint: string, credential: string): string {
  return `${endpoint}?token=${credential}`;
}
