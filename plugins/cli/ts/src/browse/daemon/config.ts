import { Float, parseText, type Value } from "../../json.ts";

export type DaemonConfig = {
  session: string;
  namespace: string;
  key: string;
  owner: string;
  dataRoot: string;
  ws: string | null;
  port: number | null;
  dataDir: string | null;
  endpointLabel: string | null;
  idleTimeoutMs: number | null;
  debug: boolean;
  noAutoDialog: boolean;
  pinTab: boolean;
  harnessSeed: bigint | null;
};

export const CONFIG_LIMIT = 1024 * 1024;
const KEY = /^[0-9a-f]{24}$/u;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export class BadConfig extends Error {
  override readonly name = "BadConfig";
}

function optionalText(config: Map<string, Value>, field: string): string | null {
  const value = config.get(field);
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new BadConfig(`${field} must be text`);
  return value;
}

function flag(config: Map<string, Value>, field: string): boolean {
  const value = config.get(field);
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw new BadConfig(`${field} must be true or false`);
  return value;
}

function wholeNumber(config: Map<string, Value>, field: string, low: bigint, high: bigint): bigint | null {
  const value = config.get(field);
  if (value === undefined || value === null) return null;
  if (typeof value !== "bigint" || value < low || value > high) throw new BadConfig(`${field} must be a whole number from ${low} to ${high}`);
  return value;
}

export function cleanLabel(label: string | null): string | null {
  if (label === null) return null;
  let kept = label;
  for (const mark of ["?", "#"]) {
    const at = kept.indexOf(mark);
    if (at >= 0) kept = kept.slice(0, at);
  }
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.exec(kept)?.[0] ?? "";
  const rest = kept.slice(scheme.length);
  const slash = rest.indexOf("/");
  const authority = slash < 0 ? rest : rest.slice(0, slash);
  const at = authority.lastIndexOf("@");
  return at < 0 ? kept : scheme + rest.slice(at + 1);
}

export function parseConfig(text: string): DaemonConfig {
  let parsed: Value | undefined;
  try {
    parsed = parseText(text, 64);
  } catch {
    parsed = undefined;
  }
  if (!(parsed instanceof Map)) throw new BadConfig("the config on stdin isn't a JSON object");
  const session = parsed.get("session");
  if (typeof session !== "string" || !NAME.test(session)) throw new BadConfig("session must be 1 to 64 letters, digits, '.', '_' or '-'");
  const namespace = optionalText(parsed, "namespace") ?? "";
  if (namespace !== "" && !NAME.test(namespace)) throw new BadConfig("namespace must be 1 to 64 letters, digits, '.', '_' or '-'");
  const key = parsed.get("key");
  if (typeof key !== "string" || !KEY.test(key)) throw new BadConfig("key must be 24 lowercase hex digits");
  const owner = parsed.get("owner") ?? key;
  if (typeof owner !== "string" || !KEY.test(owner)) throw new BadConfig("owner must be 24 lowercase hex digits");
  const dataRoot = parsed.get("data_root");
  if (typeof dataRoot !== "string" || !dataRoot.startsWith("/") || dataRoot.includes("\0")) throw new BadConfig("data_root must be an absolute path");
  const port = wholeNumber(parsed, "port", 1n, 65535n);
  const idle = parsed.get("idle_timeout_ms");
  let idleTimeoutMs: number | null = null;
  if (idle instanceof Float || typeof idle === "bigint") {
    idleTimeoutMs = idle instanceof Float ? idle.value : Number(idle);
    if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs < 0) throw new BadConfig("idle_timeout_ms must be a number of milliseconds");
  } else if (idle !== undefined && idle !== null) throw new BadConfig("idle_timeout_ms must be a number of milliseconds");
  return {
    session,
    namespace,
    key,
    owner,
    dataRoot,
    ws: optionalText(parsed, "ws"),
    port: port === null ? null : Number(port),
    dataDir: optionalText(parsed, "data_dir"),
    endpointLabel: cleanLabel(optionalText(parsed, "endpoint_label")),
    idleTimeoutMs,
    debug: flag(parsed, "debug"),
    noAutoDialog: flag(parsed, "no_auto_dialog"),
    pinTab: flag(parsed, "pin_tab"),
    harnessSeed: wholeNumber(parsed, "harness_seed", 0n, 2n ** 64n),
  };
}
