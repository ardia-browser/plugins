import { loadPlugin, readManifest } from "@ardia-plugins/testing";

const root = new URL("..", import.meta.url).pathname;

export const sdk = await loadPlugin(root, "test/entry.ts");
export const manifest = readManifest(root);

export const ACCOUNT = { url: "my.1password.com", email: "me@example.com", user_uuid: "USERUUID1", account_uuid: "ACCOUNTUUID1" };
export const WORK_ACCOUNT = { url: "work.1password.com", email: "me@work.example", user_uuid: "USERUUID2", account_uuid: "ACCOUNTUUID2", shorthand: "work" };
export const ITEM_ID = "abcdefghijklmnopqrstuvwxyz";
export const PASSWORD = "fixture-" + "pw-1";
export const NEW_PASSWORD = "fixture-" + "pw-2";
export const TOTP_URI = "otpauth://totp/Example:me@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example";

export const listedEntry = (overrides = {}) => ({
  id: ITEM_ID,
  title: "Example",
  version: 3,
  vault: { id: "vvvvvvvvvvvvvvvvvvvvvvvvvv", name: "Private" },
  category: "LOGIN",
  last_edited_by: "USERUUID1",
  created_at: "2025-12-01T00:00:00Z",
  updated_at: "2026-01-02T03:04:05.678Z",
  additional_information: "me@example.com",
  urls: [{ label: "website", primary: true, href: "https://example.com" }],
  ...overrides,
});

export const revealedEntry = ({ password = PASSWORD, username = "me@example.com", otp, extraFields = [], ...overrides } = {}) => ({
  id: ITEM_ID,
  title: "Example",
  version: 3,
  vault: { id: "vvvvvvvvvvvvvvvvvvvvvvvvvv", name: "Private" },
  category: "LOGIN",
  fields: [
    { id: "username", type: "STRING", purpose: "USERNAME", label: "username", value: username, reference: `op://Private/${ITEM_ID}/username` },
    ...(password === null ? [] : [{ id: "password", type: "CONCEALED", purpose: "PASSWORD", label: "password", value: password, entropy: 71.2, password_details: { strength: "FANTASTIC" }, reference: `op://Private/${ITEM_ID}/password` }]),
    { id: "notesPlain", type: "STRING", purpose: "NOTES", label: "notesPlain", reference: `op://Private/${ITEM_ID}/notesPlain` },
    ...(otp ? [{ id: "TOTP_abc", section: { id: "add more" }, type: "OTP", label: "one-time password", ...otp }] : []),
    ...extraFields,
  ],
  urls: [{ label: "website", primary: true, href: "https://example.com" }],
  ...overrides,
});

const json = (value) => ({ stdout: JSON.stringify(value) });
export const ok = (value) => (typeof value === "string" ? { stdout: value } : json(value));
export const fail = (stderr, status = 1) => ({ status, stderr });

export function fakeOp(routes) {
  const seen = [];
  const cli = (launch) => {
    const line = launch.argv.join(" ");
    seen.push({ line, launch });
    for (const [pattern, answer] of routes) {
      const glob = new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "s");
      const matches = glob.test(line);
      if (matches) return typeof answer === "function" ? answer(launch, seen) : answer;
    }
    return fail(`[ERROR] 2026/11/22 10:00:00 the fake op has no route for: ${line}`);
  };
  cli.seen = seen;
  cli.lines = () => seen.map((entry) => entry.line);
  return cli;
}

export const unlocked = { session: { key: null }, preferences: { account: ACCOUNT.account_uuid } };

export function harness(routes, context = unlocked) {
  const cli = fakeOp(routes);
  const ready = sdk.credentialHarness({
    plugin: sdk.createPlugin,
    spec: sdk.CLI,
    id: sdk.ID,
    cli,
    session: context.session ?? null,
    preferences: context.preferences ?? {},
    offline: context.offline === true,
  });
  const h = {
    async call(name, input) {
      return (await ready).call(name, input);
    },
    get preferences() {
      return settled.preferences;
    },
    get session() {
      return settled.unlocked ? { key: null } : null;
    },
    get refused() {
      return settled.sidecar.refused;
    },
  };
  let settled = null;
  ready.then((value) => (settled = value));
  return { h, cli, ready };
}

export async function listAll(h) {
  const items = [];
  let request = { snapshot: null, cursor: null };
  const pages = [];
  for (;;) {
    const answer = await h.call("list", request);
    if (!answer.ok) return { answer, items, pages };
    pages.push(answer.result);
    items.push(...answer.result.items);
    if (!answer.result.cursor) return { answer, items, pages };
    request = { snapshot: answer.result.snapshot, cursor: answer.result.cursor };
  }
}

const unescapedName = (name) => name.replace(/\\(.)/g, "$1");
const opName = (name) => name.replace(/\s/g, "").toLowerCase();

function splitAssignment(argument) {
  for (let at = 0; at < argument.length; at++) {
    if (argument[at] === "\\") at++;
    else if (argument[at] === "=") return { target: argument.slice(0, at), value: argument.slice(at + 1) };
  }
  return { target: argument, value: undefined };
}

function applyAssignment(item, argument) {
  if (argument.startsWith("--url=")) {
    const href = argument.slice("--url=".length);
    const urls = item.urls ?? [];
    const at = Math.max(0, urls.findIndex((url) => url.primary));
    item.urls = urls.length ? urls.map((url, i) => (i === at ? { ...url, href } : url)) : [{ href, primary: true }];
    return true;
  }
  const { target, value } = splitAssignment(argument);
  const typed = /^(.*)\[([a-z]+)\]$/s.exec(target);
  const name = opName(unescapedName(typed ? typed[1] : target));
  const type = typed?.[2];
  const builtIn = item.fields.find((field) => field.id === name);
  if (builtIn?.purpose) {
    if (type || value === undefined) return false;
    const { entropy: _entropy, password_details: _details, ...kept } = builtIn;
    item.fields = item.fields.map((field) => (field === builtIn ? { ...kept, value } : field));
    return true;
  }
  const matching = item.fields.filter((field) => opName(field.label ?? "") === name);
  if (matching.length > 1) return false;
  if (type === "delete") {
    if (!matching.length || value !== undefined) return false;
    item.fields = item.fields.filter((field) => field !== matching[0]);
    return true;
  }
  if (type !== "otp" || value === undefined) return false;
  if (matching.length) item.fields = item.fields.map((field) => (field === matching[0] ? { ...field, type: "OTP", value } : field));
  else item.fields = [...item.fields, { id: `field${item.fields.length}`, type: "OTP", label: unescapedName(typed[1]), value }];
  return true;
}

export const PASSKEY_FIELD = { id: "passkey", type: "PASSKEY", label: "passkey" };

export function opHoldingPasskey(stored, passkey = true) {
  const item = structuredClone(stored);
  if (passkey) item.fields = [...(item.fields ?? []), PASSKEY_FIELD];
  const vault = { item, passkey };
  const routes = [
    ["item get*", () => ok(vault.item)],
    [
      "item edit*",
      (launch) => {
        if (launch.stdin) {
          vault.item = JSON.parse(launch.stdin);
          vault.passkey = false;
          return ok(vault.item);
        }
        const edited = structuredClone(vault.item);
        const changes = launch.argv.slice(3).filter((argument) => argument !== "--format=json" && !argument.startsWith("--account="));
        if (!changes.every((argument) => applyAssignment(edited, argument))) return fail("[ERROR] 2026/11/23 10:00:00 the fake op couldn't apply an assignment");
        vault.item = edited;
        return ok(vault.item);
      },
    ],
  ];
  return { vault, routes };
}
