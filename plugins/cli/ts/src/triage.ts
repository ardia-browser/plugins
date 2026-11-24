import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants, readSync, realpathSync, statSync } from "node:fs";
import { isatty } from "node:tty";
import { iso, now } from "./clock.ts";
import { dataRoot } from "./control.ts";
import type { Said } from "./deliver.ts";
import { object } from "./json.ts";
import { abspath, env, envSet, join, LINUX } from "./paths.ts";
import { writeAll } from "./printable.ts";
import { closeDir, writePrivate } from "./privatefs.ts";
import { utf8 } from "./pystr.ts";
import { shellJoin, shellQuote } from "./pystrings.ts";
import { systemInfo } from "./system-info.ts";
import { type Call, readConsent } from "./telemetry.ts";
import { ardiaRunning, collectEvidence, contextText, neverRead } from "./triage-evidence.ts";
import { fetchPlaybook } from "./triage-playbook.ts";
import {
  AGENT_ENV,
  consentSaved,
  forgetConsent,
  machineWord,
  makeSourceCache,
  MODE_ENV,
  newSession,
  openSessionPart,
  saveConsent,
  type Session,
  SESSION_ENV,
  sourceCache,
  triageHome,
  TriageRefused,
  writeSessionRecord,
} from "./triage-session.ts";
import { cliVersion } from "./version.ts";

export type TriageArgs = {
  what: string[];
  agent: string | undefined;
  model: string | undefined;
  yes: boolean;
  resetConsent: boolean;
  print: boolean;
  dataDir: string | undefined;
};

type Agent = { id: "claude" | "codex"; label: string };

const AGENTS: readonly Agent[] = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
];
const PROMPT = "Read playbook.md in this folder and follow it.";
const ONE_LINE = "Triage reads Ardia's version, settings, crash reports and local usage log and sends them to your agent's provider. --reset-consent shows the details.";
const HELP_TIMEOUT_MS = 5000;
const MAX_ANSWER = 64;
const ASKS = 3;

function flag(call: Call, name: string): void {
  call.metrics.set(name, true);
}

function say(text: string): void {
  writeAll(1, `${text}\n`);
}

function onPath(program: string): string | undefined {
  for (const folder of (env("PATH") ?? "").split(":")) {
    if (folder === "") continue;
    const candidate = join(folder, program);
    try {
      accessSync(candidate, fsConstants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return undefined;
}

function interactive(): boolean {
  return isatty(0) && isatty(1);
}

function readAnswer(): string | undefined {
  const bytes: number[] = [];
  const one = Buffer.alloc(1);
  for (;;) {
    let got: number;
    try {
      got = readSync(0, one, 0, 1, null);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EINTR" || code === "EAGAIN") continue;
      return undefined;
    }
    if (got === 0) return bytes.length > 0 ? Buffer.from(bytes).toString("utf8").trim() : undefined;
    if (one[0] === 0x0a) return Buffer.from(bytes).toString("utf8").trim();
    if (bytes.length < MAX_ANSWER) bytes.push(one[0] as number);
  }
}

function ask(question: string, read: (answer: string) => boolean | undefined): boolean | undefined {
  for (let attempt = 0; attempt < ASKS; attempt += 1) {
    writeAll(1, question);
    const answer = readAnswer();
    if (answer === undefined) {
      say("");
      return undefined;
    }
    const meant = read(answer.toLowerCase());
    if (meant !== undefined) return meant;
  }
  return undefined;
}

function pickAgent(args: TriageArgs): { agent: Agent | undefined; path: string | undefined } {
  if (args.agent !== undefined) {
    const agent = AGENTS.find((candidate) => candidate.id === args.agent);
    if (agent === undefined) throw new TriageRefused(`--agent takes claude or codex, not ${JSON.stringify(args.agent)}`);
    if (args.print) return { agent, path: undefined };
    const path = onPath(agent.id);
    if (path === undefined) throw new TriageRefused(`${agent.id} isn't on PATH; install ${agent.label}, or run ardia triage --print to use another agent`);
    return { agent, path };
  }
  if (args.print) return { agent: undefined, path: undefined };
  const installed = AGENTS.map((agent) => ({ agent, path: onPath(agent.id) })).filter((found): found is { agent: Agent; path: string } => found.path !== undefined);
  if (installed.length <= 1) return installed[0] ?? { agent: undefined, path: undefined };
  if (!interactive()) throw new TriageRefused("both claude and codex are installed and there's no terminal to ask which; pass --agent claude or --agent codex");
  const menu = installed.map((found, index) => `  ${index + 1}. ${found.agent.label}`).join("\n");
  let chosen: { agent: Agent; path: string } | undefined;
  const answered = ask(`Which agent should look into it?\n${menu}\n> `, (answer) => {
    const number = Number.parseInt(answer, 10);
    chosen = (String(number) === answer ? installed[number - 1] : undefined) ?? installed.find((found) => found.agent.id === answer);
    return chosen === undefined ? undefined : true;
  });
  if (answered === undefined || chosen === undefined) throw new TriageRefused("no agent was picked; pass --agent claude or --agent codex");
  return chosen;
}

function consentText(agent: Agent | undefined): string {
  const opening = agent === undefined ? "ardia triage gets a session ready for your coding agent to look into a problem\nwith Ardia." : `ardia triage starts ${agent.label} to look into a problem with Ardia.`;
  return [
    opening,
    "",
    "It reads:        Ardia's version and settings, crash reports, and the local",
    "                 usage log (counts and timings, no sites)",
    "It doesn't read: cookies, passwords, history, or what's on your pages",
    "Where it goes:   to the company behind the agent you pick, through your own",
    "                 account with them. None of it goes to Ardia.",
    `It asks before changing anything on ${machineWord()}, and nothing is posted`,
    "until you approve the exact text.",
    "",
  ].join("\n");
}

const CLOSING = "These are rules the agent is given, not a lock.";

function consent(home: string, args: TriageArgs, agent: Agent | undefined): boolean {
  if (args.resetConsent) forgetConsent(home);
  else if (consentSaved(home)) {
    say(ONE_LINE);
    return true;
  }
  if (args.yes) {
    say(`${consentText(agent)}\n${CLOSING} Continuing: --yes was given.`);
    return true;
  }
  if (!interactive()) throw new TriageRefused("ardia triage asks before it reads anything, and there's no terminal to ask on; read ardia triage --help and pass --yes to agree");
  const answer = ask(`${consentText(agent)}\n${CLOSING} Continue? [y/N] `, (text) => (text === "y" || text === "yes" ? true : text === "" || text === "n" || text === "no" ? false : undefined));
  if (answer !== true) return false;
  saveConsent(home);
  return true;
}

const CLAUDE_ASKS: readonly string[] = ["Bash(ardia triage file *)", "Bash(gh *)"];
const CLAUDE_DENIED_COMMANDS: readonly string[] = ["Bash(security *)", "Bash(secret-tool *)"];

function claudeSettings(root: string): string {
  const deny = [...neverRead(root).folders.map((folder) => `Read(/${folder}/**)`), ...CLAUDE_DENIED_COMMANDS];
  return JSON.stringify({ permissions: { deny, ask: CLAUDE_ASKS } });
}

function claudeAskFirstMode(path: string | undefined): string {
  if (path === undefined) return "manual";
  const help = spawnSync(path, ["--help"], { encoding: "utf8", timeout: HELP_TIMEOUT_MS, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"] }).stdout ?? "";
  return help.includes('"default"') && !help.includes('"manual"') ? "default" : "manual";
}

function launchArgs(agent: Agent, path: string | undefined, prompt: string, model: string | undefined, root: string, cache: string): string[] {
  const chosenModel = model === undefined ? [] : agent.id === "claude" ? ["--model", model] : ["-m", model];
  if (agent.id === "claude") return ["--permission-mode", claudeAskFirstMode(path), "--settings", claudeSettings(root), ...chosenModel, prompt];
  return ["--sandbox", "workspace-write", "--ask-for-approval", "on-request", "--add-dir", cache, ...chosenModel, prompt];
}

function promptFor(description: string | undefined): string {
  return description === undefined ? PROMPT : `${PROMPT} What went wrong, in the user's words: ${description}`;
}

function resolved(path: string): string {
  let rest = "";
  let current = path;
  for (;;) {
    try {
      return `${realpathSync(current)}${rest}`;
    } catch {
      const cut = current.lastIndexOf("/");
      if (cut <= 0) return path;
      rest = `${current.slice(cut)}${rest}`;
      current = current.slice(0, cut);
    }
  }
}

function sessionEnv(session: Session, args: TriageArgs): Record<string, string> {
  const extra: Record<string, string> = { [MODE_ENV]: "1", [SESSION_ENV]: session.dir };
  if (envSet("ARDIA_CLI_HOME") !== undefined) extra.ARDIA_CLI_HOME = session.home;
  const dataDir = args.dataDir ?? envSet("ARDIA_DATA_DIR");
  if (dataDir !== undefined) extra.ARDIA_DATA_DIR = abspath(dataRoot(dataDir));
  return extra;
}

function sessionLines(session: Session, args: TriageArgs, prompt: string, agent: Agent | undefined, path: string | undefined): string[] {
  const variables = Object.entries(sessionEnv(session, args)).map(([name, value]) => `${name}=${shellQuote(value)}`).join(" ");
  const agentCommand =
    agent === undefined ? "<your agent, in its ask-first mode>" : shellJoin([agent.id, ...launchArgs(agent, path, prompt, args.model, abspath(dataRoot(args.dataDir)), sourceCache(session.home))]);
  return [
    `Session folder: ${session.dir}`,
    "  context.md   the facts about this install and the files never to read",
    "  evidence/    what was collected, scrubbed (evidence/README.md lists it)",
    "  playbook.md  what the agent follows",
    "",
    "Start a coding agent in that folder with this prompt:",
    `  ${prompt}`,
    "",
    "and these variables, so ardia knows it's a triage session:",
    `  cd ${shellQuote(session.dir)} && ${variables} ${agentCommand}`,
  ];
}

function launch(path: string, args: string[], cwd: string, extra: Record<string, string>): Promise<number | Error> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(path, args, { cwd, stdio: "inherit", env: { ...process.env, ...extra } });
    } catch (error) {
      resolve(error as Error);
      return;
    }
    child.once("error", (error) => resolve(error));
    child.once("exit", (code, signal) => resolve(code ?? (signal === null ? 0 : 1)));
  });
}

async function prepareSession(home: string, args: TriageArgs, agent: Agent | undefined, description: string | undefined): Promise<Session> {
  const root = abspath(dataRoot(args.dataDir));
  const realHome = resolved(home);
  const inside = neverRead(root).folders.find((folder) => realHome === resolved(folder) || realHome.startsWith(`${resolved(folder)}/`));
  if (inside !== undefined) throw new TriageRefused(`the ardia command keeps its files in ${home}, inside ${inside}, which triage keeps the agent out of; set ARDIA_CLI_HOME to a folder somewhere else`);
  const session = newSession(home);
  makeSourceCache(home);
  const evidenceDir = openSessionPart(session, ["evidence"]);
  let collected;
  try {
    collected = collectEvidence(evidenceDir, root, args.dataDir);
  } finally {
    closeDir(evidenceDir);
  }
  const [playbook, running] = await Promise.all([fetchPlaybook(), ardiaRunning(root)]);
  const info = systemInfo();
  const top = openSessionPart(session, []);
  try {
    writePrivate("playbook.md", top, utf8(playbook.text));
    writePrivate(
      "context.md",
      top,
      utf8(
        contextText({
          description,
          consent: readConsent(root),
          cliVersion: cliVersion(),
          os: info.os,
          osVersion: info.osVersion,
          arch: info.arch,
          running,
          dataRoot: root,
          sourceCache: sourceCache(home),
          agent: agent === undefined ? "none picked: the user starts one by hand" : `${agent.label} (${agent.id})`,
          playbook: playbook.source,
          linux: LINUX,
          evidence: collected,
        }),
      ),
    );
  } finally {
    closeDir(top);
  }
  writeSessionRecord(
    session,
    object([
      ["agent", agent?.id ?? "none"],
      ["model", args.model ?? null],
      ["cli_version", cliVersion()],
      ["created_at", iso(now())],
      ["data_dir", args.dataDir !== undefined || envSet("ARDIA_DATA_DIR") !== undefined ? root : null],
      ["data_root", root],
      ["playbook", playbook.source],
    ]),
  );
  return session;
}

export async function runTriage(args: TriageArgs, call: Call): Promise<Said> {
  try {
    return await triage(args, call);
  } catch (error) {
    if (error instanceof TriageRefused) return { status: error.status, out: [], err: [`ardia triage: ${error.message}`] };
    throw error;
  }
}

async function triage(args: TriageArgs, call: Call): Promise<Said> {
  const home = triageHome();
  const { agent, path } = pickAgent(args);
  flag(call, `triage_agent_${agent === undefined || args.print ? "none" : agent.id}`);
  if (!consent(home, args, agent)) {
    flag(call, "triage_declined");
    return { status: 1, out: ["Nothing was collected. Run ardia triage again whenever you like."], err: [] };
  }
  const description = args.what.join(" ").trim() || undefined;
  const session = await prepareSession(home, args, agent, description);
  const prompt = promptFor(description);
  if (agent === undefined || path === undefined || args.print) {
    flag(call, "triage_printed");
    const lead = args.print ? [] : ["Neither claude nor codex is on PATH, so no agent was started.", ""];
    return { status: 0, out: [...lead, ...sessionLines(session, args, prompt, agent, path)], err: [] };
  }
  const extra: Record<string, string> = { ...sessionEnv(session, args), [AGENT_ENV]: agent.id };
  say(`Starting ${agent.label} in ${session.dir}. It will ask what went wrong.\n`);
  flag(call, "triage_launched");
  const ended = await launch(path, launchArgs(agent, path, prompt, args.model, abspath(dataRoot(args.dataDir)), sourceCache(home)), session.dir, extra);
  if (typeof ended === "number" && ended === 0) return { status: 0, out: [], err: [] };
  const why = typeof ended === "number" ? `${agent.label} exited with code ${ended}.` : `${agent.label} couldn't be started (${ended.message}).`;
  return { status: typeof ended === "number" ? ended : 1, out: ["", why, "", ...sessionLines(session, args, prompt, agent, path)], err: [] };
}
