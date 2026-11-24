import { Cancelled } from "../cdp/cancel.ts";
import { ConnectionLost } from "../daemon-errors.ts";
import { flag } from "../metrics.ts";
import { type Node, walk } from "./tree.ts";

export const MASKED = "••••";
export const MIN_ECHO = 3;
export const MIN_UNKNOWN_ECHO = 6;
const ALONE = "(?<![a-z0-9])(?:pin|cvc2?|cvv2?|csc|otp|2fa|mfa|totp|ssn)(?![a-z0-9])";
export const SENSITIVE_NAME = new RegExp(
  `pass(?:word|code|phrase)|passwd|pwd|${ALONE}|security[\\s_-]*code|card[\\s_-]*(?:number|num|no(?![a-z0-9]))|cc[\\s_-]*(?:num|number|csc)|credit[\\s_-]*card|` +
    "one[\\s_-]*time|verification[\\s_-]*code|auth(?:entication)?[\\s_-]*code|social[\\s_-]*security",
  "iu",
);
export const SENSITIVE_AUTOCOMPLETE = /(?:^|\s)(?:current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp|cc-exp-month|cc-exp-year)(?:\s|$)/u;
export const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);
export const TEXT_ROLES = new Set(["textbox"]);

export type FieldFacts = { type?: unknown; autocomplete?: unknown; said?: unknown; secure?: unknown };

export function sensitiveFacts(facts: FieldFacts): boolean {
  if (facts.type === "password" || facts.secure === true) return true;
  if (typeof facts.autocomplete === "string" && SENSITIVE_AUTOCOMPLETE.test(facts.autocomplete.toLowerCase())) return true;
  return typeof facts.said === "string" && SENSITIVE_NAME.test(facts.said);
}

export function sensitiveNode(node: Node): boolean {
  if (node.props.get("inputType") === "password") return true;
  const autocomplete = node.props.get("autocomplete");
  if (typeof autocomplete === "string" && SENSITIVE_AUTOCOMPLETE.test(autocomplete.toLowerCase())) return true;
  return SENSITIVE_NAME.test(node.name);
}

function holdsValue(node: Node): boolean {
  return VALUE_ROLES.has(node.role) && node.value !== "" && node.value !== MASKED;
}

export type FactsReader = (node: Node) => Promise<FieldFacts | null>;

const OBSCURED = /^[•*·●∙⦁]+$/u;

export function luhnCard(value: string): boolean {
  const digits = value.replace(/[\s-]/gu, "");
  if (!/^[0-9]{13,19}$/u.test(digits) || !/^[0-9][0-9\s-]*[0-9]$/u.test(value.trim())) return false;
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

export function axFacts(node: Node): FieldFacts | null {
  if (OBSCURED.test(node.value)) return { secure: true };
  if (node.name.trim() === "") return TEXT_ROLES.has(node.role) ? null : { said: "" };
  return { type: node.props.get("inputType") ?? "", autocomplete: "", said: node.name };
}

export const axReader: FactsReader = async (node) => axFacts(node);

type Verdict = "keep" | "sensitive" | "unknown";

async function verdictOf(node: Node, read: FactsReader): Promise<Verdict> {
  if (sensitiveNode(node) || luhnCard(node.value)) return "sensitive";
  try {
    const facts = await read(node);
    if (facts === null) return "unknown";
    return sensitiveFacts(facts) ? "sensitive" : "keep";
  } catch (error) {
    if (error instanceof Cancelled || error instanceof ConnectionLost) throw error;
    return "unknown";
  }
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export const SHORT_NUMERIC = /^[0-9]{3,4}$/u;
export const SHORT_ECHO = 4;

export function maskEchoes(nodes: readonly Node[], hidden: readonly string[], least = MIN_ECHO): void {
  const needles = [...new Set(hidden.map((value) => value.trim()).filter((value) => [...value].length >= least && !OBSCURED.test(value)))].sort((a, b) => b.length - a.length);
  if (needles.length === 0) return;
  const numeric = needles.filter((needle) => SHORT_NUMERIC.test(needle));
  const shortWords = needles.filter((needle) => !SHORT_NUMERIC.test(needle) && [...needle].length <= SHORT_ECHO);
  const anywhere = needles.filter((needle) => [...needle].length > SHORT_ECHO);
  const patterns: RegExp[] = [];
  if (numeric.length > 0) patterns.push(new RegExp(`(?<!\\p{N})(?:${numeric.map(escaped).join("|")})(?![\\p{N}\\p{M}])`, "gu"));
  if (shortWords.length > 0) patterns.push(new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_])(?:${shortWords.map(escaped).join("|")})(?![\\p{L}\\p{M}\\p{N}_])`, "giu"));
  const mask = (text: string): string => {
    let out = text;
    for (const needle of anywhere) if (out.includes(needle)) out = out.replaceAll(needle, MASKED);
    for (const pattern of patterns) out = out.replace(pattern, MASKED);
    return out;
  };
  for (const node of walk(nodes)) {
    node.name = mask(node.name);
    node.value = mask(node.value);
  }
}

export async function maskSensitive(nodes: readonly Node[], read: FactsReader): Promise<number> {
  const fields = [...walk(nodes)].filter(holdsValue);
  const verdicts = await Promise.all(fields.map((node) => verdictOf(node, read)));
  const echoed: string[] = [];
  const unknown: string[] = [];
  let masked = 0;
  fields.forEach((node, index) => {
    const verdict = verdicts[index];
    if (verdict === "keep") return;
    (verdict === "sensitive" ? echoed : unknown).push(node.value);
    node.value = MASKED;
    masked += 1;
  });
  maskEchoes(nodes, echoed);
  maskEchoes(nodes, unknown, MIN_UNKNOWN_ECHO);
  if (masked > 0) flag("snapshot_masked_fields", true);
  return masked;
}
