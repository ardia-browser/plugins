import { type Value } from "../../json.ts";
import { codePoints } from "../../pystr.ts";
import { addSecret } from "../../redact.ts";
import { plainParams } from "../cdp/params.ts";
import { navigate } from "../commands/core.ts";
import type { Ctx } from "../commands/ctx.ts";
import { register } from "../commands/index.ts";
import { parse } from "../commands/parse.ts";
import { BrowseError, ConnectionLost, Usage } from "../daemon-errors.ts";
import { Cancelled } from "../cdp/cancel.ts";
import { Result } from "../daemon/render.ts";
import { browseDir, checkName, closeFd, listNames, openPrivateDirAt, readPrivateJson, unlinkQuietly, writePrivateJson } from "../paths.ts";
import { pyValue } from "../daemon/render.ts";
import type { Element, Page } from "../state/page.ts";
import { waitUntil } from "../state/wait.ts";
import { credential } from "./providers.ts";
import { LOOPBACK_HOSTS, originOf } from "./origin.ts";

export { LOOPBACK_HOSTS, originOf };
import { run, RunTimedOut, SpawnFailed } from "./run.ts";

export const SECURITY = "/usr/bin/security";
export const SERVICE = "dev.ardia.browse.auth";
export const SECURITY_TIMEOUT = 20;
export const tools = { security: SECURITY, timeout: SECURITY_TIMEOUT };

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
  const line = commandLine(words);
  let ran;
  try {
    ran = await run([tools.security, "-i"], { input: Buffer.from(line, "utf8"), timeout: tools.timeout });
  } catch (error) {
    if (error instanceof RunTimedOut) throw new BrowseError("The Keychain didn't answer in time (is a Keychain prompt waiting?)");
    if (error instanceof SpawnFailed) throw new BrowseError(`Couldn't run ${SECURITY}: ${error.strerror}`);
    throw error;
  }
  const failed = ran.stderr.includes("returned -") || ran.stderr.includes("could not be found");
  return [failed ? 1 : ran.code, new TextDecoder("utf-8").decode(ran.stdout)];
}

export async function storeSecret(name: string, password: string): Promise<void> {
  const [code] = await security(["add-generic-password", "-U", "-a", name, "-s", SERVICE, "-l", `Ardia browse: ${name}`, "-w", password, ...keychainArgs()]);
  if (code) throw new BrowseError("The Keychain refused to save the password");
}

export async function readSecret(name: string, utf8: boolean): Promise<string> {
  const [code, output] = await security(["find-generic-password", "-a", name, "-s", SERVICE, "-w", ...keychainArgs()]);
  if (code) throw new BrowseError(`No password for ${name} in the Keychain; save it again with \`ardia browse auth save ${name} ...\``);
  let value = output.endsWith("\n") ? output.slice(0, -1) : output;
  if (utf8 && /^(?:[0-9a-f]{2})+$/u.test(value)) value = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value, "hex"));
  return value;
}

export async function deleteSecret(name: string): Promise<void> {
  await security(["delete-generic-password", "-a", name, "-s", SERVICE, ...keychainArgs()]);
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

export async function readPassword(options: Record<string, unknown>, source: PasswordSource): Promise<string> {
  if (options["password"]) {
    throw new Usage("--password puts the secret on the command line (visible in ps and shell history); use --password-stdin or answer the prompt");
  }
  let text: string;
  if (options["password_stdin"]) {
    text = source.stdin();
    if (text.endsWith("\n")) text = text.slice(0, -1);
    if (text.endsWith("\r")) text = text.slice(0, -1);
  } else if (source.isTTY()) text = await source.prompt();
  else throw new Usage("Give the password with --password-stdin (stdin isn't a terminal, so there's no prompt)");
  if (!text) throw new Usage("The password is empty");
  return text;
}

export async function save(root: string, name: string, options: Record<string, unknown>, source: PasswordSource): Promise<Meta> {
  checkName("An auth profile name", name);
  if (!options["url"]) throw new Usage("Usage: ardia browse auth save <name> --url <https url> --username <user> [--password-stdin]");
  const origins = [originOf(options["url"] as string), ...((options["origin"] as string[] | undefined) ?? []).map(originOf)];
  let password: string | null = await readPassword(options, source);
  const meta: Meta = {
    name,
    url: options["url"],
    origins: [...new Set(origins)].sort(),
    username: options["username"] ?? null,
    usernameSelector: options["username_selector"] ?? null,
    passwordSelector: options["password_selector"] ?? null,
    submitSelector: options["submit_selector"] ?? null,
    utf8: codePoints(password).some((point) => (point.codePointAt(0) as number) > 126),
    savedAt: Math.trunc(Date.now() / 1000),
  };
  await storeSecret(name, password);
  password = null;
  const folder = authDir(root);
  try {
    writePrivateJson(`${name}.json`, folder, pyValue(meta));
  } finally {
    closeFd(folder);
  }
  return meta;
}

export function publicMeta(meta: Meta): Meta {
  const out: Meta = {};
  for (const key of ["name", "url", "origins", "username", "usernameSelector", "passwordSelector", "submitSelector", "savedAt"]) out[key] = meta[key] ?? null;
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
  loadMeta(root, name);
  await deleteSecret(name);
  const folder = authDir(root);
  try {
    unlinkQuietly(`${name}.json`, folder);
  } finally {
    closeFd(folder);
  }
}

export type Guard = () => Promise<void>;
export type LoginActions = {
  typeInto: (page: Page, element: Element, frame: string, text: string, humanize: boolean, guard: Guard) => Promise<void>;
  click: (page: Page, element: Element, humanize: boolean) => Promise<void>;
  pressEnter: (page: Page, frame: string, humanize: boolean) => Promise<void>;
};
export const loginHooks: { actions: LoginActions | null; currentOrNew: ((ctx: Ctx) => Promise<Page>) | null } = { actions: null, currentOrNew: null };

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

export async function login(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, LOGIN_FLAGS);
  if (args.length === 0) throw new Usage("Usage: ardia browse auth login <name> [--username-selector S] [--password-selector S] [--submit-selector S]");
  const actions = loginHooks.actions;
  const currentOrNew = loginHooks.currentOrNew;
  if (actions === null || currentOrNew === null) throw new BrowseError("`auth login` isn't served by the TypeScript daemon yet (it arrives with the act slice)", null, "unsupported");
  const name = args[0] as string;
  const root = ctx.state.dataRoot;
  if (root === null) throw new BrowseError("This session has no data folder for auth profiles");
  let meta: Meta;
  let password: string | null;
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
    addSecret(password);
  } else {
    meta = loadMeta(root, name);
    password = await readSecret(name, Boolean(meta["utf8"]));
    addSecret(password);
  }
  const finish = async (): Promise<Result> => {
    for (const key of ["username_selector", "password_selector", "submit_selector"]) {
      const camel = `${key.split("_")[0]}Selector`;
      if (options[key]) meta[camel] = options[key];
    }
    const humanize = ctx.humanize && !options["no_humanize"];
    const origins = new Set<string>(meta["origins"]);
    const page = await currentOrNew(ctx);
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
        if (frame !== page.mainFrame) {
          const owner = Number((await page.send("DOM.getFrameOwner", { frameId: frame }))["backendNodeId"]);
          const ownerElement = await page.resolveBackend(owner, page.mainFrame as string, "the field's frame");
          const topFocus = ownerElement !== null && (await page.call("(el) => document.activeElement === el", [ownerElement], { frame: page.mainFrame }));
          if (!topFocus) throw new BrowseError(`Stopped typing ${name}'s credentials: focus left the field's frame`);
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
    return new Result({ name, loggedIn: true, url: page.url }, `✓ Logged in as ${meta["username"] || name}`);
  };
  if (!providerName) return finish();
  const supplied = [meta["url"], ...meta["origins"], meta["username"], meta["usernameSelector"], meta["passwordSelector"], meta["submitSelector"]].filter(
    (value): value is string => typeof value === "string" && value !== "" && value !== name,
  );
  try {
    return await finish();
  } catch (error) {
    if (error instanceof Cancelled || error instanceof ConnectionLost) throw error;
    const said = error instanceof BrowseError ? JSON.stringify([error.text, error.data ?? null]) : "";
    if (error instanceof BrowseError && !supplied.some((value) => said.includes(value))) throw error;
    throw new BrowseError(`Credential provider ${providerName} named a page or field this session couldn't use`, null, error instanceof BrowseError ? (error.code ?? "credential_provider_failed") : "credential_provider_failed");
  }
}

register("auth", (ctx, argv) => login(ctx, argv));
