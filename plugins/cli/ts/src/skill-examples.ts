import { frontEndOutcome } from "./argparse-cli.ts";
import { parseCommand } from "./commands.ts";
import { route } from "./route.ts";
import { splitGlobals, Usage } from "./browse/args.ts";
import { SKIPPED } from "./browse/daemon/names.ts";
import { closest } from "./browse/suggest.ts";
import { subcommandFlagProblem } from "./browse/subcommand-flags.ts";
import { ALIASES, COMMAND_FLAGS, COMMAND_OWNS, KNOWN_COMMANDS } from "./browse/tables.ts";

export type Example = { file: string; line: number; text: string; batch: boolean };
export type Problem = { example: Example; problem: string };

const HELP_WORDS = ["--help", "-h", "help", "--version", "-V"];
const ALWAYS_FLAGS = ["--help", "-h"];
const STOP_WORDS = new Set(["|", "||", "&&", ";", ">", ">>", "2>", "2>&1", "<", "&"]);
const HEREDOC = /<<-?\s*['"]?([A-Za-z_]+)['"]?/u;
const SHARED_VALUE = ["--port", "--ws", "--data-dir", "--timeout"];
const MENTION = /: error: the following arguments are required: /u;

function placeholder(word: string): boolean {
  return /^[<[{]/u.test(word) || word === "…" || word === "..." || word.includes("<") || word.endsWith("…");
}

export function shellWords(text: string): string[] {
  const words: string[] = [];
  let current = "";
  let started = false;
  let index = 0;
  while (index < text.length) {
    const char = text[index] as string;
    if (char === "'") {
      const end = text.indexOf("'", index + 1);
      current += end < 0 ? text.slice(index + 1) : text.slice(index + 1, end);
      started = true;
      index = end < 0 ? text.length : end + 1;
      continue;
    }
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') {
        if (text[end] === "\\" && end + 1 < text.length) {
          current += text[end + 1];
          end += 2;
          continue;
        }
        current += text[end];
        end += 1;
      }
      started = true;
      index = end + 1;
      continue;
    }
    if (char === "\\" && index + 1 < text.length) {
      current += text[index + 1];
      started = true;
      index += 2;
      continue;
    }
    if (/\s/u.test(char)) {
      if (started) words.push(current);
      current = "";
      started = false;
      index += 1;
      continue;
    }
    if (char === "#" && !started) break;
    current += char;
    started = true;
    index += 1;
  }
  if (started) words.push(current);
  const stop = words.findIndex((word) => STOP_WORDS.has(word) || word.startsWith("<<") || word.startsWith(">"));
  return stop < 0 ? words : words.slice(0, stop);
}

function commandFlags(name: string): Set<string> {
  return new Set([...(COMMAND_FLAGS[name] ?? []), ...(COMMAND_OWNS[name] ?? []), ...ALWAYS_FLAGS]);
}

export function checkBrowse(words: readonly string[]): string[] {
  let rest: string[];
  try {
    rest = splitGlobals(words).rest;
  } catch (error) {
    if (error instanceof Usage) return [error.message];
    throw error;
  }
  const command = rest[0];
  if (command === undefined) return [];
  if (HELP_WORDS.includes(command) || placeholder(command)) return [];
  const name = Object.hasOwn(ALIASES, command) ? (ALIASES[command] as string) : command;
  if (Object.hasOwn(SKIPPED, name)) return [`\`${command}\` isn't part of ardia browse`];
  if (!KNOWN_COMMANDS.includes(name)) {
    const guess = closest(command, KNOWN_COMMANDS);
    return [`unknown command \`${command}\`${guess === undefined ? "" : ` (did you mean \`${guess}\`?)`}`];
  }
  const problems: string[] = [];
  const allowed = commandFlags(name);
  for (const word of rest.slice(1)) {
    if (word === "--") break;
    if (!word.startsWith("-") || word === "-" || /^-\d/u.test(word) || placeholder(word)) continue;
    const flag = word.includes("=") ? word.slice(0, word.indexOf("=")) : word;
    if (!allowed.has(flag)) {
      const guess = closest(flag, allowed);
      problems.push(`\`${name}\` doesn't take ${flag}${guess === undefined ? "" : ` (did you mean ${guess}?)`}`);
    }
  }
  const subcommand = rest.slice(1).find((word) => !word.startsWith("-") && !placeholder(word));
  const misplaced = subcommandFlagProblem(name, subcommand, rest.slice(1).filter((word) => !placeholder(word)));
  if (misplaced !== undefined) problems.push(misplaced);
  if (name === "batch") {
    for (const word of rest.slice(1)) {
      if (word.startsWith("-") || placeholder(word)) continue;
      const line = word.trim().startsWith("[") ? jsonLine(word) : shellWords(word);
      if (line !== undefined && line.length > 0) problems.push(...checkBrowse(line).map((problem) => `batch line "${word}": ${problem}`));
    }
  }
  return problems;
}

function jsonLine(word: string): string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(word);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? (parsed as string[]) : undefined;
  } catch {
    return undefined;
  }
}

function leadingShared(words: readonly string[]): number {
  let index = 0;
  while (index < words.length) {
    const word = words[index] as string;
    const name = word.split("=")[0] as string;
    if (SHARED_VALUE.includes(name)) index += word.includes("=") ? 1 : 2;
    else if (word === "--json") index += 1;
    else break;
  }
  return index;
}

export function checkArdia(words: readonly string[]): string[] {
  const at = leadingShared(words);
  const command = words[at];
  if (command === undefined) return [];
  if (placeholder(command)) return [];
  if (command === "browse") return checkBrowse([...words.slice(0, at), ...words.slice(at + 1)]);
  if (command === "repl") return checkBrowse([...words.slice(0, at), "script", "--repl", ...words.slice(at + 1)]);
  if (command === "guide") return [];
  if (command === "notes") return checkBrowse(["notes", ...words.slice(at + 1)]);
  const outcome = frontEndOutcome([...words]);
  if (outcome.kind !== "served") return [];
  const served = outcome.served;
  if (served.status === 0 || served.status === null) return [];
  const said = (served.stderr || served.stdout).trim().split("\n").filter(Boolean);
  const last = said[said.length - 1] ?? `exit ${served.status}`;
  if (MENTION.test(last)) return [];
  const routed = route([...words], undefined, parseCommand);
  return routed.kind === "command" || routed.kind === "tools" ? [] : [last];
}

export function checkCommand(text: string): string[] {
  const words = shellWords(text);
  if (words[0] !== "ardia") return [`doesn't start with ardia: ${text}`];
  return checkArdia(words.slice(1));
}

function inlineSpans(text: string): { text: string; offset: number }[] {
  const spans: { text: string; offset: number }[] = [];
  const pattern = /(`+)([\s\S]*?[^`])\1(?!`)/gu;
  for (const match of text.matchAll(pattern)) spans.push({ text: (match[2] as string).replace(/\s*\n\s*/gu, " ").trim(), offset: match.index ?? 0 });
  return spans;
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) if (text[index] === "\n") line += 1;
  return line;
}

export function examplesIn(file: string, markdown: string): Example[] {
  const examples: Example[] = [];
  const lines = markdown.split("\n");
  let prose: string[] = [];
  let proseStart = 1;
  const flushProse = () => {
    const text = prose.join("\n");
    for (const span of inlineSpans(text)) {
      if (/^ardia\s/u.test(span.text)) examples.push({ file, line: proseStart + lineAt(text, span.offset) - 1, text: span.text, batch: false });
    }
    prose = [];
  };
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as string;
    if (/^\s*```/u.test(line)) {
      flushProse();
      index += 1;
      while (index < lines.length && !/^\s*```/u.test(lines[index] as string)) {
        const code = (lines[index] as string).trim();
        const heredoc = HEREDOC.exec(code);
        if (code.startsWith("ardia ")) examples.push({ file, line: index + 1, text: code, batch: false });
        if (heredoc !== null) {
          const isBatch = code.startsWith("ardia ") && shellWords(code).slice(1).includes("batch");
          index += 1;
          while (index < lines.length && (lines[index] as string).trim() !== heredoc[1]) {
            const body = (lines[index] as string).trim();
            if (isBatch && body !== "" && !body.startsWith("#")) examples.push({ file, line: index + 1, text: body, batch: true });
            index += 1;
          }
        }
        index += 1;
      }
      index += 1;
      proseStart = index + 1;
      continue;
    }
    if (prose.length === 0) proseStart = index + 1;
    if (line.trim() === "") {
      flushProse();
      proseStart = index + 2;
    } else prose.push(line);
    index += 1;
  }
  flushProse();
  return examples;
}

export function checkExamples(files: readonly (readonly [string, string])[]): { examples: Example[]; problems: Problem[] } {
  const examples: Example[] = [];
  const problems: Problem[] = [];
  for (const [file, text] of files) {
    if (!file.endsWith(".md")) continue;
    for (const example of examplesIn(file, text)) {
      examples.push(example);
      const found = example.batch ? checkBrowse(shellWords(example.text)) : checkCommand(example.text);
      for (const problem of found) problems.push({ example, problem });
    }
  }
  return { examples, problems };
}
