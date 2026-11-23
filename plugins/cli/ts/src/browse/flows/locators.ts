import { codePoints } from "../../pystr.ts";

export const CANDIDATE_KINDS = ["role", "aria-label", "placeholder", "name", "testid", "text", "css", "xpath"] as const;
export type CandidateKind = (typeof CANDIDATE_KINDS)[number];
export type Candidate = { by: CandidateKind; value: string; tag?: string; name?: string };
export type Fingerprint = { role: string; name: string };
export type Descriptor = {
  tag?: string | null;
  role?: string | null;
  name?: string | null;
  ariaLabel?: string | null;
  placeholder?: string | null;
  fieldName?: string | null;
  testId?: string | null;
  text?: string | null;
  id?: string | null;
  classes?: readonly string[] | null;
  css?: string | null;
  xpath?: string | null;
  type?: string | null;
  checked?: boolean | null;
};

export const MAX_CANDIDATES = 6;
export const MAX_VALUE = 120;
const MAX_TEXT = 60;
const RANK: Readonly<Record<CandidateKind, number>> = { role: 0, "aria-label": 1, placeholder: 2, name: 3, testid: 4, text: 5, css: 6, xpath: 7 };
const TAG = /^[a-z][a-z0-9-]{0,30}$/u;
const ROLE = /^[a-z][a-z-]{1,30}$/u;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;
const LONG_HEX = /(^|[^a-z0-9])[0-9a-f]{8,}($|[^a-z0-9])/iu;
const MIXED_RUN = /(?=[a-z0-9]*[0-9])(?=[a-z0-9]*[a-z])[a-z0-9]{10,}/iu;
const HASHED_CLASS = /^(css|sc|jsx|emotion|styled|makeStyles|jss|tw|svelte|astro|chakra|mui|Mui[A-Za-z]+)-[A-Za-z0-9_-]*[0-9][A-Za-z0-9_-]*$|^_(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{5,}$|^(?=[A-Za-z0-9]*[0-9])[a-z]{1,3}[A-Z0-9][A-Za-z0-9]{4,7}$|^[A-Za-z0-9]+__[A-Za-z0-9]+___[A-Za-z0-9]{5}$/u;
const GENERATED_ID = /^(ember|ext-gen|yui_|ui-id-|react-select-|headlessui-|radix-|mui-|downshift-|rc-|el-id-)[A-Za-z0-9_:-]*[0-9]|^:r[0-9a-z]+:$|^[a-z]{0,6}[_-]?[0-9]{3,}$|^[A-Za-z]{0,4}[0-9]{4,}[A-Za-z0-9]*$/u;
const TIMESTAMP = /\b(19|20)[0-9]{2}-[01][0-9]-[0-3][0-9]([T ][0-2][0-9]:[0-5][0-9])?|\b1[5-9][0-9]{8,11}\b|\b[0-2]?[0-9]:[0-5][0-9](:[0-5][0-9])?\b/u;
const EMAIL = /[^\s@"']+@[^\s@"']+\.[a-z]{2,}/iu;
const LONG_NUMBER = /[0-9]{6,}/u;

export type Problem = { what: string; why: string };

function clean(text: unknown, limit = MAX_VALUE): string {
  if (typeof text !== "string") return "";
  const flat = text.replace(/\s+/gu, " ").trim();
  const points = codePoints(flat);
  return points.length <= limit ? flat : "";
}

function quoted(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function fragileId(value: string): boolean {
  return UUID.test(value) || GENERATED_ID.test(value) || LONG_HEX.test(value) || MIXED_RUN.test(value);
}

export function fragileClass(value: string): boolean {
  return HASHED_CLASS.test(value) || UUID.test(value) || LONG_HEX.test(value);
}

export function cssTokens(css: string): { ids: string[]; classes: string[]; attrs: string[] } {
  const ids = [...css.matchAll(/#((?:\\.|[A-Za-z0-9_-])+)/gu)].map((match) => (match[1] as string).replaceAll("\\", ""));
  const classes = [...css.matchAll(/\.((?:\\.|[A-Za-z0-9_-])+)/gu)].map((match) => (match[1] as string).replaceAll("\\", ""));
  const attrs = [...css.matchAll(/\[[^\]=]+[~|^$*]?=\s*["']?([^"'\]]*)["']?\s*\]/gu)].map((match) => match[1] as string);
  return { ids, classes, attrs };
}

export function fragileSelector(candidate: Candidate): string | null {
  const value = candidate.value;
  if (candidate.by === "css") {
    const { ids, classes, attrs } = cssTokens(value);
    const id = ids.find(fragileId);
    if (id) return `it keys on the generated id #${id}`;
    const hashed = classes.find(fragileClass);
    if (hashed) return `it keys on the hashed class .${hashed}`;
    const attr = attrs.find((item) => UUID.test(item) || LONG_HEX.test(item));
    if (attr) return `it keys on the generated value ${attr}`;
    if (/:nth-(child|of-type)\(\s*[0-9]{2,}/u.test(value)) return "it keys on a far nth-child position";
    return null;
  }
  if (candidate.by === "xpath") {
    const id = [...value.matchAll(/@id\s*=\s*["']([^"']+)["']/gu)].map((match) => match[1] as string).find(fragileId);
    if (id) return `it keys on the generated id ${id}`;
    if (/@class\s*=/u.test(value) && [...value.matchAll(/@class\s*=\s*["']([^"']+)["']/gu)].some((match) => (match[1] as string).split(/\s+/u).some(fragileClass))) {
      return "it keys on a hashed class";
    }
    return null;
  }
  if (candidate.by === "testid" && (UUID.test(value) || LONG_HEX.test(value))) return `its test id ${value} looks generated`;
  if (candidate.by === "name" && (UUID.test(value) || LONG_HEX.test(value))) return `its name ${value} looks generated`;
  return null;
}

export function hardcodedValue(text: string, runValues: readonly string[]): string | null {
  for (const value of runValues) {
    if (value && codePoints(value).length >= 3 && text.includes(value)) return `it holds ${quoted(value)}, a value from one run; use its {{param}}`;
  }
  if (UUID.test(text)) return "it holds a UUID, which changes between runs";
  if (EMAIL.test(text)) return "it holds an email address from one run";
  if (TIMESTAMP.test(text)) return "it holds a date or time from one run";
  if (LONG_NUMBER.test(text)) return "it holds a long number (an id or count) from one run";
  return null;
}

export function candidateProblem(candidate: Candidate, runValues: readonly string[] = []): string | null {
  if (!CANDIDATE_KINDS.includes(candidate.by)) return `${String(candidate.by)} isn't a locator kind (${CANDIDATE_KINDS.join(", ")})`;
  if (typeof candidate.value !== "string" || !candidate.value.trim()) return "it has no value";
  if (codePoints(candidate.value).length > MAX_VALUE * 2) return "it's too long to be a stable locator";
  if (candidate.by === "role" && (!ROLE.test(candidate.value) || typeof candidate.name !== "string" || !candidate.name.trim())) return "a role locator needs a role and a name";
  if (candidate.tag !== undefined && !TAG.test(candidate.tag)) return `${candidate.tag} isn't a tag name`;
  const fragile = fragileSelector(candidate);
  if (fragile) return fragile;
  const text = candidate.by === "role" ? `${candidate.name}` : candidate.value;
  return hardcodedValue(text, runValues);
}

function push(out: Candidate[], candidate: Candidate): void {
  if (!candidate.value) return;
  if (out.some((item) => selectorOf(item) === selectorOf(candidate))) return;
  if (candidateProblem(candidate) !== null) return;
  out.push(candidate);
}

export function rankCandidates(descriptor: Descriptor): Candidate[] {
  const out: Candidate[] = [];
  const tag = clean(descriptor.tag, 30).toLowerCase();
  const label = clean(descriptor.ariaLabel);
  if (label) push(out, { by: "aria-label", value: label });
  const placeholder = clean(descriptor.placeholder);
  if (placeholder) push(out, { by: "placeholder", value: placeholder });
  const field = clean(descriptor.fieldName);
  if (field) push(out, TAG.test(tag) ? { by: "name", value: field, tag } : { by: "name", value: field });
  const testId = clean(descriptor.testId);
  if (testId) push(out, { by: "testid", value: testId });
  const text = clean(descriptor.text, MAX_TEXT);
  if (text) push(out, { by: "text", value: text });
  const css = clean(descriptor.css, MAX_VALUE * 2);
  if (css) push(out, { by: "css", value: css });
  const id = clean(descriptor.id);
  if (id && !fragileId(id) && /^[A-Za-z][A-Za-z0-9_-]*$/u.test(id)) push(out, { by: "css", value: `#${id}` });
  const xpath = clean(descriptor.xpath, MAX_VALUE * 2);
  if (xpath) push(out, { by: "xpath", value: xpath });
  return sortCandidates(out).slice(0, MAX_CANDIDATES);
}

export function sortCandidates(candidates: readonly Candidate[]): Candidate[] {
  return [...candidates].map((candidate, index) => ({ candidate, index })).sort((a, b) => RANK[a.candidate.by] - RANK[b.candidate.by] || a.index - b.index).map((item) => item.candidate);
}

export function fingerprintOf(descriptor: Descriptor): Fingerprint | null {
  const role = clean(descriptor.role, 30).toLowerCase();
  const name = clean(descriptor.name);
  if (!ROLE.test(role) || !name || hardcodedValue(name, []) !== null) return null;
  return { role, name };
}

export function selectorOf(candidate: Candidate): string {
  switch (candidate.by) {
    case "aria-label":
      return `[aria-label=${quoted(candidate.value)}]`;
    case "placeholder":
      return `[placeholder=${quoted(candidate.value)}]`;
    case "name":
      return `${candidate.tag ?? ""}[name=${quoted(candidate.value)}]`;
    case "testid":
      return `[data-testid=${quoted(candidate.value)}]`;
    case "text":
      return `text=${quoted(candidate.value)}`;
    case "xpath":
      return candidate.value.startsWith("xpath=") ? candidate.value : `xpath=${candidate.value}`;
    case "role":
      return `role=${candidate.value}[name=${quoted(candidate.name ?? "")}]`;
    default:
      return candidate.value;
  }
}

export function normalName(text: string): string {
  return text.replace(/\s+/gu, " ").trim().toLowerCase();
}

export type LiveNode = { ref: string; role: string; name: string };

export function matchFingerprint(fingerprint: Fingerprint, nodes: readonly LiveNode[]): { ref: string | null; why: string } {
  const sameRole = nodes.filter((node) => node.role === fingerprint.role);
  if (sameRole.length === 0) return { ref: null, why: `no ${fingerprint.role} on the page` };
  const exact = sameRole.filter((node) => node.name === fingerprint.name);
  if (exact.length === 1) return { ref: (exact[0] as LiveNode).ref, why: "exact role and name" };
  if (exact.length > 1) return { ref: null, why: `${exact.length} ${fingerprint.role}s are named ${quoted(fingerprint.name)}` };
  const loose = sameRole.filter((node) => normalName(node.name) === normalName(fingerprint.name));
  if (loose.length === 1) return { ref: (loose[0] as LiveNode).ref, why: "role and name, ignoring case and spacing" };
  if (loose.length > 1) return { ref: null, why: `${loose.length} ${fingerprint.role}s are named ${quoted(fingerprint.name)}` };
  return { ref: null, why: `no ${fingerprint.role} named ${quoted(fingerprint.name)}` };
}

export function intentOf(type: string, fingerprint: Fingerprint | null, candidates: readonly Candidate[], value: string | null = null): string {
  const label = fingerprint?.name ?? candidates.find((candidate) => ["aria-label", "placeholder", "text", "name", "testid"].includes(candidate.by))?.value ?? "";
  const what = fingerprint?.role ?? "element";
  const target = label ? `the ${quoted(clip(label))} ${what}` : `the ${what}`;
  switch (type) {
    case "fill":
    case "type":
      return `enter ${value && value.startsWith("{{") ? value : "text"} in ${target}`;
    case "select":
      return `choose ${value && value.startsWith("{{") ? value : "an option"} in ${target}`;
    case "check":
      return `turn on ${target}`;
    case "uncheck":
      return `turn off ${target}`;
    case "press":
      return `press ${value ?? "a key"}${label ? ` in ${target}` : ""}`;
    case "open":
      return "open the start page";
    case "submit":
      return `submit ${target}`;
    default:
      return `${type} ${target}`;
  }
}

function clip(text: string): string {
  const points = codePoints(text);
  return points.length <= 40 ? text : `${points.slice(0, 39).join("")}…`;
}
