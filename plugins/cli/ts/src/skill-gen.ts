import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SKIPPED } from "./browse/daemon/names.ts";
import { commandHelp } from "./browse/help.ts";
import { ERROR_CODES } from "./browse/remedies.ts";
import { ALIASES, KNOWN_COMMANDS } from "./browse/tables.ts";

export const SKILL_COMMANDS_HEADING = "## Commands";
export const ERROR_CODES_HEADING = "## Error codes";
export const COMMANDS_FILE = "references/commands.md";
const NOT_COMMANDS = new Set(["help", "version"]);

export function browseCommands(): string[] {
  return KNOWN_COMMANDS.filter((name) => !Object.hasOwn(SKIPPED, name) && !Object.hasOwn(ALIASES, name) && !NOT_COMMANDS.has(name)).sort();
}

export function aliasesOf(name: string): string[] {
  return Object.entries(ALIASES)
    .filter(([alias, target]) => target === name && KNOWN_COMMANDS.includes(alias))
    .map(([alias]) => alias)
    .sort();
}

export function synopsis(name: string): string[] {
  const help = commandHelp(name);
  const usage: string[] = [];
  for (const line of help.split("\n")) {
    if (line.trim() === "" || line === "flags: none") break;
    usage.push(line.trim());
  }
  return usage.map((line) => ownForm(name, line));
}

function ownForm(name: string, line: string): string {
  const prefix = "ardia browse ";
  if (!line.startsWith(prefix) || line.startsWith(`${prefix}${name}`)) return line;
  const parts = line.slice(prefix.length).split(/,\s+|\s+\|\s+/u);
  const own = parts.filter((part) => part === name || part.startsWith(`${name} `));
  return own.length > 0 ? own.map((part) => `${prefix}${part}`).join(" | ") : line;
}

export function commandReference(): string {
  const lines = [
    "# ardia browse commands",
    "",
    "Every command and its forms, from the ardia command's own help: `ardia browse <command> --help` prints the whole",
    "entry. Generated from that help and the command table by `bun src/skill-gen.ts --write` in plugins/cli/ts.",
    "",
  ];
  for (const name of browseCommands()) {
    const forms = synopsis(name);
    const aliases = aliasesOf(name);
    lines.push(`- **${name}**${aliases.length > 0 ? ` (also ${aliases.join(", ")})` : ""}: ${forms.map((form) => `\`${form}\``).join(" · ")}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function skillIndex(): string {
  const aliases = new Map<string, string[]>();
  for (const [alias, target] of Object.entries(ALIASES)) {
    if (!KNOWN_COMMANDS.includes(alias) || !KNOWN_COMMANDS.includes(target)) continue;
    aliases.set(target, [...(aliases.get(target) ?? []), alias].sort());
  }
  const aliasText = [...aliases.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([target, names]) => `${names.join(", ")} = ${target}`)
    .join("; ");
  return [
    SKILL_COMMANDS_HEADING,
    "",
    `\`ardia browse\` takes ${browseCommands().join(", ")}.`,
    `Aliases: ${aliasText}. Every form and flag: \`references/commands.md\`.`,
    "",
    "A mistyped command or flag names the closest one. A failure ends with its stable `(code)`, and when one command fixes",
    "it, a `remedy:` line with that command (`--json`: `code` and `remedy`); `references/troubleshooting.md` lists the codes.",
    "",
  ].join("\n");
}

export function errorCodeTable(): string {
  const rows = Object.entries(ERROR_CODES)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([code, help]) => `| \`${code}\` | ${help.means} | ${help.remedy === undefined ? "" : `\`${help.remedy.replaceAll("{command}", "<command>")}\``} |`);
  return [
    ERROR_CODES_HEADING,
    "",
    "A failure's last word is its code in brackets, `(stale_ref)`; `--json` puts it in `code`. When one command fixes it, the",
    "next line is `remedy: <command>` (`--json`: `remedy`): run it. Other codes are the page's or the site's: read the message.",
    "",
    "| code | means | remedy |",
    "| --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

export function replaceSection(text: string, heading: string, section: string): string {
  const marker = `\n${heading}\n`;
  const at = text.indexOf(marker);
  const head = at < 0 ? `${text.replace(/\n*$/u, "")}\n` : text.slice(0, at + 1);
  return `${head}\n${section}`.replace(/\n\n\n+/gu, "\n\n").replace(/^\n/u, "");
}

export function generated(current: ReadonlyMap<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  const skill = current.get("SKILL.md");
  if (skill !== undefined) out.set("SKILL.md", replaceSection(skill, SKILL_COMMANDS_HEADING, skillIndex()));
  const troubleshooting = current.get("references/troubleshooting.md");
  if (troubleshooting !== undefined) out.set("references/troubleshooting.md", replaceSection(troubleshooting, ERROR_CODES_HEADING, errorCodeTable()));
  out.set(COMMANDS_FILE, commandReference());
  return out;
}

export function skillFolder(): string {
  return path.resolve(import.meta.dir, "..", "assets", "skill");
}

function readFolder(folder: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.set(path.relative(folder, full).split(path.sep).join("/"), readFileSync(full, "utf8"));
    }
  };
  walk(folder);
  return files;
}

export function stale(folder = skillFolder()): string[] {
  const current = readFolder(folder);
  return [...generated(current)].filter(([name, text]) => current.get(name) !== text).map(([name]) => name);
}

function main(argv: readonly string[]): number {
  const folder = skillFolder();
  if (argv.includes("--write")) {
    for (const [name, text] of generated(readFolder(folder))) writeFileSync(path.join(folder, name), text, "utf8");
    return 0;
  }
  const behind = stale(folder);
  if (behind.length === 0) return 0;
  process.stderr.write(`skill-gen: ${behind.join(", ")} differ from the command registry; run \`bun src/skill-gen.ts --write\` in plugins/cli/ts\n`);
  return 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
