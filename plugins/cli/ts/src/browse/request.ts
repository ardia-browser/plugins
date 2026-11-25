import { buildStamp } from "../version.ts";
import { parseQsl, urlsplit } from "../pylib/urllib.ts";
import { PyException } from "../pylib/str.ts";
import { builtinCrash } from "./errors.ts";
import { createHash } from "node:crypto";
import { fstatSync } from "node:fs";
import { dataRoot } from "../control.ts";
import { EndpointError, type EnvEndpoint, envEndpoint } from "./endpoint.ts";
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

export function contentBoundaries(found: Found): boolean {
  const given = env("AGENT_BROWSER_CONTENT_BOUNDARIES") || env("ARDIA_BROWSE_CONTENT_BOUNDARIES");
  let wanted = given === undefined || given === "" ? true : truthy(given);
  const flagged = found.flag("content_boundaries");
  if (flagged !== undefined) wanted = flagged;
  if (found.flag("no_content_boundaries")) wanted = false;
  return wanted;
}

export function optionsFrom(found: Found): Options {
  let humanize = humanizeDefault();
  if (found.flag("no_humanize")) humanize = false;
  if (found.flag("humanize")) humanize = true;
  const given = either(found.value("max_output"), env("AGENT_BROWSER_MAX_OUTPUT"));
  let maxOutput: Value = null;
  if (given !== undefined) {
    const parsed = pythonInt(given);
    if ("invalid" in parsed) throw new Usage("--max-output takes a number of characters");
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
    ["content_boundaries", contentBoundaries(found)],
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
  if (found.flag("out_only")) entries.set("out_only", true);
  if (found.flag("out_body")) entries.set("out_body", true);
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

const DIGIT_LIKE = /^[\p{Nd}\u00b2\u00b3\u00b9\u2070\u2074-\u2079\u2080-\u2089\u2460-\u2468\u2474-\u247c\u2488-\u2490\u24f5-\u24fd\u24ea\u24ff\u2776-\u277e\u2780-\u2788\u278a-\u2792\u1369-\u1371\u19da]$/u;

function pyIsDigit(text: string): boolean {
  const points = [...text];
  return points.length > 0 && points.every((point) => DIGIT_LIKE.test(point));
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
    if ("invalid" in parsed) throw new Usage("--port takes a number");
    number = parsed.value;
  }
  if (!ws && number === undefined) checkEnvEndpoint(process.env);
  return { ws, port: number, dataDir: found.value("data_dir") };
}

// The daemon refuses an ARDIA_PORT that isn't a port. Refuse it here instead, before a session is claimed
// (and an idle one maybe closed to make room) for a daemon that can't start.
export function checkEnvEndpoint(environment: NodeJS.ProcessEnv): void {
  let found: EnvEndpoint | null;
  try {
    found = envEndpoint(environment);
  } catch (error) {
    if (error instanceof EndpointError) throw new Usage(error.message);
    throw error;
  }
  if (found?.kind === "port" && !(found.port > 0n && found.port < 65536n)) {
    throw new Usage(`ARDIA_PORT must be between 1 and 65535, not ${found.port}`);
  }
}

type Split = { scheme: string; netloc: string; path: string; query: string };

export function splitUrl(url: string): Split {
  try {
    return urlsplit(url);
  } catch (error) {
    if (error instanceof PyException) throw builtinCrash(error.type, error.message);
    throw error;
  }
}

function queryValues(query: string): string[] {
  return parseQsl(query).map(([, value]) => value);
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

function wsKey(url: string): string {
  const parts = splitUrl(url);
  return `ws:${parts.scheme}://${parts.netloc}${parts.path}`;
}

// Keys the session by the endpoint its daemon will reach: the flags first, then the environment as
// envEndpoint() reads it (ARDIA_WS, ARDIA_PORT, ARDIA_CDP_URL), the order daemonEnvironment() hands the daemon.
export function endpointKey(endpoint: Endpoint, root: string, environment: NodeJS.ProcessEnv = process.env): string {
  if (endpoint.ws) return wsKey(endpoint.ws);
  if (endpoint.port !== undefined) return `port:${endpoint.port}`;
  let found: EnvEndpoint | null;
  try {
    found = envEndpoint(environment);
  } catch (error) {
    if (!(error instanceof EndpointError)) throw error;
    return `port:${environment["ARDIA_PORT"]}`;
  }
  if (found === null) return `token:${root}`;
  return found.kind === "ws" ? wsKey(found.url) : `port:${found.port}`;
}

export function sessionKey(namespace: string, endpointKey: string, session: string, forPlugin = false): string {
  const raw = `${namespace}\0${endpointKey}\0${session}${forPlugin ? "\0plugin" : ""}\0build:${buildStamp()}`;
  return createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 24);
}

export function sessionOwner(namespace: string, endpointKey: string, session: string, forPlugin = false): string {
  const raw = `owner\0${namespace}\0${endpointKey}\0${session}${forPlugin ? "\0plugin" : ""}`;
  return createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 24);
}

export const FORWARDED_ENV: readonly string[] = ["ARDIA_CRUX_API_KEY"];

export function agentEnv(): JsonObject {
  const entries: JsonObject = new Map();
  for (const [name, value] of Object.entries(process.env)) {
    if ((name.startsWith("AGENT_BROWSER_") || FORWARDED_ENV.includes(name)) && value !== undefined) entries.set(name, value);
  }
  return entries;
}
