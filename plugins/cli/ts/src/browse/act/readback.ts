import { headPoints } from "../../pylib/str.ts";
import { redact } from "../../redact.ts";
import { BrowseError, ConnectionLost } from "../daemon-errors.ts";
import { flag } from "../metrics.ts";
import type { Element, Page } from "../state/page.ts";
import { asRecord } from "./common.ts";

export type ReadbackStatus = "ok" | "did_not_commit" | "unverified";
export type FieldKind = "password" | "card" | "phone" | "date" | "number" | "email" | "rich" | "text";
export type Readback = { status: ReadbackStatus; kind: FieldKind; reason: string | null; held: string | null };
export type FieldRead = {
  tag: string;
  type: string | null;
  value: string | null;
  length: number | null;
  secret: boolean;
  maxLength: number;
  autocomplete: string;
  hint: string;
  combo: string | null;
};

export const SECRET_AUTOCOMPLETE = ["current-password", "new-password", "one-time-code", "cc-csc"];

export const HELD_SHOWN = 80;

export const READ_FIELD = `(el, latched) => {
  const tag = el.tagName.toLowerCase();
  const plain = tag === "input" || tag === "textarea" || tag === "select";
  const value = plain ? el.value : el.isContentEditable ? el.innerText : null;
  const hint = [el.name, el.id, el.getAttribute("placeholder"), el.getAttribute("aria-label"), el.getAttribute("inputmode")].filter(Boolean).join(" ").toLowerCase();
  const autocomplete = (el.getAttribute("autocomplete") || "").toLowerCase();
  const secret = !!latched || (tag === "input" && (el.type || "").toLowerCase() === "password") || ${JSON.stringify(SECRET_AUTOCOMPLETE)}.some((word) => autocomplete.split(/\\s+/).includes(word));
  return {
    tag,
    type: tag === "input" ? (el.type || "text").toLowerCase() : null,
    value: value == null || secret ? null : String(value),
    length: value == null ? null : Array.from(String(value)).length,
    secret,
    maxLength: typeof el.maxLength === "number" ? el.maxLength : -1,
    autocomplete,
    hint,
    combo: globalThis.ardiaBrowse ? ardiaBrowse.comboKind(el) : null,
  };
}`;

const CARD_HINT = /\b(card|cc-?num(ber)?|cardnumber|credit|pan)\b/u;
const PHONE_HINT = /\b(phone|mobile|cell|tel)\b/u;
const DATE_HINT = /\b(date|dob|birth(day|date)?|expir\w*|exp|mm\s*\/?\s*yy|dd\s*\/?\s*mm)\b/u;
const MASKED = /^[•●*·∙⋅◦]+$/u;

export function fieldKind(read: FieldRead): FieldKind {
  const type = read.type ?? "";
  if (read.secret || type === "password") return "password";
  if (read.autocomplete.startsWith("cc-number") || CARD_HINT.test(read.hint)) return "card";
  if (type === "tel" || read.autocomplete.startsWith("tel") || PHONE_HINT.test(read.hint)) return "phone";
  if (["date", "datetime-local", "month", "week", "time"].includes(type) || read.autocomplete.startsWith("bday") || read.autocomplete.startsWith("cc-exp") || DATE_HINT.test(read.hint)) return "date";
  if (type === "number") return "number";
  if (type === "email") return "email";
  if (read.tag !== "input" && read.tag !== "textarea") return "rich";
  return "text";
}

function digits(text: string): string {
  return text.replace(/\D+/gu, "");
}

function alnum(text: string): string {
  return text.normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
}

function squash(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function dateGroups(text: string): string {
  return (text.match(/\d+/gu) ?? [])
    .map((group) => String(Number(group)))
    .sort()
    .join(",");
}

function shown(held: string): string {
  return headPoints(redact(held), HELD_SHOWN);
}

function length(text: string): number {
  return Array.from(text).length;
}

function judged(kind: FieldKind, held: string | null, status: ReadbackStatus, reason: string | null = null): Readback {
  return { status, kind, reason, held: kind === "password" || held === null ? null : shown(held) };
}

export function fieldRead(given: Record<string, unknown>): FieldRead {
  const textOf = (value: unknown) => (typeof value === "string" ? value : "");
  return {
    tag: textOf(given["tag"]) || "input",
    type: typeof given["type"] === "string" ? given["type"] : null,
    value: typeof given["value"] === "string" ? given["value"] : null,
    length: typeof given["length"] === "number" ? given["length"] : null,
    secret: given["secret"] === true,
    maxLength: typeof given["maxLength"] === "number" ? given["maxLength"] : -1,
    autocomplete: textOf(given["autocomplete"]),
    hint: textOf(given["hint"]),
    combo: typeof given["combo"] === "string" ? given["combo"] : null,
  };
}

export function judgeSecret(read: FieldRead, wanted: string): Readback {
  const held = read.length ?? (read.value === null ? null : length(read.value));
  const want = length(wanted);
  const secret = (status: ReadbackStatus, reason: string | null = null): Readback => ({ status, kind: "password", reason, held: null });
  if (held === null) return secret("unverified", "its length can't be read back");
  if (held === want) return secret("ok");
  if (held === 0) return secret("did_not_commit", "it is empty after typing");
  if (read.maxLength > 0 && held === read.maxLength && held < want) return secret("did_not_commit", `its maxlength cut it to ${read.maxLength} characters`);
  return secret("did_not_commit", `it holds ${held} characters, not ${want}`);
}

export function judgeReadback(read: FieldRead, wanted: string): Readback {
  const kind = fieldKind(read);
  if (kind === "password") return judgeSecret(read, wanted);
  const held = read.value;
  if (held === null) return judged(kind, null, "unverified", "its value can't be read back");
  const truncated = read.maxLength > 0 && length(held) === read.maxLength && length(held) < length(wanted);
  if (held === wanted || squash(held) === squash(wanted)) return judged(kind, held, "ok");
  if (held === "") return judged(kind, held, "did_not_commit", "it is empty after typing");
  if (MASKED.test(held) && length(held) === length(wanted)) return judged(kind, held, "ok", "the field masks what it holds");
  if (truncated && (wanted.startsWith(held) || digits(wanted).startsWith(digits(held)))) {
    return judged(kind, held, "did_not_commit", `its maxlength cut it to ${read.maxLength} characters`);
  }
  if ((kind === "card" || kind === "phone") && digits(wanted) !== "") {
    if (digits(held) === digits(wanted)) return judged(kind, held, "ok", "the field formatted it");
    if (digits(wanted).startsWith(digits(held))) return judged(kind, held, "did_not_commit", `it kept only ${length(digits(held))} of ${length(digits(wanted))} digits`);
  }
  if (kind === "date" && dateGroups(held) !== "" && dateGroups(held) === dateGroups(wanted)) return judged(kind, held, "ok", "the field formatted the date");
  if (kind === "number" && held.trim() !== "" && Number(held) === Number(wanted)) return judged(kind, held, "ok");
  if (kind === "email" && held.trim().toLowerCase() === wanted.trim().toLowerCase()) return judged(kind, held, "ok");
  if (kind === "rich" && squash(held).includes(squash(wanted))) return judged(kind, held, "ok");
  if (read.combo === "typeahead" && held.toLowerCase().startsWith(wanted.toLowerCase())) return judged(kind, held, "ok", "the field completed it");
  if (alnum(held) !== "" && alnum(held) === alnum(wanted)) return judged(kind, held, "ok", "the field formatted it");
  return judged(kind, held, "did_not_commit", `it holds "${shown(held)}"`);
}

export function secretField(facts: Record<string, unknown>): boolean {
  return facts["tag"] === "input" && String(facts["type"] ?? "").toLowerCase() === "password";
}

export async function readBack(page: Page, element: Element, wanted: string, secret = false): Promise<Readback> {
  let read: FieldRead;
  try {
    read = fieldRead(asRecord(await page.call(READ_FIELD, [element, secret], { frame: element.frame, read: true })));
  } catch (error) {
    if (!(error instanceof BrowseError) || error instanceof ConnectionLost) throw error;
    flag("fill_readback_unverified", true);
    return { status: "unverified", kind: "text", reason: "the field couldn't be read back", held: null };
  }
  const judgedRead = judgeReadback(read, wanted);
  if (judgedRead.status === "did_not_commit") flag("fill_readback_mismatch", true);
  if (judgedRead.status === "unverified") flag("fill_readback_unverified", true);
  return judgedRead;
}

export function readbackNote(readback: Readback | null | undefined): string {
  if (!readback || readback.status !== "did_not_commit") return "";
  return `\n→ The field didn't keep it as typed: ${readback.reason ?? "it reads differently"}. Check it (snapshot or get value) before going on`;
}
