export type Framing = "ndjson" | "content-length";

export type JsonRpcId = string | number | null;

export type JsonRpcMessage = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
export const RESOURCE_NOT_FOUND = -32002;

export const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_HEADER_BYTES = 8192;

const HEADER_END = Buffer.from("\r\n\r\n");
const BARE_HEADER_END = Buffer.from("\n\n");
const CONTENT_LENGTH = /^content-length\s*:\s*(\d{1,10})\s*$/imu;
const HEADER_START = /^content-/iu;
const HEADER_PREFIX = "content-";
const LEADING_SPACE = new Set([0x20, 0x09, 0x0d, 0x0a]);

export type Frame = { kind: "message"; text: string } | { kind: "invalid"; reason: string };

export class FrameReader {
  framing: Framing | undefined;
  private pending: Buffer = Buffer.alloc(0);
  private discardingLine = false;

  push(chunk: Uint8Array): Frame[] {
    this.pending = this.pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.pending, chunk]);
    const frames: Frame[] = [];
    for (;;) {
      const frame = this.next();
      if (frame === undefined) break;
      frames.push(frame);
    }
    return frames;
  }

  finish(): Frame[] {
    if (this.discardingLine) {
      this.discardingLine = false;
      this.pending = Buffer.alloc(0);
      return [];
    }
    if (this.pending.length === 0) return [];
    if (this.framing === "content-length") {
      let at = 0;
      while (at < this.pending.length && LEADING_SPACE.has(this.pending[at] as number)) at += 1;
      const truncated = at < this.pending.length;
      this.pending = Buffer.alloc(0);
      return truncated ? [{ kind: "invalid", reason: "truncated message" }] : [];
    }
    const over = this.pending.length > MAX_FRAME_BYTES;
    const text = over ? "" : this.pending.toString("utf8").trim();
    this.pending = Buffer.alloc(0);
    if (over) return [{ kind: "invalid", reason: "message too large" }];
    return text === "" ? [] : [{ kind: "message", text }];
  }

  private detect(): boolean {
    let at = 0;
    while (at < this.pending.length && LEADING_SPACE.has(this.pending[at] as number)) at += 1;
    if (at === this.pending.length) return false;
    const head = this.pending.subarray(at, at + 16).toString("latin1");
    if (HEADER_START.test(head)) this.framing = "content-length";
    else if (head.length < HEADER_PREFIX.length && HEADER_PREFIX.startsWith(head.toLowerCase())) return false;
    else this.framing = "ndjson";
    return true;
  }

  private next(): Frame | undefined {
    if (this.framing === undefined && !this.detect()) return undefined;
    return this.framing === "content-length" ? this.nextSized() : this.nextLine();
  }

  private nextLine(): Frame | undefined {
    for (;;) {
      const end = this.pending.indexOf(0x0a);
      if (this.discardingLine) {
        if (end < 0) {
          this.pending = Buffer.alloc(0);
          return undefined;
        }
        this.pending = this.pending.subarray(end + 1);
        this.discardingLine = false;
        continue;
      }
      if (end < 0) {
        if (this.pending.length > MAX_FRAME_BYTES) {
          this.pending = Buffer.alloc(0);
          this.discardingLine = true;
          return { kind: "invalid", reason: "message too large" };
        }
        return undefined;
      }
      if (end > MAX_FRAME_BYTES) {
        this.pending = this.pending.subarray(end + 1);
        return { kind: "invalid", reason: "message too large" };
      }
      const text = this.pending.subarray(0, end).toString("utf8").trim();
      this.pending = this.pending.subarray(end + 1);
      if (text !== "") return { kind: "message", text };
    }
  }

  private nextSized(): Frame | undefined {
    let start = 0;
    while (start < this.pending.length && LEADING_SPACE.has(this.pending[start] as number)) start += 1;
    const crlf = this.pending.indexOf(HEADER_END, start);
    const lf = this.pending.indexOf(BARE_HEADER_END, start);
    const [end, gap] = crlf >= 0 && (lf < 0 || crlf <= lf) ? [crlf, HEADER_END.length] : lf >= 0 ? [lf, BARE_HEADER_END.length] : [-1, 0];
    if (end < 0) {
      if (this.pending.length - start > MAX_HEADER_BYTES + HEADER_END.length - 1) {
        this.pending = Buffer.alloc(0);
        return { kind: "invalid", reason: "header too large" };
      }
      return undefined;
    }
    if (end - start > MAX_HEADER_BYTES) {
      this.pending = this.pending.subarray(end + gap);
      return { kind: "invalid", reason: "header too large" };
    }
    const header = this.pending.subarray(start, end).toString("latin1");
    const length = CONTENT_LENGTH.exec(header);
    if (length === null) {
      this.pending = this.pending.subarray(end + gap);
      return { kind: "invalid", reason: "missing Content-Length" };
    }
    const size = Number(length[1]);
    if (size > MAX_FRAME_BYTES) {
      this.pending = Buffer.alloc(0);
      return { kind: "invalid", reason: "message too large" };
    }
    const bodyStart = end + gap;
    if (this.pending.length < bodyStart + size) return undefined;
    const text = this.pending.subarray(bodyStart, bodyStart + size).toString("utf8");
    this.pending = this.pending.subarray(bodyStart + size);
    return { kind: "message", text };
  }
}

export function encodeFrame(message: unknown, framing: Framing): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (framing === "ndjson") return Buffer.concat([body, Buffer.from("\n")]);
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "latin1"), body]);
}

export function validId(id: unknown): id is JsonRpcId {
  return id === null || typeof id === "string" || (typeof id === "number" && Number.isFinite(id));
}

export function success(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

export function failure(id: JsonRpcId, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error["data"] = data;
  return { jsonrpc: "2.0", id, error };
}

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
