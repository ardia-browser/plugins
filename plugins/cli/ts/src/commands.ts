import { arrange, leafTokens, optionNames, parse, type Parsed, type Spec, TOP_FLAGS } from "./argv.ts";
import { EVENTS_SPEC, RUN_SPEC, runEvents, runRun } from "./automation-cli.ts";
import { CALL_FLAGS, CALL_SPEC, family, METHODS_SPEC, runCall, runMethods } from "./call-cli.ts";
import type { Command, Context } from "./runner.ts";
import { APPLY_SPEC, GROUP_SPECS, GROUP_VERBS, runApply, runGroupsVerb, runTabsVerb, TAB_SPECS, TAB_VERBS } from "./workspace-cli.ts";

const TABS_FLAGS = ["-h", "--help", "--data-dir", "--json", "--window", "--profile", "--flat", "--usage", "--pid"];
const GROUPS_FLAGS = ["-h", "--help", "--data-dir", "--json", "--window", "--profile"];

const TREE = new Map<string, readonly string[] | undefined>([
  ["call", undefined],
  ["methods", undefined],
  ["run", undefined],
  ["events", undefined],
  ["apply", undefined],
  ["tabs", TAB_VERBS],
  ["groups", GROUP_VERBS],
]);

const LEAVES: Record<string, Spec> = { call: CALL_SPEC, methods: METHODS_SPEC, run: RUN_SPEC, events: EVENTS_SPEC, apply: APPLY_SPEC };

export type CommandRoute = { label: string; dataDir: string | undefined; command: Command };

function specOf(path: string[]): Spec | undefined {
  const [head, verb] = path;
  if (head === "tabs") return TAB_SPECS[verb ?? ""];
  if (head === "groups") return GROUP_SPECS[verb ?? ""];
  return LEAVES[head ?? ""];
}

function parentFlags(head: string): string[] {
  if (head === "tabs") return TABS_FLAGS;
  return head === "groups" ? GROUPS_FLAGS : [];
}

function runnerOf(path: string[]): (context: Context, parsed: Parsed) => Promise<number> {
  const [head, verb = ""] = path;
  switch (head) {
    case "call":
      return runCall;
    case "methods":
      return runMethods;
    case "run":
      return runRun;
    case "events":
      return runEvents;
    case "apply":
      return runApply;
    case "tabs":
      return (context, parsed) => runTabsVerb(context, verb, parsed);
    default:
      return (context, parsed) => runGroupsVerb(context, verb, parsed);
  }
}

export function parseCommand(argv: string[]): CommandRoute | undefined {
  if (argv.includes("--")) return undefined;
  const arranged = arrange(argv, TREE);
  if (arranged === undefined) return undefined;
  const spec = specOf(arranged.path);
  if (spec === undefined) return undefined;
  const tokens = leafTokens(arranged, spec);
  if (tokens === undefined) return undefined;
  const parsed = parse(tokens, spec);
  if (parsed === undefined) return undefined;
  const [head = "", verb] = arranged.path;
  const isCall = head === "call";
  const run = runnerOf(arranged.path);
  const command: Command = {
    command: head,
    subcommand: isCall ? family(parsed.values.get("method") as string) : verb,
    allowedFlags: isCall ? CALL_FLAGS : [...TOP_FLAGS, ...parentFlags(head), ...optionNames(spec)],
    topWord: head,
    json: argv.includes("--json"),
    run: (context) => run(context, parsed),
  };
  return { label: isCall ? "call *" : arranged.path.join(" "), dataDir: parsed.values.get("data_dir"), command };
}
