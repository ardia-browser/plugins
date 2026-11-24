import { formatG, groupThousands } from "../../pylib/format.ts";
import { pyLen } from "../../pylib/str.ts";
import { urljoin, urlsplit } from "../../pylib/urllib.ts";
import { BrowseError, Usage } from "../daemon-errors.ts";
import { OUTPUT_CAP, Result } from "../daemon/render.ts";
import { add, count, flag } from "../metrics.ts";
import { extractHtml } from "../read/readurl.ts";
import { record } from "../state/records.ts";
import { clock } from "../metrics.ts";
import { neutralize, safeHead, stripLoneSurrogates } from "../untrusted.ts";
import type { Ctx } from "./ctx.ts";
import { register } from "./index.ts";
import { parse } from "./parse.ts";
import { cmdTab } from "./tabs.ts";

export const MAX_URLS = 50;
export const DEFAULT_CONCURRENCY = 6;
export const MAX_CONCURRENCY = 10;
export const DEFAULT_TIMEOUT = 15;
export const MAX_TIMEOUT = 60;
export const MAX_BYTES = 2 * 1024 * 1024;
export const MIN_SHARE = 400;
export const DEFAULT_SHARE = 4000;
export const FAILED_SHOWN = 300;

const FETCH_ALL = `async (urls, maxBytes, concurrency, timeoutMs) => {
  const out = new Array(urls.length);
  let next = 0;
  const textual = (type) => type === "" || /^text\\/|json|xml|javascript|markdown|x-www-form-urlencoded/i.test(type);
  const decoderFor = (type) => {
    const named = /charset=([^;\\s]+)/i.exec(type);
    try { return new TextDecoder(named ? named[1].replace(/["']/g, "") : "utf-8"); } catch (error) { return new TextDecoder("utf-8"); }
  };
  const one = async (index) => {
    const url = urls[index];
    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), timeoutMs);
    try {
      const response = await fetch(url, { credentials: "include", redirect: "follow", signal: control.signal });
      const type = response.headers.get("content-type") || "";
      const base = { url, status: response.status, ok: response.ok, finalUrl: response.url || url, contentType: type, redirected: response.redirected };
      if (!textual(type)) {
        try { await response.body?.cancel(); } catch (error) {}
        out[index] = { ...base, binary: true, body: "", truncated: false };
        return;
      }
      const decoder = decoderFor(type);
      let body = "";
      let got = 0;
      let truncated = false;
      if (response.body && response.body.getReader) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          got += value.byteLength;
          body += decoder.decode(value, { stream: true });
          if (got >= maxBytes) {
            truncated = true;
            try { await reader.cancel(); } catch (error) {}
            break;
          }
        }
        body += decoder.decode();
      } else body = await response.text();
      out[index] = { ...base, binary: false, body, truncated };
    } catch (error) {
      out[index] = { url, error: control.signal.aborted ? "timeout" : String((error && error.message) || error) };
    } finally {
      clearTimeout(timer);
    }
  };
  const workers = Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
    while (next < urls.length) {
      const index = next;
      next += 1;
      await one(index);
    }
  });
  await Promise.all(workers);
  return out;
}`;

export type Fetched = {
  url: string;
  finalUrl: string | null;
  status: number | null;
  ok: boolean;
  contentType: string;
  title: string;
  content: string;
  chars: number;
  truncated: boolean;
  error: string | null;
};

function intFlag(value: unknown, name: string, fallback: number, low: number, high: number): number {
  if (value === undefined || value === null) return fallback;
  const text = String(value);
  if (!/^[0-9]+(\.[0-9]+)?$/u.test(text)) throw new Usage(`${name} takes a number, not ${text}`);
  return Math.min(Math.max(Number(text), low), high);
}

export function absoluteUrls(given: readonly string[], base: string): string[] {
  return given.map((url) => {
    let full: string;
    try {
      full = new URL(url, base && !base.startsWith("about:") ? base : undefined).href;
    } catch {
      full = urljoin(base, url);
    }
    const scheme = urlsplit(full).scheme;
    if (scheme !== "http" && scheme !== "https") throw new Usage(`read-urls fetches http and https addresses; ${url} isn't one (on about:blank, give full addresses)`);
    return full;
  });
}

function blockedReason(error: string, origin: string): string {
  if (error === "timeout") return "timed out";
  if (/failed to fetch|networkerror|load failed/iu.test(error)) {
    return `the page at ${origin || "this tab"} can't read it (another site that doesn't allow it, or the network failed); \`ardia browse read <url>\` loads it in a tab`;
  }
  return error;
}

export function contentOf(body: string, type: string): { content: string; title: string } {
  const lower = type.toLowerCase();
  if (lower.includes("html") || (lower === "" && /^\s*<(?:!doctype|html|head|body)/iu.test(body))) {
    const { content, title } = extractHtml(body);
    const lines = content.split("\n");
    return { content: title && lines[0] === title ? lines.slice(1).join("\n").trim() : content, title };
  }
  return { content: body.trim(), title: "" };
}

export function share(total: number, urls: number, given: number | null): number {
  if (given !== null) return given;
  if (total <= 0) return DEFAULT_SHARE * 4;
  return Math.max(MIN_SHARE, Math.floor(total / Math.max(urls, 1)));
}

export function fetchedOf(raw: Record<string, unknown>, origin: string, perUrl: number): Fetched {
  const url = String(raw["url"] ?? "");
  if (typeof raw["error"] === "string") {
    return { url, finalUrl: null, status: null, ok: false, contentType: "", title: "", content: "", chars: 0, truncated: false, error: blockedReason(raw["error"], origin) };
  }
  const status = typeof raw["status"] === "number" ? raw["status"] : null;
  const type = String(raw["contentType"] ?? "");
  const finalUrl = typeof raw["finalUrl"] === "string" ? raw["finalUrl"] : url;
  if (raw["binary"]) {
    return { url, finalUrl, status, ok: false, contentType: type, title: "", content: "", chars: 0, truncated: false, error: `${type || "the body"} isn't text; \`ardia browse read --http ${url} --out <file>\` saves it` };
  }
  const { content, title } = contentOf(neutralize(stripLoneSurrogates(String(raw["body"] ?? ""))), type);
  const chars = pyLen(content);
  const cut = perUrl > 0 && chars > perUrl;
  const shown = cut ? safeHead(content, perUrl) : content;
  const failed = status !== null && status >= 400;
  return {
    url,
    finalUrl,
    status,
    ok: !failed,
    contentType: type,
    title,
    content: shown,
    chars,
    truncated: cut || Boolean(raw["truncated"]),
    error: failed ? `HTTP ${status}` : null,
  };
}

export function fetchedText(fetched: readonly Fetched[], origin: string, seconds: number): string {
  const good = fetched.filter((item) => item.error === null).length;
  const took = seconds < 1 ? `${Math.round(seconds * 1000)} ms` : `${formatG(Math.round(seconds * 10) / 10)} s`;
  const lines = [`read-urls: ${good} of ${fetched.length} read in ${took}, from ${origin || "this tab"} with its cookies`];
  fetched.forEach((item, index) => {
    const where = item.finalUrl && item.finalUrl !== item.url ? `${item.url} → ${item.finalUrl}` : item.url;
    if (item.error !== null) {
      lines.push("", `## [${index + 1}] ✗ ${where}: ${item.error}`);
      if (item.content) lines.push(safeHead(item.content, FAILED_SHOWN));
      return;
    }
    const kind = item.contentType ? `, ${item.contentType.split(";")[0]}` : "";
    lines.push("", `## [${index + 1}] ${item.title ? `${item.title} — ` : ""}${where} (${item.status ?? "?"}${kind})`);
    lines.push(item.content || "(no text)");
    if (item.truncated) lines.push(`[cut at ${groupThousands(String(pyLen(item.content)))} of ${groupThousands(String(item.chars))} characters; --max-chars or --full shows more]`);
  });
  return lines.join("\n");
}

export async function cmdReadUrls(ctx: Ctx, argv: string[]): Promise<Result> {
  const [options, args] = parse(argv, { "--concurrency": "value", "--timeout": "value", "--max-chars": "value" });
  if (args.length === 0) throw new Usage("Usage: ardia browse read-urls <url> [url...] [--concurrency n] [--timeout s] [--max-chars n]");
  if (args.length > MAX_URLS) throw new Usage(`read-urls takes up to ${MAX_URLS} addresses at once; split the list`);
  const concurrency = intFlag(options["concurrency"], "--concurrency", DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY);
  const timeout = intFlag(options["timeout"], "--timeout", DEFAULT_TIMEOUT, 1, MAX_TIMEOUT);
  const given = options["max_chars"] === undefined ? null : intFlag(options["max_chars"], "--max-chars", DEFAULT_SHARE, 1, 10_000_000);
  const state = ctx.state;
  await state.connect();
  let notice: string | null = null;
  if (state.current === null || !state.targetInfos.has(state.current)) {
    await cmdTab(ctx, ["active"]);
    notice = `→ Read through your active tab [${state.tabId(state.current as string)}], as \`tab active\` picks it`;
  }
  const page = await state.page();
  await page.refreshFrames();
  const urls = absoluteUrls(args, page.url);
  const origin = (() => {
    try {
      return new URL(page.url).origin;
    } catch {
      return "";
    }
  })();
  const started = clock();
  const raw = await page.call(FETCH_ALL, [urls, MAX_BYTES, concurrency, timeout * 1000], { frame: page.mainFrame, read: true, timeout: timeout + 15 });
  const seconds = clock() - started;
  if (!Array.isArray(raw)) throw new BrowseError("read-urls got no answer from the page", null, "page_script_error");
  const cap = ctx.options["full"] ? 0 : ctx.options["max_output"] === undefined || ctx.options["max_output"] === null ? OUTPUT_CAP : Number(ctx.options["max_output"]);
  const perUrl = share(cap - urls.length * 120, urls.length, given);
  const fetched = raw.map((item) => fetchedOf(record(item), origin === "null" ? "" : origin, cap === 0 && given === null ? 0 : perUrl));
  flag("read_urls", true);
  count("read_urls_count", urls.length);
  add("read_urls_failed", fetched.filter((item) => item.error !== null).length);
  const result = new Result({ origin, results: fetched }, fetchedText(fetched, origin === "null" ? "" : origin, seconds), true);
  if (fetched.every((item) => item.error !== null)) result.failed = true;
  result.notice = notice;
  return result;
}

register("read-urls", cmdReadUrls);
