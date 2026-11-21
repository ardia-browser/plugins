import { arrange, type CommandSpec, optionNames, type Parsed, parseStrict } from "./cmdline.ts";
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

export function registerEntries(more: Entry[]): void {
  ENTRIES.push(...more);
}

export function commandRoute(argv: readonly string[]): CommandRoute | undefined {
  for (const entry of ENTRIES) {
    const allowedFlags = optionNames(entry.spec);
    const arranged = arrange(argv, entry.path, allowedFlags);
    if (arranged === undefined) continue;
    const [command, subcommand] = entry.path as [string, string | undefined];
    const base = { label: entry.path.join(" "), command, allowedFlags, json: jsonRequested(argv) };
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
