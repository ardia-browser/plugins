import { type Value } from "../../json.ts";
import { createHash, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { codePoints } from "../../pystr.ts";
import { plainParams } from "../cdp/params.ts";
import { navigate } from "../commands/core.ts";
import { currentOrNew } from "../commands/shared.ts";
import { expectInput } from "../act/common.ts";
import { clearField, focusField } from "../act/fields.ts";
import { click } from "../act/pointer.ts";
import { inputOf } from "../input/input.ts";
import { pauseAfter } from "../input/human.ts";
import { rng } from "../../pylib/random.ts";
import type { Ctx } from "../commands/ctx.ts";
import { register } from "../commands/index.ts";
import { parse } from "../commands/parse.ts";
import { BrowseError, ConnectionLost, Usage } from "../daemon-errors.ts";
import { Cancelled, sleep } from "../cdp/cancel.ts";
import { safeCode } from "../codes.ts";
import { Result } from "../daemon/render.ts";
import { browseDir, checkName, closeFd, listNames, openPrivateDirAt, openPrivateFile, readPrivateJson, unlinkQuietly, writePrivateJson } from "../paths.ts";
import { flock } from "../../libc.ts";
import { pyValue } from "../daemon/render.ts";
import type { Element, Page } from "../state/page.ts";
import { waitUntil } from "../state/wait.ts";
import { credential } from "./providers.ts";
import { addVaultSecret } from "../../redact.ts";
import { flag } from "../metrics.ts";
import { type Clock, freshCode, parseSeed, settingsOf, systemClock, type TotpSeed } from "./totp.ts";
import { LOOPBACK_HOSTS, originOf } from "./origin.ts";

export { LOOPBACK_HOSTS, originOf };
import { run, RunTimedOut, SpawnFailed } from "./run.ts";

export const SECURITY = "/usr/bin/security";
export const SERVICE = "dev.ardia.browse.auth";
export const SECURITY_TIMEOUT = 20;
export const tools = { security: SECURITY, timeout: SECURITY_TIMEOUT };
export const TOTP_ACCOUNT = "#totp";
export const OTP_WAIT = 10;

export type Meta = Record<string, any>;

export function keychainArgs(): string[] {
  const path = process.env["ARDIA_BROWSE_KEYCHAIN"];
  return path ? [path] : [];
}

export function quote(value: string): string {
  for (const point of codePoints(value)) {
    const code = point.codePointAt(0) as number;
    if (code < 32 || code === 127) throw new BrowseError("Secrets and names can't contain control characters or line breaks");
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function commandLine(words: readonly string[]): string {
  return `${words.map((word, index) => (index ? quote(word) : word)).join(" ")}\n`;
}

export async function security(words: readonly string[]): Promise<[number, string]> {
  const ran = await securityRun(words);
  return [ran.failed ? 1 : ran.code, ran.stdout];
}

export const NOT_FOUND = "could not be found";

async function securityRun(words: readonly string[]): Promise<{ code: number; failed: boolean; stdout: string; stderr: string }> {
  const line = commandLine(words);
  let ran;
  try {
    ran = await run([tools.security, "-i"], { input: Buffer.from(line, "utf8"), timeout: tools.timeout });
  } catch (error) {
    if (error instanceof RunTimedOut) throw new BrowseError("The Keychain didn't answer in time (is a Keychain prompt waiting?)");
    if (error instanceof SpawnFailed) throw new BrowseError(`Couldn't run ${SECURITY}: ${error.strerror}`);
    throw error;
  }
  const stderr = typeof ran.stderr === "string" ? ran.stderr : new TextDecoder("utf-8").decode(ran.stderr);
  const failed = stderr.includes("returned -") || stderr.includes(NOT_FOUND);
  return { code: ran.code, failed, stdout: new TextDecoder("utf-8").decode(ran.stdout), stderr };
}

export async function storeSecret(name: string, password: string, label = `Ardia browse: ${name}`): Promise<void> {
  const [code] = await security(["add-generic-password", "-U", "-a", name, "-s", SERVICE, "-l", label, "-w", password, ...keychainArgs()]);
  if (code) throw new BrowseError("The Keychain refused to save the password");
}

export function seedForms(text: string): string[] {
  const forms = new Set<string>([text.trim()]);
  let secret = text.trim();
  if (/^otpauth:\/\//iu.test(secret)) {
    try {
      secret = new URL(secret).searchParams.get("secret") ?? "";
    } catch {
      secret = "";
    }
  }
  if (secret !== "") {
    forms.add(secret);
    const compact = secret.replace(/[\s-]/gu, "");
    forms.add(compact);
    forms.add(compact.toUpperCase());
    forms.add(compact.toLowerCase());
    forms.add(compact.replace(/=+$/u, ""));
  }
  return [...forms].filter((form) => form.length >= 6);
}

export function totpAccount(name: string): string {
  return `${name}${TOTP_ACCOUNT}`;
}

export function registerSeed(text: string): TotpSeed {
  for (const form of seedForms(text)) addVaultSecret(form);
  const seed = parseSeed(text);
  addVaultSecret(seed.secret.toString("hex"));
  addVaultSecret(seed.secret.toString("latin1"));
  return seed;
}

export async function readLegacyTotp(name: string): Promise<string> {
  const [code, output] = await security(["find-generic-password", "-a", totpAccount(name), "-s", SERVICE, "-w", ...keychainArgs()]);
  if (code) throw new BrowseError(`No TOTP secret for ${name} in the Keychain; add one with \`ardia browse auth save ${name} --url <url> --totp-stdin\``, null, "no_totp");
  return output.endsWith("\n") ? output.slice(0, -1) : output;
}

export function scopeOf(root: string): string {
  let real = root;
  try {
    real = realpathSync(root);
  } catch {}
  return createHash("sha256").update(real, "utf8").digest("hex").slice(0, 16);
}

export function recordAccount(root: string, name: string, generation: string): string {
  return `${name}@${scopeOf(root)}#${generation}`;
}

export type Credentials = { password: string; totp: string | null };

export function encodeRecord(record: Credentials): string {
  return Buffer.from(JSON.stringify({ v: 1, password: record.password, totp: record.totp }), "utf8").toString("base64");
}

export function decodeRecord(text: string): Credentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(text.trim(), "base64").toString("utf8"));
  } catch {
    parsed = null;
  }
  const record = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  if (record["v"] !== 1 || typeof record["password"] !== "string") throw new BrowseError("The Keychain item for this profile is damaged; save the profile again");
  return { password: record["password"], totp: typeof record["totp"] === "string" ? record["totp"] : null };
}

export async function storeRecord(root: string, name: string, generation: string, record: Credentials): Promise<void> {
  await storeSecret(recordAccount(root, name, generation), encodeRecord(record), `Ardia browse: ${name}`);
}

export async function readCredentials(root: string, name: string, meta: Meta): Promise<Credentials> {
  const generation = meta["generation"];
  if (typeof generation === "string" && generation !== "") {
    const [code, output] = await security(["find-generic-password", "-a", recordAccount(root, name, generation), "-s", SERVICE, "-w", ...keychainArgs()]);
    if (code) throw new BrowseError(`No password for ${name} in the Keychain; save it again with \`ardia browse auth save ${name} ...\``);
    return decodeRecord(output);
  }
  const password = await readSecret(name, Boolean(meta["utf8"]));
  return { password, totp: meta["totp"] ? await readLegacyTotp(name) : null };
}

export async function deleteCredentials(root: string, name: string, meta: Meta | null): Promise<void> {
  if (meta === null) return;
  const generation = meta["generation"];
  if (typeof generation === "string" && generation !== "") await deleteSecret(recordAccount(root, name, generation));
}

export async function totpCode(root: string, name: string, clock: Clock = systemClock): Promise<{ code: string; remaining: number; waited: number }> {
  const seedText = await withProfileLock(root, name, async () => {
    const meta = loadMeta(root, name);
    if (!meta["totp"]) throw new BrowseError(`${name} has no TOTP secret; add one with \`ardia browse auth save ${name} --url <url> --totp-stdin\``, null, "no_totp");
    const record = await readCredentials(root, name, meta);
    if (record.totp === null) throw new BrowseError(`${name} has no TOTP secret; add one with \`ardia browse auth save ${name} --url <url> --totp-stdin\``, null, "no_totp");
    return record.totp;
  });
  return freshCode(registerSeed(seedText), clock);
}

export async function readSecret(name: string, utf8: boolean): Promise<string> {
  const [code, output] = await security(["find-generic-password", "-a", name, "-s", SERVICE, "-w", ...keychainArgs()]);
  if (code) throw new BrowseError(`No password for ${name} in the Keychain; save it again with \`ardia browse auth save ${name} ...\``);
  let value = output.endsWith("\n") ? output.slice(0, -1) : output;
  if (utf8 && /^(?:[0-9a-f]{2})+$/u.test(value)) value = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value, "hex"));
  return value;
}

export async function deleteSecret(name: string): Promise<void> {
  const ran = await securityRun(["delete-generic-password", "-a", name, "-s", SERVICE, ...keychainArgs()]);
  if (ran.stderr.includes(NOT_FOUND)) return;
  if (ran.failed || ran.code !== 0) throw new BrowseError("The Keychain refused to delete the saved password; the profile was kept", null, "keychain_refused");
}

function strippedLine(text: string): string {
  let line = text;
  if (line.endsWith("\n")) line = line.slice(0, -1);
  if (line.endsWith("\r")) line = line.slice(0, -1);
  return line;
}

export function splitSecrets(text: string, password: boolean, totp: boolean): { password: string | null; totp: string | null } {
  if (!(password && totp)) return { password: password ? strippedLine(text) : null, totp: totp ? strippedLine(text).trim() : null };
  const cut = text.indexOf("\n");
  if (cut < 0) throw new Usage("With --password-stdin and --totp-stdin, stdin is two lines: the password, then the TOTP secret or otpauth:// link");
  return { password: strippedLine(text.slice(0, cut + 1)), totp: strippedLine(text.slice(cut + 1)).trim() };
}


export function authDir(root: string): number {
  const browse = browseDir(root);
  try {
    return openPrivateDirAt(browse, "auth");
  } finally {
    closeFd(browse);
  }
}

export function loadMeta(root: string, name: string): Meta {
  checkName("An auth profile name", name);
  const folder = authDir(root);
  let meta: Value | undefined;
  try {
    meta = readPrivateJson(`${name}.json`, folder);
  } finally {
    closeFd(folder);
  }
  const plain = meta === undefined ? null : (plainParams(meta) as Meta | null);
  if (!plain || (typeof plain === "object" && Object.keys(plain).length === 0)) throw new BrowseError(`No auth profile named ${name}; run \`ardia browse auth list\``);
  return plain;
}

export type PasswordSource = { stdin: () => string; isTTY: () => boolean; prompt: () => Promise<string> };

export async function readPassword(options: Record<string, unknown>, source: PasswordSource, given: string | null = null): Promise<string> {
  if (options["password"]) {
    throw new Usage("--password puts the secret on the command line (visible in ps and shell history); use --password-stdin or answer the prompt");
  }
  let text: string;
  if (given !== null) text = given;
  else if (options["password_stdin"]) text = strippedLine(source.stdin());
  else if (source.isTTY()) text = await source.prompt();
  else throw new Usage("Give the password with --password-stdin (stdin isn't a terminal, so there's no prompt)");
  if (!text) throw new Usage("The password is empty");
  return text;
}

export const BOUND_KEYS = ["url", "origin", "username", "username_selector", "password_selector", "submit_selector"];

export function refuseRebinding(name: string, previous: Meta, options: Record<string, unknown>): void {
  const given = BOUND_KEYS.filter((key) => options[key] !== undefined && options[key] !== null);
  if (given.length === 0) return;
  const wanted = options["url"] ? [originOf(options["url"] as string), ...((options["origin"] as string[] | undefined) ?? []).map(originOf)] : null;
  const sameOrigins = wanted === null || JSON.stringify([...new Set(wanted)].sort()) === JSON.stringify(previous["origins"]);
  const sameUrl = !options["url"] || options["url"] === previous["url"];
  const sameUser = options["username"] === undefined || options["username"] === previous["username"];
  const selectorsSame = ["username_selector", "password_selector", "submit_selector"].every((key) => {
    const camel = `${key.split("_")[0]}Selector`;
    return options[key] === undefined || options[key] === previous[camel];
  });
  if (sameOrigins && sameUrl && sameUser && selectorsSame) return;
  throw new Usage(
    `${name} keeps its saved password, so its URL, origins, username and selectors stay as they are; to change them, give the password again with --password-stdin`,
  );
}

export const PROFILE_LOCK_WAIT = 30;
export const PROFILE_LOCK_POLL = 0.05;

export async function withProfileLock<T>(root: string, name: string, work: () => Promise<T>): Promise<T> {
  checkName("An auth profile name", name);
  const folder = authDir(root);
  let fd: number;
  try {
    fd = openPrivateFile(`.${name}.lock`, folder);
  } finally {
    closeFd(folder);
  }
  try {
    const deadline = performance.now() + PROFILE_LOCK_WAIT * 1000;
    while (!flock(fd, true, false)) {
      if (performance.now() >= deadline) throw new BrowseError(`Another command is saving or deleting ${name}; try again when it's done`, null, "profile_busy");
      await sleep(PROFILE_LOCK_POLL, null);
    }
    return await work();
  } finally {
    closeFd(fd);
  }
}

export async function save(root: string, name: string, options: Record<string, unknown>, source: PasswordSource): Promise<Meta> {
  return withProfileLock(root, name, () => saveLocked(root, name, options, source));
}

function storedMeta(root: string, name: string): Meta | null {
  try {
    return loadMeta(root, name);
  } catch (error) {
    if (error instanceof BrowseError) return null;
    throw error;
  }
}

async function saveLocked(root: string, name: string, options: Record<string, unknown>, source: PasswordSource): Promise<Meta> {
  const withTotp = Boolean(options["totp_stdin"]);
  const stored = storedMeta(root, name);
  const previous = withTotp && !options["password_stdin"] ? stored : null;
  if (previous !== null) refuseRebinding(name, previous, options);
  if (previous === null && !options["url"]) throw new Usage("Usage: ardia browse auth save <name> --url <https url> --username <user> [--password-stdin] [--totp-stdin]");
  const origins = previous === null ? [originOf(options["url"] as string), ...((options["origin"] as string[] | undefined) ?? []).map(originOf)] : null;
  const piped = withTotp ? splitSecrets(source.stdin(), Boolean(options["password_stdin"]), true) : { password: null, totp: null };
  const seedText = piped.totp;
  const seed = seedText === null ? null : parseSeed(seedText);
  const kept = previous !== null ? await readCredentials(root, name, previous) : null;
  const password = kept !== null ? kept.password : await readPassword(options, source, piped.password);
  const keepsTotp = previous === null && seedText === null && !options["no_totp"] && stored !== null && Boolean(stored["totp"]);
  const keptTotp = keepsTotp ? (await readCredentials(root, name, stored as Meta)).totp : null;
  if (keepsTotp && keptTotp === null) throw new BrowseError(`${name}'s TOTP secret is missing from the Keychain; give it again with --totp-stdin, or --no-totp to drop it`, null, "no_totp");
  const generation = randomBytes(8).toString("hex");
  const savedAt = Math.trunc(Date.now() / 1000);
  const meta: Meta =
    previous !== null
      ? { ...previous, name, totp: seed !== null ? settingsOf(seed) : (previous["totp"] ?? null), generation, savedAt }
      : {
          name,
          url: options["url"],
          origins: [...new Set(origins)].sort(),
          username: options["username"] ?? null,
          usernameSelector: options["username_selector"] ?? null,
          passwordSelector: options["password_selector"] ?? null,
          submitSelector: options["submit_selector"] ?? null,
          utf8: codePoints(password).some((point) => (point.codePointAt(0) as number) > 126),
          totp: seed !== null ? settingsOf(seed) : keepsTotp ? (stored as Meta)["totp"] : null,
          generation,
          savedAt,
        };
  await storeRecord(root, name, generation, { password, totp: seedText ?? keptTotp });
  const folder = authDir(root);
  try {
    writePrivateJson(`${name}.json`, folder, pyValue(meta));
  } catch (error) {
    await deleteSecret(recordAccount(root, name, generation)).catch(() => undefined);
    throw error;
  } finally {
    closeFd(folder);
  }
  await deleteCredentials(root, name, stored).catch(() => undefined);
  return meta;
}

export function publicMeta(meta: Meta): Meta {
  const out: Meta = {};
  for (const key of ["name", "url", "origins", "username", "usernameSelector", "passwordSelector", "submitSelector", "savedAt"]) out[key] = meta[key] ?? null;
  out["totp"] = Boolean(meta["totp"]);
  return out;
}

export function listing(root: string): Meta[] {
  const folder = authDir(root);
  try {
    const rows: Meta[] = [];
    for (const entry of listNames(folder).sort()) {
      if (!entry.endsWith(".json") || entry.startsWith(".")) continue;
      const meta = readPrivateJson(entry, folder);
      const plain = meta === undefined ? null : (plainParams(meta) as Meta | null);
      if (plain && typeof plain === "object" && Object.keys(plain).length > 0) rows.push(publicMeta(plain));
    }
    return rows;
  } finally {
    closeFd(folder);
  }
}

export async function remove(root: string, name: string): Promise<void> {
  await withProfileLock(root, name, () => removeLocked(root, name));
}

async function removeLocked(root: string, name: string): Promise<void> {
  const meta = loadMeta(root, name);
  await deleteCredentials(root, name, meta);
  const folder = authDir(root);
  try {
    unlinkQuietly(`${name}.json`, folder);
  } finally {
    closeFd(folder);
  }
}

export type Guard = () => Promise<void>;
export type LoginActions = {
  typeInto: (page: Page, element: Element, frame: string, text: string, humanize: boolean, guard: Guard, beforeUp?: Guard) => Promise<void>;
  click: (page: Page, element: Element, humanize: boolean) => Promise<void>;
  pressEnter: (page: Page, frame: string, humanize: boolean) => Promise<void>;
};
async function typeInto(page: Page, element: Element, frame: string, text: string, humanize: boolean, guard: Guard, beforeUp: Guard = guard): Promise<void> {
  const facts = await page.call("(el) => ardiaBrowse.info(el)", [element], { frame });
  await focusField(page, element, facts !== null && typeof facts === "object" ? (facts as Record<string, unknown>) : {}, humanize);
  await clearField(page, element, humanize);
  const input = inputOf(page);
  const keyboard = input.keyboard(element, null);
  const typing = async () => {
    for (const char of text) {
      await keyboard.typeSecretChar(char, humanize ? null : 0, guard, beforeUp);
      if (humanize) await sleep(pauseAfter(char, rng()));
    }
  };
  await expectInput(page, frame, () => input.gesture("auth login", typing), { keydown: codePoints(text).length }, "The typing");
}

async function pressEnter(page: Page, frame: string, humanize: boolean): Promise<void> {
  const input = inputOf(page);
  await expectInput(page, frame, () => input.gesture("auth login", () => input.pressCombo("Enter", humanize)), { keydown: 1 }, "The Enter press");
}

export const loginHooks: { actions: LoginActions; currentOrNew: (ctx: Ctx) => Promise<Page> } = {
  actions: { typeInto, click: (page, element, humanize) => click(page, element, humanize), pressEnter },
  currentOrNew: (ctx) => currentOrNew(ctx),
};

const LOGIN_FLAGS = {
  "--url": "value",
  "--username-selector": "value",
  "--password-selector": "value",
  "--submit-selector": "value",
  "--credential-provider": "value",
  "--item": "value",
  "--no-humanize": "bool",
} as const;

const USERNAME_FIELD =
  "(pw) => { const inputs = Array.from(document.querySelectorAll('input')).filter((i) => ardiaBrowse.visible(i) && !i.disabled);" +
  " const named = inputs.find((i) => /username|email/.test(i.autocomplete || '')); if (named) return named;" +
  " const before = inputs.filter((i) => i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING && /^(text|email|tel|)$/.test(i.type));" +
  " return before.length ? before[before.length - 1] : null; }";

function originOfFrame(page: Page, frame: string | null): string | null {
  return (frame === null ? undefined : page.frames.get(frame)?.origin) ?? null;
}

const FOCUSED_ORIGIN = "() => { let doc = document; let el = doc.activeElement; while (el && (el.tagName === 'IFRAME' || el.tagName === 'FRAME')) { let inner = null; try { inner = el.contentDocument; } catch (e) { inner = null; } if (!inner) return { origin: self.origin, focus: document.hasFocus(), crossed: true }; doc = inner; el = doc.activeElement; } return { origin: doc.defaultView ? doc.defaultView.origin : self.origin, own: self.origin, focus: document.hasFocus(), crossed: false }; }";

export async function focusedFrameOrigin(page: Page, frame: string): Promise<{ origin: string; own: string; focus: boolean }> {
  const found = await page.call(FOCUSED_ORIGIN, [], { frame });
  const facts = found !== null && typeof found === "object" ? (found as Record<string, unknown>) : {};
  const origin = typeof facts["origin"] === "string" ? facts["origin"] : "null";
  return { origin, own: typeof facts["own"] === "string" ? facts["own"] : origin, focus: facts["focus"] === true && facts["crossed"] !== true };
}

export async function checkFocusedOrigin(page: Page, frame: string, origins: ReadonlySet<string>, name: string): Promise<void> {
  const seen = await focusedFrameOrigin(page, frame);
  if (!origins.has(seen.origin) || !origins.has(seen.own)) {
    throw new BrowseError(`Stopped typing ${name}'s credentials: the focused frame is ${seen.origin}, not ${[...origins].sort().join(", ")}`, null, "origin_mismatch");
  }
  if (!seen.focus) throw new BrowseError(`Stopped typing ${name}'s credentials: the field's frame doesn't have focus`, null, "origin_mismatch");
}

export const OTP_FIELDS =
  "(digits) => { const usable = (i) => ardiaBrowse.visible(i) && !i.disabled && !i.readOnly && /^(text|tel|number|password|)$/.test(i.type || '');" +
  " const inputs = Array.from(document.querySelectorAll('input')).filter(usable);" +
  " const coded = (i) => /(^|\\s)one-time-code(\\s|$)/.test(String(i.getAttribute('autocomplete') || i.autocomplete || ''));" +
  " const singles = inputs.filter((i) => i.maxLength === 1);" +
  " const shared = (list) => { let holder = list[0].parentElement; while (holder && !list.every((box) => holder.contains(box))) holder = holder.parentElement; return holder; };" +
  " const groups = []; for (let start = 0; start + digits <= singles.length; start += 1) { const run = singles.slice(start, start + digits); const holder = shared(run);" +
  " if (holder && holder !== document.body && holder !== document.documentElement && Array.from(holder.querySelectorAll('input')).filter(usable).length === digits) groups.push(run); }" +
  " const full = inputs.find((i) => coded(i) && i.maxLength !== 1);" +
  " if (full) return [full];" +
  " const codedGroup = groups.find((run) => run.some(coded));" +
  " if (codedGroup) return codedGroup;" +
  " if (singles.some(coded)) return [];" +
  " const said = (i) => [i.name, i.id, i.getAttribute('aria-label') || '', i.placeholder || '', (i.labels && i.labels[0] && i.labels[0].textContent) || ''].join(' ');" +
  " const named = inputs.find((i) => i.type !== 'password' && i.maxLength !== 1 && /(^|[^a-z0-9])(otp|totp|2fa|mfa|one.?time|verification|security.?code|auth(entication)?.?code|passcode|6.?digit|code)([^a-z0-9]|$)/i.test(said(i)));" +
  " if (named) return [named];" +
  " return groups.length > 0 ? groups[0] : []; }";

export function splitDigits(code: string, boxes: number): string[] {
  if (boxes <= 1) return [code];
  if (boxes !== code.length) throw new BrowseError(`The page has ${boxes} one-digit boxes for a ${code.length}-digit code`, null, "otp_boxes_mismatch");
  return [...code];
}

export async function otpFields(page: Page, frame: string, digits: number): Promise<Element[]> {
  try {
    const remote = await page.call(OTP_FIELDS, [digits], { frame, byValue: false });
    return await page.elementsFrom(remote, frame, "the one-time code field", 8);
  } catch (error) {
    if (error instanceof Cancelled || error instanceof ConnectionLost) throw error;
    if (error instanceof BrowseError) return [];
    throw error;
  }
}

export async function login(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, LOGIN_FLAGS);
  if (args.length === 0) throw new Usage("Usage: ardia browse auth login <name> [--username-selector S] [--password-selector S] [--submit-selector S]");
  const actions = loginHooks.actions;
  const pageFor = loginHooks.currentOrNew;
  const name = args[0] as string;
  const root = ctx.state.dataRoot;
  if (root === null) throw new BrowseError("This session has no data folder for auth profiles");
  let meta: Meta;
  let password: string | null;
  let totpSeed: TotpSeed | null = null;
  const providerName = (options["credential_provider"] as string | undefined) || null;
  if (options["credential_provider"]) {
    const creds = await credential(root, options["credential_provider"] as string, (options["item"] as string | undefined) || name, (options["url"] as string | undefined) ?? null);
    const url = (options["url"] as string | undefined) || creds["url"];
    if (!url) throw new BrowseError("The credential provider gave no URL; pass --url");
    meta = {
      url,
      origins: [originOf(url)],
      username: creds["username"] ?? null,
      usernameSelector: creds["usernameSelector"] ?? null,
      passwordSelector: creds["passwordSelector"] ?? null,
      submitSelector: creds["submitSelector"] ?? null,
    };
    password = creds["password"] || "";
  } else {
    const snapshot = await withProfileLock(root, name, async () => {
      const saved = loadMeta(root, name);
      const record = await readCredentials(root, name, saved);
      const seed = saved["totp"] && record.totp !== null ? registerSeed(record.totp) : null;
      return { saved, secret: record.password, seed };
    });
    meta = snapshot.saved;
    password = snapshot.secret;
    totpSeed = snapshot.seed;
  }
  addVaultSecret(password);
  const finish = async (): Promise<Result> => {
    for (const key of ["username_selector", "password_selector", "submit_selector"]) {
      const camel = `${key.split("_")[0]}Selector`;
      if (options[key]) meta[camel] = options[key];
    }
    const humanize = ctx.humanize && !options["no_humanize"];
    const origins = new Set<string>(meta["origins"]);
    const page = await pageFor(ctx);
    await page.refreshFrames();
    if (!origins.has(originOfFrame(page, page.mainFrame) ?? "")) await navigate(ctx, page, meta["url"]);
    const passwordSelector = meta["passwordSelector"] || "input[type=password]";
    const passwordField = async (): Promise<Element | null> => {
      let found: [Page, Element];
      try {
        found = await ctx.state.locate(passwordSelector, page);
      } catch (error) {
        if (error instanceof BrowseError) return null;
        throw error;
      }
      const [foundPage, element] = found;
      const visible = await foundPage.call("(el) => ardiaBrowse.visible(el)", [element], { frame: element.frame });
      return visible ? element : null;
    };
    const passwordElement = (await waitUntil(passwordField, ctx.timeout, 0.2, "the password field")) as Element;
    let usernameElement: Element | null = null;
    if (meta["username"]) {
      if (meta["usernameSelector"]) usernameElement = (await ctx.state.locate(meta["usernameSelector"], page))[1];
      else {
        const remote = await page.call(USERNAME_FIELD, [passwordElement], { frame: passwordElement.frame, byValue: false });
        usernameElement = await page.elementFrom(remote, passwordElement.frame, "the username field");
      }
    }
    await page.refreshFrames();
    const frame = passwordElement.frame;
    const expected = [page.loader(page.mainFrame), page.loader(frame)];
    const frameOrigin = originOfFrame(page, frame);
    const topOrigin = originOfFrame(page, page.mainFrame);
    if (!origins.has(frameOrigin ?? "") || !origins.has(topOrigin ?? "")) {
      throw new BrowseError(
        `Refusing to type ${name}'s credentials: the page is ${topOrigin || "unknown"}` +
          `${frame === page.mainFrame ? "" : ` with the field in ${frameOrigin ?? "None"}`}, not ${[...origins].sort().join(", ")}`,
      );
    }
    const navigations = page.navigations;
    const makeGuard =
      (element: Element): Guard =>
      async () => {
        await page.refreshFrames();
        if (page.navigations !== navigations || page.loader(page.mainFrame) !== expected[0] || page.loader(frame) !== expected[1] || !origins.has(originOfFrame(page, frame) ?? "")) {
          throw new BrowseError(`Stopped typing ${name}'s credentials: the page navigated or the frame changed`);
        }
        const focused = await page.call("(el) => document.activeElement === el || el.contains(document.activeElement)", [element], { frame });
        if (!focused) throw new BrowseError(`Stopped typing ${name}'s credentials: focus left the field`);
        await checkFocusedOrigin(page, frame, origins, name);
        if (frame !== page.mainFrame && !(await frameOwnerFocused(page, frame))) {
          throw new BrowseError(`Stopped typing ${name}'s credentials: focus left the field's frame`);
        }
      };
    try {
      if (usernameElement !== null) await actions.typeInto(page, usernameElement, frame, String(meta["username"]), humanize, makeGuard(usernameElement));
      await actions.typeInto(page, passwordElement, frame, password as string, humanize, makeGuard(passwordElement));
    } finally {
      password = null;
    }
    if (meta["submitSelector"]) {
      const [, submit] = await ctx.state.locate(meta["submitSelector"], page);
      await actions.click(page, submit, humanize);
    } else await actions.pressEnter(page, frame, humanize);
    let otp: string | null = null;
    if (totpSeed !== null && !providerName) otp = await enterOtp(ctx, page, name, totpSeed, origins, humanize, actions);
    const data: Record<string, unknown> = { name, loggedIn: true, url: page.url };
    if (totpSeed !== null && !providerName) data["otp"] = otp;
    return new Result(data, `✓ Logged in as ${meta["username"] || name}${otp === "typed" || otp === "split" ? " (with a one-time code)" : ""}`);
  };
  if (!providerName) return finish();
  try {
    return await finish();
  } catch (error) {
    if (error instanceof Cancelled || error instanceof ConnectionLost) throw error;
    const code = (error instanceof BrowseError ? safeCode(error.code) : null) ?? "credential_provider_failed";
    throw new BrowseError(`Credential provider ${providerName}: the login didn't finish (${code})`, null, code);
  }
}

export const otpHooks: { clock: Clock; wait: number } = { clock: systemClock, wait: OTP_WAIT };

export const MAX_FRAME_DEPTH = 16;

export async function frameOwnerFocused(page: Page, frame: string): Promise<boolean> {
  let child = frame;
  for (let depth = 0; depth < MAX_FRAME_DEPTH; depth += 1) {
    if (child === page.mainFrame) return true;
    const parent = page.frames.get(child)?.parent ?? null;
    if (parent === null) return false;
    const owner = Number((await page.send("DOM.getFrameOwner", { frameId: child }, { session: page.sessionFor(parent) }))["backendNodeId"]);
    const ownerElement = await page.resolveBackend(owner, parent, "the field's frame");
    if (ownerElement === null || !(await page.call("(el) => document.activeElement === el", [ownerElement], { frame: parent }))) return false;
    child = parent;
  }
  return false;
}

export function otpFrames(page: Pick<Page, "frames" | "mainFrame">, origins: ReadonlySet<string>): string[] {
  const main = page.mainFrame;
  if (main === null || !origins.has(originOfFrame(page as Page, main) ?? "")) return [];
  const children = [...page.frames.keys()].filter((frame) => frame !== main && origins.has(originOfFrame(page as Page, frame) ?? ""));
  return [main, ...children];
}

async function enterOtp(ctx: Ctx, page: Page, name: string, seed: TotpSeed, origins: ReadonlySet<string>, humanize: boolean, actions: LoginActions): Promise<string> {
  let found: { frame: string; fields: Element[] };
  try {
    found = (await waitUntil(async () => {
      await page.refreshFrames();
      for (const candidate of otpFrames(page, origins)) {
        const fields = await otpFields(page, candidate, seed.digits);
        if (fields.length > 0) return { frame: candidate, fields };
      }
      return null;
    }, Math.min(otpHooks.wait, ctx.timeout), 0.25, "a one-time code field")) as { frame: string; fields: Element[] };
  } catch (error) {
    if (error instanceof BrowseError && error.code === "timeout") {
      flag("otp_not_asked", true);
      return "not_asked";
    }
    throw error;
  }
  const { frame, fields } = found;
  const { code } = await freshCode(seed, otpHooks.clock);
  addVaultSecret(code);
  const digits = splitDigits(code, fields.length);
  const expected = [page.loader(page.mainFrame), page.loader(frame)];
  const navigations = page.navigations;
  const focusedOn = (allowed: Element[]): Guard => async () => {
    await page.refreshFrames();
    const moved = page.navigations !== navigations || page.loader(page.mainFrame) !== expected[0] || page.loader(frame) !== expected[1];
    if (moved || !origins.has(originOfFrame(page, frame) ?? "") || !origins.has(originOfFrame(page, page.mainFrame) ?? "")) {
      throw new BrowseError(`Stopped typing ${name}'s one-time code: the page navigated`);
    }
    const focused = await page.call("(...boxes) => boxes.includes(document.activeElement)", allowed, { frame });
    if (!focused) throw new BrowseError(`Stopped typing ${name}'s one-time code: focus left the field`);
    await checkFocusedOrigin(page, frame, origins, name);
    if (frame !== page.mainFrame && !(await frameOwnerFocused(page, frame))) throw new BrowseError(`Stopped typing ${name}'s one-time code: focus left the field's frame`);
  };
  for (let index = 0; index < fields.length; index += 1) {
    const element = fields[index] as Element;
    const next = fields[index + 1];
    await actions.typeInto(page, element, frame, digits[index] as string, humanize, focusedOn([element]), focusedOn(next === undefined ? [element] : [element, next]));
  }
  if (fields.length === 1) await actions.pressEnter(page, frame, humanize);
  flag(fields.length > 1 ? "otp_split_boxes" : "otp_typed", true);
  return fields.length > 1 ? "split" : "typed";
}

register("auth", (ctx, argv) => login(ctx, argv));
