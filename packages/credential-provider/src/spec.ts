import { CREDENTIAL_LIMITS, DENIED_ENV_PATTERNS, HOST_ENV, VERB_TIMEOUTS_MS } from "./constants";
import { Checks, isFields, KEY, KEY_RULE, P, type Fields } from "./checks";
import { deniedMatch, deniedName } from "./denied";
import type { ArgvToken, CliInstall, CliSpec, CredentialVerb, EnvEntry, OutputMode, SlotType, VerbOutput, VerbSlot, VerbUnlocks } from "./types";

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const ENV_KINDS = ["literal", "secretSlot"] as const;
const ENV_LIMITS = { env: 16, literal: 256 } as const;

export function deniedEnvPattern(name: string): string | null {
  for (const pattern of DENIED_ENV_PATTERNS) {
    const matches = pattern.startsWith("*") ? name.endsWith(pattern.slice(1)) : pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
    if (matches) return pattern;
  }
  return null;
}

export type EnvScope = { inCli: boolean; secretSlots: ReadonlySet<string>; cliNames: ReadonlySet<string> };

export function envOf(c: Checks, path: string, value: unknown, scope: EnvScope): EnvEntry[] {
  const raw = c.list(path, value, 0, ENV_LIMITS.env) ?? [];
  const seen = new Set<string>();
  const out: EnvEntry[] = [];
  raw.forEach((item, i) => {
    const at = `${path}[${i}]`;
    const kinds = isFields(item) ? ENV_KINDS.filter((kind) => item[kind] !== undefined) : [];
    const extra = isFields(item) ? Object.keys(item).filter((k) => k !== "name" && !(ENV_KINDS as readonly string[]).includes(k)) : [];
    if (!isFields(item) || item.name === undefined || kinds.length !== 1 || extra.length) return c.add(`${at} needs a name and exactly one of literal or secretSlot`);
    const kind = kinds[0]!;
    const name = c.matching(`${at}.name`, item.name, ENV_NAME, "an environment variable name, like BW_NOINTERACTION");
    if (!name) return;
    if (HOST_ENV.includes(name)) return c.add(`${at}.name: ${name} is set by Ardia`);
    const denied = deniedEnvPattern(name);
    if (denied) return c.add(`${at}.name: ${name} matches ${denied}, which Ardia never passes`);
    if (seen.has(name)) c.add(`${path} has ${name} twice`);
    else if (!scope.inCli && scope.cliNames.has(name)) c.add(`${P}.env has ${name} twice`);
    seen.add(name);
    const entry = envEntryOf(c, at, kind, item[kind], name, scope);
    if (entry) out.push(entry);
  });
  return out;
}

function envEntryOf(c: Checks, at: string, kind: (typeof ENV_KINDS)[number], value: unknown, name: string, scope: EnvScope): EnvEntry | null {
  if (kind === "secretSlot") {
    if (scope.inCli) return (c.add(`${at}.secretSlot: only a verb's env can name a slot`), null);
    if (typeof value !== "string" || !scope.secretSlots.has(value)) return (c.add(`${at}.secretSlot: ${String(value)} isn't a secret slot of this verb`), null);
    return { name, secretSlot: value };
  }
  const text = c.plain(`${at}.${kind}`, value, ENV_LIMITS.literal, `must be text of at most ${ENV_LIMITS.literal} characters, with no control characters`);
  if (text === null) return null;
  return { name, literal: text };
}

const VERB_KEYS = ["argv", "slots", "env", "stdin", "timeoutMs", "outputLimitBytes", "output", "signIn", "unlocks", "outlivesCall", "argvSecrets", "hints"];
const SLOT_TYPES: readonly SlotType[] = ["id", "enum", "flag", "url", "email", "code", "secret", "json"];
const OUTPUT_MODES: readonly OutputMode[] = ["json", "lines", "lastLineSecret", "stream"];
const LONG_OPTION = /^--[a-z][a-z0-9-]{0,40}$/;
const PLAIN_TOKEN = /^[^\s\u0000-\u001f\u007f]{1,256}$/;
const ARGV_PREFIX = /^[\x20-\x7e]{0,63}=$/;
const VERB_LIMITS = { argv: 32, slots: 16, values: 16, value: 64, hints: 16, needles: 16, needle: 120 } as const;
const DEFAULT_OUTPUT_BYTES = CREDENTIAL_LIMITS.defaultOutputBytes;

export type VerbScope = { program: string; patterns: Readonly<Record<string, string>>; cliNames: ReadonlySet<string> };

function slotOf(c: Checks, path: string, value: unknown, patterns: Readonly<Record<string, string>>): VerbSlot | null {
  const doc = c.object(path, value);
  if (!doc) return null;
  c.only(path, doc, ["type", "optional", "pattern", "values", "allowLocalHttp"], "of a slot");
  const type = (SLOT_TYPES as readonly unknown[]).includes(doc.type) ? (doc.type as SlotType) : (c.add(`${path}.type must be one of ${SLOT_TYPES.join(", ")}`), null);
  const optional = c.flag(`${path}.optional`, doc.optional, false);
  const slot: VerbSlot = { type: type ?? "id", optional };
  if (type === "id") {
    if (typeof doc.pattern !== "string" || !Object.hasOwn(patterns, doc.pattern)) c.add(`${path}.pattern must name one of ${P}.patterns`);
    else slot.pattern = doc.pattern;
  } else if (doc.pattern !== undefined) c.add(`${path}.pattern only goes with type id`);
  if (type === "enum") {
    const values = doc.values;
    const ok = Array.isArray(values) && values.length >= 1 && values.length <= VERB_LIMITS.values && values.every((v) => typeof v === "string" && v.length >= 1 && v.length <= VERB_LIMITS.value && !v.startsWith("-") && PLAIN_TOKEN.test(v));
    if (!ok) c.add(`${path}.values must be a list of 1 to ${VERB_LIMITS.values} tokens`);
    else slot.values = [...new Set(values as string[])];
  } else if (doc.values !== undefined) c.add(`${path}.values only goes with type enum`);
  if (doc.allowLocalHttp !== undefined) {
    if (type !== "url") c.add(`${path}.allowLocalHttp only goes with type url`);
    else if (c.flag(`${path}.allowLocalHttp`, doc.allowLocalHttp, false)) slot.allowLocalHttp = true;
  }
  return type ? slot : null;
}

function slotsOf(c: Checks, path: string, value: unknown, patterns: Readonly<Record<string, string>>): Record<string, VerbSlot> {
  if (value === undefined) return {};
  const doc = isFields(value) && Object.keys(value).length <= VERB_LIMITS.slots ? value : null;
  if (!doc) return (c.add(`${path} must be an object of at most ${VERB_LIMITS.slots} slots`), {});
  const out: Record<string, VerbSlot> = {};
  for (const [name, raw] of Object.entries(doc)) {
    if (!KEY.test(name)) {
      c.add(`${path}: ${name} isn't a slot name of ${KEY_RULE}`);
      continue;
    }
    const slot = slotOf(c, `${path}.${name}`, raw, patterns);
    if (slot) out[name] = slot;
  }
  return out;
}

function slotInArgv(c: Checks, at: string, name: unknown, slots: Readonly<Record<string, VerbSlot>>): string | null {
  const slot = typeof name === "string" && Object.hasOwn(slots, name) ? slots[name]! : null;
  if (!slot) return (c.add(`${at}.slot: ${String(name)} isn't one of this verb's slots`), null);
  if (slot.type === "secret") return (c.add(`${at}: a secret slot can't go in argv, where other programs see it`), null);
  if (slot.type === "json") return (c.add(`${at}: a json slot only goes in stdin`), null);
  if (slot.type === "flag") return (c.add(`${at}: a flag slot goes in a when`), null);
  return name as string;
}

function secretArgOf(c: Checks, at: string, element: Fields, slots: Readonly<Record<string, VerbSlot>>, argvSecrets: boolean): ArgvToken | null {
  if (Object.keys(element).some((k) => k !== "slot" && k !== "prefix")) return (c.add(`${at} must be a token, { slot }, { flag, slot }, { flag, when } or { slot, prefix }`), null);
  if (typeof element.prefix !== "string" || !ARGV_PREFIX.test(element.prefix)) return (c.add(`${at}.prefix must be 1 to 64 printable ASCII characters ending in =`), null);
  const slot = typeof element.slot === "string" && Object.hasOwn(slots, element.slot) ? slots[element.slot]! : null;
  if (slot?.type !== "secret") return (c.add(`${at}.slot: ${String(element.slot)} must be a secret slot of this verb`), null);
  if (!argvSecrets) return (c.add(`${at}: a secret goes in argv only with argvSecrets: true, since other programs on this Mac can read it while the command runs`), null);
  return { slot: element.slot as string, prefix: element.prefix };
}

function argvTokenOf(c: Checks, at: string, element: unknown, slots: Readonly<Record<string, VerbSlot>>, argvSecrets: boolean): ArgvToken | null {
  if (isFields(element) && element.prefix !== undefined) return secretArgOf(c, at, element, slots, argvSecrets);
  if (typeof element === "string") return PLAIN_TOKEN.test(element) && element !== "--" ? element : (c.add(`${at} must be a plain token: no spaces, newlines, NUL or a lone --`), null);
  if (!isFields(element)) return (c.add(`${at} must be a token, { slot }, { flag, slot } or { flag, when }`), null);
  const keys = Object.keys(element);
  if (element.slot !== undefined && element.when !== undefined) return (c.add(`${at} takes a slot or a when, not both`), null);
  if (keys.some((k) => !["slot", "flag", "when"].includes(k)) || (element.slot === undefined && element.when === undefined) || (element.when !== undefined && element.flag === undefined)) {
    return (c.add(`${at} must be a token, { slot }, { flag, slot } or { flag, when }`), null);
  }
  const flag = element.flag === undefined ? null : c.matching(`${at}.flag`, element.flag, LONG_OPTION, "a long option, like --method");
  if (element.flag !== undefined && !flag) return null;
  if (element.when !== undefined) {
    const when = element.when;
    if (typeof when !== "string" || slots[when]?.type !== "flag") return (c.add(`${at}.when: ${String(when)} isn't a flag slot of this verb`), null);
    return { flag: flag!, when };
  }
  const slot = slotInArgv(c, at, element.slot, slots);
  if (!slot) return null;
  return flag ? { flag, slot } : { slot };
}

function verbArgvOf(c: Checks, path: string, value: unknown, slots: Readonly<Record<string, VerbSlot>>, argvSecrets: boolean): ArgvToken[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > VERB_LIMITS.argv) return (c.add(`${path} must be a list of 1 to ${VERB_LIMITS.argv} tokens and slots`), []);
  if (typeof value[0] !== "string") c.add(`${path}[0] must be a plain token, the subcommand`);
  return value.flatMap((element, i) => argvTokenOf(c, `${path}[${i}]`, element, slots, argvSecrets) ?? []);
}

function outputOf(c: Checks, path: string, value: unknown): VerbOutput {
  const doc: Fields = isFields(value) ? value : {};
  if (isFields(value)) c.only(path, doc, ["mode", "items"]);
  const mode = (OUTPUT_MODES as readonly unknown[]).includes(doc.mode) ? (doc.mode as OutputMode) : (c.add(`${path}.mode must be json, lines, lastLineSecret or stream`), "lines" as const);
  if (doc.items === undefined) return { mode };
  if (mode !== "json") return (c.add(`${path}.items only goes with mode json`), { mode });
  if (typeof doc.items !== "string" || !(doc.items === "$" || KEY.test(doc.items))) return (c.add(`${path}.items must be $ or a key`), { mode });
  return { mode, items: doc.items };
}

function unlocksOf(c: Checks, path: string, value: unknown): VerbUnlocks {
  if (value === undefined || value === false) return false;
  if (value === true) return true;
  if (isFields(value) && Object.keys(value).every((k) => k === "persistent") && typeof value.persistent === "boolean") return { persistent: value.persistent };
  c.add(`${path} must be true or { persistent: true }`);
  return false;
}

function hintsOf(c: Checks, path: string, value: unknown): Record<string, string[]> {
  if (value === undefined) return {};
  const doc = isFields(value) && Object.keys(value).length <= VERB_LIMITS.hints ? value : null;
  if (!doc) return (c.add(`${path} must be an object of at most ${VERB_LIMITS.hints} hints`), {});
  const out: Record<string, string[]> = {};
  for (const [id, needles] of Object.entries(doc)) {
    const ok = KEY.test(id) && Array.isArray(needles) && needles.length >= 1 && needles.length <= VERB_LIMITS.needles && needles.every((n) => typeof n === "string" && n.length >= 1 && n.length <= VERB_LIMITS.needle);
    if (ok) out[id] = needles as string[];
    else c.add(`${path}.${id} must be a list of 1 to ${VERB_LIMITS.needles} texts of 1 to ${VERB_LIMITS.needle} characters`);
  }
  return out;
}

function stdinOf(c: Checks, path: string, value: unknown, slots: Readonly<Record<string, VerbSlot>>): CredentialVerb["stdin"] {
  if (value === undefined) return null;
  const doc = c.object(path, value);
  if (!doc) return null;
  c.only(path, doc, ["slot", "encoding"]);
  const slot = typeof doc.slot === "string" && (slots[doc.slot]?.type === "json" || slots[doc.slot]?.type === "secret") ? doc.slot : (c.add(`${path}.slot: ${String(doc.slot)} must be a json or secret slot of this verb`), null);
  const encoding = doc.encoding === undefined ? "utf8" : doc.encoding === "utf8" || doc.encoding === "base64" ? doc.encoding : (c.add(`${path}.encoding must be utf8 or base64`), null);
  return slot && encoding ? { slot, encoding } : null;
}

function literalProblem(program: string, argv: readonly ArgvToken[]): string | null {
  const tokens = argv.map((t) => (typeof t === "string" ? t : "flag" in t ? `${t.flag}=` : "prefix" in t ? `${t.prefix}\u0000` : "\u0000slot"));
  const denied = deniedMatch(program, tokens);
  return denied ? `${deniedName(program, denied)} is never allowed, since ${denied.why}` : null;
}

const named = (value: unknown, key: string): string[] => (isFields(value) && typeof value[key] === "string" ? [value[key] as string] : []);

function usedSlots(doc: Fields): string[] {
  const argv = Array.isArray(doc.argv) ? doc.argv.flatMap((t) => [...named(t, "slot"), ...named(t, "when")]) : [];
  const env = Array.isArray(doc.env) ? doc.env.flatMap((e) => named(e, "secretSlot")) : [];
  return [...argv, ...env, ...named(doc.stdin, "slot")];
}

export function verbOf(c: Checks, path: string, value: unknown, scope: VerbScope): CredentialVerb | null {
  const doc = c.object(path, value);
  if (!doc) return null;
  c.only(path, doc, VERB_KEYS, "of a verb");
  const slots = slotsOf(c, `${path}.slots`, doc.slots, scope.patterns);
  const argvSecrets = c.flag(`${path}.argvSecrets`, doc.argvSecrets, false);
  const argv = verbArgvOf(c, `${path}.argv`, doc.argv, slots, argvSecrets);
  if (argvSecrets && !argv.some((t) => typeof t === "object" && "prefix" in t)) c.add(`${path}.argvSecrets is set, but no secret goes in argv`);
  const secretSlots = new Set(Object.entries(slots).flatMap(([name, s]) => (s.type === "secret" ? [name] : [])));
  const env = envOf(c, `${path}.env`, doc.env, { inCli: false, secretSlots, cliNames: scope.cliNames });
  const stdin = stdinOf(c, `${path}.stdin`, doc.stdin, slots);
  const used = usedSlots(doc);
  for (const name of Object.keys(slots)) {
    const times = used.filter((u) => u === name).length;
    if (times === 0) c.add(`${path}.slots.${name} isn't used in argv, env or stdin`);
    else if (times > 1) c.add(`${path}.slots.${name} is used more than once`);
  }
  const timeoutMs = c.integer(`${path}.timeoutMs`, doc.timeoutMs, VERB_TIMEOUTS_MS.least, VERB_TIMEOUTS_MS.most, VERB_TIMEOUTS_MS.default);
  const outputLimitBytes = c.integer(`${path}.outputLimitBytes`, doc.outputLimitBytes, 1024, CREDENTIAL_LIMITS.mostOutputBytes, DEFAULT_OUTPUT_BYTES);
  const output = outputOf(c, `${path}.output`, doc.output);
  const signIn = c.flag(`${path}.signIn`, doc.signIn, false);
  const unlocks = unlocksOf(c, `${path}.unlocks`, doc.unlocks);
  const outlivesCall = c.flag(`${path}.outlivesCall`, doc.outlivesCall, false);
  if (unlocks && !signIn) c.add(`${path}.unlocks needs signIn: true`);
  if (typeof unlocks === "object" && unlocks.persistent && output.mode !== "lastLineSecret") c.add(`${path}.unlocks.persistent only goes with mode lastLineSecret`);
  if (output.mode === "lastLineSecret" && !unlocks) c.add(`${path}: a lastLineSecret verb must unlock, since its secret goes nowhere else`);
  if (outlivesCall && (!signIn || output.mode !== "stream")) c.add(`${path}.outlivesCall needs signIn: true and mode stream`);
  const hints = hintsOf(c, `${path}.hints`, doc.hints);
  const denied = scope.program ? literalProblem(scope.program, argv) : null;
  if (denied) c.add(`${path}: ${denied}`);
  return { argv, slots, env, stdin, timeoutMs, outputLimitBytes, output, signIn, unlocks, outlivesCall, argvSecrets, hints };
}

const CLI = P;
const PROGRAM = /^[a-z][a-z0-9._-]{0,31}$/;
const VERSION = /^\d{1,6}(\.\d{1,6}){1,3}$/;
const VERB_ID = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*){0,3}$/;
const CLI_LIMITS = { patterns: 8, pattern: 200, literal: 256, verbs: 48, verbId: 48, install: 200, url: 2048 } as const;

function isSafeRegex(source: string): boolean {
  if (source.length < 1 || source.length > CLI_LIMITS.pattern || !source.startsWith("^") || !source.endsWith("$")) return false;
  if (/\\[1-9]|\\k<|\(\?[=!]|\(\?<[=!]/.test(source)) return false;
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

function patternsOf(c: Checks, value: unknown): Record<string, string> {
  if (value === undefined) return {};
  const doc = c.object(`${CLI}.patterns`, value);
  if (!doc) return {};
  const entries = Object.entries(doc);
  if (entries.length > CLI_LIMITS.patterns) c.add(`${CLI}.patterns must be an object of at most ${CLI_LIMITS.patterns} patterns`);
  const out: Record<string, string> = {};
  for (const [key, source] of entries.slice(0, CLI_LIMITS.patterns)) {
    if (!KEY.test(key)) c.add(`${CLI}.patterns: ${key} isn't a pattern name of ${KEY_RULE}`);
    else if (typeof source !== "string" || !isSafeRegex(source)) c.add(`${CLI}.patterns.${key} must be a regular expression of 1 to ${CLI_LIMITS.pattern} characters that starts with ^ and ends with $`);
    else out[key] = source;
  }
  return out;
}

function installOf(c: Checks, value: unknown): CliInstall {
  const doc = c.object(`${CLI}.install`, value);
  if (!doc) return { command: "" };
  c.only(`${CLI}.install`, doc, ["command", "update", "url"]);
  const command = c.text(`${CLI}.install.command`, doc.command, CLI_LIMITS.install) ?? "";
  const update = c.text(`${CLI}.install.update`, doc.update, CLI_LIMITS.install, false);
  const url = doc.url === undefined ? null : typeof doc.url === "string" && /^https:\/\/[^/?#@\s]+/i.test(doc.url) && doc.url.length <= CLI_LIMITS.url && !/\s/.test(doc.url) ? doc.url : (c.add(`${CLI}.install.url must be an https address`), null);
  return { command, ...(update ? { update } : {}), ...(url ? { url } : {}) };
}

function verbsOf(c: Checks, value: unknown, program: string, patterns: Readonly<Record<string, string>>, cliNames: ReadonlySet<string>): Record<string, CredentialVerb> {
  const doc = isFields(value) ? value : null;
  const ids = doc ? Object.keys(doc) : [];
  if (!doc || ids.length < 1 || ids.length > CLI_LIMITS.verbs) {
    c.add(`${CLI}.verbs must be an object of 1 to ${CLI_LIMITS.verbs} verbs`);
    if (!doc) return {};
  }
  const out: Record<string, CredentialVerb> = {};
  for (const id of ids.slice(0, CLI_LIMITS.verbs)) {
    if (!VERB_ID.test(id) || id.length > CLI_LIMITS.verbId) {
      c.add(`${CLI}.verbs: ${id} isn't a verb id, like list.items`);
      continue;
    }
    const verb = verbOf(c, `${CLI}.verbs.${id}`, doc![id], { program, patterns, cliNames });
    if (verb) out[id] = verb;
  }
  return out;
}

function cliOf(c: Checks, value: unknown): CliSpec | null {
  const doc: Fields | null = isFields(value) ? value : null;
  if (!doc) return (c.add(`${CLI} must be an object`), null);
  c.only(CLI, doc, ["name", "install", "minimumVersion", "sessionLastsSeconds", "patterns", "env", "verbs"]);
  const name = c.matching(`${CLI}.name`, doc.name, PROGRAM, "a program name, like bw");
  const install = installOf(c, doc.install);
  const minimumVersion = c.matching(`${CLI}.minimumVersion`, doc.minimumVersion, VERSION, "a version, like 2024.6.0", false);
  const patterns = patternsOf(c, doc.patterns);
  const env = envOf(c, `${CLI}.env`, doc.env, { inCli: true, secretSlots: new Set(), cliNames: new Set() });
  const patternNames = Object.fromEntries((isFields(doc.patterns) ? Object.keys(doc.patterns) : []).map((key) => [key, patterns[key] ?? ""]));
  const verbs = verbsOf(c, doc.verbs, name ?? "", patternNames, new Set(env.map((e) => e.name)));
  const sessionLastsSeconds = c.integer(`${CLI}.sessionLastsSeconds`, doc.sessionLastsSeconds, 30, 86_400, null);
  return name ? { name, install, minimumVersion, sessionLastsSeconds, patterns, env, verbs } : null;
}

export type SpecCheck = { ok: true; spec: CliSpec; problems: [] } | { ok: false; spec: null; problems: string[] };

export function validateCliSpec(value: unknown): SpecCheck {
  const c = new Checks();
  const spec = cliOf(c, value);
  return spec && c.problems.length === 0 ? { ok: true, spec, problems: [] } : { ok: false, spec: null, problems: c.problems.length ? c.problems : [`${P} isn't a CLI spec`] };
}

export function defineCliSpec(value: unknown): CliSpec {
  const checked = validateCliSpec(value);
  if (!checked.ok) throw new TypeError(`The CLI spec has ${checked.problems.length} problem${checked.problems.length === 1 ? "" : "s"}: ${checked.problems.join("; ")}`);
  return checked.spec;
}
