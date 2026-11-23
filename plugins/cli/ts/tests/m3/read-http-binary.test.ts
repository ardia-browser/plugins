import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import "../libc-loaded.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeJsonAnswer } from "../../src/browse/answer-codes.ts";
import { BrowseError } from "../../src/browse/daemon-errors.ts";
import { save, savedBody } from "../../src/browse/outfile.ts";
import { binaryBody, fetchUrl, requestUrl, run as fetchRun } from "../../src/browse/read/fetch.ts";
import { readHttp } from "../../src/browse/read/pages.ts";
import type { Value } from "../../src/json.ts";
import { loads } from "../../src/pyjson.ts";

const ZIP = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0xd3, 0xb2, 0x76, 0x5d, 0xff, 0xfe, 0x80, 0x0a, 0x0d, 0x22, 0x5c]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const seen: string[] = [];
let server: ReturnType<typeof Bun.serve>;
let base = "";
let folder = "";

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), "read-http-binary-"));
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      seen.push(url.pathname + url.search);
      if (url.pathname === "/deck.pptx") return new Response(ZIP, { headers: { "content-type": "application/zip" } });
      if (url.pathname === "/logo") return new Response(PNG, { headers: { "content-type": "image/png" } });
      if (url.pathname === "/untyped") return new Response(ZIP);
      if (url.pathname === "/plain-octets") return new Response("just text, mislabeled", { headers: { "content-type": "application/octet-stream" } });
      if (url.pathname === "/caf%C3%A9") return new Response("<html><title>Café</title><body><main>Un café, s'il vous plaît.</main></body></html>", { headers: { "content-type": "text/html; charset=utf-8" } });
      if (url.pathname === "/moved") return new Response(null, { status: 302, headers: { location: "/café" } });
      return new Response("nope", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  rmSync(folder, { recursive: true, force: true });
});

describe("read --http keeps binary bodies whole (plugins#73, FB-8EJR)", () => {
  test("binary types and bytes are told apart from text", () => {
    expect(binaryBody("application/zip", null, ZIP)).toBe(true);
    expect(binaryBody("image/png", null, PNG)).toBe(true);
    expect(binaryBody("", null, ZIP)).toBe(true);
    expect(binaryBody("application/octet-stream", null, new TextEncoder().encode("plain words é"))).toBe(false);
    expect(binaryBody("text/plain", null, ZIP)).toBe(false);
    expect(binaryBody("application/json", null, ZIP)).toBe(false);
    expect(binaryBody("application/vnd.api+json", null, ZIP)).toBe(false);
    expect(binaryBody("application/x-thing", "latin-1", Uint8Array.from([0xe9, 0xe8]))).toBe(false);
    const long = new Uint8Array(9000).fill(0x61);
    long.set([0xc3, 0xa9], 8191);
    expect(binaryBody("application/octet-stream", null, long)).toBe(false);
  });

  test("with --out the body comes back byte for byte and saves raw", async () => {
    const result = await fetchRun(`${base}/deck.pptx`, {}, { out_only: true });
    const data = result.data as Record<string, unknown>;
    expect(data["contentType"]).toBe("application/zip");
    expect(data["bytes"]).toBe(ZIP.length);
    const body = savedBody("read", new Map(Object.entries(data)) as Map<string, Value>);
    expect(body).not.toBeNull();
    const target = save(join(folder, "deck.pptx"), body as Uint8Array);
    expect(Buffer.compare(readFileSync(target), Buffer.from(ZIP))).toBe(0);
  });

  test("an untyped binary body is sniffed and kept raw too", async () => {
    const [, kind, text, , body] = await fetchUrl(`${base}/untyped`, 5, undefined, true);
    expect(kind).toBe("application/octet-stream");
    expect(text).toBe("");
    expect(Buffer.compare(Buffer.from(body as Uint8Array), Buffer.from(ZIP))).toBe(0);
  });

  test("without --out a binary body is refused with binary_body, never printed as mojibake", async () => {
    let caught: unknown;
    try {
      await fetchRun(`${base}/logo`, {}, {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BrowseError);
    expect((caught as BrowseError).code).toBe("binary_body");
    expect((caught as BrowseError).text).toContain("--out <file>");
  });

  test("text served as application/octet-stream still reads as text", async () => {
    const result = await fetchRun(`${base}/plain-octets`, { raw: true }, {});
    expect((result.data as Record<string, unknown>)["content"]).toBe("just text, mislabeled");
  });

  test("text --out saves are unchanged", () => {
    expect(savedBody("read", new Map([["content", "hello"]]))).toBeNull();
    expect(savedBody("script", new Map([["bodyBase64", "aGk="]]))).toBeNull();
  });
});

describe("read --http fetches URLs written with Unicode (plugins#73, FB-A2CU, FB-5QSW)", () => {
  test("the request goes out as a URI: IDNA host, percent-encoded path and query", () => {
    expect(requestUrl("https://bücher.example/café/ä?q=naïve&x=ü#frag")).toBe("https://xn--bcher-kva.example/caf%C3%A9/%C3%A4?q=na%C3%AFve&x=%C3%BC#frag");
    expect(requestUrl("https://example.com/already%20encoded")).toBe("https://example.com/already%20encoded");
  });

  test("a Unicode path is fetched percent-encoded and reported as given", async () => {
    seen.length = 0;
    const [status, , text, final] = await fetchUrl(`${base}/café`, 5);
    expect(status).toBe(200);
    expect(text).toContain("Café");
    expect(final).toBe(`${base}/café`);
    expect(seen).toContain("/caf%C3%A9");
  });

  test("a redirect to a Unicode Location is followed", async () => {
    const [status, , text] = await fetchUrl(`${base}/moved`, 5);
    expect(status).toBe(200);
    expect(text).toContain("Café");
  });

  test("a batch of URLs reads every one, and a Unicode or binary one only fails its own page", async () => {
    const pages = await readHttp([`${base}/café`, `${base}/naïve-missing`, `${base}/logo`, `${base}/plain-octets`], { raw: true });
    expect(pages.map((page) => Boolean(page["error"]))).toEqual([false, true, true, false]);
    expect(String(pages[0]?.["text"])).toContain("Café");
    expect(String(pages[1]?.["error"])).toContain("HTTP 404");
    expect(String(pages[2]?.["error"])).toContain("binary file");
  });
});

describe("a read with a failed page keeps its JSON payload (plugins#73)", () => {
  test("success:true with exit 1 is passed through, not wrapped as an internal_error string", () => {
    const out = `${JSON.stringify({ success: true, data: { pages: [{ url: "a", text: "x" }, { url: "b", error: "HTTP 404" }] }, error: null })}\n`;
    const answer = new Map<string, Value>([["exit", 1n], ["out", out], ["err", ""]]);
    codeJsonAnswer(answer, "read");
    expect(answer.get("out")).toBe(out);
    const parsed = loads(answer.get("out") as string) as Map<string, Value>;
    expect(parsed.get("success")).toBe(true);
  });

  test("a failure without a payload is still coded", () => {
    const answer = new Map<string, Value>([["exit", 1n], ["out", `${JSON.stringify({ success: false, data: null, error: "boom" })}\n`], ["err", ""]]);
    codeJsonAnswer(answer, "read");
    expect(JSON.parse(answer.get("out") as string).code).toBe("command_failed");
  });
});
