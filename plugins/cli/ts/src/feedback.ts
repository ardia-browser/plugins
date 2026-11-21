import { createHash, randomUUID } from "node:crypto";
import { openAsBlob, readSync, realpathSync, statSync } from "node:fs";
import { isatty } from "node:tty";
import { now } from "./clock.ts";
import { dataRoot } from "./control.ts";
import type { Said } from "./deliver.ts";
import { dumps, type JsonObject, object, parse, type Value } from "./json.ts";
import { abspath, envSet, errnoOf, expandUser, NeedsPython, strerror } from "./paths.ts";
import { close, closeDir, notFound, O_CREAT, O_RDONLY, O_TRUNC, O_WRONLY, openPrivateFile, readFd, renameIn, unlinkQuietly, writeOnce } from "./privatefs.ts";
import { fixed, isSpace, reprStr, strip } from "./py.ts";
import { codePoints, utf8 } from "./pystr.ts";
import { routedCaller } from "./routed.ts";
import { freeText, onlyPlaceholders, scrub } from "./scrub.ts";
import { systemInfo } from "./system-info.ts";
import { environmentFor, loopbackUrl, readConsent, sessionId, sharingId } from "./telemetry.ts";
import { openUsageFolder, recentCommands, recordingHome, releaseFeedbackSlot, takeFeedbackSlot, usagePath } from "./usage-store.ts";
import { cliVersion, isDevBuild } from "./version.ts";

const FEEDBACK_URL = "https://ardia.dev/api/feedback";
const TEST_URL_ENV = "ARDIA_FEEDBACK_URL";
export const KINDS: readonly string[] = ["bug", "slow", "idea", "other"];
const MAX_TITLE = 67;
const MAX_DESCRIPTION = 4000;
const MAX_COMMAND = 300;
const MAX_STDIN_BYTES = 64 * 1024;
const MAX_ATTACHMENTS = 10;
const MB = 1024 * 1024;
const RECORDING: Kind = ["recording.mp4", 100 * MB, "video/mp4"];
const TRACE: Kind = ["trace.json.gz", 50 * MB, "application/gzip"];
const OTHER_FILE_BYTES = 10 * MB;
const OTHER_TYPES: Readonly<Record<string, string>> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic", mov: "video/quicktime",
  txt: "text/plain", log: "text/plain", md: "text/markdown", json: "application/json", jsonl: "application/x-ndjson", csv: "text/csv",
};
const REQUEST_TIMEOUT_MS = 15_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const DAILY_LIMIT = 20;
const WINDOW_S = 24 * 60 * 60;
const LOCAL_FILE = "feedback.jsonl";
const MAX_LOCAL_LINES = 200;
const REFERENCE = /^FB-[A-Z0-9]{2,16}$/;
const TOKEN = /^[\x21-\x7e]{8,512}$/;
const INGEST_KEY_HEADER = "X-Ardia-Key";
const CLI_INGEST_KEY = "ak_cli_67adb8ebc49841125eda860e";
const TEST_ENDPOINT_ENV = ["ARDIA_WS", "ARDIA_PORT", "ARDIA_CDP_URL", "AGENT_BROWSER_CDP"];
const OFF_VALUES = ["0", "false", "off", "no"];
const CALLER_FALLBACK = "unknown";

type Kind = [string, number, string];
type Attachment = { path: string; name: string; bytes: number; type: string };
type Outcome = { sent: boolean; reason: string; reference?: string; name?: string; issueUrl?: string };
export type FeedbackArgs = { text: string[]; title: string | undefined; kind: string; attach: string[]; about: string | undefined; dataDir: string | undefined };

class Refused extends Error {}

function readStdin(): string {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total < MAX_STDIN_BYTES) {
    const chunk = Buffer.alloc(MAX_STDIN_BYTES - total);
    let got: number;
    try {
      got = readSync(0, chunk, 0, chunk.length, null);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EINTR" || code === "EAGAIN") continue;
      if (code === "EOF") break;
      throw error;
    }
    if (got === 0) break;
    chunks.push(chunk.subarray(0, got));
    total += got;
  }
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(Buffer.concat(chunks));
}

function readText(words: string[]): string {
  if (words.length > 0 && !(words.length === 1 && words[0] === "-")) return words.join(" ");
  if (words.length === 0 && isatty(0)) return "";
  return readStdin();
}

function splitWords(text: string): string[] {
  const words: string[] = [];
  let current: string[] = [];
  for (const ch of codePoints(text)) {
    if (isSpace(ch)) {
      if (current.length > 0) words.push(current.join(""));
      current = [];
    } else current.push(ch);
  }
  if (current.length > 0) words.push(current.join(""));
  return words;
}

function cleanTitle(given: string | undefined): string {
  const title = splitWords(given ?? "").join(" ");
  if (title === "") throw new Refused(`ardia feedback needs --title "…" (1-${MAX_TITLE} characters)`);
  const length = codePoints(title).length;
  if (length > MAX_TITLE) throw new Refused(`the title is ${length} characters; keep it to ${MAX_TITLE}`);
  const clean = scrub(title);
  if (onlyPlaceholders(clean)) throw new Refused("nothing is left of the title once secrets and personal data are removed; describe the problem instead");
  return clean;
}

function cleanDescription(text: string): [string, boolean] {
  const stripped = strip(text, isSpace);
  if (stripped === "") throw new Refused('ardia feedback needs a description: ardia feedback --title "…" "what happened, what you expected"');
  const [clean, truncated] = freeText(stripped, MAX_DESCRIPTION);
  if (onlyPlaceholders(clean)) throw new Refused("nothing is left of the description once secrets and personal data are removed; describe what happened without them");
  return [clean, truncated];
}

function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

function attachmentKind(path: string, counts: Map<string, number>): Kind {
  const name = baseName(path);
  const lower = name.toLowerCase();
  const bump = (key: string) => {
    const value = (counts.get(key) ?? 0) + 1;
    counts.set(key, value);
    return value;
  };
  if (lower.endsWith(".mp4")) {
    if (bump("mp4") > 1) throw new Refused("only one .mp4 recording can be attached");
    return RECORDING;
  }
  if (lower.endsWith(".json.gz")) {
    if (bump("trace") > 1) throw new Refused("only one .json.gz trace can be attached");
    return TRACE;
  }
  if (lower.endsWith(".ips")) return [`crash-${bump("ips")}.ips`, OTHER_FILE_BYTES, "text/plain"];
  const extension = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  const type = Object.hasOwn(OTHER_TYPES, extension) ? OTHER_TYPES[extension] : undefined;
  if (type === undefined) throw new Refused(`${name}: can't attach this kind of file (see ardia feedback --help for the kinds)`);
  return [`attachment-${bump("other")}.${extension}`, OTHER_FILE_BYTES, type];
}

function attachments(files: string[]): Attachment[] {
  if (files.length > MAX_ATTACHMENTS) throw new Refused(`at most ${MAX_ATTACHMENTS} files can be attached`);
  const counts = new Map<string, number>();
  const found: Attachment[] = [];
  for (const file of files) {
    const path = expandUser(file);
    let info;
    try {
      info = statSync(path);
    } catch (error) {
      const errno = errnoOf(error);
      throw new Refused(`${file}: ${errno ? strerror(errno) : "can not be read"}`);
    }
    if (!info.isFile()) throw new Refused(`${file}: not a file`);
    const [name, cap, type] = attachmentKind(path, counts);
    if (info.size === 0) throw new Refused(`${file}: the file is empty`);
    if (info.size > cap) throw new Refused(`${file}: ${fixed(info.size / MB, 1)} MB is over the ${Math.floor(cap / MB)} MB limit for this kind of file`);
    found.push({ path: realpathSync(abspath(path)), name, bytes: info.size, type });
  }
  return found;
}

function urlPath(base: string): string {
  const rest = base.slice(base.indexOf("://") + 3);
  const slash = rest.search(/[/?#]/);
  if (slash < 0 || rest[slash] !== "/") return "";
  const tail = rest.slice(slash);
  const end = tail.search(/[?#]/);
  return end < 0 ? tail : tail.slice(0, end);
}

function feedbackUrl(): [string | undefined, string] {
  const override = envSet(TEST_URL_ENV);
  if (override !== undefined) {
    if (override.includes("\n") || override.includes("\r") || override.includes("\t")) throw new NeedsPython("a feedback URL with a line break");
    const afterScheme = override.includes("://") ? override.slice(override.indexOf("://") + 3) : override;
    if (loopbackUrl(afterScheme.includes("/") ? override : `${override}/`)) {
      const base = override.replace(/\/+$/, "");
      const path = urlPath(base);
      return [path === "" || path === "/" ? `${base}/api/feedback` : base, ""];
    }
    return [undefined, `${TEST_URL_ENV} isn't a loopback http:// URL`];
  }
  if (isDevBuild()) {
    return [undefined, `this ardia is a checkout build (${cliVersion()}), which never sends to ardia.dev; set ${TEST_URL_ENV} to a local service`];
  }
  return [FEEDBACK_URL, ""];
}

function blockedReason(): string | undefined {
  const doNotTrack = strip(process.env.DO_NOT_TRACK ?? "", isSpace);
  if (!["", "0", "false"].includes(doNotTrack.toLowerCase())) return `DO_NOT_TRACK=${doNotTrack} is set`;
  const sharing = strip(process.env.ARDIA_TELEMETRY ?? "", isSpace);
  if (OFF_VALUES.includes(sharing.toLowerCase())) return `ARDIA_TELEMETRY=${sharing} is set`;
  for (const name of TEST_ENDPOINT_ENV) if (envSet(name) !== undefined) return `${name} points ardia at a test browser`;
  return undefined;
}

function callerName(): string {
  try {
    const name = (routedCaller() as JsonObject).get("name");
    return typeof name === "string" ? name : CALLER_FALLBACK;
  } catch {
    return CALLER_FALLBACK;
  }
}

function appBuild(value: Value | undefined): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  return null;
}

function body(args: FeedbackArgs, title: string, description: string, truncated: boolean, found: Attachment[], doc: JsonObject | undefined, installId: string, environment: string, home: string | undefined): JsonObject {
  const info = systemInfo();
  const aboutClean = args.about ? freeText(args.about, MAX_COMMAND)[0] : null;
  const version = doc?.get("lastVersion");
  const channel = doc?.get("channel");
  return object([
    ["kind", args.kind],
    ["title", title],
    ["description", description],
    ["source", "cli"],
    ["install_id", installId],
    ["session_id", sessionId(doc)],
    ["app_version", typeof version === "string" ? version : null],
    ["app_build", appBuild(doc?.get("lastBuild"))],
    ["channel", typeof channel === "string" ? channel : null],
    ["os_version", info.osVersion],
    ["arch", info.arch],
    ["cli_version", cliVersion()],
    ["watch_days", 0n],
    [
      "diagnostics",
      object([
        ["agent", callerName()],
        ["about_command", aboutClean || null],
        ["recent_commands", home !== undefined ? recentCommands(home) : []],
        ["description_truncated", truncated],
        ["environment", environment],
      ]),
    ],
    ["attachments", found.map((item) => object([["name", item.name], ["bytes", BigInt(item.bytes)], ["type", item.type]]))],
  ]);
}

function networkReason(error: unknown): string {
  const cause = (error as { cause?: unknown })?.cause ?? error;
  const code = (cause as NodeJS.ErrnoException)?.code;
  if (code === "ConnectionRefused" || code === "ECONNREFUSED") return "[Errno 61] Connection refused";
  if ((error as Error)?.name === "TimeoutError" || code === "ETIMEDOUT") return "timed out";
  const message = (cause as Error)?.message ?? String(cause);
  return message;
}

function serviceRefusal(status: number, raw: Buffer): string {
  let message: Value | undefined;
  try {
    const parsed = parse(raw, 1000);
    message = parsed instanceof Map ? parsed.get("message") : undefined;
  } catch {
    message = undefined;
  }
  if (typeof message === "string" && strip(message, isSpace) !== "") {
    return `the feedback service answered HTTP ${status}: ${freeText(message, 200)[0]}`;
  }
  return `the feedback service answered HTTP ${status}`;
}

async function limitedBody(response: Response, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (reader === undefined) return Buffer.alloc(0);
  while (total < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    total += value.length;
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks).subarray(0, limit);
}

async function request(method: string, url: string, data: Buffer | Blob, headers: Record<string, string>, timeoutMs: number): Promise<[number, JsonObject, string]> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      body: data,
      headers: { [INGEST_KEY_HEADER]: CLI_INGEST_KEY, ...headers },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return [0, new Map(), `the network failed (${networkReason(error)})`];
  }
  if (response.status >= 300) return [response.status, new Map(), serviceRefusal(response.status, await limitedBody(response, 8192))];
  const raw = await limitedBody(response, 64 * 1024);
  let answer: Value | undefined;
  try {
    answer = raw.length > 0 ? parse(raw, 1000) : new Map();
  } catch {
    answer = undefined;
  }
  return [response.status, answer instanceof Map ? answer : new Map(), ""];
}

function postJson(url: string, payload: JsonObject, token?: string): Promise<[number, JsonObject, string]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return request("POST", url, utf8(dumps(payload, "spaced")), headers, REQUEST_TIMEOUT_MS);
}

async function upload(url: string, item: Attachment, token: string): Promise<[number, string]> {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": item.type, "Content-Length": String(item.bytes) };
  const [status, , failure] = await request("PUT", `${url}/files/${encodeURIComponent(item.name)}`, await openAsBlob(item.path), headers, UPLOAD_TIMEOUT_MS);
  return [status, failure];
}

function issueLink(value: Value | undefined, base: string): string | undefined {
  if (typeof value !== "string" || codePoints(value).length > 2048) return undefined;
  if (value.startsWith("https://") || (value.startsWith("file://") && loopbackUrl(`${base}/`))) return value;
  return undefined;
}

function ok(status: number): boolean {
  return status >= 200 && status < 300;
}

async function submit(base: string, payload: JsonObject, found: Attachment[]): Promise<Outcome> {
  const [status, created, failure] = await postJson(base, payload);
  if (!ok(status)) return { sent: false, reason: failure || `the feedback service answered HTTP ${status}` };
  const reference = created.get("id");
  const token = created.get("upload_token");
  if (typeof reference !== "string" || !REFERENCE.test(reference) || typeof token !== "string" || !TOKEN.test(token)) {
    return { sent: false, reason: "the feedback service gave an answer ardia couldn't read" };
  }
  const itemUrl = `${base}/${encodeURIComponent(reference)}`;
  for (const item of found) {
    const [uploaded, failed] = await upload(itemUrl, item, token);
    if (!ok(uploaded)) return { sent: false, reason: `uploading ${baseName(item.path)} failed: ${failed || `HTTP ${uploaded}`}`, reference };
  }
  const [finished, done, failedToFinish] = await postJson(`${itemUrl}/complete`, new Map(), token);
  if (!ok(finished)) return { sent: false, reason: `finishing ${reference} failed: ${failedToFinish || `HTTP ${finished}`}`, reference };
  const doneName = done.get("name");
  const name = typeof doneName === "string" ? doneName : created.get("name");
  const outcome: Outcome = { sent: true, reason: "", reference };
  if (typeof name === "string") outcome.name = name;
  const link = issueLink(done.get("issue_url"), base);
  if (link !== undefined) outcome.issueUrl = link;
  return outcome;
}

function splitLines(raw: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const byte = raw[index];
    if (byte === 0x0a || byte === 0x0d) {
      const end = byte === 0x0d && raw[index + 1] === 0x0a ? index + 2 : index + 1;
      lines.push(raw.subarray(start, end));
      start = end;
      index = end - 1;
    }
  }
  if (start < raw.length) lines.push(raw.subarray(start));
  return lines;
}

function saveLocally(home: string, entry: JsonObject): string {
  const dir = openUsageFolder(home);
  try {
    let lines: Buffer[] = [];
    try {
      const fd = openPrivateFile(LOCAL_FILE, dir, O_RDONLY);
      try {
        lines = splitLines(readFd(fd, MAX_LOCAL_LINES * 8192));
      } finally {
        close(fd);
      }
    } catch (error) {
      if (!notFound(error)) throw error;
    }
    lines.push(utf8(`${dumps(entry, "spaced")}\n`));
    const temp = `.${LOCAL_FILE}.${process.pid}.tmp`;
    const fd = openPrivateFile(temp, dir, O_WRONLY | O_CREAT | O_TRUNC);
    try {
      writeOnce(fd, Buffer.concat(lines.slice(Math.max(0, lines.length - MAX_LOCAL_LINES))));
    } catch (error) {
      close(fd);
      unlinkQuietly(temp, dir);
      throw error;
    }
    close(fd);
    renameIn(dir, temp, LOCAL_FILE);
  } finally {
    closeDir(dir);
  }
  return usagePath(home, LOCAL_FILE);
}

function errorText(error: unknown): string {
  const errno = errnoOf(error);
  if (!errno) return (error as Error)?.message ?? String(error);
  const path = (error as NodeJS.ErrnoException).path;
  return `[Errno ${errno}] ${strerror(errno)}${typeof path === "string" ? `: ${reprStr(path)}` : ""}`;
}

function keep(home: string | undefined, entry: JsonObject, reason: string): Said {
  if (home === undefined) {
    return { status: 1, out: [`Not sent: ${reason}. It wasn't saved either: a checkout build keeps notes only with ARDIA_CLI_HOME set.`], err: [] };
  }
  const kept = new Map(entry);
  kept.set("reason", reason);
  try {
    const path = saveLocally(home, kept);
    return { status: 1, out: [`Not sent: ${reason}. It's kept on this Mac: ${path}`], err: [] };
  } catch (error) {
    return { status: 1, out: [`Not sent: ${reason}. It couldn't be saved on this Mac either (${errorText(error)}).`], err: [] };
  }
}

function utcStamp(): string {
  return `${new Date(Math.floor(now()) * 1000).toISOString().slice(0, 19)}Z`;
}

export async function runFeedback(args: FeedbackArgs): Promise<Said> {
  const text = readText(args.text);
  let title: string;
  let description: string;
  let truncated: boolean;
  let found: Attachment[];
  try {
    title = cleanTitle(args.title);
    [description, truncated] = cleanDescription(text);
    found = attachments(args.attach);
  } catch (error) {
    if (error instanceof Refused) return { status: 2, out: [], err: [`ardia feedback: ${error.message}`] };
    throw error;
  }
  const home = recordingHome();
  const explicit = args.dataDir || envSet("ARDIA_DATA_DIR");
  const root = explicit || !isDevBuild() ? abspath(dataRoot(explicit)) : undefined;
  const doc = root !== undefined ? readConsent(root) : undefined;
  const sharedId = sharingId(doc);
  const installId = sharedId ?? randomUUID();
  const environment = root !== undefined ? environmentFor(root) : "dev";
  const payload = body(args, title, description, truncated, found, doc, installId, environment, home);
  const diagnostics = payload.get("diagnostics") as JsonObject;
  const entry = object([
    ["at", utcStamp()],
    ["kind", payload.get("kind") as Value],
    ["title", title],
    ["description", description],
    ["cli_version", cliVersion()],
    ["about_command", diagnostics.get("about_command") as Value],
    ["attachments", found.map((item) => item.path)],
  ]);
  const [base, urlProblem] = feedbackUrl();
  const reason = blockedReason() || urlProblem;
  if (reason || base === undefined) return keep(home, entry, reason);
  const digest = createHash("sha256").update(utf8(`${args.kind}\0${title}\0${description}`)).digest("hex").slice(0, 16);
  const slot = home !== undefined ? takeFeedbackSlot(home, digest, DAILY_LIMIT, WINDOW_S, now()) : "ok";
  if (slot === "duplicate") return { status: 0, out: ["Not sent again: the same report already went out in the last day."], err: [] };
  if (slot === "limited") return keep(home, entry, `${DAILY_LIMIT} reports already went out in the last day`);
  if (slot !== "ok") return keep(home, entry, "another ardia was updating the report count (try again)");
  const outcome = await submit(base, payload, found);
  if (!outcome.sent) {
    if (home !== undefined) releaseFeedbackSlot(home, digest);
    const kept = new Map(entry);
    if (outcome.reference) kept.set("reference", outcome.reference);
    return keep(home, kept, outcome.reason);
  }
  const out = [`Sent. Reference ${outcome.reference}.`];
  out.push(outcome.issueUrl ? `Issue: ${outcome.issueUrl}` : "No public issue was opened for it; the developer still has it.");
  if (outcome.name) out.push(`You appear to us as ${outcome.name}${sharedId !== undefined ? "" : " (a one-time id: sharing is off)"}.`);
  return { status: 0, out, err: [] };
}

