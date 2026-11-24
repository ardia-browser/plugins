import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { iso, now } from "./clock.ts";
import { call as callControl, dataRoot } from "./control.ts";
import type { Said } from "./deliver.ts";
import { attachableName, FEEDBACK_ATTACHMENT_LIMIT, FEEDBACK_DESCRIPTION_LIMIT, FEEDBACK_FILE_BYTES, sendFeedback } from "./feedback.ts";
import { type JsonObject, object, parse, type Value } from "./json.ts";
import { abspath, env, envSet, expandUser, join, LINUX } from "./paths.ts";
import { close, closeDir, type Dir, takeLock, writePrivate } from "./privatefs.ts";
import { codePoints, joinCodePoints, utf8 } from "./pystr.ts";
import { wholeWords } from "./scrub.ts";
import type { Call } from "./telemetry.ts";
import { ardiaRunning } from "./triage-evidence.ts";
import { buildReport, codeOf, formUrl, renderBody } from "./triage-report.ts";
import { removedLines, triageScrub } from "./triage-scrub.ts";
import { openExistingSession, readJsonIn, stringIn, TriageRefused, writeJsonIn } from "./triage-session.ts";
import { cliVersion, isDevBuild } from "./version.ts";

const REPOSITORY = "ardia-browser/ardia";
const TEST_REPOSITORY_ENV = "ARDIA_TRIAGE_REPO";
const TEMPLATE_NAME = "Triage report";
const REPORT_JSON = "prepared-report.json";
const REPORT_TEXT = "prepared-report.md";
const FILED_JSON = "filed.json";
const POST_PREFIX = "post-";
const POST_LOCK = "post.lock";
const OWN_FILES: readonly string[] = [REPORT_JSON, REPORT_TEXT, FILED_JSON, POST_LOCK, "session.json", "context.md", "playbook.md"];
const EVIDENCE_NAME = /^(?:README\.md|config\.json|usage-(?:cli-)?\d{4}-\d{2}-\d{2}\.jsonl|crash-[1-9]\.ips)$/;
const GH_TIMEOUT_MS = 60_000;
const GH_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_BODY_FILE = 256 * 1024;
const CODE = /^[0-9a-f]{8}$/;
const MODEL_NAME = /^[A-Za-z0-9._:/[\]-]{1,64}$/;
const CREATE_ISSUE =
  "mutation($repo:ID!,$template:String!,$title:String!,$body:String!){createIssue(input:{repositoryId:$repo,issueTemplate:$template,title:$title,body:$body}){issue{url labels(first:20){nodes{name}}}}}";
const FEEDBACK_NOTE = "\n\n[The full report is attached as a Markdown file.]";

export type TriageFileArgs = {
  title: string | undefined;
  body: string | undefined;
  post: string | undefined;
  via: string | undefined;
  attachEvidence: boolean;
  commentOn: string | undefined;
  session: string | undefined;
};

function flag(call: Call, name: string): void {
  call.metrics.set(name, true);
}

function repository(): string {
  if (!isDevBuild()) return REPOSITORY;
  const given = envSet(TEST_REPOSITORY_ENV);
  if (given === undefined || given.toLowerCase() === REPOSITORY || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(given)) {
    throw new TriageRefused(`this ardia is a checkout build (${cliVersion()}), which never files to ${REPOSITORY}; set ${TEST_REPOSITORY_ENV} to a test repository`);
  }
  return given;
}

function filedBy(record: JsonObject): string {
  const agent = stringIn(record, "agent");
  const who = agent === "claude" || agent === "codex" ? agent : "a coding agent";
  const model = stringIn(record, "model");
  const shownModel = model !== undefined && MODEL_NAME.test(model) ? `, model ${model}` : "";
  return `${who} via ardia triage ${cliVersion()}${shownModel}`;
}

function sameFile(one: string, other: string): boolean {
  try {
    return realpathSync(one) === realpathSync(other);
  } catch {
    return false;
  }
}

function readBody(path: string, sessionDir: string): string {
  const full = abspath(expandUser(path));
  let info;
  try {
    info = statSync(full);
  } catch {
    throw new TriageRefused(`${path}: there's no such file`);
  }
  if (!info.isFile()) throw new TriageRefused(`${path}: not a file`);
  const name = full.slice(full.lastIndexOf("/") + 1);
  const own = sameFile(full.slice(0, full.lastIndexOf("/")) || "/", sessionDir) && (OWN_FILES.includes(name) || name.startsWith(POST_PREFIX));
  if (own) throw new TriageRefused(`${path} is the copy ardia triage file writes; write the report in a file of your own, such as report.md`);
  if (info.size > MAX_BODY_FILE) throw new TriageRefused(`${path}: over ${MAX_BODY_FILE / 1024} KB; keep only the lines that matter`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(full));
  } catch {
    throw new TriageRefused(`${path}: isn't UTF-8 text`);
  }
}

function prepare(args: TriageFileArgs, dir: Dir, record: JsonObject, sessionDir: string, call: Call): Said {
  if (args.title === undefined || args.body === undefined) throw new TriageRefused('ardia triage file needs --title "…" and --body FILE, or --post CODE');
  const report = buildReport(args.title, readBody(args.body, sessionDir), filedBy(record));
  const fields: [string, Value][] = [...report.fields].map(([id, text]) => [id, text]);
  writeJsonIn(dir, REPORT_JSON, object([["code", report.code], ["title", report.title], ["body", report.body], ["fields", object(fields)], ["prepared_at", iso(now())]]));
  writePrivate(REPORT_TEXT, dir, utf8(report.text));
  flag(call, "triage_prepared");
  return {
    status: 0,
    out: [
      "This is the exact text that would be posted:",
      "",
      ...report.text.replace(/\n$/, "").split("\n"),
      "",
      "Removed before posting:",
      ...removedLines(report.removed),
      "",
      `Saved as ${join(sessionDir, REPORT_TEXT)}.`,
      `Code: ${report.code}`,
      `Once the user approves this exact text: ardia triage file --post ${report.code}`,
    ],
    err: [],
  };
}

type Stored = { code: string; title: string; body: string; fields: Map<string, string> };

function stored(dir: Dir): Stored | undefined {
  const doc = readJsonIn(dir, REPORT_JSON);
  if (doc === undefined) return undefined;
  const code = stringIn(doc, "code");
  const title = stringIn(doc, "title");
  const body = stringIn(doc, "body");
  const given = doc.get("fields");
  if (code === undefined || title === undefined || body === undefined || !(given instanceof Map)) return undefined;
  const fields = new Map<string, string>();
  for (const [key, value] of given) if (typeof value === "string") fields.set(key, value);
  return { code, title, body, fields };
}

type Filed = { code: string; via: string; where: string; state: string };

function filedEntries(dir: Dir): Filed[] {
  const list = readJsonIn(dir, FILED_JSON)?.get("filed");
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    if (!(entry instanceof Map)) return [];
    const [code, via, where, state] = ["code", "via", "where", "state"].map((key) => stringIn(entry, key));
    return code && via && where && state ? [{ code, via, where, state }] : [];
  });
}

function remember(dir: Dir, entry: Filed): void {
  const entries = filedEntries(dir).filter((item) => !(item.code === entry.code && item.via === entry.via));
  entries.push(entry);
  const rows: Value[] = entries.map((item) => object([["code", item.code], ["via", item.via], ["where", item.where], ["state", item.state], ["at", iso(now())]]));
  writeJsonIn(dir, FILED_JSON, object([["filed", rows]]));
}

function which(program: string): string | undefined {
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

type Ran = { status: number | null; stdout: string; stderr: string; timedOut: boolean };

function run(program: string, args: string[]): Ran {
  const done = spawnSync(program, args, { encoding: "utf8", timeout: GH_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: GH_OUTPUT_BYTES, stdio: ["ignore", "pipe", "pipe"] });
  const timedOut = (done.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  return { status: done.status, stdout: done.stdout ?? "", stderr: done.stderr ?? "", timedOut };
}

function firstLine(text: string): string {
  const line = text.split("\n").map((part) => part.trim()).find((part) => part !== "") ?? "";
  return joinCodePoints(codePoints(line).slice(0, 300));
}

function turnedDown(ran: Ran): boolean {
  return !ran.timedOut && /\(HTTP 4\d\d\)/.test(ran.stderr);
}

function signedIn(gh: string): boolean {
  return run(gh, ["auth", "status", "--hostname", "github.com"]).status === 0;
}

function jsonOf(text: string): Value | undefined {
  try {
    return parse(utf8(text), 32);
  } catch {
    return undefined;
  }
}

function dig(value: Value | undefined, ...keys: string[]): Value | undefined {
  let current = value;
  for (const key of keys) current = current instanceof Map ? current.get(key) : undefined;
  return current;
}

function postWithGh(gh: string, repo: string, report: Stored, dir: Dir, sessionDir: string, call: Call): Said {
  const node = run(gh, ["api", "--hostname", "github.com", `repos/${repo}`, "--jq", ".node_id"]);
  const nodeId = node.stdout.trim();
  if (node.status !== 0 || !/^[A-Za-z0-9_=-]{1,100}$/.test(nodeId)) {
    flag(call, "triage_refused");
    return { status: 1, out: [], err: [`ardia triage: gh couldn't look up ${repo} (${firstLine(node.stderr) || "no answer"}); nothing was filed. Try again, or use --via form.`] };
  }
  const titleFile = `${POST_PREFIX}title-${report.code}.txt`;
  const bodyFile = `${POST_PREFIX}body-${report.code}.md`;
  writePrivate(titleFile, dir, utf8(report.title));
  writePrivate(bodyFile, dir, utf8(report.body));
  const created = run(gh, [
    "api", "--hostname", "github.com", "graphql",
    "-f", `repo=${nodeId}`,
    "-f", `template=${TEMPLATE_NAME}`,
    "-F", `title=@${join(sessionDir, titleFile)}`,
    "-F", `body=@${join(sessionDir, bodyFile)}`,
    "-f", `query=${CREATE_ISSUE}`,
  ]);
  const answer = jsonOf(created.stdout);
  const issue = dig(answer, "data", "createIssue", "issue");
  const url = dig(issue, "url");
  if (created.status !== 0 || typeof url !== "string" || !url.startsWith("https://")) {
    flag(call, "triage_refused");
    const errors = dig(answer, "errors");
    const refused = Array.isArray(errors) && errors.length > 0;
    if (!refused && !turnedDown(created)) {
      const mine = `https://github.com/${repo}/issues?q=author%3A%40me`;
      remember(dir, { code: report.code, via: "gh", where: `unknown: gh gave no clear answer; check ${mine} before trying again`, state: "uncertain" });
      const what = created.timedOut ? `gh didn't answer in ${GH_TIMEOUT_MS / 1000} s` : `gh stopped without a clear answer (${firstLine(created.stderr) || "no message"})`;
      return { status: 1, out: [], err: [`ardia triage: ${what}, so the issue may or may not exist. Check ${mine} before filing again.`] };
    }
    const why = refused && errors[0] instanceof Map && typeof errors[0].get("message") === "string" ? (errors[0].get("message") as string) : firstLine(created.stderr);
    return { status: 1, out: [], err: [`ardia triage: GitHub refused the issue (${why || "no reason given"}); nothing was filed. Try --via form, or --via feedback.`] };
  }
  const labels = dig(issue, "labels", "nodes");
  const names = Array.isArray(labels) ? labels.map((label) => dig(label, "name")).filter((name): name is string => typeof name === "string") : [];
  remember(dir, { code: report.code, via: "gh", where: url, state: "filed" });
  flag(call, "triage_filed_gh");
  return { status: 0, out: [`Filed: ${url}`, names.includes("via-triage") ? "It has the via-triage label." : "It doesn't show the via-triage label; a maintainer will add it. Don't file it again."], err: [] };
}

async function openUrl(url: string, dataDir: string | undefined): Promise<string> {
  if (await ardiaRunning(dataRoot(dataDir))) {
    try {
      await callControl(dataDir, "apply", object([["ops", [object([["op", "open"], ["urls", [url]], ["activate", true]])]]]));
      return "in Ardia";
    } catch {}
  }
  const opener = which(LINUX ? "xdg-open" : "open");
  if (opener === undefined) return "";
  try {
    const child = spawn(opener, [url], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return "in your default browser";
  } catch {
    return "";
  }
}

async function postWithForm(repo: string, report: Stored, dir: Dir, sessionDir: string, dataDir: string | undefined, call: Call): Promise<Said> {
  const built = formUrl(`https://github.com/${repo}/issues/new`, report.title, report.fields);
  const where = await openUrl(built.url, dataDir);
  remember(dir, { code: report.code, via: "form", where: built.url, state: "opened" });
  flag(call, "triage_filed_form");
  const out = [
    where === "" ? "Open this link to file the report:" : `Opened the filled-in form ${where}. Read it, then click Submit; nothing is filed until you do.`,
    built.url,
  ];
  for (const cut of built.cuts) out.push(`${cut.heading} was cut from ${cut.from} to ${cut.to} characters to fit the link; the full text is in ${join(sessionDir, REPORT_TEXT)}.`);
  return { status: 0, out, err: [] };
}

function evidenceAttachments(dir: Dir, sessionDir: string, code: string, room: number): { paths: string[]; left: string[] } {
  const folder = join(sessionDir, "evidence");
  const paths: string[] = [];
  const left: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(folder);
  } catch {}
  for (const name of names.sort()) {
    const path = join(folder, name);
    let size = 0;
    try {
      const info = lstatSync(path);
      if (!info.isFile()) continue;
      size = info.size;
    } catch {
      continue;
    }
    if (size === 0) continue;
    if (!EVIDENCE_NAME.test(name) || !attachableName(name)) left.push(`${name} (not a file triage collected)`);
    else if (size > FEEDBACK_FILE_BYTES) left.push(`${name} (over ${FEEDBACK_FILE_BYTES / (1024 * 1024)} MB)`);
    else if (paths.length >= room) left.push(`${name} (at most ${FEEDBACK_ATTACHMENT_LIMIT} files go with a report)`);
    else {
      const scrubbed = triageScrub(new TextDecoder("utf-8").decode(readFileSync(path))).text;
      if (scrubbed === "") continue;
      const copy = `${POST_PREFIX}evidence-${code}-${name}`;
      writePrivate(copy, dir, utf8(`${scrubbed}\n`));
      paths.push(join(sessionDir, copy));
    }
  }
  return { paths, left };
}

function feedbackDescription(body: string): string {
  const room = FEEDBACK_DESCRIPTION_LIMIT - codePoints(FEEDBACK_NOTE).length;
  if (codePoints(body).length <= FEEDBACK_DESCRIPTION_LIMIT) return body;
  return `${wholeWords(body, room).trimEnd()}${FEEDBACK_NOTE}`;
}

async function postWithFeedback(args: TriageFileArgs, report: Stored, dir: Dir, sessionDir: string, dataDir: string | undefined, call: Call): Promise<Said> {
  const extra = args.attachEvidence ? evidenceAttachments(dir, sessionDir, report.code, FEEDBACK_ATTACHMENT_LIMIT - 1) : { paths: [], left: [] };
  const approved = `${POST_PREFIX}report-${report.code}.md`;
  writePrivate(approved, dir, utf8(`Title: ${report.title}\n\n${report.body}`));
  const sent = await sendFeedback(
    { text: [], title: report.title, kind: "bug", attach: [join(sessionDir, approved), ...extra.paths], about: undefined, dataDir, via: "triage", fingerprint: report.code },
    feedbackDescription(report.body),
  );
  if (sent.reference === undefined || sent.said.status !== 0) {
    flag(call, "triage_refused");
    return sent.said;
  }
  remember(dir, { code: report.code, via: "feedback", where: sent.reference, state: "filed" });
  flag(call, "triage_filed_feedback");
  const out = [...sent.said.out];
  if (args.attachEvidence) out.push(extra.paths.length > 0 ? `Attached ${extra.paths.length} evidence file${extra.paths.length === 1 ? "" : "s"} with the report.` : "No evidence file could be attached.");
  for (const left of extra.left) out.push(`Not attached: ${left}.`);
  return { ...sent.said, out };
}

function issueNumber(text: string): number {
  if (!/^[1-9][0-9]{0,8}$/.test(text)) throw new TriageRefused(`--comment-on takes an issue number, not ${JSON.stringify(text)}`);
  return Number(text);
}

function commentText(report: Stored): string {
  return `**${report.title}**\n\nAnother report of this from \`ardia triage\`:\n\n${report.body}`;
}

async function comment(number: number, via: string | undefined, repo: string, report: Stored, dir: Dir, sessionDir: string, dataDir: string | undefined, call: Call): Promise<Said> {
  const gh = via === "form" ? undefined : which("gh");
  const page = `https://github.com/${repo}/issues/${number}`;
  if (via === "gh" && (gh === undefined || !signedIn(gh))) throw new TriageRefused("gh isn't installed or is signed out; drop --via gh to open the issue in a browser instead");
  if (gh !== undefined && signedIn(gh)) {
    const looked = run(gh, ["api", "--hostname", "github.com", `repos/${repo}/issues/${number}`]);
    const issue = jsonOf(looked.stdout);
    if (looked.status !== 0 || !(issue instanceof Map)) {
      flag(call, "triage_refused");
      return { status: 1, out: [], err: [`ardia triage: there's no issue #${number} in ${repo} (${firstLine(looked.stderr) || "gh found nothing"}); nothing was posted.`] };
    }
    if (issue.has("pull_request")) throw new TriageRefused(`#${number} is a pull request, not an issue; nothing was posted`);
    if (issue.get("state") !== "open") throw new TriageRefused(`#${number} is closed; file a new report instead (drop --comment-on)`);
    const commentFile = `${POST_PREFIX}comment-${report.code}-${number}.md`;
    writePrivate(commentFile, dir, utf8(commentText(report)));
    const posted = run(gh, ["api", "--hostname", "github.com", `repos/${repo}/issues/${number}/comments`, "-F", `body=@${join(sessionDir, commentFile)}`]);
    const url = dig(jsonOf(posted.stdout), "html_url");
    if (posted.status !== 0 || typeof url !== "string") {
      if (!turnedDown(posted)) remember(dir, { code: report.code, via: `comment-${number}`, where: `unknown: gh gave no clear answer; check ${page}`, state: "uncertain" });
      flag(call, "triage_refused");
      return { status: 1, out: [], err: [`ardia triage: the comment didn't go through (${firstLine(posted.stderr) || "no answer"}). Check ${page} before trying again.`] };
    }
    remember(dir, { code: report.code, via: `comment-${number}`, where: url, state: "filed" });
    flag(call, "triage_commented");
    return { status: 0, out: [`Commented: ${url}`], err: [] };
  }
  const where = await openUrl(page, dataDir);
  remember(dir, { code: report.code, via: `comment-${number}`, where: page, state: "opened" });
  flag(call, "triage_commented");
  return {
    status: 0,
    out: [
      where === "" ? `Open ${page} and paste this as a comment:` : `Opened ${page} ${where}. Paste this as a comment there:`,
      "",
      ...commentText(report).replace(/\n$/, "").split("\n"),
    ],
    err: [],
  };
}

async function post(args: TriageFileArgs, code: string, dir: Dir, record: JsonObject, sessionDir: string, call: Call): Promise<Said> {
  const via = args.via;
  if (via !== undefined && !["gh", "form", "feedback"].includes(via)) throw new TriageRefused(`--via takes gh, form or feedback, not ${JSON.stringify(via)}`);
  if (args.commentOn !== undefined && via === "feedback") throw new TriageRefused("--comment-on adds to a GitHub issue, so it doesn't go with --via feedback");
  if (args.title !== undefined || args.body !== undefined) throw new TriageRefused("--post files the prepared report as it is; drop --title and --body, or prepare it again without --post");
  if (!CODE.test(code)) throw new TriageRefused(`${JSON.stringify(code)} isn't a report code; ardia triage file prints one when it prepares a report`);
  const commentVia = args.commentOn === undefined ? undefined : `comment-${issueNumber(args.commentOn)}`;
  const done = filedEntries(dir).find((entry) => entry.code === code && entry.state !== "opened" && (commentVia === undefined ? !entry.via.startsWith("comment-") : entry.via === commentVia));
  if (done !== undefined) {
    flag(call, "triage_refused");
    return { status: 0, out: [done.state === "uncertain" ? `Not sent again: the last try may have gone out (${done.where}).` : `Already filed: ${done.where}`], err: [] };
  }
  const report = stored(dir);
  if (report === undefined) throw new TriageRefused('there\'s no prepared report in this session; run ardia triage file --title "…" --body FILE first');
  if (report.code !== code) throw new TriageRefused(`${code} isn't the code of the prepared report (it's stale or mistyped); show the user the newest text and use its code`);
  if (codeOf(report.title, report.body) !== code || renderBody(report.fields) !== report.body) throw new TriageRefused("the prepared report was changed after it was prepared; prepare it again");
  const dataDir = stringIn(record, "data_dir");
  if (args.commentOn !== undefined) return comment(issueNumber(args.commentOn), via, repository(), report, dir, sessionDir, dataDir, call);
  if (via === "feedback") return postWithFeedback(args, report, dir, sessionDir, dataDir, call);
  if (via === "form") return postWithForm(repository(), report, dir, sessionDir, dataDir, call);
  const gh = which("gh");
  if (gh === undefined) {
    if (via === "gh") throw new TriageRefused("gh isn't installed; use --via form or --via feedback");
    return postWithForm(repository(), report, dir, sessionDir, dataDir, call);
  }
  if (!signedIn(gh)) {
    flag(call, "triage_refused");
    return { status: 3, out: [], err: ["ardia triage: gh is installed but signed out (gh auth login signs in); --via form and --via feedback are the other ways. Nothing was posted."] };
  }
  return postWithGh(gh, repository(), report, dir, sessionDir, call);
}

export async function runTriageFile(args: TriageFileArgs, call: Call): Promise<Said> {
  call.subcommand = "file";
  let opened;
  try {
    opened = openExistingSession(args.session);
  } catch (error) {
    if (error instanceof TriageRefused) {
      flag(call, "triage_refused");
      return { status: error.status, out: [], err: [`ardia triage file: ${error.message}`] };
    }
    throw error;
  }
  try {
    if (args.post === undefined && (args.via !== undefined || args.attachEvidence || args.commentOn !== undefined)) throw new TriageRefused("--via, --attach-evidence and --comment-on go with --post CODE");
    const lock = takeLock(POST_LOCK, opened.dir);
    if (lock === undefined) throw new TriageRefused("another ardia triage file --post is running in this session; wait for it, then check what it said before trying again", 1);
    try {
      if (args.post !== undefined) return await post(args, args.post, opened.dir, opened.record, opened.session.dir, call);
      return prepare(args, opened.dir, opened.record, opened.session.dir, call);
    } finally {
      close(lock);
    }
  } catch (error) {
    if (error instanceof TriageRefused) {
      flag(call, "triage_refused");
      return { status: error.status, out: [], err: [`ardia triage file: ${error.message}`] };
    }
    throw error;
  } finally {
    closeDir(opened.dir);
  }
}

