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
]);
const SNIFFED = 8192;

export type Fetched = [number, string, string, string, Uint8Array?];
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

export function binaryBody(kind: string, charset: string | null, body: Uint8Array): boolean {
  if (textualType(kind)) return false;
  const head = body.subarray(0, SNIFFED);
  if (head.includes(0)) return true;
  if (charset !== null && !/^utf-?8$/iu.test(charset)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(body.length > SNIFFED ? trimmedToChar(head) : head);
    return false;
  } catch {
    return true;
  }
}

function trimmedToChar(head: Uint8Array): Uint8Array {
  let end = head.length;
  for (let back = 1; back <= 3 && end - back >= 0; back += 1) {
    const unit = head[end - back] as number;
    if ((unit & 0xc0) === 0xc0) return head.subarray(0, end - back);
    if ((unit & 0x80) === 0) break;
  }
  return head;
}

export function requestUrl(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    throw new BrowseError(`${url} isn't a URL read can fetch`, null, "usage");
  }
}

export async function fetchUrl(url: string, timeout: number, accept = ACCEPT, keepBinary = false): Promise<Fetched> {
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
        const next = requestUrl(urljoin(target, location));
        if (!WEB_SCHEMES.has(urlsplit(next).scheme.toLowerCase())) break;
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
      if (error instanceof Cancelled || controller.signal.reason instanceof Cancelled) throw new Cancelled();
      if (controller.signal.reason instanceof FetchTimeout) throw new BrowseError(`Couldn't fetch ${url}: timed out`);
      throw new BrowseError(`Couldn't fetch ${url}: ${reasonOf(error)}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    const final = (response as unknown as { finalUrl: string }).finalUrl;
    const kind = pyStrip(contentType.split(";")[0] as string).toLowerCase();
    if (kind === "application/pdf" || (body[0] === 0x25 && body[1] === 0x50 && body[2] === 0x44 && body[3] === 0x46)) {
      if (body.length > MAX_BODY) throw new BrowseError(`${url} is a PDF over ${MAX_BODY} bytes; read it in a tab instead (drop --http)`);
      return [response.status, "application/pdf", await textFromBytes(body), final];
    }
    const charset = CHARSET.exec(contentType);
    const declared = charset ? (charset[1] as string) : null;
    if (binaryBody(kind, declared, body)) {
      const size = body.length > MAX_BODY ? `over ${groupThousands(String(MAX_BODY))}` : groupThousands(String(body.length));
      if (!keepBinary) throw new BrowseError(`${url} sent a binary file (${kind || "no content type"}, ${size} bytes), not text; save it with read --http ${url} --out <file>`, null, "binary_body");
      if (body.length > MAX_BODY) throw new BrowseError(`${url} sent a binary file over ${groupThousands(String(MAX_BODY))} bytes; read --http --out saves files up to that size`, null, "result_too_large");
      return [response.status, kind || "application/octet-stream", "", final, body];
    }
    const text = decode(body.subarray(0, MAX_BODY), declared ?? "utf-8");
    return [response.status, kind, text, final];
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", stop);
  }
}

export async function nearestLlms(url: string, timeout: number, name = "llms.txt"): Promise<[string | null, string | null]> {
  for (const candidate of llmsCandidates(url, name)) {
    const [status, , text, final] = await fetchUrl(candidate, timeout, "text/plain, text/markdown", true);
    if (status === 200 && text && !text.slice(0, 500).toLowerCase().includes("<html")) return [final, text];
  }
  return [null, null];
}

function rstripSlash(text: string): string {
  return text.replace(/\/+$/u, "");
}

export async function run(given: string, options: ReadOptions, globalOptions: ReadOptions): Promise<Result> {
  const url = normalizeUrl(given);
  const timeout = Number(options["timeout"] || 10000) / 1000;
  const filter = (options["filter"] as string | undefined) ?? null;
  if (options["llms"]) {
    const mode = options["llms"];
    if (mode !== "index" && mode !== "full") throw new BrowseError("--llms takes index or full");
    const [source, text] = await nearestLlms(url, timeout, mode === "index" ? "llms.txt" : "llms-full.txt");
    if (text === null || source === null) throw new BrowseError(`No ${mode === "index" ? "llms.txt" : "llms-full.txt"} found at or above ${url}`);
    const content = mode === "index" ? llmsLinks(text, source, filter).join("\n") : postProcess(text, { outline: options["outline"], filter });
    return new Result({ content, source, contentType: "text/plain", url }, content, true);
  }
  const saving = Boolean(globalOptions["out_only"]);
  let [status, kind, text, final, binary] = await fetchUrl(url, timeout, ACCEPT, saving);
  if (status >= 400) throw new BrowseError(`${url} answered HTTP ${status}`);
  if (binary !== undefined) {
    const summary = `a ${kind} file of ${groupThousands(String(binary.length))} bytes`;
    return new Result({ url, finalUrl: final, contentType: kind, source: "response", bytes: binary.length, bodyBase64: Buffer.from(binary).toString("base64") }, summary, true);
  }
  let source = "response";
  if (!MARKDOWN_TYPES.includes(kind) && !options["raw"]) {
    if (!urlsplit(final).path.endsWith(".md")) {
      const [mdStatus, mdKind, mdText, mdFinal] = await fetchUrl(`${rstripSlash(final)}.md`, timeout, ACCEPT, true);
      if (mdStatus === 200 && (MARKDOWN_TYPES.includes(mdKind) || (mdKind === "text/plain" && mdText && !mdText.slice(0, 300).toLowerCase().includes("<html")))) {
        [status, kind, text, final, source] = [mdStatus, "text/markdown", mdText, mdFinal, "md-suffix"];
      }
    }
    if (!MARKDOWN_TYPES.includes(kind)) {
      const [llmsSource, llmsText] = await nearestLlms(final, timeout);
      if (llmsText && llmsSource) {
        for (const href of llmsHrefs(llmsText)) {
          const target = urljoin(llmsSource, href);
          if (sameDocument(target, final)) {
            const [mdStatus, , mdText, mdFinal, mdBinary] = await fetchUrl(target, timeout, ACCEPT, true);
            if (mdStatus === 200 && mdBinary === undefined) [status, kind, text, final, source] = [mdStatus, "text/markdown", mdText, mdFinal, "llms.txt"];
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
