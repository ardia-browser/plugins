import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";
import { homeNameSegments, hostOnlyUrls, triageScrub } from "../src/triage-scrub.ts";
import { buildReport, formUrl, parseSections } from "../src/triage-report.ts";
import { newestReleaseTag } from "../src/triage-playbook.ts";
import { allowedInTriage } from "../src/triage-mode.ts";
import { looksLikeArdia } from "../src/triage-evidence.ts";

const TS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROGRAM = process.env.ARDIA_TS_CLI ?? path.join(TS, "dist", "ardia-ts");
const BUNDLED = fs.readFileSync(path.join(TS, "assets", "triage-playbook.md"), "utf8");
const MAC = process.platform === "darwin";
const RUN_TIMEOUT_MS = 30_000;

const SECRET = ["ghp", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_");
const API_KEY = ["sk", "livekeyabcdefghijklmnop"].join("-");
const EMAIL = "someone.private@example.org";
const URL_PATH = "/inbox/8812/thread";
const URL_QUERY = "q=bankstatement";
const TODAY = new Date().toISOString().slice(0, 10);

type Sandbox = { root: string; bin: string; tools: string; home: string; cli: string; data: string; record: string };
const TOOLS = ["sh", "ls", "grep", "env", "sort", "pwd", "cp", "cat", "printf"];
type Ran = { status: number | null; out: string; err: string };

function sandbox(): Sandbox {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ardia-triage-")));
  const box = { root, bin: path.join(root, "bin"), tools: path.join(root, "tools"), home: path.join(root, "home", "alice"), cli: path.join(root, "cli"), data: path.join(root, "data"), record: path.join(root, "record") };
  for (const dir of [box.bin, box.tools, box.home, box.data, box.record]) fs.mkdirSync(dir, { recursive: true });
  for (const tool of TOOLS) {
    const found = ["/bin", "/usr/bin"].map((folder) => path.join(folder, tool)).find((candidate) => fs.existsSync(candidate));
    if (found !== undefined) fs.symlinkSync(found, path.join(box.tools, tool));
  }
  return box;
}

function cleanup(box: Sandbox): void {
  fs.rmSync(box.root, { recursive: true, force: true });
}

function standIn(box: Sandbox, name: string, body = ""): void {
  const script = `#!${box.tools}/sh
case "$1" in --help) printf '%s\\n' "\${STANDIN_HELP:-}"; exit 0;; esac
n=$(ls "${box.record}" | grep -c "^${name}\\.[0-9]*\\.argv$")
out="${box.record}/${name}.$n"
for a in "$@"; do printf '%s\\n----\\n' "$a"; done > "$out.argv"
env | grep '^ARDIA_' | sort > "$out.env"
pwd > "$out.cwd"
${body}
exit \${STANDIN_EXIT:-0}
`;
  const file = path.join(box.bin, name);
  fs.writeFileSync(file, script);
  fs.chmodSync(file, 0o755);
}

function ghStandIn(box: Sandbox): void {
  standIn(
    box,
    "gh",
    `case "$1 $2" in
"auth status") exit \${GH_AUTH:-0};;
esac
for a in "$@"; do case "$a" in body=@*) cp "\${a#body=@}" "$out.body";; title=@*) cp "\${a#title=@}" "$out.title";; esac; done
case "$*" in
*"--jq .node_id"*) echo R_kgTest; exit 0;;
*graphql*) echo '{"data":{"createIssue":{"issue":{"url":"https://github.com/test/repo/issues/41","labels":{"nodes":[{"name":"via-triage"}]}}}}}'; exit 0;;
*"/comments"*) echo '{"html_url":"https://github.com/test/repo/issues/12#issuecomment-1"}'; exit 0;;
*"issues/12"*) echo "{\\"number\\":12,\\"state\\":\\"\${GH_ISSUE_STATE:-open}\\"}"; exit 0;;
esac
exit 1`,
  );
}

function args(box: Sandbox, name: string, index = 0): string[] {
  const text = fs.readFileSync(path.join(box.record, `${name}.${index}.argv`), "utf8");
  return text.split("\n----\n").slice(0, -1);
}

function recorded(box: Sandbox, name: string): number {
  return fs.readdirSync(box.record).filter((file) => file.startsWith(`${name}.`) && file.endsWith(".argv")).length;
}

function baseEnv(box: Sandbox, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: `${box.bin}:${box.tools}`,
    HOME: box.home,
    ARDIA_CLI_HOME: box.cli,
    ARDIA_DATA_DIR: box.data,
    XDG_STATE_HOME: path.join(box.home, ".local", "state"),
    ARDIA_TRIAGE_REPO: "test/repo",
    LANG: "C.UTF-8",
    ...extra,
  };
}

function run(box: Sandbox, argv: string[], extra: Record<string, string> = {}, input?: string, cwd = box.root): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(PROGRAM, argv, { cwd, env: baseEnv(box, extra), stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk) => (out += chunk));
    child.stderr?.on("data", (chunk) => (err += chunk));
    if (input !== undefined) child.stdin?.end(input);
    const timer = setTimeout(() => child.kill("SIGKILL"), RUN_TIMEOUT_MS);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, out, err });
    });
  });
}

function shellQuote(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`;
}

function onTerminal(box: Sandbox, argv: string[], answers: string, extra: Record<string, string> = {}): Promise<Ran> {
  const command = [PROGRAM, ...argv].map(shellQuote).join(" ");
  const wrapper = MAC ? ["/usr/bin/script", ["-q", "/dev/null", "/bin/sh", "-c", command]] : ["/usr/bin/script", ["-qec", command, "/dev/null"]];
  return new Promise((resolve) => {
    const child = spawn(wrapper[0] as string, wrapper[1] as string[], { cwd: box.root, env: baseEnv(box, extra), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout?.on("data", (chunk) => (out += chunk));
    child.stderr?.on("data", (chunk) => (out += chunk));
    child.stdin?.write(answers);
    const timer = setTimeout(() => child.kill("SIGKILL"), RUN_TIMEOUT_MS);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, out: out.replaceAll("\r", ""), err: "" });
    });
  });
}

function triageDir(box: Sandbox): string {
  return path.join(box.cli, "triage");
}

function sessions(box: Sandbox): string[] {
  if (!fs.existsSync(triageDir(box))) return [];
  return fs.readdirSync(triageDir(box)).filter((name) => /^\d{4}-/.test(name)).map((name) => path.join(triageDir(box), name));
}

function plantEvidence(box: Sandbox): void {
  const local = path.join(box.data, "Telemetry", "local");
  fs.mkdirSync(local, { recursive: true });
  const event = { event: "page_failed", token: SECRET, contact: EMAIL, file: `${box.home}/Downloads/statement.pdf`, link: `https://mail.example.org${URL_PATH}?${URL_QUERY}` };
  fs.writeFileSync(path.join(local, `${TODAY}.jsonl`), `${JSON.stringify(event)}\n`);
  fs.writeFileSync(path.join(local, `cli-${TODAY}.jsonl`), `${JSON.stringify({ event: "cli_command", api_key: API_KEY })}\n`);
  fs.writeFileSync(path.join(local, "2000-01-01.jsonl"), `${JSON.stringify({ event: "long_ago" })}\n`);
  fs.writeFileSync(path.join(local, `${new Date(Date.now() - 9 * 86400000).toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify({ event: "nine_days_ago" })}\n`);
  fs.writeFileSync(path.join(local, "2099-01-01.jsonl"), `${JSON.stringify({ event: "far_future" })}\n`);
  const config = MAC ? path.join(box.home, ".config", "ardia") : path.join(box.data, "config");
  fs.mkdirSync(config, { recursive: true });
  fs.mkdirSync(path.join(box.data, "config"), { recursive: true });
  for (const folder of new Set([config, path.join(box.data, "config")])) {
    fs.writeFileSync(path.join(folder, "config.json"), JSON.stringify({ theme: "nord", homepage: `https://start.example.org${URL_PATH}?${URL_QUERY}` }));
  }
  const logs = MAC ? path.join(box.home, "Library", "Logs", "Ardia") : path.join(box.home, ".local", "state", "ardia");
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, "hooks.log"), `hook ran for ${EMAIL} at https://bank.example.org${URL_PATH}?${URL_QUERY}\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz123456\n`);
  fs.writeFileSync(path.join(box.data, "telemetry.json"), JSON.stringify({ lastVersion: "0.2.48", lastBuild: "512", channel: "nightly" }));
}

function evidenceText(session: string): string {
  const folder = path.join(session, "evidence");
  return fs.readdirSync(folder).map((name) => fs.readFileSync(path.join(folder, name), "utf8")).join("\n");
}

async function withServer(handler: (request: IncomingMessage, response: ServerResponse, body: Buffer) => void, work: (base: string, seen: string[]) => Promise<void>): Promise<void> {
  const seen: string[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      seen.push(`${request.method} ${request.url}`);
      handler(request, response, Buffer.concat(chunks));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await work(`http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`, seen);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const REPORT = `## What happened
The sidebar goes blank after the computer wakes. I was reading https://mail.example.org${URL_PATH}?${URL_QUERY} and my address is ${EMAIL}.

## Diagnosis
A guess: the sidebar store loses its window id. The log mentions ${SECRET} and /home/alice/notes.txt.

## Steps to reproduce
1. Open two windows
2. Sleep and wake

## Version
0.2.48, nightly

## Environment
Linux 6.8, x86_64

## Evidence
\`\`\`
sidebar: no window 3
\`\`\`
`;

async function preparedSession(box: Sandbox, report = REPORT, title = "Sidebar blank after wake with two windows"): Promise<{ session: string; code: string; prepared: Ran }> {
  const launched = await run(box, ["triage", "--print", "--yes"]);
  assert.equal(launched.status, 0, launched.err);
  const session = sessions(box)[0] as string;
  fs.writeFileSync(path.join(box.root, "report.md"), report);
  const prepared = await run(box, ["triage", "file", "--title", title, "--body", "report.md"], { ARDIA_TRIAGE: "1", ARDIA_TRIAGE_SESSION: session });
  const code = /^Code: ([0-9a-f]{8})$/m.exec(prepared.out)?.[1] ?? "";
  return { session, code, prepared };
}

function inSession(session: string, extra: Record<string, string> = {}): Record<string, string> {
  return { ARDIA_TRIAGE: "1", ARDIA_TRIAGE_SESSION: session, ...extra };
}

test("nothing is collected before consent, and no terminal without --yes is refused", async () => {
  const box = sandbox();
  try {
    plantEvidence(box);
    standIn(box, "claude");
    const ran = await run(box, ["triage", "the sidebar is blank"]);
    assert.equal(ran.status, 2, ran.out + ran.err);
    assert.match(ran.err, /pass --yes/);
    assert.equal(fs.existsSync(triageDir(box)), false);
    assert.equal(recorded(box, "claude"), 0);
  } finally {
    cleanup(box);
  }
});

test("a no on the terminal exits 1 having collected nothing", async () => {
  const box = sandbox();
  try {
    plantEvidence(box);
    standIn(box, "claude");
    const ran = await onTerminal(box, ["triage"], "n\n");
    assert.equal(ran.status, 1, ran.out);
    assert.match(ran.out, /It reads: {8}Ardia's version and settings/);
    assert.match(ran.out, /Continue\? \[y\/N\]/);
    assert.match(ran.out, /Nothing was collected/);
    assert.deepEqual(sessions(box), []);
    assert.equal(fs.existsSync(path.join(triageDir(box), "consent.json")), false);
    assert.equal(recorded(box, "claude"), 0);
  } finally {
    cleanup(box);
  }
});

test("a yes is saved: the next run prints one line, and --reset-consent asks again", async () => {
  const box = sandbox();
  try {
    standIn(box, "claude");
    const enter = await onTerminal(box, ["triage"], "\n");
    assert.equal(enter.status, 1, enter.out);
    assert.match(enter.out, /Nothing was collected/);
    assert.deepEqual(sessions(box), []);
    const first = await onTerminal(box, ["triage"], "y\n");
    assert.equal(first.status, 0, first.out);
    assert.match(first.out, MAC ? /changing anything on this Mac/ : /changing anything on this computer/);
    assert.equal(fs.statSync(path.join(triageDir(box), "consent.json")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(triageDir(box)).mode & 0o777, 0o700);
    const second = await run(box, ["triage"]);
    assert.equal(second.status, 0, second.err);
    assert.match(second.out, /^Triage reads Ardia's version, settings, crash reports and local usage log and sends them to your agent's provider\. --reset-consent shows the details\.$/m);
    assert.doesNotMatch(second.out, /It reads:/);
    assert.equal(recorded(box, "claude"), 2);
    const reset = await run(box, ["triage", "--reset-consent"]);
    assert.equal(reset.status, 2, reset.out);
    assert.equal(fs.existsSync(path.join(triageDir(box), "consent.json")), false);
    assert.equal(recorded(box, "claude"), 2);
  } finally {
    cleanup(box);
  }
});

test("claude starts in the session folder in ask-first mode with read-deny rules and the triage variables", async () => {
  const box = sandbox();
  try {
    standIn(box, "claude");
    const ran = await run(box, ["triage", "--yes", "--model", "opus", "tabs", "vanish"]);
    assert.equal(ran.status, 0, ran.err);
    const session = sessions(box)[0] as string;
    const argv = args(box, "claude");
    assert.deepEqual(argv.slice(0, 2), ["--permission-mode", "manual"]);
    assert.equal(argv[2], "--settings");
    const deny = JSON.parse(argv[3] as string).permissions.deny as string[];
    assert.ok(deny.includes(`Read(/${box.data}/**)`), deny.join(" "));
    assert.ok(deny.every((rule) => !rule.startsWith("Read(") || rule.startsWith("Read(//")));
    assert.ok(deny.includes("Bash(security *)") && deny.includes("Bash(secret-tool *)"));
    assert.deepEqual(JSON.parse(argv[3] as string).permissions.ask, ["Bash(ardia triage file *)", "Bash(gh *)"]);
    assert.deepEqual(argv.slice(4, 6), ["--model", "opus"]);
    assert.equal(argv[6], "Read playbook.md in this folder and follow it. What went wrong, in the user's words: tabs vanish");
    assert.equal(fs.readFileSync(path.join(box.record, "claude.0.cwd"), "utf8").trim(), session);
    const env = fs.readFileSync(path.join(box.record, "claude.0.env"), "utf8");
    assert.match(env, /^ARDIA_TRIAGE=1$/m);
    assert.match(env, new RegExp(`^ARDIA_TRIAGE_SESSION=${session}$`, "m"));
    assert.match(env, /^ARDIA_TRIAGE_AGENT=claude$/m);
    assert.equal(fs.statSync(session).mode & 0o777, 0o700);
    for (const name of ["context.md", "playbook.md", "session.json", "evidence/README.md"]) assert.ok(fs.existsSync(path.join(session, name)), name);
    assert.ok(!session.startsWith(box.data));
    const context = fs.readFileSync(path.join(session, "context.md"), "utf8");
    assert.match(context, /> tabs vanish/);
    assert.match(context, /Never read/);
    assert.match(context, new RegExp(`- \`${box.data}/\` and everything in it`));
    assert.match(context, /cookies, saved passwords, history, bookmarks, open tabs/);
    assert.match(context, /Ardia running now: no/);
    assert.match(context, new RegExp(`Source cache .*: ${path.join(triageDir(box), "source")}`));
  } finally {
    cleanup(box);
  }
});

test("codex starts with its workspace sandbox, ask on request and the source cache writable", async () => {
  const box = sandbox();
  try {
    standIn(box, "codex");
    const ran = await run(box, ["triage", "--yes", "--model", "gpt-x"]);
    assert.equal(ran.status, 0, ran.err);
    assert.deepEqual(args(box, "codex"), [
      "--sandbox", "workspace-write", "--ask-for-approval", "on-request", "--add-dir", path.join(triageDir(box), "source"), "-m", "gpt-x",
      "Read playbook.md in this folder and follow it.",
    ]);
  } finally {
    cleanup(box);
  }
});

test("the agent's exit code is the command's, with the session paths printed after a failure", async () => {
  const box = sandbox();
  try {
    standIn(box, "claude");
    const ran = await run(box, ["triage", "--yes"], { STANDIN_EXIT: "7" });
    assert.equal(ran.status, 7);
    assert.match(ran.out, /Claude Code exited with code 7/);
    assert.match(ran.out, /Session folder: /);
    assert.match(ran.out, /Read playbook\.md in this folder and follow it\./);
  } finally {
    cleanup(box);
  }
});

test("agent picking: both without a terminal, --agent, a missing --agent, neither, and the numbered prompt", async () => {
  const box = sandbox();
  try {
    standIn(box, "claude");
    standIn(box, "codex");
    const both = await run(box, ["triage", "--yes"]);
    assert.equal(both.status, 2);
    assert.match(both.err, /pass --agent claude or --agent codex/);
    assert.deepEqual(sessions(box), []);
    const forced = await run(box, ["triage", "--yes", "--agent", "codex"]);
    assert.equal(forced.status, 0, forced.err);
    assert.equal(recorded(box, "codex"), 1);
    assert.equal(recorded(box, "claude"), 0);
    const picked = await onTerminal(box, ["triage", "--yes"], "2\n");
    assert.equal(picked.status, 0, picked.out);
    assert.match(picked.out, /1\. Claude Code\n {2}2\. Codex/);
    assert.equal(recorded(box, "codex"), 2);
    const bad = await run(box, ["triage", "--yes", "--agent", "gemini"]);
    assert.equal(bad.status, 2);
    fs.rmSync(path.join(box.bin, "codex"));
    const missing = await run(box, ["triage", "--yes", "--agent", "codex"]);
    assert.equal(missing.status, 2);
    assert.match(missing.err, /codex isn't on PATH/);
    const only = await run(box, ["triage", "--yes"]);
    assert.equal(only.status, 0);
    assert.equal(recorded(box, "claude"), 1);
    fs.rmSync(path.join(box.bin, "claude"));
    const before = sessions(box).length;
    const neither = await run(box, ["triage", "--yes"]);
    assert.equal(neither.status, 0, neither.err);
    assert.match(neither.out, /Neither claude nor codex is on PATH/);
    assert.match(neither.out, /Read playbook\.md in this folder and follow it\./);
    assert.equal(sessions(box).length, before + 1);
  } finally {
    cleanup(box);
  }
});

test("--print starts no agent even with both installed and prints the session and prompt", async () => {
  const box = sandbox();
  try {
    standIn(box, "claude");
    standIn(box, "codex");
    const ran = await run(box, ["triage", "--yes", "--print"]);
    assert.equal(ran.status, 0, ran.err);
    assert.equal(recorded(box, "claude") + recorded(box, "codex"), 0);
    const session = sessions(box)[0] as string;
    assert.match(ran.out, new RegExp(`Session folder: ${session}`));
    assert.match(ran.out, /ARDIA_TRIAGE=1 ARDIA_TRIAGE_SESSION=/);
  } finally {
    cleanup(box);
  }
});

test("evidence is copied scrubbed: a planted secret, email, home path and URL path and query never reach evidence/", async () => {
  const box = sandbox();
  try {
    plantEvidence(box);
    const ran = await run(box, ["triage", "--yes", "--print"]);
    assert.equal(ran.status, 0, ran.err);
    const session = sessions(box)[0] as string;
    const text = evidenceText(session);
    for (const planted of [SECRET, EMAIL, "alice", URL_PATH, URL_QUERY, API_KEY, "abcdefghijklmnopqrstuvwxyz123456"]) assert.ok(!text.includes(planted), `${planted} reached evidence/`);
    assert.match(text, /https:\/\/mail\.example\.org\/<path>/);
    assert.match(text, /<email>/);
    const names = fs.readdirSync(path.join(session, "evidence")).sort();
    assert.deepEqual(names, ["README.md", "config.json", `usage-${TODAY}.jsonl`, `usage-cli-${TODAY}.jsonl`]);
    for (const left of ["long_ago", "nine_days_ago", "far_future"]) assert.ok(!text.includes(left), left);
    const readme = fs.readFileSync(path.join(session, "evidence", "README.md"), "utf8");
    assert.doesNotMatch(readme, /hooks/);
    assert.ok(readme.includes(`usage-${TODAY}.jsonl`));
    const context = fs.readFileSync(path.join(session, "context.md"), "utf8");
    assert.match(context, /Ardia version: 0\.2\.48/);
    assert.match(context, /Update channel: nightly/);
  } finally {
    cleanup(box);
  }
});

test("an install Ardia never ran on still gets a session, with every source listed as missing", async () => {
  const box = sandbox();
  try {
    fs.rmSync(box.data, { recursive: true });
    const ran = await run(box, ["triage", "--yes", "--print"]);
    assert.equal(ran.status, 0, ran.err);
    const readme = fs.readFileSync(path.join(sessions(box)[0] as string, "evidence", "README.md"), "utf8");
    assert.match(readme, /None: Ardia may never have run here/);
    assert.match(fs.readFileSync(path.join(sessions(box)[0] as string, "context.md"), "utf8"), /Ardia version: unknown/);
  } finally {
    cleanup(box);
  }
});

const TAGS = [
  { ref: "refs/tags/engine-linux-eb14e4729781" },
  { ref: "refs/tags/v0.2.47" },
  { ref: "refs/tags/v0.2.48-nightly.3" },
  { ref: "refs/tags/v0.2.48-nightly.10" },
  { ref: "refs/tags/cli-v0.9.0" },
];

async function playbookWith(handler: (url: string, response: ServerResponse) => void): Promise<{ playbook: string; context: string; seen: string[] }> {
  const box = sandbox();
  try {
    let result = { playbook: "", context: "", seen: [] as string[] };
    await withServer(
      (request, response) => handler(request.url ?? "", response),
      async (base, seen) => {
        const ran = await run(box, ["triage", "--yes", "--print"], { ARDIA_TRIAGE_PLAYBOOK_URL: base });
        assert.equal(ran.status, 0, ran.err);
        const session = sessions(box)[0] as string;
        result = { playbook: fs.readFileSync(path.join(session, "playbook.md"), "utf8"), context: fs.readFileSync(path.join(session, "context.md"), "utf8"), seen };
      },
    );
    return result;
  } finally {
    cleanup(box);
  }
}

test("the playbook comes from the newest release tag, nightlies included, skipping other tags", async () => {
  const served = "# Fetched playbook\n\nFollow it.\n";
  const got = await playbookWith((url, response) => {
    if (url === "/repos/ardia-browser/ardia/git/matching-refs/tags/v") response.end(JSON.stringify(TAGS));
    else if (url === "/ardia-browser/ardia/v0.2.48-nightly.10/.github/triage/PLAYBOOK.md") response.end(served);
    else response.writeHead(404).end();
  });
  assert.equal(got.playbook, served);
  assert.match(got.context, /Playbook: \.github\/triage\/PLAYBOOK\.md at v0\.2\.48-nightly\.10/);
});

for (const [name, handler] of [
  ["the release has no playbook yet (404)", (url: string, response: ServerResponse) => (url.endsWith("/tags/v") ? response.end(JSON.stringify(TAGS)) : response.writeHead(404).end())],
  ["the playbook is too large", (url: string, response: ServerResponse) => response.end(url.endsWith("/tags/v") ? JSON.stringify(TAGS) : "x".repeat(300 * 1024))],
  ["the playbook isn't UTF-8", (url: string, response: ServerResponse) => response.end(url.endsWith("/tags/v") ? Buffer.from(JSON.stringify(TAGS)) : Buffer.from([0xff, 0xfe, 0x41]))],
  ["no tag is a release", (url: string, response: ServerResponse) => response.end(url.endsWith("/tags/v") ? JSON.stringify([{ ref: "refs/tags/engine-1" }]) : "never")],
  ["the tag list isn't JSON", (_url: string, response: ServerResponse) => response.end("<html>")],
  ["the service fails", (_url: string, response: ServerResponse) => response.writeHead(500).end()],
] as [string, (url: string, response: ServerResponse) => void][]) {
  test(`the bundled playbook is used when ${name}`, async () => {
    const got = await playbookWith(handler);
    assert.equal(got.playbook, BUNDLED);
    assert.match(got.context, /Playbook: the copy built into this ardia/);
  });
}

test("the bundled playbook is used when the service is offline, and a checkout build doesn't fetch", async () => {
  const box = sandbox();
  try {
    const offline = await run(box, ["triage", "--yes", "--print"], { ARDIA_TRIAGE_PLAYBOOK_URL: "http://127.0.0.1:9/" });
    assert.equal(offline.status, 0, offline.err);
    const plain = await run(box, ["triage", "--yes", "--print"]);
    assert.equal(plain.status, 0, plain.err);
    for (const session of sessions(box)) assert.equal(fs.readFileSync(path.join(session, "playbook.md"), "utf8"), BUNDLED);
    const notLoopback = await run(box, ["triage", "--yes", "--print"], { ARDIA_TRIAGE_PLAYBOOK_URL: "https://example.org/" });
    assert.equal(notLoopback.status, 0);
  } finally {
    cleanup(box);
  }
});

test("newestReleaseTag orders versions and puts a stable after its nightlies", () => {
  assert.equal(newestReleaseTag(TAGS), "v0.2.48-nightly.10");
  assert.equal(newestReleaseTag([...TAGS, { ref: "refs/tags/v0.2.48" }]), "v0.2.48");
  assert.equal(newestReleaseTag([{ ref: "refs/tags/v0.10.0" }, { ref: "refs/tags/v0.9.99" }]), "v0.10.0");
  assert.equal(newestReleaseTag([{ ref: "refs/tags/v1.0.0-beta.1" }, { ref: "refs/tags/v0.2.48-nightly.x" }]), undefined);
  assert.equal(newestReleaseTag("nope"), undefined);
});

test("triage mode refuses everything outside the allowlist, at dispatch", async () => {
  const box = sandbox();
  try {
    for (const argv of [["tabs"], ["windows", "--json"], ["browse", "snapshot"], ["call", "run"], ["pinned"], ["history"], ["triage"], ["triage", "my", "tabs"], ["config", "edit"], ["config", "list"], ["config", "get", "theme"], ["config", "set", "theme", "x"], ["feedback", "--title", "t", "x"], ["daemon"], ["daemon", "--help"], ["--ardia-history-read"], ["--ardia-script-runner", "x"], ["plugins", "install", "x"], ["--data-dir", box.data, "tabs"], ["notes"], ["--skill"]]) {
      const ran = await run(box, argv, { ARDIA_TRIAGE: "1" });
      assert.equal(ran.status, 2, argv.join(" "));
      assert.match(ran.err, /^ardia: this is a triage session \(ARDIA_TRIAGE=1\), so only triage file/, argv.join(" "));
    }
    for (const argv of [["--version"], ["--help"], ["triage", "file", "--help"], ["plugins", "list"]]) {
      const ran = await run(box, argv, { ARDIA_TRIAGE: "1" });
      assert.doesNotMatch(ran.err, /triage session/, argv.join(" "));
    }
    const unset = await run(box, ["tabs"]);
    assert.doesNotMatch(unset.err, /triage session/);
    const other = await run(box, ["tabs"], { ARDIA_TRIAGE: "0" });
    assert.doesNotMatch(other.err, /triage session/);
  } finally {
    cleanup(box);
  }
});

test("the allowlist is small and exact", () => {
  for (const argv of [[], ["--version"], ["-h"], ["triage", "file", "--post", "x"], ["plugins", "list"], ["commands"], ["methods"], ["--json", "commands"], ["plugins", "--help"]]) {
    assert.ok(allowedInTriage(argv), argv.join(" "));
  }
  for (const argv of [["triage"], ["plugins", "check", "."], ["feedback", "--title", "t"], ["config", "list"], ["config", "get", "a"], ["config", "set", "a", "b"], ["config", "--help"], ["plugins", "call", "x"], ["tabs"], ["run", "newTab"], ["events"], ["apply"], ["mcp"], ["computer"], ["--port", "9", "browse", "open", "x"]]) {
    assert.ok(!allowedInTriage(argv), argv.join(" "));
  }
});

test("triage scrub keeps a URL's scheme and host, cuts its path, query and login, and counts what it removed", () => {
  const done = triageScrub(`see https://user:pw@mail.example.org:8443${URL_PATH}?${URL_QUERY}#frag and https://example.org and ${EMAIL} ${SECRET} /Users/bob/x`);
  assert.equal(done.text, "see https://mail.example.org:8443/<path> and https://example.org and <email> <secret> /Users/<user>/x");
  assert.equal(done.removed.get("URL logins, paths and queries"), 1);
  assert.equal(done.removed.get("emails"), 1);
  assert.equal(done.removed.get("secrets"), 1);
  assert.equal(done.removed.get("home folder names"), 1);
  assert.deepEqual(hostOnlyUrls("http://a.example/ and file:///home/x/y"), ["http://a.example/ and file:///<path>", 1]);
});

test("ardia feedback's own scrub still keeps a URL's path", async () => {
  const { scrub } = await import("../src/scrub.ts");
  assert.equal(scrub("https://example.org/a/b?c=d"), "https://example.org/a/b?<redacted>");
});

test("the report needs its required sections and takes only the playbook's headings", () => {
  assert.throws(() => parseSections("## What happened\nx\n"), /"## Diagnosis" section/);
  assert.throws(() => parseSections("intro\n## What happened\nx"), /text above its first heading/);
  assert.throws(() => parseSections(`${REPORT}\n## Notes\nx`), /"## Notes" isn't a heading the report takes; use "## What happened", "## Diagnosis"/);
  assert.throws(() => parseSections(`${REPORT}\n## Diagnosis\nagain`), /twice/);
  assert.throws(() => parseSections(REPORT.replace("0.2.48, nightly", "")), /"## Version" section with text/);
  const fields = parseSections(`${REPORT}\n## Related issues\n#12 looks close\n`);
  assert.equal(fields.get("related"), "#12 looks close");
  assert.equal(parseSections("## What happened\n```\n## not a heading\n```\n## Diagnosis\nd\n## Steps to reproduce\ns\n## Version\nv\n## Environment\ne\n").get("what-happened"), "```\n## not a heading\n```");
});

test("a required section with nothing left after scrubbing is refused, and the title is limited after scrubbing", () => {
  assert.throws(() => buildReport("Blank sidebar", REPORT.replace("A guess: the sidebar store loses its window id. The log mentions ", "").replace(" and /home/alice/notes.txt.", ""), "claude"), /nothing is left of "## Diagnosis"/);
  assert.throws(() => buildReport("x".repeat(68), REPORT, "claude"), /68 characters after scrubbing; keep it to 67/);
  assert.throws(() => buildReport("   ", REPORT, "claude"), /needs --title/);
  assert.throws(() => buildReport(EMAIL, REPORT, "claude"), /nothing is left of the title/);
  const fits = buildReport(`Crash for ${EMAIL} ${"x".repeat(40)}`, REPORT, "claude");
  assert.ok(fits.title.length <= 67);
});

test("prepare prints the exact text, the counts it removed and a code, and files nothing", async () => {
  const box = sandbox();
  try {
    ghStandIn(box);
    const { session, code, prepared } = await preparedSession(box);
    assert.equal(prepared.status, 0, prepared.err);
    assert.match(code, /^[0-9a-f]{8}$/);
    const text = fs.readFileSync(path.join(session, "prepared-report.md"), "utf8");
    assert.ok(prepared.out.includes(text.trimEnd()));
    for (const planted of [EMAIL, SECRET, URL_PATH, URL_QUERY, "alice"]) assert.ok(!text.includes(planted), planted);
    assert.match(text, /^Title: Sidebar blank after wake with two windows\n\n### What happened\n/);
    assert.match(text, /https:\/\/mail\.example\.org\/<path>/);
    assert.match(text, /### Evidence\n\n```shell\nsidebar: no window 3\n```/);
    assert.match(text, /### Filed by\n\nclaude via ardia triage 0\.0\.0\.dev0\n$|### Filed by\n\na coding agent via ardia triage /);
    assert.match(prepared.out, /Removed before posting:\n {2}secrets: 1\n {2}emails: 1\n {2}home folder names: 1\n {2}URL logins, paths and queries: 1\n/);
    assert.equal(recorded(box, "gh"), 0);
  } finally {
    cleanup(box);
  }
});

test("Filed by comes from the session: the agent and the model given at launch", async () => {
  const box = sandbox();
  try {
    standIn(box, "codex");
    assert.equal((await run(box, ["triage", "--yes", "--model", "gpt-5"])).status, 0);
    const session = sessions(box)[0] as string;
    fs.writeFileSync(path.join(box.root, "report.md"), `${REPORT}\n## Fix applied or workaround\nFiled by: someone else\n`);
    const prepared = await run(box, ["triage", "file", "--title", "Blank sidebar", "--body", "report.md"], inSession(session));
    assert.equal(prepared.status, 0, prepared.err);
    assert.match(prepared.out, /### Filed by\n\ncodex via ardia triage 0\.0\.0\.dev0, model gpt-5$/m);
  } finally {
    cleanup(box);
  }
});

test("triage file refuses outside a session and with a body it can't use", async () => {
  const box = sandbox();
  try {
    const outside = await run(box, ["triage", "file", "--title", "t", "--body", "x.md"]);
    assert.equal(outside.status, 2);
    assert.match(outside.err, /runs inside a triage session/);
    const elsewhere = await run(box, ["triage", "file", "--title", "t", "--body", "x.md", "--session", box.data]);
    assert.equal(elsewhere.status, 2);
    assert.match(elsewhere.err, /isn't a triage session folder/);
    const { session } = await preparedSession(box);
    const missing = await run(box, ["triage", "file", "--title", "t", "--body", "nothing.md"], inSession(session));
    assert.equal(missing.status, 2);
    assert.match(missing.err, /no such file/);
    const extra = await run(box, ["triage", "file", "--title", "t", "--body", "report.md", "--bogus"], inSession(session));
    assert.equal(extra.status, 2);
    assert.match(extra.err, /unrecognized option --bogus/);
  } finally {
    cleanup(box);
  }
});

test("--post refuses a wrong code and a stale one, and preparing again replaces the draft", async () => {
  const box = sandbox();
  try {
    ghStandIn(box);
    const { session, code } = await preparedSession(box);
    const wrong = await run(box, ["triage", "file", "--post", "00000000"], inSession(session));
    assert.equal(wrong.status, 2);
    assert.match(wrong.err, /isn't the code of the prepared report/);
    const junk = await run(box, ["triage", "file", "--post", "ZZ"], inSession(session));
    assert.equal(junk.status, 2);
    fs.writeFileSync(path.join(box.root, "report.md"), REPORT.replace("Open two windows", "Open three windows"));
    const again = await run(box, ["triage", "file", "--title", "Sidebar blank after wake", "--body", "report.md"], inSession(session));
    const newer = /^Code: ([0-9a-f]{8})$/m.exec(again.out)?.[1];
    assert.ok(newer !== undefined && newer !== code);
    const stale = await run(box, ["triage", "file", "--post", code], inSession(session));
    assert.equal(stale.status, 2);
    assert.match(stale.err, /stale or mistyped/);
    assert.equal(recorded(box, "gh"), 0);
    const tampered = JSON.parse(fs.readFileSync(path.join(session, "prepared-report.json"), "utf8"));
    tampered.body = `${tampered.body}extra`;
    fs.writeFileSync(path.join(session, "prepared-report.json"), JSON.stringify(tampered));
    const changed = await run(box, ["triage", "file", "--post", newer as string], inSession(session));
    assert.equal(changed.status, 2);
    assert.match(changed.err, /changed after it was prepared/);
  } finally {
    cleanup(box);
  }
});

test("--post with gh signed in files through the Triage report form, once", async () => {
  const box = sandbox();
  try {
    ghStandIn(box);
    const { session, code } = await preparedSession(box);
    const posted = await run(box, ["triage", "file", "--post", code], inSession(session));
    assert.equal(posted.status, 0, posted.err);
    assert.match(posted.out, /^Filed: https:\/\/github\.com\/test\/repo\/issues\/41$/m);
    assert.match(posted.out, /via-triage label/);
    assert.deepEqual(args(box, "gh", 0), ["auth", "status", "--hostname", "github.com"]);
    assert.deepEqual(args(box, "gh", 1), ["api", "--hostname", "github.com", "repos/test/repo", "--jq", ".node_id"]);
    const create = args(box, "gh", 2);
    assert.deepEqual(create.slice(0, 8), ["api", "--hostname", "github.com", "graphql", "-f", "repo=R_kgTest", "-f", "template=Triage report"]);
    assert.match(create.at(-1) as string, /^query=mutation.*createIssue\(input:\{repositoryId:\$repo,issueTemplate:\$template/);
    const report = fs.readFileSync(path.join(session, "prepared-report.md"), "utf8");
    assert.equal(fs.readFileSync(path.join(box.record, "gh.2.title"), "utf8"), "Sidebar blank after wake with two windows");
    assert.equal(`Title: Sidebar blank after wake with two windows\n\n${fs.readFileSync(path.join(box.record, "gh.2.body"), "utf8")}`, report);
    const again = await run(box, ["triage", "file", "--post", code], inSession(session));
    assert.equal(again.status, 0);
    assert.match(again.out, /^Already filed: https:\/\/github\.com\/test\/repo\/issues\/41$/m);
    const otherWay = await run(box, ["triage", "file", "--post", code, "--via", "form"], inSession(session));
    assert.match(otherWay.out, /Already filed/);
    assert.equal(recorded(box, "gh"), 3);
  } finally {
    cleanup(box);
  }
});

test("--post with gh signed out posts nothing and exits 3", async () => {
  const box = sandbox();
  try {
    ghStandIn(box);
    standIn(box, "xdg-open");
    standIn(box, "open");
    const { session, code } = await preparedSession(box);
    const posted = await run(box, ["triage", "file", "--post", code], inSession(session, { GH_AUTH: "1" }));
    assert.equal(posted.status, 3);
    assert.equal(posted.err.trim().split("\n").length, 1);
    assert.match(posted.err, /gh is installed but signed out .*--via form and --via feedback are the other ways/);
    assert.equal(recorded(box, "gh"), 1);
    assert.equal(recorded(box, "xdg-open") + recorded(box, "open"), 0);
    const viaGh = await run(box, ["triage", "file", "--post", code, "--via", "gh"], inSession(session, { GH_AUTH: "1" }));
    assert.equal(viaGh.status, 3);
  } finally {
    cleanup(box);
  }
});

test("--post with no gh opens the prefilled form, prints its address and can open it again", async () => {
  const box = sandbox();
  try {
    standIn(box, "xdg-open");
    standIn(box, "open");
    const { session, code } = await preparedSession(box);
    const posted = await run(box, ["triage", "file", "--post", code], inSession(session));
    assert.equal(posted.status, 0, posted.err);
    const url = posted.out.split("\n").find((line) => line.startsWith("https://")) as string;
    const parsed = new URL(url);
    assert.equal(`${parsed.origin}${parsed.pathname}`, "https://github.com/test/repo/issues/new");
    assert.equal(parsed.searchParams.get("template"), "via-triage.yml");
    assert.equal(parsed.searchParams.get("title"), "Sidebar blank after wake with two windows");
    assert.equal(parsed.searchParams.get("version"), "0.2.48, nightly");
    assert.equal(parsed.searchParams.get("evidence"), "sidebar: no window 3");
    assert.match(parsed.searchParams.get("agent") as string, /via ardia triage/);
    for (const id of ["what-happened", "diagnosis", "steps", "environment"]) assert.ok(parsed.searchParams.get(id), id);
    assert.match(posted.out, /Click Submit|click Submit/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const opener = MAC ? "open" : "xdg-open";
    assert.deepEqual(args(box, opener), [url]);
    const again = await run(box, ["triage", "file", "--post", code, "--via", "form"], inSession(session));
    assert.equal(again.status, 0);
    assert.ok(again.out.includes(url));
  } finally {
    cleanup(box);
  }
});

test("the form link stays under 6000 characters by cutting Evidence first, then Diagnosis, and says so", async () => {
  const box = sandbox();
  try {
    const long = REPORT.replace("sidebar: no window 3", Array.from({ length: 400 }, (_, index) => `line ${index} the sidebar had no window`).join("\n")).replace(
      "A guess: the sidebar store loses its window id.",
      Array.from({ length: 200 }, () => "the store lost the id").join(" "),
    );
    const { session, code } = await preparedSession(box, long);
    const posted = await run(box, ["triage", "file", "--post", code, "--via", "form"], inSession(session));
    assert.equal(posted.status, 0, posted.err);
    const url = posted.out.split("\n").find((line) => line.startsWith("https://")) as string;
    assert.ok(url.length < 6000, String(url.length));
    assert.match(posted.out, /Evidence was cut from \d+ to \d+ characters to fit the link; the full text is in .*report\.md/);
    assert.match(posted.out, /Diagnosis was cut from/);
    assert.match(new URL(url).searchParams.get("evidence") as string, /Shortened to fit the form/);
    assert.equal(new URL(url).searchParams.get("steps"), "1. Open two windows\n2. Sleep and wake");
  } finally {
    cleanup(box);
  }
});

test("formUrl cuts only Evidence when that is enough", () => {
  const fields = new Map([["what-happened", "w"], ["diagnosis", "d".repeat(500)], ["evidence", "e ".repeat(4000)]]);
  const built = formUrl("https://github.com/x/y/issues/new", "t", fields);
  assert.ok(built.url.length < 6000);
  assert.deepEqual(built.cuts.map((cut) => cut.heading), ["Evidence"]);
});

async function feedbackService(work: (base: string, seen: string[], uploads: Map<string, Buffer>, posted: unknown[]) => Promise<void>): Promise<void> {
  const uploads = new Map<string, Buffer>();
  const posted: unknown[] = [];
  await withServer(
    (request, response, body) => {
      const url = request.url ?? "";
      response.setHeader("Content-Type", "application/json");
      if (request.method === "POST" && url === "/api/feedback") {
        posted.push(JSON.parse(body.toString("utf8")));
        response.writeHead(201).end(JSON.stringify({ id: "FB-TR1A", name: "Quiet Otter", upload_token: "token-12345678" }));
      } else if (request.method === "PUT" && url.startsWith("/api/feedback/FB-TR1A/files/")) {
        uploads.set(decodeURIComponent(url.slice("/api/feedback/FB-TR1A/files/".length)), body);
        response.writeHead(200).end("{}");
      } else if (request.method === "POST" && url === "/api/feedback/FB-TR1A/complete") response.writeHead(200).end(JSON.stringify({ id: "FB-TR1A", name: "Quiet Otter" }));
      else response.writeHead(404).end("{}");
    },
    (base, seen) => work(base, seen, uploads, posted),
  );
}

test("--via feedback sends the report privately with the full text attached, and --attach-evidence adds the evidence", async () => {
  const box = sandbox();
  try {
    plantEvidence(box);
    const { session, code } = await preparedSession(box);
    await feedbackService(async (base, _seen, uploads, posted) => {
      const sent = await run(box, ["triage", "file", "--post", code, "--via", "feedback", "--attach-evidence"], inSession(session, { ARDIA_FEEDBACK_URL: base }));
      assert.equal(sent.status, 0, sent.out + sent.err);
      assert.match(sent.out, /Sent\. Reference FB-TR1A\./);
      assert.match(sent.out, /Attached \d+ evidence files/);
      const payload = posted[0] as { kind: string; title: string; description: string; attachments: { name: string }[] };
      assert.equal(payload.kind, "bug");
      assert.equal(payload.title, "Sidebar blank after wake with two windows");
      assert.match(payload.description, /### What happened/);
      const report = fs.readFileSync(path.join(session, "prepared-report.md"), "utf8");
      assert.equal(uploads.get("attachment-1.md")?.toString("utf8"), report);
      assert.ok(uploads.size >= 4, [...uploads.keys()].join(","));
      for (const body of uploads.values()) assert.ok(!body.toString("utf8").includes(SECRET));
      assert.equal((posted[0] as { diagnostics: { via?: string } }).diagnostics.via, "triage");
      const again = await run(box, ["triage", "file", "--post", code, "--via", "feedback"], inSession(session, { ARDIA_FEEDBACK_URL: base }));
      assert.match(again.out, /^Already filed: FB-TR1A$/m);
      assert.equal(posted.length, 1);
    });
  } finally {
    cleanup(box);
  }
});

test("--via feedback cuts a long report to 4000 characters and keeps feedback's refusals", async () => {
  const box = sandbox();
  try {
    const long = REPORT.replace("sidebar: no window 3", "word ".repeat(2000));
    const { session, code } = await preparedSession(box, long);
    await feedbackService(async (base, _seen, uploads, posted) => {
      const refused = await run(box, ["triage", "file", "--post", code, "--via", "feedback"], inSession(session, { ARDIA_FEEDBACK_URL: base, DO_NOT_TRACK: "1" }));
      assert.equal(refused.status, 1);
      assert.match(refused.out, /Not sent: DO_NOT_TRACK=1 is set/);
      assert.equal(posted.length, 0);
      const checkout = await run(box, ["triage", "file", "--post", code, "--via", "feedback"], inSession(session));
      assert.equal(checkout.status, 1);
      assert.match(checkout.out, /checkout build/);
      const sent = await run(box, ["triage", "file", "--post", code, "--via", "feedback"], inSession(session, { ARDIA_FEEDBACK_URL: base }));
      assert.equal(sent.status, 0, sent.out + sent.err);
      const payload = posted[0] as { description: string };
      assert.ok([...payload.description].length <= 4000);
      assert.match(payload.description, /full report is attached/);
      assert.equal(uploads.size, 1);
    });
  } finally {
    cleanup(box);
  }
});

test("--comment-on comments on an open issue with gh, refuses a closed one, and opens the page without gh", async () => {
  const box = sandbox();
  try {
    ghStandIn(box);
    standIn(box, "xdg-open");
    standIn(box, "open");
    const { session, code } = await preparedSession(box);
    const closed = await run(box, ["triage", "file", "--post", code, "--comment-on", "12"], inSession(session, { GH_ISSUE_STATE: "closed" }));
    assert.equal(closed.status, 2);
    assert.match(closed.err, /#12 is closed/);
    const commented = await run(box, ["triage", "file", "--post", code, "--comment-on", "12"], inSession(session));
    assert.equal(commented.status, 0, commented.err);
    assert.match(commented.out, /^Commented: https:\/\/github\.com\/test\/repo\/issues\/12#issuecomment-1$/m);
    const last = recorded(box, "gh") - 1;
    assert.deepEqual(args(box, "gh", last).slice(0, 4), ["api", "--hostname", "github.com", "repos/test/repo/issues/12/comments"]);
    assert.match(fs.readFileSync(path.join(box.record, `gh.${last}.body`), "utf8"), /\*\*Sidebar blank after wake with two windows\*\*[\s\S]*### Diagnosis/);
    const twice = await run(box, ["triage", "file", "--post", code, "--comment-on", "12"], inSession(session));
    assert.match(twice.out, /Already filed: https:\/\/github\.com\/test\/repo\/issues\/12#issuecomment-1/);
    const bad = await run(box, ["triage", "file", "--post", code, "--comment-on", "twelve"], inSession(session));
    assert.equal(bad.status, 2);
    fs.rmSync(path.join(box.bin, "gh"));
    const pasted = await run(box, ["triage", "file", "--post", code, "--comment-on", "13"], inSession(session));
    assert.equal(pasted.status, 0, pasted.err);
    assert.match(pasted.out, /https:\/\/github\.com\/test\/repo\/issues\/13/);
    assert.match(pasted.out, /Paste this as a comment|paste this as a comment/);
    assert.match(pasted.out, /### What happened/);
  } finally {
    cleanup(box);
  }
});

test("a checkout build never files to ardia-browser/ardia", async () => {
  const box = sandbox();
  try {
    ghStandIn(box);
    const { session, code } = await preparedSession(box);
    const posted = await run(box, ["triage", "file", "--post", code], inSession(session, { ARDIA_TRIAGE_REPO: "" }));
    assert.equal(posted.status, 2);
    assert.match(posted.err, /never files to ardia-browser\/ardia/);
    assert.equal(recorded(box, "gh"), 1);
  } finally {
    cleanup(box);
  }
});

test("triage --help and triage file --help print the usage", async () => {
  const box = sandbox();
  try {
    for (const argv of [["triage", "--help"], ["triage", "file", "-h"]]) {
      const ran = await run(box, argv);
      assert.equal(ran.status, 0, ran.err);
      assert.match(ran.out, /^usage: ardia triage \[WHAT WENT WRONG \.\.\.\]/);
      assert.match(ran.out, /guard rails, not a lock/);
    }
    const bad = await run(box, ["triage", "--frobnicate"]);
    assert.equal(bad.status, 2);
    assert.match(bad.err, /^ardia triage: unrecognized option --frobnicate \(see ardia triage --help\)/);
    const top = await run(box, ["--help"]);
    assert.match(top.out, /^ {4}triage {2,}start your coding agent/m);
  } finally {
    cleanup(box);
  }
});

test("use is counted through the cli_command event, with the agent and outcome as flags", async () => {
  const box = sandbox();
  try {
    standIn(box, "claude");
    await run(box, ["triage", "--yes"], { ARDIA_TELEMETRY_URL: "http://127.0.0.1:9/v1/logs" });
    const local = path.join(box.data, "Telemetry", "local");
    const lines = fs.readdirSync(local).filter((name) => name.startsWith("cli-")).flatMap((name) => fs.readFileSync(path.join(local, name), "utf8").split("\n").filter(Boolean));
    const event = lines.map((line) => JSON.parse(line)).find((record) => record.event === "cli_command" || record.record?.event === "cli_command");
    const properties = JSON.stringify(event);
    assert.match(properties, /"command": ?"triage"/);
    assert.match(properties, /"triage_agent_claude": ?true/);
    assert.match(properties, /"triage_launched": ?true/);
    assert.doesNotMatch(properties, /sidebar|playbook\.md/);
  } finally {
    cleanup(box);
  }
});

test("a draft the agent keeps in the session folder as report.md is left as it wrote it, and prepares twice", async () => {
  const box = sandbox();
  try {
    const launched = await run(box, ["triage", "--print", "--yes"]);
    assert.equal(launched.status, 0, launched.err);
    const session = sessions(box)[0] as string;
    const draft = path.join(session, "report.md");
    fs.writeFileSync(draft, REPORT);
    const first = await run(box, ["triage", "file", "--title", "Sidebar blank after wake", "--body", draft], inSession(session));
    assert.equal(first.status, 0, first.err);
    assert.equal(fs.readFileSync(draft, "utf8"), REPORT);
    assert.match(fs.readFileSync(path.join(session, "prepared-report.md"), "utf8"), /^Title: Sidebar blank after wake\n\n### What happened/);
    const second = await run(box, ["triage", "file", "--title", "Sidebar blank after wake", "--body", "report.md"], inSession(session), undefined, session);
    assert.equal(second.status, 0, second.err);
    assert.equal(/^Code: ([0-9a-f]{8})$/m.exec(second.out)?.[1], /^Code: ([0-9a-f]{8})$/m.exec(first.out)?.[1]);
    const own = await run(box, ["triage", "file", "--title", "Sidebar blank after wake", "--body", path.join(session, "prepared-report.md")], inSession(session));
    assert.equal(own.status, 2);
    assert.match(own.err, /is the copy ardia triage file writes/);
  } finally {
    cleanup(box);
  }
});

test("a form field changed after preparing is refused, though the title and body still match the code", async () => {
  const box = sandbox();
  try {
    standIn(box, "xdg-open");
    standIn(box, "open");
    const { session, code } = await preparedSession(box);
    const stored = path.join(session, "prepared-report.json");
    const tampered = JSON.parse(fs.readFileSync(stored, "utf8"));
    tampered.fields.diagnosis = "something the user never saw";
    fs.writeFileSync(stored, JSON.stringify(tampered));
    const posted = await run(box, ["triage", "file", "--post", code, "--via", "form"], inSession(session));
    assert.equal(posted.status, 2);
    assert.match(posted.err, /changed after it was prepared/);
    assert.equal(recorded(box, "xdg-open") + recorded(box, "open"), 0);
  } finally {
    cleanup(box);
  }
});

test("an older Claude Code that calls its ask-first mode default is started with that name", async () => {
  const box = sandbox();
  try {
    standIn(box, "claude");
    const older = await run(box, ["triage", "--yes"], { STANDIN_HELP: '--permission-mode <mode>  (choices: "acceptEdits", "bypassPermissions", "default", "plan")' });
    assert.equal(older.status, 0, older.err);
    assert.deepEqual(args(box, "claude").slice(0, 2), ["--permission-mode", "default"]);
    const newer = await run(box, ["triage", "--yes"], { STANDIN_HELP: '--permission-mode <mode>  (choices: "acceptEdits", "auto", "manual", "plan")' });
    assert.equal(newer.status, 0, newer.err);
    assert.deepEqual(args(box, "claude", 1).slice(0, 2), ["--permission-mode", "manual"]);
  } finally {
    cleanup(box);
  }
});

test("the playbook fetch doesn't follow a redirect", async () => {
  const got = await playbookWith((url, response) => {
    if (url.endsWith("/tags/v")) response.end(JSON.stringify(TAGS));
    else if (url.endsWith("/elsewhere")) response.end("# From somewhere else\n");
    else response.writeHead(302, { Location: "/elsewhere" }).end();
  });
  assert.equal(got.playbook, BUNDLED);
});

test("triage scrub cuts the path of an address written without its scheme, and the home folder's name in other paths", () => {
  const done = triageScrub(`it broke on mail.example.org${URL_PATH}?${URL_QUERY} and docs.example.com/d/1abc but not in engine/ardiacore/src/window.mm or README.md or 0.2.48/notes`);
  assert.equal(done.text, "it broke on mail.example.org/<path> and docs.example.com/<path> but not in engine/ardiacore/src/window.mm or README.md or 0.2.48/notes");
  assert.equal(done.removed.get("URL logins, paths and queries"), 2);
  assert.equal(triageScrub("see https://www.example.org/<path> again").text, "see https://www.example.org/<path> again");
  assert.equal(homeNameSegments("/Volumes/Data/alice/x and ~alice and /srv/alice: but malice/x and /alicette", "alice"), "/Volumes/Data/<user>/x and ~<user> and /srv/<user>: but malice/x and /alicette");
});

test("--attach-evidence sends only the files triage collected, scrubbed again", async () => {
  const box = sandbox();
  try {
    plantEvidence(box);
    const { session, code } = await preparedSession(box);
    fs.writeFileSync(path.join(session, "evidence", "notes.txt"), "something else entirely\n");
    fs.appendFileSync(path.join(session, "evidence", "config.json"), `\n{"added":"${SECRET}","to":"${EMAIL}"}\n`);
    await feedbackService(async (base, _seen, uploads) => {
      const sent = await run(box, ["triage", "file", "--post", code, "--via", "feedback", "--attach-evidence"], inSession(session, { ARDIA_FEEDBACK_URL: base }));
      assert.equal(sent.status, 0, sent.out + sent.err);
      assert.match(sent.out, /Not attached: notes\.txt \(not a file triage collected\)/);
      const all = [...uploads.values()].map((body) => body.toString("utf8")).join("\n");
      assert.ok(!all.includes("something else entirely"));
      assert.ok(!all.includes(SECRET) && !all.includes(EMAIL));
      assert.match(all, /"added":"<secret>"/);
    });
  } finally {
    cleanup(box);
  }
});

test("two posts at once file one issue", async () => {
  const box = sandbox();
  try {
    fs.symlinkSync("/bin/sleep", path.join(box.tools, "sleep"));
    standIn(
      box,
      "gh",
      `case "$1 $2" in
"auth status") exit 0;;
esac
case "$*" in
*"--jq .node_id"*) echo R_kgTest; exit 0;;
*graphql*) sleep 1; echo '{"data":{"createIssue":{"issue":{"url":"https://github.com/test/repo/issues/77","labels":{"nodes":[{"name":"via-triage"}]}}}}}'; exit 0;;
esac
exit 1`,
    );
    const { session, code } = await preparedSession(box);
    const both = await Promise.all([run(box, ["triage", "file", "--post", code], inSession(session)), run(box, ["triage", "file", "--post", code], inSession(session))]);
    const filed = both.filter((ran) => /^Filed: https:\/\/github\.com\/test\/repo\/issues\/77$/m.test(ran.out));
    const waited = both.filter((ran) => /another ardia triage file --post is running/.test(ran.err) || /^Already filed:/m.test(ran.out));
    assert.equal(filed.length, 1, both.map((ran) => ran.out + ran.err).join("|"));
    assert.equal(waited.length, 1, both.map((ran) => ran.out + ran.err).join("|"));
    const creates = fs.readdirSync(box.record).filter((file) => file.startsWith("gh.") && file.endsWith(".argv") && fs.readFileSync(path.join(box.record, file), "utf8").includes("graphql"));
    assert.equal(creates.length, 1);
  } finally {
    cleanup(box);
  }
});

test("a checkout build can't be pointed at the real repository, and --via form with --comment-on never posts through gh", async () => {
  const box = sandbox();
  try {
    ghStandIn(box);
    standIn(box, "xdg-open");
    standIn(box, "open");
    const { session, code } = await preparedSession(box);
    const real = await run(box, ["triage", "file", "--post", code], inSession(session, { ARDIA_TRIAGE_REPO: "ardia-browser/ardia" }));
    assert.equal(real.status, 2);
    assert.match(real.err, /never files to ardia-browser\/ardia/);
    const before = recorded(box, "gh");
    const pasted = await run(box, ["triage", "file", "--post", code, "--comment-on", "12", "--via", "form"], inSession(session));
    assert.equal(pasted.status, 0, pasted.err);
    assert.match(pasted.out, /https:\/\/github\.com\/test\/repo\/issues\/12/);
    assert.match(pasted.out, /[Pp]aste this as a comment/);
    assert.equal(recorded(box, "gh"), before);
  } finally {
    cleanup(box);
  }
});

test("a login with several @ in a URL is cut whole", () => {
  assert.equal(triageScrub("at https://alice:p@ss@word@localhost/private?x=1 now").text, "at https://localhost/<path> now");
});

for (const [name, answer, expected] of [
  ["a GraphQL error", `echo '{"errors":[{"message":"Could not resolve to an issue template"}]}'; exit 1`, "refused"],
  ["an HTTP 4xx from gh", `echo 'gh: Bad credentials (HTTP 401)' >&2; exit 1`, "refused"],
  ["no clear answer", `echo 'unexpected EOF' >&2; exit 1`, "uncertain"],
] as [string, string, string][]) {
  test(`gh failing with ${name} is ${expected === "refused" ? "a refusal that can be tried again" : "kept as uncertain and not sent again"}`, async () => {
    const box = sandbox();
    try {
      standIn(
        box,
        "gh",
        `case "$1 $2" in
"auth status") exit 0;;
esac
case "$*" in
*"--jq .node_id"*) echo R_kgTest; exit 0;;
*graphql*) ${answer};;
esac
exit 1`,
      );
      const { session, code } = await preparedSession(box);
      const first = await run(box, ["triage", "file", "--post", code], inSession(session));
      assert.equal(first.status, 1, first.out + first.err);
      const creates = () => fs.readdirSync(box.record).filter((file) => file.startsWith("gh.") && file.endsWith(".argv") && fs.readFileSync(path.join(box.record, file), "utf8").includes("graphql")).length;
      assert.equal(creates(), 1);
      const second = await run(box, ["triage", "file", "--post", code], inSession(session));
      if (expected === "refused") {
        assert.match(first.err, /GitHub refused the issue .*nothing was filed/);
        assert.equal(creates(), 2);
      } else {
        assert.match(first.err, /may or may not exist/);
        assert.match(second.out, /^Not sent again: the last try may have gone out/m);
        assert.equal(creates(), 1);
      }
    } finally {
      cleanup(box);
    }
  });
}

test("the private route attaches the text the code is for, and a draft can't be prepared while a post is running", async () => {
  const box = sandbox();
  try {
    const { session, code } = await preparedSession(box);
    const approved = fs.readFileSync(path.join(session, "prepared-report.md"), "utf8");
    const uploads = new Map<string, string>();
    let whilePosting: Ran | undefined;
    await withServer(
      (request, response, body) => {
        const url = request.url ?? "";
        response.setHeader("Content-Type", "application/json");
        if (request.method === "POST" && url === "/api/feedback") {
          fs.writeFileSync(path.join(box.root, "other.md"), REPORT.replace("Open two windows", "Open nine windows"));
          void run(box, ["triage", "file", "--title", "Another report entirely", "--body", "other.md"], inSession(session)).then((ran) => {
            whilePosting = ran;
            response.writeHead(201).end(JSON.stringify({ id: "FB-RACE", name: "Quiet Otter", upload_token: "token-12345678" }));
          });
        } else if (request.method === "PUT") {
          uploads.set(decodeURIComponent(url.slice(url.lastIndexOf("/") + 1)), body.toString("utf8"));
          response.writeHead(200).end("{}");
        } else response.writeHead(200).end(JSON.stringify({ id: "FB-RACE", name: "Quiet Otter" }));
      },
      async (base) => {
        const sent = await run(box, ["triage", "file", "--post", code, "--via", "feedback"], inSession(session, { ARDIA_FEEDBACK_URL: base }));
        assert.equal(sent.status, 0, sent.out + sent.err);
      },
    );
    assert.equal(whilePosting?.status, 1, `${whilePosting?.out}${whilePosting?.err}`);
    assert.match(whilePosting?.err ?? "", /another ardia triage file --post is running/);
    assert.equal(uploads.get("attachment-1.md"), approved);
    assert.equal(fs.readFileSync(path.join(session, `post-report-${code}.md`), "utf8"), approved);
  } finally {
    cleanup(box);
  }
});

test("triage scrub cuts addresses with a port, an IP or no scheme at all, and leaves stack frames alone", () => {
  for (const [given, expected] of [
    ["example.test:8080/account/123?q=private", "example.test:8080/<path>"],
    ["see //example.test/path?q=private here", "see //example.test/<path> here"],
    ["192.0.2.8/private/page", "192.0.2.8/<path>"],
    ["localhost:3000/admin/users", "localhost:3000/<path>"],
    ["com.ardia.browser/AppDelegate.swift:42", "com.ardia.browser/AppDelegate.swift:42"],
    ["at ArdiaCore.framework/Versions/A/ArdiaCore + 1234", "at ArdiaCore.framework/Versions/A/ArdiaCore + 1234"],
    ["engine/ardiacore/src/ac_window_host.mm:120 in node_modules/foo/index.js", "engine/ardiacore/src/ac_window_host.mm:120 in node_modules/foo/index.js"],
    ["version 0.2.48-nightly.3 and 3/4", "version 0.2.48-nightly.3 and 3/4"],
  ] as [string, string][]) assert.equal(triageScrub(given).text, expected);
  assert.equal(homeNameSegments("/Volumes/x/josé/file", "josé"), "/Volumes/x/<user>/file");
});

test("a crash report is recognised by its header, however long the report", () => {
  const box = sandbox();
  try {
    const long = path.join(box.root, "Ardia-long.ips");
    fs.writeFileSync(long, `{"bundleID":"com.ardia.browser","app_name":"Ardia"}\n${"frame\n".repeat(20000)}`);
    const other = path.join(box.root, "Other.ips");
    fs.writeFileSync(other, `{"bundleID":"com.example.other"}\n${"frame\n".repeat(20000)}`);
    assert.equal(looksLikeArdia(long), true);
    assert.equal(looksLikeArdia(other), false);
  } finally {
    cleanup(box);
  }
});

test("a relative ARDIA_CLI_HOME still makes a session triage file accepts, the source cache exists, and a CLI home inside Ardia's data folder is refused", async () => {
  const box = sandbox();
  try {
    standIn(box, "codex");
    const launched = await run(box, ["triage", "--yes"], { ARDIA_CLI_HOME: "cli" });
    assert.equal(launched.status, 0, launched.err);
    const session = sessions(box)[0] as string;
    assert.ok(fs.statSync(path.join(triageDir(box), "source")).isDirectory());
    assert.ok(args(box, "codex").includes(path.join(triageDir(box), "source")));
    fs.writeFileSync(path.join(box.root, "report.md"), REPORT);
    const prepared = await run(box, ["triage", "file", "--session", session, "--title", "Sidebar blank", "--body", "report.md"], { ARDIA_CLI_HOME: "cli" });
    assert.equal(prepared.status, 0, prepared.err);
    const inside = await run(box, ["triage", "--yes", "--print"], { ARDIA_CLI_HOME: path.join(box.data, "cli") });
    assert.equal(inside.status, 2);
    assert.match(inside.err, /which triage keeps the agent out of/);
  } finally {
    cleanup(box);
  }
});

test("a login on an address that starts with // goes, and a port or a query makes a reversed name an address", () => {
  for (const [given, expected] of [
    ["//alice:open-sesame@localhost:3000/private?q=alice", "//localhost:3000/<path>"],
    ["org.example.net:8443/private?q=alice", "org.example.net:8443/<path>"],
    ["org.example.net/private?q=alice", "org.example.net/<path>"],
    ["FocusHandoff.swift/handoff and window_host.mm/reattach", "FocusHandoff.swift/handoff and window_host.mm/reattach"],
    ["//cdn.example.org/", "//cdn.example.org/"],
  ] as [string, string][]) assert.equal(triageScrub(given).text, expected);
});

test("a settings file with a very long encoded value is collected quickly, without the value", async () => {
  const box = sandbox();
  try {
    plantEvidence(box);
    const blob = Buffer.from(Uint8Array.from({ length: 192 * 1024 }, (_, index) => (index * 31 + 7) % 251)).toString("base64");
    for (const folder of [MAC ? path.join(box.home, ".config", "ardia") : path.join(box.data, "config"), path.join(box.data, "config")]) {
      fs.writeFileSync(path.join(folder, "config.json"), JSON.stringify({ theme: "nord", icon: blob }));
    }
    const started = Date.now();
    const ran = await run(box, ["triage", "--yes", "--print"]);
    assert.equal(ran.status, 0, ran.err);
    assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
    const config = fs.readFileSync(path.join(sessions(box)[0] as string, "evidence", "config.json"), "utf8");
    assert.ok(config.length < 200 && config.includes('"theme":"nord"'), config.slice(0, 200));
  } finally {
    cleanup(box);
  }
});

test("an issue gh created is filed even when gh exits 1, and a post cut short is not sent again", async () => {
  const box = sandbox();
  try {
    standIn(
      box,
      "gh",
      `case "$1 $2" in
"auth status") exit 0;;
esac
case "$*" in
*"--jq .node_id"*) echo R_kgTest; exit 0;;
*graphql*) if [ -n "$GH_DIES" ]; then kill -9 $PPID; exit 0; fi; echo '{"data":{"createIssue":{"issue":{"url":"https://github.com/test/repo/issues/88","labels":null}}},"errors":[{"message":"labels unavailable"}]}'; exit 1;;
esac
exit 1`,
    );
    const creates = () => fs.readdirSync(box.record).filter((file) => file.startsWith("gh.") && file.endsWith(".argv") && fs.readFileSync(path.join(box.record, file), "utf8").includes("graphql")).length;
    const first = await preparedSession(box);
    const filed = await run(box, ["triage", "file", "--post", first.code], inSession(first.session));
    assert.equal(filed.status, 0, filed.out + filed.err);
    assert.match(filed.out, /^Filed: https:\/\/github\.com\/test\/repo\/issues\/88$/m);
    const again = await run(box, ["triage", "file", "--post", first.code], inSession(first.session));
    assert.match(again.out, /^Already filed: https:\/\/github\.com\/test\/repo\/issues\/88$/m);
    assert.equal(creates(), 1);
    fs.writeFileSync(path.join(box.root, "second.md"), REPORT.replace("Open two windows", "Open four windows"));
    const prepared = await run(box, ["triage", "file", "--title", "A second report", "--body", "second.md"], inSession(first.session));
    const code = /^Code: ([0-9a-f]{8})$/m.exec(prepared.out)?.[1] as string;
    const killed = await run(box, ["triage", "file", "--post", code], inSession(first.session, { GH_DIES: "1" }));
    assert.notEqual(killed.status, 0);
    assert.equal(creates(), 2);
    const retried = await run(box, ["triage", "file", "--post", code], inSession(first.session));
    assert.match(retried.out, /^Not sent again: the last try may have gone out/m);
    assert.equal(creates(), 2);
  } finally {
    cleanup(box);
  }
});

test("the agent is handed absolute paths when the CLI home and data dir were given as relative ones", async () => {
  const box = sandbox();
  try {
    standIn(box, "claude");
    fs.mkdirSync(path.join(box.root, "profile"), { recursive: true });
    const ran = await run(box, ["triage", "--yes"], { ARDIA_CLI_HOME: "cli", ARDIA_DATA_DIR: "profile" });
    assert.equal(ran.status, 0, ran.err);
    const env = fs.readFileSync(path.join(box.record, "claude.0.env"), "utf8");
    assert.match(env, new RegExp(`^ARDIA_CLI_HOME=${box.cli}$`, "m"));
    assert.match(env, new RegExp(`^ARDIA_DATA_DIR=${path.join(box.root, "profile")}$`, "m"));
    const printed = await run(box, ["triage", "--yes", "--print"], { ARDIA_CLI_HOME: "cli", ARDIA_DATA_DIR: "profile" });
    assert.ok(printed.out.includes(`ARDIA_CLI_HOME=${JSON.stringify(box.cli)}`), printed.out);
  } finally {
    cleanup(box);
  }
});
