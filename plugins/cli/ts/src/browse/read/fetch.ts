import fs from "node:fs";
import tls from "node:tls";
import { groupThousands } from "../../pylib/format.ts";
import { pyStrip } from "../../pylib/str.ts";
import { urljoin, urlsplit } from "../../pylib/urllib.ts";
import { Cancelled, currentSignal, untilCancelled } from "../cdp/cancel.ts";
import { BrowseError } from "../daemon-errors.ts";
import { Result } from "../daemon/render.ts";
import { normalizeUrl } from "../commands/parse.ts";
import { decode } from "./charset.ts";
import { type FastResult, fastRead, type Probe } from "./fastpath.ts";
import type { HopGuard } from "./netguard.ts";
import { textFromBytes } from "./pdftext.ts";
import { extractHtml, llmsCandidates, llmsHrefs, llmsLinks, MARKDOWN_TYPES, MAX_BODY, postProcess, sameDocument } from "./readurl.ts";

export const ACCEPT = "text/markdown, text/plain;q=0.9, text/html;q=0.8, */*;q=0.5";
export const USER_AGENT = "ardia-browse-read/1";
const CHARSET = /charset=([\p{L}\p{N}\p{M}\p{Pc}-]+)/u;
const REDIRECTS = 10;
const WEB_SCHEMES = new Set(["http", "https"]);
const TEXT_TYPES = new Set([
  "application/json", "application/ld+json", "application/x-ndjson", "application/xml", "application/xhtml+xml", "application/rss+xml",
  "application/atom+xml", "application/javascript", "application/ecmascript", "application/x-javascript", "application/x-www-form-urlencoded",
  "application/yaml", "application/x-yaml", "application/toml", "application/x-sh", "application/sql", "image/svg+xml",
  "audio/x-mpegurl", "audio/mpegurl", "application/x-mpegurl", "application/vnd.apple.mpegurl", "audio/x-scpls",
]);
const BINARY_FAMILIES = ["image/", "audio/", "video/", "font/"];
const BINARY_TYPES = new Set([
  "application/zip", "application/gzip", "application/x-gzip", "application/x-tar", "application/x-7z-compressed", "application/x-rar-compressed",
  "application/vnd.rar", "application/x-bzip2", "application/x-xz", "application/zstd", "application/wasm", "application/x-sqlite3",
  "application/protobuf", "application/x-protobuf", "application/vnd.google.protobuf", "application/msgpack", "application/x-msgpack",
  "application/cbor", "application/bson", "application/msword", "application/vnd.ms-excel", "application/vnd.ms-powerpoint", "application/x-msdownload", "application/java-archive",
]);
const QUOTED_CHARSET = /charset\s*=\s*"([^"]+)"/iu;
const NAMED_CHARSET = /charset\s*=\s*([^;"\s]+)/iu;
const TEXT_CONTROLS = new Set([0x09, 0x0a, 0x0c, 0x0d, 0x1b]);

function holdsControlBytes(body: Uint8Array): boolean {
  for (const byte of body) if (byte < 0x20 && !TEXT_CONTROLS.has(byte)) return true;
  return false;
}
const UNICODE_CHARSETS = /^utf(16|32)(le|be)?$/u;

export type Fetched = [number, string, string, string, Uint8Array?];
export type BinaryMode = "refuse" | "keep" | "skip";
export type ReadOptions = Record<string, unknown>;

let extraRoots: string[] | null | undefined;

export function trustedRoots(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const extra: string[] = [];
  for (const name of ["SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"]) {
    const file = env[name];
    if (!file) continue;
    try {
      extra.push(fs.readFileSync(file, "utf8"));
    } catch {}
  }
  return extra.length ? [...tls.rootCertificates, ...extra] : null;
}

function roots(): string[] | null {
  if (extraRoots === undefined) extraRoots = trustedRoots();
  return extraRoots;
}

export function reasonOf(error: unknown): string {
  const code = typeof error === "object" && error !== null ? String((error as { code?: unknown }).code ?? "") : "";
  const message = error instanceof Error ? error.message : String(error);
  if (code === "ConnectionRefused" || code === "ECONNREFUSED") return "[Errno 61] Connection refused";
  if (code === "ENOTFOUND" || code === "DNSException" || /getaddrinfo|DNS|resolve host/iu.test(message)) return "[Errno 8] nodename nor servname provided, or not known";
  if (/CERT|SELF_SIGNED|ALTNAME|certificate/iu.test(code + message)) return `[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: ${code || message}`;
  return code ? `${code}: ${message}` : message;
}

class FetchTimeout extends Error {}

async function readBody(response: Response, limit: number, arm: () => void): Promise<Uint8Array> {
  const reader = (response.body as ReadableStream<Uint8Array> | null)?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await untilCancelled(reader.read());
      if (done) break;
      arm();
      chunks.push(value);
      size += value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const whole = Buffer.concat(chunks);
  return whole.subarray(0, Math.min(whole.length, limit));
}

export function textualType(kind: string): boolean {
  return kind.startsWith("text/") || TEXT_TYPES.has(kind) || kind.endsWith("+json") || kind.endsWith("+xml");
}

export function binaryType(kind: string): boolean {
  if (textualType(kind)) return false;
  return BINARY_TYPES.has(kind) || BINARY_FAMILIES.some((family) => kind.startsWith(family)) || kind.startsWith("application/vnd.openxmlformats-") || kind.startsWith("application/vnd.oasis.opendocument.");
}

export function binaryBody(kind: string, charset: string | null, body: Uint8Array): boolean {
  if (textualType(kind)) return false;
  if (binaryType(kind)) return true;
  if (charset !== null && UNICODE_CHARSETS.test(charset.toLowerCase().replaceAll(/[-_]/gu, ""))) return false;
  if (holdsControlBytes(body)) return true;
  const sample = body.length > MAX_BODY ? trimmedToChar(body.subarray(0, MAX_BODY)) : body;
  if (charset !== null && !/^utf-?8$/iu.test(charset)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return false;
  } catch {
    return true;
  }
}

function sequenceLength(lead: number): number {
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 0;
}

function trimmedToChar(head: Uint8Array): Uint8Array {
  const end = head.length;
  for (let back = 1; back <= 3 && end - back >= 0; back += 1) {
    const unit = head[end - back] as number;
    if ((unit & 0xc0) === 0x80) continue;
    return sequenceLength(unit) > back ? head.subarray(0, end - back) : head;
  }
  return head;
}

export function locationText(location: string): string {
  if (!/[\x80-\xff]/u.test(location) || /[^\x00-\xff]/u.test(location)) return location;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(location, "latin1"));
  } catch {
    return location;
  }
}

export function requestUrl(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    throw new BrowseError(`${url} isn't a URL read can fetch`, null, "usage");
  }
}

export class UnsafeAddress extends BrowseError {
  constructor(url: string) {
    super(`Didn't fetch ${url}: it's on a private, local or link-local address the page doesn't share an origin with`, null, "unsafe_address");
  }
}

export async function fetchUrl(url: string, timeout: number, accept = ACCEPT, binary: BinaryMode = "refuse", guard: HopGuard | null = null): Promise<Fetched> {
  const parts = urlsplit(url);
  if (parts.scheme !== "http" && parts.scheme !== "https") throw new BrowseError(`read fetches http(s) URLs only, not ${url}`);
  const requested = requestUrl(url);
  const controller = new AbortController();
  const outer = currentSignal();
  const stop = () => controller.abort(new Cancelled());
  outer?.addEventListener("abort", stop, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new FetchTimeout("timed out")), Math.max(1, timeout * 1000));
  };
  arm();
  try {
    let response: Response;
    let body: Uint8Array;
    try {
      const ca = roots();
      let target = requested;
      let landed = url;
      for (let hop = 0; ; hop += 1) {
        if (guard !== null && !(await untilCancelled(guard(target)))) throw new UnsafeAddress(target);
        response = await untilCancelled(
          fetch(target, {
            headers: { Accept: accept, "User-Agent": USER_AGENT },
            redirect: "manual",
            signal: controller.signal,
            ...(ca ? { tls: { ca } } : {}),
          } as RequestInit),
        );
        const location = response.headers.get("location");
        if (![301, 302, 303, 307, 308].includes(response.status) || !location || hop >= REDIRECTS) break;
        let next: string;
        try {
          const joined = urljoin(target, locationText(location));
          if (!WEB_SCHEMES.has(urlsplit(joined).scheme.toLowerCase())) break;
          next = requestUrl(joined);
        } catch {
          break;
        }
        response.body?.cancel().catch(() => {});
        target = next;
        landed = next;
        arm();
      }
      if (response.status < 200 || response.status >= 300) {
        response.body?.cancel().catch(() => {});
        return [response.status, "", "", url];
      }
      arm();
      body = await readBody(response, MAX_BODY + 1, arm);
      Object.defineProperty(response, "finalUrl", { value: landed });
    } catch (error) {
      if (error instanceof UnsafeAddress) throw error;
      if (error instanceof Cancelled || controller.signal.reason instanceof Cancelled) throw new Cancelled();
      if (controller.signal.reason instanceof FetchTimeout) throw new BrowseError(`Couldn't fetch ${url}: timed out`);
      throw new BrowseError(`Couldn't fetch ${url}: ${reasonOf(error)}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    const final = (response as unknown as { finalUrl: string }).finalUrl;
    const kind = pyStrip(contentType.split(";")[0] as string).toLowerCase();
    const pdf = kind === "application/pdf" || (body[0] === 0x25 && body[1] === 0x50 && body[2] === 0x44 && body[3] === 0x46);
    if (pdf && binary === "skip") return [response.status, "application/pdf", "", final, new Uint8Array()];
    if (pdf && binary === "keep") {
      if (body.length > MAX_BODY) throw new BrowseError(`${url} sent a binary file over ${groupThousands(String(MAX_BODY))} bytes; read --http --out saves files up to that size`, null, "result_too_large");
      return [response.status, "application/pdf", "", final, body];
    }
    if (pdf) {
      if (body.length > MAX_BODY) throw new BrowseError(`${url} is a PDF over ${MAX_BODY} bytes; read it in a tab instead (drop --http)`);
      return [response.status, "application/pdf", await textFromBytes(body), final];
    }
    const charset = CHARSET.exec(contentType) ?? QUOTED_CHARSET.exec(contentType) ?? NAMED_CHARSET.exec(contentType);
    const declared = charset ? (charset[1] as string) : null;
    if (binaryBody(kind, declared, body)) {
      const size = body.length > MAX_BODY ? `over ${groupThousands(String(MAX_BODY))}` : groupThousands(String(body.length));
      if (binary === "skip") return [response.status, kind || "application/octet-stream", "", final, new Uint8Array()];
      if (binary === "refuse") throw new BrowseError(`${url} sent a binary file (${kind || "no content type"}, ${size} bytes), not text; save it with read --http ${url} --out <file>`, null, "binary_body");
      if (body.length > MAX_BODY) throw new BrowseError(`${url} sent a binary file over ${groupThousands(String(MAX_BODY))} bytes; read --http --out saves files up to that size`, null, "result_too_large");
      return [response.status, kind || "application/octet-stream", "", final, body];
    }
    if (binary === "keep" && body.length > MAX_BODY) throw new BrowseError(`${url} sent over ${groupThousands(String(MAX_BODY))} bytes; read --http --out saves responses up to that size`, null, "result_too_large");
    if (binary === "skip" && body.length > MAX_BODY) return [response.status, kind, "", final];
    const text = decode(body.subarray(0, MAX_BODY), declared ?? "utf-8");
    return [response.status, kind, text, final];
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", stop);
  }
}

export async function nearestLlms(url: string, timeout: number, name = "llms.txt"): Promise<[string | null, string | null]> {
  for (const candidate of llmsCandidates(url, name)) {
    const [status, , text, final] = await fetchUrl(candidate, timeout, "text/plain, text/markdown", "skip");
    if (status === 200 && text && !text.slice(0, 500).toLowerCase().includes("<html")) return [final, text];
  }
  return [null, null];
}

function rstripSlash(text: string): string {
  return text.replace(/\/+$/u, "");
}

export function fastResult(url: string, found: FastResult): Result {
  const note = `[read via ${found.method} from ${found.source}]`;
  return new Result(
    { content: found.content, contentType: found.contentType, finalUrl: found.finalUrl, method: found.method, source: found.source, title: found.title, tried: found.tried, truncated: false, url },
    found.content ? `${found.content}\n${note}` : note,
    true,
  );
}

export async function run(given: string, options: ReadOptions, globalOptions: ReadOptions): Promise<Result> {
  const url = normalizeUrl(given);
  const timeout = Number(options["timeout"] || 10000) / 1000;
  const filter = (options["filter"] as string | undefined) ?? null;
  if (options["fast"]) {
    const probe: Probe = { tried: [], binary: null };
    const found = await fastRead(url, timeout, fetchUrl, { outline: options["outline"], filter }, true, probe);
    if (found !== null) return fastResult(url, found);
    if (probe.binary === null) throw new BrowseError(`Couldn't read ${url}: it sent no Markdown, llms.txt, ard.json or HTML`, null, "navigation_failed");
    const { fast, ...plain } = options;
    return run(given, plain, globalOptions);
  }
  if (options["llms"]) {
    const mode = options["llms"];
    if (mode !== "index" && mode !== "full") throw new BrowseError("--llms takes index or full");
    const [source, text] = await nearestLlms(url, timeout, mode === "index" ? "llms.txt" : "llms-full.txt");
    if (text === null || source === null) throw new BrowseError(`No ${mode === "index" ? "llms.txt" : "llms-full.txt"} found at or above ${url}`);
    const content = mode === "index" ? llmsLinks(text, source, filter).join("\n") : postProcess(text, { outline: options["outline"], filter });
    return new Result({ content, source, contentType: "text/plain", url }, content, true);
  }
  const saving = Boolean(globalOptions["out_body"]);
  let [status, kind, text, final, binary] = await fetchUrl(url, timeout, ACCEPT, saving ? "keep" : "refuse");
  if (status >= 400) throw new BrowseError(`${url} answered HTTP ${status}`);
  if (binary !== undefined) {
    if (options["require_md"]) throw new BrowseError(`${url} didn't answer with text/markdown (got ${kind})`);
    const result = new Result({ url, finalUrl: final, contentType: kind, source: "response", bytes: binary.length }, `a ${kind} file of ${groupThousands(String(binary.length))} bytes`, true);
    result.body = binary;
    return result;
  }
  let source = "response";
  if (!MARKDOWN_TYPES.includes(kind) && !options["raw"]) {
    if (!urlsplit(final).path.endsWith(".md")) {
      const [mdStatus, mdKind, mdText, mdFinal] = await fetchUrl(`${rstripSlash(final)}.md`, timeout, ACCEPT, "skip");
      if (mdStatus === 200 && mdText && (MARKDOWN_TYPES.includes(mdKind) || (mdKind === "text/plain" && mdText && !mdText.slice(0, 300).toLowerCase().includes("<html")))) {
        [status, kind, text, final, source] = [mdStatus, "text/markdown", mdText, mdFinal, "md-suffix"];
      }
    }
    if (!MARKDOWN_TYPES.includes(kind)) {
      const [llmsSource, llmsText] = await nearestLlms(final, timeout);
      if (llmsText && llmsSource) {
        for (const href of llmsHrefs(llmsText)) {
          const target = urljoin(llmsSource, href);
          if (sameDocument(target, final)) {
            const [mdStatus, , mdText, mdFinal, mdBinary] = await fetchUrl(target, timeout, ACCEPT, "skip");
            if (mdStatus === 200 && mdBinary === undefined && mdText) [status, kind, text, final, source] = [mdStatus, "text/markdown", mdText, mdFinal, "llms.txt"];
            break;
          }
        }
      }
    }
  }
  if (options["require_md"] && !MARKDOWN_TYPES.includes(kind)) throw new BrowseError(`${url} didn't answer with text/markdown (got ${kind || "nothing"})`);
  let content = text;
  let title = "";
  if (!options["raw"] && kind === "text/html") {
    const extracted = extractHtml(text);
    content = extracted.content;
    title = extracted.title;
    source = "html-extract";
  }
  if (!options["raw"]) content = postProcess(content, { outline: options["outline"], filter });
  const maxOutput = globalOptions["max_output"];
  const truncated = Boolean(maxOutput && [...content].length > Number(maxOutput));
  return new Result({ content, contentType: kind, finalUrl: final, source, title, truncated, url }, content, true);
}
