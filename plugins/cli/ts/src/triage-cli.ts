import type { Said } from "./deliver.ts";
import type { Call } from "./telemetry.ts";

type Options = { values: readonly string[]; flags: readonly string[]; positional: boolean };
type Read = { values: Map<string, string>; flags: Set<string>; words: string[] } | { problem: string };

const TRIAGE_OPTIONS: Options = { values: ["--agent", "--model", "--data-dir"], flags: ["--yes", "--reset-consent", "--print"], positional: true };
const FILE_OPTIONS: Options = { values: ["--title", "--body", "--post", "--via", "--comment-on", "--session"], flags: ["--attach-evidence"], positional: false };
const HELP_FLAGS = ["-h", "--help"];

export const TRIAGE_HELP = `usage: ardia triage [WHAT WENT WRONG ...] [--agent claude|codex] [--model M] [--yes]
                    [--reset-consent] [--print] [--data-dir DIR]
       ardia triage file --title "..." --body FILE
       ardia triage file --post CODE [--via gh|form|feedback] [--attach-evidence]
                         [--comment-on N]

Look into a problem with Ardia with your own coding agent. ardia triage asks once
what it may read, collects scrubbed evidence (Ardia's version and settings, crash
reports and the local usage log) into a private session folder, and starts
Claude Code or Codex there with a playbook. The agent investigates and drafts a
report; ardia triage file scrubs it, shows the exact text and files it only with
--post and the code it printed. The agent's rules are guard rails, not a lock.

options:
  WHAT WENT WRONG      the problem in your words, given to the agent
  --agent claude|codex the agent to start (default: the one installed, or ask)
  --model M            the model the agent uses
  --yes                agree to what triage reads without being asked
  --reset-consent      forget the saved yes and ask again
  --print              start no agent: print the session folder and the prompt
  --data-dir DIR       the Ardia data dir to look at ($ARDIA_DATA_DIR)

ardia triage file (inside a session):
  --title T            the issue title, 1-67 characters
  --body FILE          the report, in the playbook's ## sections
  --post CODE          file the prepared report: gh when signed in, else the form
  --via gh|form|feedback  file it this way instead
  --attach-evidence    with --via feedback, also send the evidence files
  --comment-on N       add it to open issue N instead of opening a new one
  --session DIR        the session folder ($ARDIA_TRIAGE_SESSION)
`;

function readTokens(tokens: readonly string[], options: Options): Read {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const words: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (token === "--") {
      if (!options.positional && index + 1 < tokens.length) return { problem: `unexpected words: ${tokens.slice(index + 1).join(" ")}` };
      words.push(...tokens.slice(index + 1));
      break;
    }
    if (!token.startsWith("-") || token === "-") {
      if (!options.positional) return { problem: `unexpected word: ${token}` };
      words.push(token);
      continue;
    }
    if (HELP_FLAGS.includes(token)) {
      flags.add("--help");
      continue;
    }
    const equals = token.indexOf("=");
    const name = equals < 0 ? token : token.slice(0, equals);
    if (options.flags.includes(name)) {
      if (equals >= 0) return { problem: `${name} doesn't take a value` };
      flags.add(name);
      continue;
    }
    if (options.values.includes(name)) {
      if (values.has(name)) return { problem: `${name} is given twice` };
      const value = equals >= 0 ? token.slice(equals + 1) : tokens[index + 1];
      if (value === undefined || (equals < 0 && value.startsWith("--"))) return { problem: `${name} needs a value` };
      values.set(name, value);
      if (equals < 0) index += 1;
      continue;
    }
    return { problem: `unrecognized option ${name}` };
  }
  return { values, flags, words };
}

function usage(call: Call, problem: string): Said {
  call.noteErrorCode("usage_error");
  return { status: 2, out: [], err: [`ardia triage: ${problem} (see ardia triage --help)`] };
}

function help(): Said {
  return { status: 0, out: TRIAGE_HELP.replace(/\n$/, "").split("\n"), err: [] };
}

export async function runTriageCommand(tokens: string[], call: Call): Promise<Said> {
  const read = readTokens(tokens, TRIAGE_OPTIONS);
  if ("problem" in read) return usage(call, read.problem);
  if (read.flags.has("--help")) return help();
  const { runTriage } = await import("./triage.ts");
  return runTriage(
    {
      what: read.words,
      agent: read.values.get("--agent"),
      model: read.values.get("--model"),
      yes: read.flags.has("--yes"),
      resetConsent: read.flags.has("--reset-consent"),
      print: read.flags.has("--print"),
      dataDir: read.values.get("--data-dir"),
    },
    call,
  );
}

export async function runTriageFileCommand(tokens: string[], call: Call): Promise<Said> {
  call.subcommand = "file";
  const read = readTokens(tokens, FILE_OPTIONS);
  if ("problem" in read) return usage(call, read.problem);
  if (read.flags.has("--help")) return help();
  const { runTriageFile } = await import("./triage-file.ts");
  return runTriageFile(
    {
      title: read.values.get("--title"),
      body: read.values.get("--body"),
      post: read.values.get("--post"),
      via: read.values.get("--via"),
      attachEvidence: read.flags.has("--attach-evidence"),
      commentOn: read.values.get("--comment-on"),
      session: read.values.get("--session"),
    },
    call,
  );
}
