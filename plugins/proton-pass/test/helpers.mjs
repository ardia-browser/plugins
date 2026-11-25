import { loadPlugin, readManifest } from "@ardia-plugins/testing";

const root = new URL("..", import.meta.url).pathname;

export const subject = await loadPlugin(root, "test/entry.ts");
export const manifest = readManifest(root);

export const PASSWORD = "fixture-password-Q7x!";
export const NEW_PASSWORD = "new-fixture-password-9Kz";
export const TOTP_URI = "otpauth://totp/Example:me?secret=JBSWY3DPEHPK3PXP&issuer=Example&period=30";

export const vaultsJson = (vaults) => JSON.stringify({ vaults });
export const VAULTS = vaultsJson([
  { name: "Work", share_id: "shareWork1" },
  { name: "Personal", share_id: "sharePersonal1" },
]);

export function entry({ id = "item0001", title = "Example", username = "me", email, password = PASSWORD, urls = ["https://example.com"], totp, extraTotp, autofill, state = "Active", modified = 1767323045 } = {}) {
  const login = { username, password, urls };
  if (email !== undefined) login.email = email;
  if (totp !== undefined) login.totp_uri = totp;
  if (autofill !== undefined) login.autofill_urls = autofill;
  const content = { title, content: { Login: login } };
  if (extraTotp !== undefined) content.extra_fields = [{ name: "2FA", content: { Totp: extraTotp } }];
  return { id, state, modify_time: modified, content };
}

export const itemsJson = (...entries) => JSON.stringify({ items: entries });

const globToRegex = (pattern) => new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);

export function fakeCli(rules) {
  const compiled = rules.map(([pattern, reply]) => [globToRegex(pattern), reply]);
  return (launch) => {
    const line = launch.argv.join(" ");
    for (const [pattern, reply] of compiled) {
      if (pattern.test(line)) return typeof reply === "function" ? reply(launch) : reply;
    }
    return { status: 2, stderr: `error: no fake rule for ${line}` };
  };
}

export function harness(rules, context = {}, extra = {}) {
  const full = { session: { key: null }, ...context };
  const ready = subject.credentialHarness({
    plugin: subject.createPlugin,
    spec: extra.spec ?? subject.CLI,
    id: subject.ID,
    cli: fakeCli(rules),
    session: full.session,
    offline: full.offline === true,
    confirms: full.ownerConfirms ?? true,
  });
  let settled = null;
  ready.then((value) => (settled = value));
  return {
    async call(name, input) {
      return (await ready).call(name, input);
    },
    secret: (value) => value,
    get launches() {
      return settled?.launches ?? [];
    },
    get session() {
      return settled?.sidecar.core.session ?? null;
    },
    get refused() {
      return settled?.sidecar.refused ?? [];
    },
    async signInRun() {
      return (await (await ready).sidecar.core.handle("session.status", {})).signInRun;
    },
    get confirmations() {
      return (settled?.host.requests("ui.showConfirm") ?? []).map((request) => String(request.options?.title ?? "").replace(/^Allow Proton Pass to (.*)\?$/, "$1"));
    },
  };
}

export const argvOf = (h) => h.launches.map((launch) => launch.argv.join(" "));

export const unlocked = { session: { key: null } };
export const locked = { session: null };
