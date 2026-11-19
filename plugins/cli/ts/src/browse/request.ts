import { createHash } from "node:crypto";
import { fstatSync } from "node:fs";
import { dataRoot } from "../control.ts";
import type { JsonObject, Value } from "../json.ts";
import { checkName, type Found, pythonInt, truthy, Usage } from "./args.ts";

const LOSSY = "�";
const DEFAULT_TIMEOUT_MS = 25000n;
const URL_ENV = ["ARDIA_CDP_URL", "AGENT_BROWSER_CDP"];

export class Refused extends Error {}

export class Unported extends Error {}

function env(name: string): string | undefined {
  return process.env[name];
}

function either(value: string | undefined, fallback: string | undefined): string | undefined {
  return value ? value : fallback;
}

export function environmentIsText(): boolean {
  return Object.entries(process.env).every(([name, value]) => !(name.startsWith("AGENT_BROWSER_") && (value ?? "").includes(LOSSY)))
    && ["ARDIA_CDP_URL", "ARDIA_DATA_DIR", "ARDIA_WS", "ARDIA_PORT"].every((name) => !(env(name) ?? "").includes(LOSSY));
}

function humanizeDefault(): boolean {
  return truthy(env("AGENT_BROWSER_HUMANIZE")) && !truthy(env("AGENT_BROWSER_NO_HUMANIZE"));
}

function stdoutIsFile(): boolean {
  try {
    return fstatSync(1).isFile();
  } catch {
    return false;
  }
}

function listed(found: string[] | undefined, variable: string): Value[] {
  return [...(found ?? []), ...(env(variable) ?? "").split(",").filter((item) => item !== "")];
}

export type Options = { entries: JsonObject; timeout: Value };

export function optionsFrom(found: Found): Options {
  let humanize = humanizeDefault();
  if (found.flag("no_humanize")) humanize = false;
  if (found.flag("humanize")) humanize = true;
  const given = either(found.value("max_output"), env("AGENT_BROWSER_MAX_OUTPUT"));
  let maxOutput: Value = null;
  if (given !== undefined) {
    const parsed = pythonInt(given);
    if ("invalid" in parsed) throw new Usage(`--max-output takes a number of characters, not ${given}`);
    maxOutput = parsed.value;
  } else if (stdoutIsFile()) maxOutput = 0n;
  const either2 = (key: string, variable: string) => found.flag(key) || truthy(env(variable));
  const timeout: Value = either(env("AGENT_BROWSER_DEFAULT_TIMEOUT"), undefined) ?? DEFAULT_TIMEOUT_MS;
  const optional = (value: string | undefined): Value => value ?? null;
  const optionalFlag = (value: boolean | undefined): Value => value ?? null;
  const entries: JsonObject = new Map<string, Value>([
    ["json", either2("json", "AGENT_BROWSER_JSON")],
    ["humanize", humanize],
    ["timeout_ms", timeout],
    ["max_output", maxOutput],
    ["expect_loader", found.value("expect_loader") ?? null],
    ["full", Boolean(found.flag("full"))],
    ["no_changes", Boolean(found.flag("no_changes"))],
    ["no_text", Boolean(found.flag("no_text"))],
    ["content_boundaries", either2("content_boundaries", "AGENT_BROWSER_CONTENT_BOUNDARIES")],
    ["annotate", either2("annotate", "AGENT_BROWSER_ANNOTATE")],
    ["screenshot_dir", optional(found.value("screenshot_dir"))],
    ["screenshot_format", optional(found.value("screenshot_format"))],
    ["screenshot_quality", optional(found.value("screenshot_quality"))],
    ["no_auto_dialog", either2("no_auto_dialog", "AGENT_BROWSER_NO_AUTO_DIALOG")],
    ["capture_console", optionalFlag(found.flag("capture_console"))],
    ["show", optionalFlag(found.flag("show"))],
    ["enable", listed(found.enable, "AGENT_BROWSER_ENABLE")],
    ["init_scripts", listed(found.initScript, "AGENT_BROWSER_INIT_SCRIPTS")],
  ]);
  if (found.flag("pin_tab") || truthy(env("AGENT_BROWSER_PIN_TAB"))) entries.set("pin_tab", true);
  if (found.flag("no_pin_tab")) entries.set("pin_tab", false);
  return { entries, timeout };
}

export function sessionName(found: Found): string {
  const session = either(found.value("session"), env("AGENT_BROWSER_SESSION")) || "default";
  const refused = checkName("A session name", session);
  if (refused !== undefined) throw new Refused(refused);
  return session;
}

export function namespaceName(found: Found): string {
  const namespace = either(found.value("namespace"), env("AGENT_BROWSER_NAMESPACE")) || "";
  const refused = namespace === "" ? undefined : checkName("A namespace", namespace);
  if (refused !== undefined) throw new Refused(refused);
  return namespace;
}

export type Endpoint = { ws: string | undefined; port: bigint | undefined; dataDir: string | undefined };

function pyIsDigit(text: string): boolean {
  if (!/^[\x00-\x7f]*$/.test(text)) throw new Unported("a non-ASCII --cdp");
  return /^[0-9]+$/.test(text);
}

export function endpointChoice(found: Found): Endpoint {
  let ws = found.value("ws");
  let port = found.value("port");
  const cdp = either(found.value("cdp"), env("AGENT_BROWSER_CDP"));
  if (cdp && !ws && !port) {
    if (pyIsDigit(cdp)) port = cdp;
    else ws = cdp;
  }
  let number: bigint | undefined;
  if (port !== undefined) {
    const parsed = pythonInt(port);
    if ("invalid" in parsed) throw new Usage(`--port takes a number, not ${port}`);
    number = parsed.value;
  }
  return { ws, port: number, dataDir: found.value("data_dir") };
}

type Split = { scheme: string; netloc: string; path: string; query: string };

function plainUrl(url: string): boolean {
  for (let at = 0; at < url.length; at += 1) {
    const code = url.charCodeAt(at);
    if (code < 0x21 || code > 0x7e || code === 0x5b || code === 0x5d) return false;
  }
  return true;
}

export function splitUrl(url: string): Split {
  if (!plainUrl(url)) throw new Unported("a URL urlsplit reads in ways not ported");
  let scheme = "";
  let rest = url;
  const colon = url.indexOf(":");
  if (colon > 0 && /^[A-Za-z][A-Za-z0-9+.-]*$/.test(url.slice(0, colon))) {
    scheme = url.slice(0, colon).toLowerCase();
    rest = url.slice(colon + 1);
  }
  let netloc = "";
  if (rest.startsWith("//")) {
    const after = rest.slice(2);
    const end = after.search(/[/?#]/);
    netloc = end < 0 ? after : after.slice(0, end);
    rest = end < 0 ? "" : after.slice(end);
  }
  const hash = rest.indexOf("#");
  if (hash >= 0) rest = rest.slice(0, hash);
  const question = rest.indexOf("?");
  return { scheme, netloc, path: question < 0 ? rest : rest.slice(0, question), query: question < 0 ? "" : rest.slice(question + 1) };
}

function unquote(text: string): string {
  if (!text.includes("%")) return text;
  const bytes: number[] = [];
  for (let at = 0; at < text.length; at += 1) {
    const pair = text.slice(at + 1, at + 3);
    if (text[at] === "%" && /^[0-9A-Fa-f]{2}$/.test(pair)) {
      bytes.push(Number.parseInt(pair, 16));
      at += 2;
    } else bytes.push(text.charCodeAt(at));
  }
  return Buffer.from(bytes).toString("utf8");
}

function queryValues(query: string): string[] {
  const values: string[] = [];
  for (const pair of query.split("&")) {
    const equals = pair.indexOf("=");
    if (pair === "" || equals < 0) continue;
    const value = pair.slice(equals + 1);
    if (value !== "") values.push(unquote(value.replaceAll("+", " ")));
  }
  return values;
}

export function urlsWithSecrets(ws: string | undefined): string[] {
  const found: string[] = [];
  for (const url of [ws, ...URL_ENV.map(env)]) {
    if (!url || !url.includes("?")) continue;
    found.push(...queryValues(splitUrl(url).query));
  }
  return found;
}

export function rootOf(endpoint: Endpoint): string {
  return dataRoot(endpoint.dataDir);
}

export function endpointKey(endpoint: Endpoint, root: string): string {
  const url = endpoint.ws ? endpoint.ws : endpoint.port !== undefined ? undefined : env("ARDIA_CDP_URL");
  if (url) {
    const parts = splitUrl(url);
    return `ws:${parts.scheme}://${parts.netloc}${parts.path}`;
  }
  if (endpoint.port !== undefined) return `port:${endpoint.port}`;
  return `token:${root}`;
}

export function sessionKey(namespace: string, endpointKey: string, session: string, forPlugin = false): string {
  const raw = `${namespace}\0${endpointKey}\0${session}${forPlugin ? "\0plugin" : ""}`;
  return createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 24);
}

export function agentEnv(): JsonObject {
  const entries: JsonObject = new Map();
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith("AGENT_BROWSER_") && value !== undefined) entries.set(name, value);
  }
  return entries;
}
