import { floatRepr, quote } from "../../json.ts";
import { codePoints } from "../../pystr.ts";

export const CONSOLE_LIMIT = 1000;
export const ERROR_LIMIT = 500;
export const REQUEST_LIMIT = 1000;
export const FETCHES_TRACKED = 256;
export const FETCH_FRESH = 1.5;
export const RECORD_TEXT_LIMIT = 64 * 1024;
export const HEADER_VALUE_LIMIT = 8 * 1024;
export const HEADERS_LIMIT = 64 * 1024;
export const REQUEST_BYTES = 32 * 1024 * 1024;

export type Json = Record<string, unknown>;

export function record(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

export function pyLength(text: string): number {
  return codePoints(text).length;
}

function sizeOf(value: unknown): number {
  if (value === null || value === undefined) return 4;
  if (typeof value === "boolean") return value ? 4 : 5;
  if (typeof value === "string") return pyLength(quote(value, false));
  if (typeof value === "number") return Number.isInteger(value) ? String(value).length : floatRepr(value).length;
  if (typeof value === "bigint") return String(value).length;
  if (Array.isArray(value)) return 2 + value.reduce((sum: number, item) => sum + sizeOf(item), 0) + Math.max(0, value.length - 1) * 2;
  if (typeof value === "object") {
    const entries = Object.entries(value as Json);
    return 2 + entries.reduce((sum, [key, item]) => sum + pyLength(quote(key, false)) + 2 + sizeOf(item), 0) + Math.max(0, entries.length - 1) * 2;
  }
  return pyLength(quote(String(value), false));
}

export function recordSize(item: unknown): number {
  return sizeOf(item);
}

export function clip(text: unknown, limit = RECORD_TEXT_LIMIT): unknown {
  if (typeof text !== "string") return text;
  const points = codePoints(text);
  if (points.length <= limit) return text;
  return `${points.slice(0, limit).join("")}… [${points.length - limit} more characters]`;
}

export const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set(["cookie", "cookie2", "set-cookie", "set-cookie2", "authorization", "proxy-authorization"]);

export function clipHeaders(headers: unknown): Json {
  const out: Json = {};
  let used = 0;
  for (const [name, value] of Object.entries(record(headers))) {
    if (CREDENTIAL_HEADERS.has(name.toLowerCase())) continue;
    const kept = clip(String(value), HEADER_VALUE_LIMIT) as string;
    used += pyLength(name) + pyLength(kept);
    if (used > HEADERS_LIMIT) {
      out["…"] = "more headers omitted";
      break;
    }
    out[name] = kept;
  }
  return out;
}

export function remoteText(arg: Json): string {
  const kind = arg["type"];
  if (Object.hasOwn(arg, "value")) {
    const value = arg["value"];
    if (kind === "string") return String(value);
    if (value === null || value === undefined) return "null";
    if (typeof value === "boolean") return value ? "true" : "false";
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  }
  if (kind === "undefined") return "undefined";
  const preview = record(arg["preview"]);
  if (Object.keys(preview).length > 0 && preview["properties"] !== null && preview["properties"] !== undefined) {
    const props = (Array.isArray(preview["properties"]) ? preview["properties"] : []).map(record);
    const more = preview["overflow"] ? ", …" : "";
    if (preview["subtype"] === "array") return `[${props.map((prop) => String(prop["value"] ?? "")).join(", ")}${more}]`;
    return `{${props.map((prop) => `${String(prop["name"])}: ${String(prop["value"] ?? "")}`).join(", ")}${more}}`;
  }
  return String(arg["description"] || arg["unserializableValue"] || kind || "");
}

export class Ring {
  readonly items: unknown[] = [];
  private readonly sizes: number[] = [];
  dropped = 0;
  total = 0;

  constructor(
    readonly limit: number,
    readonly maxBytes = 16 * 1024 * 1024,
  ) {}

  add(item: unknown): void {
    const size = recordSize(item);
    while (this.items.length > 0 && (this.items.length >= this.limit || this.total + size > this.maxBytes)) {
      this.items.shift();
      this.total -= this.sizes.shift() as number;
      this.dropped += 1;
    }
    this.items.push(item);
    this.sizes.push(size);
    this.total += size;
  }

  clear(): void {
    this.items.length = 0;
    this.sizes.length = 0;
    this.total = 0;
    this.dropped = 0;
  }
}

function monotonic(): number {
  return performance.now() / 1000;
}

export class NetworkLog {
  readonly requests = new Map<string, Json>();
  readonly sizes = new Map<string, number>();
  dropped = 0;
  fetchesStarted = new Map<string, number>();
  fetchLoaders = new Map<string, string>();
  fetchesBusyUntil = 0;

  onEvent(method: string, params: Json): void {
    const requestId = params["requestId"];
    if (typeof requestId !== "string" || !requestId) return;
    this.trackFetch(method, requestId, params);
    let entry: Json | undefined;
    if (method === "Network.requestWillBeSent") {
      const request = record(params["request"]);
      entry = this.requests.get(requestId);
      if (entry === undefined) {
        if (this.requests.size >= REQUEST_LIMIT) this.dropOldest();
        entry = { requestId };
        this.requests.set(requestId, entry);
      } else if (params["redirectResponse"]) {
        entry["redirects"] = Number(entry["redirects"] ?? 0) + 1;
      }
      const postData = typeof request["postData"] === "string" ? codePoints(request["postData"]).slice(0, 65536).join("") : "";
      Object.assign(entry, {
        url: clip(String(request["url"] ?? ""), 16 * 1024),
        method: request["method"] ?? "GET",
        headers: clipHeaders(request["headers"]),
        postData: postData || null,
        resourceType: params["type"] || "Other",
        timestamp: Math.trunc((Number(params["wallTime"]) || Date.now() / 1000) * 1000),
        monotonic: params["timestamp"] ?? null,
      });
    } else {
      entry = this.requests.get(requestId);
      if (entry === undefined) return;
      if (method === "Network.responseReceived") {
        const response = record(params["response"]);
        Object.assign(entry, {
          status: response["status"] ?? null,
          statusText: response["statusText"] ?? "",
          mimeType: response["mimeType"] ?? "",
          responseHeaders: clipHeaders(response["headers"]),
          protocol: response["protocol"] ?? "",
          remoteIPAddress: response["remoteIPAddress"] ?? null,
          timing: response["timing"] ?? null,
        });
      } else if (method === "Network.loadingFinished") {
        entry["finished"] = params["timestamp"] ?? null;
        entry["encodedDataLength"] = params["encodedDataLength"] ?? null;
      } else if (method === "Network.loadingFailed") {
        entry["failed"] = clip(String(params["errorText"] || "failed"), 1024);
        entry["finished"] = params["timestamp"] ?? null;
      }
    }
    this.account(requestId);
  }

  private dropOldest(): void {
    const oldest = this.requests.keys().next().value as string;
    this.requests.delete(oldest);
    this.sizes.delete(oldest);
    this.dropped += 1;
  }

  private trackFetch(method: string, requestId: string, params: Json): void {
    if (method === "Network.requestWillBeSent") {
      if ((params["type"] === "XHR" || params["type"] === "Fetch") && !this.fetchesStarted.has(requestId)) {
        const now = monotonic();
        if (this.fetchesStarted.size >= FETCHES_TRACKED) {
          this.fetchesStarted = new Map([...this.fetchesStarted].filter(([, started]) => now - started < FETCH_FRESH));
          this.fetchLoaders = new Map([...this.fetchesStarted.keys()].filter((key) => this.fetchLoaders.has(key)).map((key) => [key, this.fetchLoaders.get(key) as string]));
        }
        if (this.fetchesStarted.size >= FETCHES_TRACKED) {
          const [oldestId, oldest] = this.fetchesStarted.entries().next().value as [string, number];
          this.fetchesStarted.delete(oldestId);
          this.fetchLoaders.delete(oldestId);
          this.fetchesBusyUntil = Math.max(this.fetchesBusyUntil, oldest + FETCH_FRESH);
        }
        this.fetchesStarted.set(requestId, now);
        if (typeof params["loaderId"] === "string" && params["loaderId"]) this.fetchLoaders.set(requestId, params["loaderId"]);
      }
    } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
      this.fetchesStarted.delete(requestId);
      this.fetchLoaders.delete(requestId);
    }
  }

  private account(requestId: string): void {
    const entry = this.requests.get(requestId);
    if (entry === undefined) return;
    this.sizes.set(requestId, recordSize(entry));
    let total = [...this.sizes.values()].reduce((sum, size) => sum + size, 0);
    while (this.requests.size > 1 && total > REQUEST_BYTES) {
      const oldest = this.requests.keys().next().value as string;
      total -= this.sizes.get(oldest) ?? 0;
      this.dropOldest();
    }
  }
}

export function consoleEntry(params: Json): Json {
  const args = (Array.isArray(params["args"]) ? params["args"] : []).map(record);
  const kind = params["type"] ?? "log";
  return {
    type: kind === "warn" ? "warning" : kind,
    text: clip(args.map(remoteText).join(" ")),
    args: args.slice(0, 20).map((arg) => {
      const kept: Json = {};
      for (const key of ["type", "value", "description", "className", "preview"]) {
        if (Object.hasOwn(arg, key)) kept[key] = typeof arg[key] === "string" ? clip(arg[key]) : arg[key];
      }
      return kept;
    }),
    timestamp: params["timestamp"] ?? null,
  };
}

export function errorEntry(params: Json): Json {
  const details = record(params["exceptionDetails"]);
  const exception = record(details["exception"]);
  return {
    text: clip(exception["description"] || details["text"] || "Uncaught error"),
    url: clip(details["url"] ?? null, 4096),
    line: details["lineNumber"] ?? null,
    column: details["columnNumber"] ?? null,
    timestamp: params["timestamp"] ?? null,
  };
}
