import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import "../libc-loaded.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeJsonAnswer } from "../../src/browse/answer-codes.ts";
import { BrowseError, Usage } from "../../src/browse/daemon-errors.ts";
import { answerOf } from "../../src/browse/local-answer.ts";
import { BodyDamaged, save, savedBody } from "../../src/browse/outfile.ts";
import { binaryBody, fetchUrl, requestUrl, run as fetchRun } from "../../src/browse/read/fetch.ts";
import { addSecret, clearSecrets } from "../../src/redact.ts";
import { readHttp, readLocal } from "../../src/browse/read/pages.ts";
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
      if (url.pathname === "/late-binary") return new Response(Buffer.concat([Buffer.from("a".repeat(8192)), Buffer.from([0xff, 0x00, 0x80])]), { headers: { "content-type": "application/octet-stream" } });
      if (url.pathname === "/doc.pdf") return new Response(Buffer.from("%PDF-1.4\n%\xe2\xe3\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n", "latin1"), { headers: { "content-type": "application/pdf" } });
      if (url.pathname === "/playlist") return new Response("#EXTM3U\n#EXTINF:5,\nclip.ts\n", { headers: { "content-type": "audio/x-mpegurl" } });
      if (url.pathname === "/big-then-nul") return new Response(Buffer.concat([Buffer.alloc(8 * 1024 * 1024, 0x61), Buffer.from([0])]), { headers: { "content-type": "application/octet-stream" } });
      if (url.pathname === "/utf16-dashed") return new Response(Buffer.from("Hello", "utf16le"), { headers: { "content-type": "application/octet-stream; charset=utf-16-le" } });
      if (url.pathname === "/model.obj") return new Response("v 0 0 0\nv 1 0 0\nf 1 2\n", { headers: { "content-type": "model/obj" } });
      if (url.pathname === "/ok") return new Response("<html><title>OK</title><body><main>A readable page with words.</main></body></html>", { headers: { "content-type": "text/html" } });
      if (url.pathname === "/ok.md") return new Response(Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(8 * 1024 * 1024 + 10, 0x20)]), { headers: { "content-type": "application/pdf" } });
      if (url.pathname === "/bad-location") return new Response(null, { status: 302, headers: { location: "http://[" } });
      if (url.pathname === "/proto") return new Response(Uint8Array.from([0x08, 0x01]), { headers: { "content-type": "application/protobuf" } });
      if (url.pathname === "/octets-control") return new Response(Uint8Array.from([0x08, 0x01]), { headers: { "content-type": "application/octet-stream" } });
      if (url.pathname === "/utf16-quoted") return new Response(Buffer.from("Hi", "utf16le"), { headers: { "content-type": 'application/octet-stream; charset="utf-16-le"' } });
      if (url.pathname === "/ascii-control") return new Response(Uint8Array.from([0x08, 0x01]), { headers: { "content-type": "application/octet-stream; charset=us-ascii" } });
      if (url.pathname === "/utf16") return new Response(Buffer.from("Hello", "utf16le"), { headers: { "content-type": "application/octet-stream; charset=utf-16le" } });
      if (url.pathname === "/pixmap") return new Response(Uint8Array.from([0x50, 0x36, 0x0a, 0x31, 0x20, 0x31, 0x0a, 0x32, 0x35, 0x35, 0x0a, 0x01, 0x02, 0x03]), { headers: { "content-type": "image/x-portable-pixmap" } });
      if (url.pathname === "/readable") return new Response("<html><title>Readable</title><body><main>A readable page with enough words in it.</main></body></html>", { headers: { "content-type": "text/html" } });
      if (url.pathname === "/readable.md") return new Response(new Uint8Array(8 * 1024 * 1024 + 1).fill(0), { headers: { "content-type": "application/octet-stream" } });
      if (url.pathname === "/to-file") return new Response(null, { status: 302, headers: { location: "file://localhost:123/something" } });
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
    const badEdge = new Uint8Array(9000).fill(0x61);
    badEdge[8191] = 0xff;
    expect(binaryBody("application/octet-stream", null, badEdge)).toBe(true);
    expect(binaryBody("application/octet-stream", "utf-16le", Buffer.from("Hello", "utf16le"))).toBe(false);
    expect(binaryBody("image/x-portable-pixmap", null, new TextEncoder().encode("P6\n1 1\n255\n"))).toBe(true);
    expect(binaryBody("application/vnd.openxmlformats-officedocument.presentationml.presentation", null, new TextEncoder().encode("PK"))).toBe(true);
  });

  test("with --out the body travels outside the redacted text and saves byte for byte", async () => {
    const result = await fetchRun(`${base}/deck.pptx`, {}, { out_body: true });
    const data = result.data as Record<string, unknown>;
    expect(data["contentType"]).toBe("application/zip");
    expect(data["bytes"]).toBe(ZIP.length);
    expect(Object.keys(data)).not.toContain("bodyBase64");
    expect(Buffer.compare(Buffer.from(result.body as Uint8Array), Buffer.from(ZIP))).toBe(0);
    clearSecrets();
    try {
      const encoded = Buffer.from(ZIP).toString("base64");
      addSecret(encoded.slice(4, 8));
      const answer = answerOf({ json: true }, result, null);
      expect(answer.get("body")).toBe(encoded);
      const body = savedBody("read", answer);
      const target = save(join(folder, "deck.pptx"), body as Uint8Array);
      expect(Buffer.compare(readFileSync(target), Buffer.from(ZIP))).toBe(0);
    } finally {
      clearSecrets();
    }
  });

  test("a body that arrives altered or short is refused, never saved", () => {
    const encoded = Buffer.from(ZIP).toString("base64");
    const size = BigInt(ZIP.length);
    expect(() => savedBody("read", new Map<string, Value>([["body", `${encoded.slice(0, 4)}***${encoded.slice(7)}`], ["body_bytes", size]]))).toThrow(BodyDamaged);
    expect(() => savedBody("read", new Map<string, Value>([["body", encoded.slice(0, 8)], ["body_bytes", size]]))).toThrow(BodyDamaged);
    expect(() => savedBody("read", new Map<string, Value>([["body", encoded]]))).toThrow(BodyDamaged);
    expect(savedBody("read", new Map<string, Value>([["body", encoded], ["body_bytes", size]]))?.length).toBe(ZIP.length);
  });

  test("an untyped binary body is sniffed and kept raw too", async () => {
    const [, kind, text, , body] = await fetchUrl(`${base}/untyped`, 5, undefined, "keep");
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
    expect(savedBody("read", new Map([["out", "hello"]]))).toBeNull();
    expect(savedBody("script", new Map([["body", "aGk="]]))).toBeNull();
  });

  test("binary bytes after a long text head, a PDF with --out and an only-out_only script read (Codex r2)", async () => {
    const late = await fetchRun(`${base}/late-binary`, {}, { out_body: true });
    expect(late.body?.length).toBe(8192 + 3);
    await expect(fetchRun(`${base}/late-binary`, {}, {})).rejects.toMatchObject({ code: "binary_body" });
    const pdf = await fetchRun(`${base}/doc.pdf`, {}, { out_body: true });
    expect(Buffer.from(pdf.body as Uint8Array).subarray(0, 5).toString()).toBe("%PDF-");
    await expect(fetchRun(`${base}/deck.pptx`, {}, { out_only: true })).rejects.toMatchObject({ code: "binary_body" });
    expect((await fetchRun(`${base}/playlist`, { raw: true }, {})).data).toMatchObject({ content: "#EXTM3U\n#EXTINF:5,\nclip.ts\n" });
  });

  test("Codex r3: oversized ambiguous bodies, charset spellings, text models, PDF probes, raw redirects", async () => {
    await expect(fetchRun(`${base}/big-then-nul`, {}, { out_body: true })).rejects.toMatchObject({ code: "result_too_large" });
    expect((await fetchRun(`${base}/utf16-dashed`, { raw: true }, {})).data).toMatchObject({ content: "Hello" });
    expect(String((await fetchRun(`${base}/model.obj`, { raw: true }, {})).data && ((await fetchRun(`${base}/model.obj`, { raw: true }, {})).data as Record<string, unknown>)["content"])).toContain("v 1 0 0");
    expect(String(((await fetchRun(`${base}/ok`, {}, {})).data as Record<string, unknown>)["content"])).toContain("A readable page");
    const [status] = await fetchUrl(`${base}/bad-location`, 5);
    expect(status).toBe(302);
    const seenRaw: string[] = [];
    const raw = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket, chunk) {
          const line = Buffer.from(chunk).toString("latin1").split("\r\n")[0] as string;
          seenRaw.push(line);
          if (line.startsWith("GET /start ")) socket.write(Buffer.concat([Buffer.from("HTTP/1.1 302 Found\r\nContent-Length: 0\r\nLocation: "), Buffer.from("/東京", "utf8"), Buffer.from("\r\nConnection: close\r\n\r\n")]));
          else socket.write("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\nConnection: close\r\n\r\ntokyo");
          socket.end();
        },
      },
    });
    try {
      const [rawStatus, , text] = await fetchUrl(`http://127.0.0.1:${raw.port}/start`, 5);
      expect(rawStatus).toBe(200);
      expect(text).toBe("tokyo");
      expect(seenRaw.some((line) => line.startsWith("GET /%E6%9D%B1%E4%BA%AC "))).toBe(true);
    } finally {
      raw.stop(true);
    }
  });

  test("Codex r4: control bytes are binary, a quoted UTF-16 charset is text, stdin keeps its validation", async () => {
    expect((await fetchRun(`${base}/proto`, {}, { out_body: true })).body?.length).toBe(2);
    expect((await fetchRun(`${base}/octets-control`, {}, { out_body: true })).body?.length).toBe(2);
    await expect(fetchRun(`${base}/octets-control`, {}, {})).rejects.toMatchObject({ code: "binary_body" });
    expect((await fetchRun(`${base}/utf16-quoted`, { raw: true }, {})).data).toMatchObject({ content: "Hi" });
    await expect(readLocal({ stdin: true, http: true, limit: "0" }, [], `${base}/proto\n`, { out_body: true })).rejects.toBeInstanceOf(Usage);
    await expect(readLocal({ stdin: true, http: true, timeout: "soon" }, [], `${base}/proto\n`, { out_body: true })).rejects.toBeInstanceOf(Usage);
    expect((await readLocal({ stdin: true, http: true }, [], `${base}/proto\n`, { out_body: true })).body?.length).toBe(2);
  });

  test("Codex r5: a declared charset doesn't skip the control-byte check; one text URL on stdin still saves page records", async () => {
    expect((await fetchRun(`${base}/ascii-control`, {}, { out_body: true })).body?.length).toBe(2);
    await expect(fetchRun(`${base}/ascii-control`, {}, {})).rejects.toMatchObject({ code: "binary_body" });
    const text = await readLocal({ stdin: true, http: true }, [], `${base}/caf%C3%A9\n`, { out_body: true });
    expect(text.body).toBeNull();
    expect(((text.data as Record<string, unknown>)["pages"] as Record<string, unknown>[])[0]?.["title"]).toBe("Café");
  });

  test("a UTF-16 body served as octets reads as text, a pixmap saves raw", async () => {
    expect((await fetchRun(`${base}/utf16`, { raw: true }, {})).data).toMatchObject({ content: "Hello" });
    const pixmap = await fetchRun(`${base}/pixmap`, {}, { out_body: true });
    expect(pixmap.body?.length).toBe(14);
  });

  test("an optional .md probe that answers binary never breaks a readable page", async () => {
    const result = await fetchRun(`${base}/readable`, {}, {});
    expect(String((result.data as Record<string, unknown>)["content"])).toContain("A readable page");
  });

  test("--require-md refuses a binary body even with --out", async () => {
    await expect(fetchRun(`${base}/deck.pptx`, { require_md: true }, { out_body: true })).rejects.toBeInstanceOf(BrowseError);
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

  test("a redirect to a non-web scheme still stops at the redirect", async () => {
    const [status, , text] = await fetchUrl(`${base}/to-file`, 5);
    expect(status).toBe(302);
    expect(text).toBe("");
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
  test("only a read's page results pass through; other success:true answers with exit 1 are still coded", () => {
    const out = `${JSON.stringify({ success: true, data: null, error: null })}\n`;
    const answer = new Map<string, Value>([["exit", 1n], ["out", out], ["err", ""]]);
    codeJsonAnswer(answer, "get");
    expect(JSON.parse(answer.get("out") as string).code).toBe("internal_error");
    const read = new Map<string, Value>([["exit", 1n], ["out", out], ["err", ""]]);
    codeJsonAnswer(read, "read");
    expect(JSON.parse(read.get("out") as string).code).toBe("internal_error");
  });

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
