import { arrange, type CommandSpec, optionNames, type Parsed, parseStrict, SHARED_VALUE_FLAGS } from "./cmdline.ts";
import { cleanNumber } from "./command-metrics.ts";
import type { Lines } from "./skills.ts";
import type { Said } from "./deliver.ts";
import type { Call } from "./telemetry.ts";

export type CommandRoute = {
  label: string;
  command: string;
  subcommand?: string;
  allowedFlags: string[];
  usage?: string;
  run?: (call: Call) => Promise<Said>;
  json: boolean;
};

export const FEEDBACK_SPEC: CommandSpec = {
  options: [
    { name: "--title", dest: "title", kind: "value" },
    { name: "--kind", dest: "kind", kind: "value", choices: ["bug", "slow", "idea", "other"] },
    { name: "--attach", dest: "attach", kind: "append" },
    { name: "--command", dest: "about", kind: "value" },
    { name: "--data-dir", dest: "data_dir", kind: "value" },
  ],
  positional: "text",
};

function text(parsed: Parsed, key: string): string | undefined {
  const value = parsed.get(key);
  return typeof value === "string" ? value : undefined;
}

function list(parsed: Parsed, key: string): string[] {
  const value = parsed.get(key);
  return Array.isArray(value) ? value : [];
}

function jsonRequested(argv: readonly string[]): boolean {
  const end = argv.indexOf("--");
  return (end < 0 ? argv : argv.slice(0, end)).includes("--json");
}

type Entry = {
  path: string[];
  spec: CommandSpec;
  run: (parsed: Parsed, call: Call) => Promise<Said>;
};

const ENTRIES: Entry[] = [
  {
    path: ["feedback"],
    spec: FEEDBACK_SPEC,
    run: async (parsed) => {
      const { runFeedback } = await import("./feedback.ts");
      return runFeedback({
        text: list(parsed, "text"),
        title: text(parsed, "title"),
        kind: text(parsed, "kind") ?? "bug",
        attach: list(parsed, "attach"),
        about: text(parsed, "about"),
        dataDir: text(parsed, "data_dir"),
      });
    },
  },
];

function skillsSaid(lines: Lines, call: Call): Said {
  if (lines.outputChars !== undefined) for (const [key, value] of cleanNumber("output_chars", lines.outputChars)) call.metrics.set(key, value);
  for (const [name, count] of lines.counts ?? []) for (const [key, value] of cleanNumber(name, count)) call.metrics.set(key, value);
  return { status: lines.status, out: lines.out, err: [] };
}

export const SKILLS_INSTALL_SPEC: CommandSpec = {
  options: [
    { name: "--target", dest: "target", kind: "append", choices: ["claude-code", "codex", "cursor", "general", "opencode"] },
    { name: "--project", dest: "project", kind: "flag" },
    { name: "--no-cua", dest: "no_cua", kind: "flag" },
    { name: "--replace", dest: "replace", kind: "flag" },
    { name: "--auto", dest: "auto", kind: "flag" },
  ],
};

ENTRIES.push(
  {
    path: ["skills", "install"],
    spec: SKILLS_INSTALL_SPEC,
    run: async (parsed, call) => {
      const skills = await import("./skills.ts");
      const computerUse = parsed.get("no_cua") !== true;
      if (parsed.get("auto") === true) return skillsSaid(await skills.installDetected(computerUse), call);
      const targets = list(parsed, "target");
      return skillsSaid(await skills.install(targets.length > 0 ? targets : ["general"], parsed.get("project") === true, computerUse, parsed.get("replace") === true), call);
    },
  },
  {
    path: ["skills", "refresh"],
    spec: { options: [] },
    run: async (_parsed, call) => skillsSaid(await (await import("./skills.ts")).refresh(), call),
  },
  {
    path: ["skills", "get"],
    spec: { options: [{ name: "--full", dest: "full", kind: "flag" }] },
    run: async (parsed, call) => {
      const printed = (await import("./skills.ts")).printSkill(parsed.get("full") === true);
      return { ...skillsSaid(printed, call), raw: printed.raw };
    },
  },
  {
    path: ["skills", "list"],
    spec: { options: [] },
    run: async (_parsed, call) => skillsSaid((await import("./skills.ts")).listSkills(), call),
  },
);

function withSkillFlag(argv: readonly string[]): readonly string[] {
  let index = 0;
  while (index < argv.length) {
    const token = argv[index] as string;
    const name = token.split("=")[0] as string;
    if (SHARED_VALUE_FLAGS.includes(name)) index += token.includes("=") ? 1 : 2;
    else if (token === "--json") index += 1;
    else break;
  }
  if (argv[index] !== "--skill") return argv;
  return [...argv.slice(0, index), "skills", "get", ...argv.slice(index + 1)];
}

export function registerEntries(more: Entry[]): void {
  ENTRIES.push(...more);
}

export function commandRoute(given: readonly string[]): CommandRoute | undefined {
  const argv = withSkillFlag(given);
  for (const entry of ENTRIES) {
    const allowedFlags = optionNames(entry.spec);
    const arranged = arrange(argv, entry.path, allowedFlags);
    if (arranged === undefined) continue;
    const [command, subcommand] = entry.path as [string, string | undefined];
    const base = { label: entry.path.join(" "), command, allowedFlags, json: jsonRequested(given) };
    const named = subcommand === undefined ? base : { ...base, subcommand };
    if (arranged.kind === "usage") {
      if (arranged.message.endsWith("needs a value")) return undefined;
      return { ...named, usage: arranged.message };
    }
    const parsed = parseStrict([...arranged.hoisted, ...arranged.rest], entry.spec);
    if (parsed === undefined) return undefined;
    return { ...named, run: (call: Call) => entry.run(parsed, call) };
  }
  return undefined;
}
