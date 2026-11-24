import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS, OVERVIEW } from "../../src/browse/help-text.ts";
import { TAGGED_CODES } from "../../src/browse/remedies.ts";
import { SKILL_FILES } from "../../src/skill-files.ts";
import { codePoints } from "../../src/pystr.ts";
import type { Body, Comparable } from "./compare.ts";
import type { Py } from "./pyjson.ts";
import { stripEnvelopeRemedies } from "../remedy-strip.ts";

const FROZEN = join(import.meta.dir, "fixtures", "frozen");
const TS_ONLY_METRICS = ["remedy_shown", "did_you_mean"];
const NEW_SKILL_FILES = ["references/commands.md"];
const ERROR_TAG = /^(✗ [^\n]*(?:\n(?!✗ |  remedy: )[^\n]*)*?) \(([a-z][a-z0-9_]*)\)(?:\n  remedy: [^\n]*)?(?=\n|$)/gmu;
const REMEDY_LINE = /\n {2}remedy: ardia [^\n]*(?=\n|$)/gu;
const MARKER_HASH = /^ {2}"hash": "[0-9a-f]{64}",\n/mu;
const METRIC_TEXT = new RegExp(`(?:,\\s*"(?:${TS_ONLY_METRICS.join("|")})":\\s*(?:true|false)|"(?:${TS_ONLY_METRICS.join("|")})":\\s*(?:true|false),\\s*)`, "gu");
const SKILL_FOLDER = /(?:^|\/)(?:\.agents|\.claude|\.cursor|\.config\/opencode|\.opencode)\/skills\/ardia\/(.+)$/u;
const TELEMETRY_COPY = /^data\/Telemetry\/local\/cli-[^/]+\.jsonl$/u;
const TOP_HELP_USAGE = "usage: ardia [-h] [--version] [--skill] <command> ...";
const NEW_COMMAND_ENTRY = /^ {4}triage(?: [^\n]*)?\n(?: {5,}[^\n]*\n)*/mu;

export const RULES: Record<string, string> = {
  "error-remedy":
    "the `(code)` tag the client adds at the end of a `✗` failure, the `  remedy: <command>` line after it, a `--json` failure's `\"remedy\"` key and the `remedy_shown` and `did_you_mean` telemetry flags are dropped from what the program printed and sent, since the captured outcomes predate them (src/browse/remedies.ts)",
  "skill-docs":
    "the shipped skill's generated parts changed (the command index in SKILL.md, the error code table in references/troubleshooting.md, the new references/commands.md and the marker's content hash): the current text reads as the captured one (fixtures/frozen), commands.md and the marker's `hash` are dropped, and `output_chars` moves by the difference",
  "help-text": "the browse overview and the command help entries that changed read as the captured ones (fixtures/frozen/browse-help.json), with `output_chars` moved by the difference",
  "new-commands": "the top-level help (`ardia --help`) lists `ardia triage`, which the captured outcomes predate: its entry, and the lines it wraps onto, are dropped from that help only",
};

type Swap = { now: string; then: string };

let swaps: Swap[] | undefined;

function frozenSwaps(): Swap[] {
  if (swaps !== undefined) return swaps;
  const shipped = new Map(SKILL_FILES);
  const help = JSON.parse(readFileSync(join(FROZEN, "browse-help.json"), "utf8")) as { overview: string; commands: Record<string, string> };
  const found: Swap[] = [
    { now: shipped.get("SKILL.md") as string, then: readFileSync(join(FROZEN, "SKILL.md"), "utf8") },
    { now: shipped.get("references/troubleshooting.md") as string, then: readFileSync(join(FROZEN, "troubleshooting.md"), "utf8") },
    { now: OVERVIEW, then: help.overview },
  ];
  for (const [name, then] of Object.entries(help.commands)) {
    const now = COMMANDS[name];
    if (now !== undefined && now !== then) found.push({ now, then });
  }
  swaps = found.filter((swap) => swap.now !== swap.then).sort((a, b) => b.now.length - a.now.length);
  return swaps;
}

function skillFile(rel: string): string | null {
  return SKILL_FOLDER.exec(rel)?.[1] ?? null;
}

function withoutNewSkillSections(text: string): string {
  let out = text;
  for (const name of NEW_SKILL_FILES) {
    const body = new Map(SKILL_FILES).get(name);
    if (body !== undefined) out = out.replace(`\n--- ${name} ---\n\n${body}`, "");
  }
  return out;
}

function frozenMarker(text: string): string {
  let out = text.replace(MARKER_HASH, "");
  for (const name of NEW_SKILL_FILES) out = out.replace(new RegExp(`^ {4}"${name.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&")}",\\n`, "mu"), "");
  return out;
}

function swapped(text: string): string {
  let out = text;
  for (const swap of frozenSwaps()) if (out.includes(swap.now)) out = out.split(swap.now).join(swap.then);
  return out;
}

export function withoutRemedies(text: string): string {
  return stripEnvelopeRemedies(text)
    .replace(ERROR_TAG, (whole, message: string, code: string) => (TAGGED_CODES.has(code) ? message : whole))
    .replace(REMEDY_LINE, "");
}

function withoutNewCommands(text: string): string {
  return text.startsWith(TOP_HELP_USAGE) ? text.replace(NEW_COMMAND_ENTRY, "") : text;
}

export function designedText(text: string): { text: string; delta: number } {
  const plain = withoutRemedies(text);
  const out = withoutNewCommands(swapped(withoutNewSkillSections(plain)));
  return { text: out, delta: codePoints(out).length - codePoints(plain).length };
}

function textOf(body: Body): string | null {
  if (!("bytes" in body)) return null;
  const text = body.bytes.toString("utf8");
  return Buffer.from(text, "utf8").compare(body.bytes) === 0 ? text : null;
}

function designedStream(body: Body): { body: Body; delta: number } {
  const text = textOf(body);
  if (text === null) return { body, delta: 0 };
  const done = designedText(text);
  return done.text === text ? { body, delta: 0 } : { body: { bytes: Buffer.from(done.text, "utf8") }, delta: done.delta };
}

function designedFile(rel: string, body: Body): Body {
  const text = textOf(body);
  if (text === null) return body;
  const name = skillFile(rel);
  let out = text;
  if (name === ".ardia-skill") out = frozenMarker(text);
  else if (name !== null) out = swapped(text);
  else if (TELEMETRY_COPY.test(rel)) out = text.replace(METRIC_TEXT, "");
  return out === text ? body : { bytes: Buffer.from(out, "utf8") };
}

function designedEvents(events: Py, delta: number): Py {
  if (Array.isArray(events)) return events.map((item) => designedEvents(item, delta));
  if (!(events instanceof Map)) return events;
  const out = new Map<string, Py>();
  for (const [key, value] of events) {
    if (TS_ONLY_METRICS.includes(key)) continue;
    if (key === "output_chars" && typeof value === "bigint" && delta !== 0) out.set(key, value + BigInt(delta));
    else out.set(key, designedEvents(value, delta));
  }
  return out;
}

export function designed(fresh: Comparable): Comparable {
  const stdout = designedStream(fresh.stdout);
  const stderr = designedStream(fresh.stderr);
  const delta = stdout.delta + stderr.delta;
  const files = new Map<string, (string | number | Body)[]>();
  for (const [rel, parts] of fresh.files) {
    const name = skillFile(rel);
    if (name !== null && NEW_SKILL_FILES.includes(name)) continue;
    files.set(rel, parts.map((part) => (typeof part === "object" && part !== null && ("bytes" in part || "sha256" in part) ? designedFile(rel, part as Body) : part)));
  }
  return {
    ...fresh,
    stdout: stdout.body,
    stderr: stderr.body,
    telemetry: designedEvents(fresh.telemetry as Py, delta) as Comparable["telemetry"],
    queued: designedEvents(fresh.queued as Py, delta) as Comparable["queued"],
    files,
  };
}
