import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import "../libc-loaded.ts";
import { spawnSync } from "node:child_process";
import CODECS from "../../src/browse/read/codecs.gen.json" with { type: "json" };
import { APPROXIMATE, codecOf, decode, normalizeEncoding } from "../../src/browse/read/charset.ts";
import { fetchUrl, run as fetchRun, trustedRoots } from "../../src/browse/read/fetch.ts";
import { shadowBackends } from "../../src/browse/state/pierce.ts";
import * as oopif from "../../src/browse/state/oopif.ts";
import { Page } from "../../src/browse/state/page.ts";
import { FakeBrowser, stateWith } from "./core-helpers.ts";
import { BrowseError } from "../../src/browse/daemon-errors.ts";
import { Cancelled, withSignal } from "../../src/browse/cdp/cancel.ts";

const PYTHON = process.env["ARDIA_TEST_PYTHON"] ?? "python3";
const NAMES = Object.keys((CODECS as { names: Record<string, string> }).names);

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function pythonDecodes(cases: [string, string][]): (string | { error: string })[] {
  const script =
    "import json,sys\nout=[]\nfor hexed,name in json.load(sys.stdin):\n" +
    "  try: out.append(bytes.fromhex(hexed).decode(name, errors='replace'))\n" +
    "  except Exception as e: out.append({'error': type(e).__name__ + ': ' + str(e)})\n" +
    "sys.stdout.write(json.dumps(out))";
  const done = spawnSync(PYTHON, ["-I", "-c", script], { input: JSON.stringify(cases), maxBuffer: 1 << 28 });
  if (done.status !== 0) throw new Error(String(done.stderr));
  return JSON.parse(String(done.stdout));
}

function tsDecode(hexed: string, name: string): string | { error: string } {
  try {
    return decode(Buffer.from(hexed, "hex"), name);
  } catch (error) {
    return { error: `${(error as Error).name}: ${(error as Error).message}` };
  }
}

describe("charset decoding against CPython", () => {
  test("every codec name and spelling resolves to Python's codec or Python's LookupError", () => {
    const random = seeded(7);
    const cases: [string, string][] = [];
    const spellings = (name: string) => [name, name.toUpperCase(), name.replaceAll("_", "-"), name.replaceAll("_", " "), `${name}-`, `x${name}`];
    for (const name of [...NAMES, "utf8", "UTF-8", "latin1", "Latin-1", "nope", "base64", "hex", "rot13", "x-unknown"]) {
      for (const spelled of spellings(name)) {
        const bytes = Buffer.from(Array.from({ length: 24 }, () => Math.floor(random() * 256)));
        cases.push([bytes.toString("hex"), spelled]);
      }
    }
    const expected = pythonDecodes(cases);
    const approximate = APPROXIMATE;
    let compared = 0;
    const differences: string[] = [];
    cases.forEach(([hexed, name], index) => {
      const want = expected[index];
      const got = tsDecode(hexed, name);
      let codec: string | null = null;
      try {
        codec = codecOf(name);
      } catch {}
      if (codec !== null && approximate.has(codec) && typeof want === "string") return;
      compared += 1;
      if (JSON.stringify(want) !== JSON.stringify(got)) differences.push(`${name} ${hexed}: ${JSON.stringify(want)} vs ${JSON.stringify(got)}`);
    });
    expect(differences.slice(0, 5)).toEqual([]);
    expect(compared).toBeGreaterThan(2000);
  });

  test("utf-8, utf-16 and utf-32 replace bad bytes as Python does", () => {
    const random = seeded(11);
    const cases: [string, string][] = [];
    const pieces = ["e282ac", "f09f9880", "c3", "e2", "f0", "ff", "80", "eda080", "f4908080", "c0af", "efbbbf", "fffe", "feff", "00", "41", "0000feff", "fffe0000", "d800"];
    for (const name of ["utf-8", "utf-8-sig", "utf-16", "utf-16-le", "utf-16-be", "utf-32", "utf-32-le", "utf-32-be"]) {
      for (let index = 0; index < 400; index += 1) {
        const parts = Array.from({ length: 1 + Math.floor(random() * 8) }, () => pieces[Math.floor(random() * pieces.length)]);
        cases.push([parts.join(""), name]);
      }
    }
    const expected = pythonDecodes(cases);
    const differences = cases.filter(([hexed, name], index) => JSON.stringify(expected[index]) !== JSON.stringify(tsDecode(hexed, name)));
    expect(differences.slice(0, 5)).toEqual([]);
  });

  test("names normalize as Python's encodings package does", () => {
    expect(normalizeEncoding("UTF--8")).toBe("UTF_8");
    expect(normalizeEncoding("  latin 1 ")).toBe("latin_1");
    expect(codecOf("ISO-8859-1")).toBe("iso8859-1");
    expect(() => codecOf("nope")).toThrow("unknown encoding: nope");
  });
});

let server: ReturnType<typeof Bun.serve>;
let base = "";

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/latin") return new Response(Buffer.from([0x63, 0x61, 0x66, 0xe9]), { headers: { "content-type": "text/plain; charset=ISO-8859-1" } });
      if (url.pathname === "/cp1252") return new Response(Buffer.from([0x80, 0x81, 0x41]), { headers: { "content-type": "text/plain; charset=windows-1252" } });
      if (url.pathname === "/bogus") return new Response("x", { headers: { "content-type": "text/plain; charset=klingon" } });
      if (url.pathname === "/hop") return new Response(null, { status: 302, headers: { location: "/latin" } });
      if (url.pathname === "/missing") return new Response("gone", { status: 404 });
      if (url.pathname === "/slow") return new Promise((resolve) => setTimeout(() => resolve(new Response("late")), 3000));
      if (url.pathname === "/page") return new Response("<html><head><title>T</title></head><body><h1>Head</h1><p>Body</p></body></html>", { headers: { "content-type": "text/html" } });
      if (url.pathname === "/agent") return new Response(request.headers.get("user-agent") ?? "", { headers: { "content-type": "text/plain" } });
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

describe("readurl.fetch", () => {
  test("decodes the response's charset with Python's codec and follows redirects", async () => {
    expect(await fetchUrl(`${base}/latin`, 5)).toEqual([200, "text/plain", "café", `${base}/latin`]);
    expect((await fetchUrl(`${base}/cp1252`, 5))[2]).toBe("€�A");
    expect(await fetchUrl(`${base}/hop`, 5)).toEqual([200, "text/plain", "café", `${base}/latin`]);
    expect((await fetchUrl(`${base}/agent`, 5))[2]).toBe("ardia-browse-read/1");
  });

  test("an unknown charset fails as Python's LookupError does", async () => {
    const failure = (await fetchUrl(`${base}/bogus`, 5).catch((error: unknown) => error)) as Error;
    expect(`${failure.name}: ${failure.message}`).toBe("LookupError: unknown encoding: klingon");
  });

  test("an HTTP error answers its status with no body, and the run says so", async () => {
    expect(await fetchUrl(`${base}/missing`, 5)).toEqual([404, "", "", `${base}/missing`]);
    await expect(fetchRun(`${base}/missing`, {}, {})).rejects.toThrow(`${base}/missing answered HTTP 404`);
  });

  test("a slow site times out and a refused port says why", async () => {
    await expect(fetchUrl(`${base}/slow`, 0.3)).rejects.toThrow(`Couldn't fetch ${base}/slow: timed out`);
    await expect(fetchUrl("http://127.0.0.1:9/", 2)).rejects.toThrow("Couldn't fetch http://127.0.0.1:9/: [Errno 61] Connection refused");
    await expect(fetchUrl("ftp://x/", 2)).rejects.toThrow("read fetches http(s) URLs only, not ftp://x/");
  });

  test("a cancelled fetch stops at once", async () => {
    const stop = new AbortController();
    const reading = withSignal(stop.signal, () => fetchUrl(`${base}/slow`, 10));
    setTimeout(() => stop.abort(), 50);
    const started = performance.now();
    await expect(reading).rejects.toBeInstanceOf(Cancelled);
    expect(performance.now() - started).toBeLessThan(1500);
  });

  test("html is extracted, titled and marked as such", async () => {
    const result = await fetchRun(`${base}/page`, { raw: false }, {});
    expect((result.data as Record<string, unknown>)["source"]).toBe("html-extract");
    expect((result.data as Record<string, unknown>)["title"]).toBe("T");
    expect(result.text).toBe("# Head\n\nBody");
  });

  test("extra roots come from SSL_CERT_FILE and NODE_EXTRA_CA_CERTS beside the bundled ones", () => {
    expect(trustedRoots({})).toBeNull();
    const roots = trustedRoots({ SSL_CERT_FILE: "/etc/ssl/cert.pem" });
    expect(roots === null || roots.length > 100).toBe(true);
  });

  test("a self-signed https server is refused with the certificate error", async () => {
    const tls = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { cert: SELF_SIGNED.cert, key: SELF_SIGNED.key },
      fetch: () => new Response("secret"),
    });
    try {
      const failure = (await fetchUrl(`https://127.0.0.1:${tls.port}/`, 5).catch((error: unknown) => error)) as BrowseError;
      expect(failure).toBeInstanceOf(BrowseError);
      expect(failure.text).toContain("[SSL: CERTIFICATE_VERIFY_FAILED]");
    } finally {
      tls.stop(true);
    }
  });
});

describe("shadow roots for selectors (row 12)", () => {
  test("open and closed roots are found at any depth, user-agent roots are not", () => {
    const document = {
      nodeId: 1,
      children: [
        { nodeId: 2, shadowRoots: [{ nodeId: 3, backendNodeId: 30, shadowRootType: "closed", children: [{ nodeId: 4, shadowRoots: [{ backendNodeId: 40, shadowRootType: "closed" }] }] }] },
        { nodeId: 5, shadowRoots: [{ backendNodeId: 50, shadowRootType: "user-agent" }] },
        { nodeId: 6, shadowRoots: [{ backendNodeId: 60, shadowRootType: "open" }] },
      ],
    };
    expect(shadowBackends(document)).toEqual([30, 40, 60]);
  });
});

describe("out-of-process iframes (rows 13, 21)", () => {
  function attachedPage() {
    const browser = new FakeBrowser((method, _params, session) => {
      if (method === "Page.getFrameTree" && session === "CHILD") {
        return { frameTree: { frame: { id: "OOPIF", parentId: "FRAME-MAIN", loaderId: "L2", url: "http://other/", securityOrigin: "http://other" }, childFrames: [{ frame: { id: "INNER", parentId: "OOPIF", loaderId: "L3", url: "http://other/inner" } }] } };
      }
      return undefined;
    });
    const state = stateWith(browser);
    return { browser, state };
  }

  test("an attached iframe joins the page's frames with its own session, and leaves with it", async () => {
    const { browser, state } = attachedPage();
    const page = await state.page("TARGET");
    expect(browser.methods(page.sessionId)).toContain("Target.setAutoAttach");
    state.onEvent("Target.attachedToTarget", { sessionId: "CHILD", targetInfo: { type: "iframe", targetId: "OOPIF" } }, page.sessionId);
    expect(page.oopifs.get("CHILD")).toEqual({ root: "OOPIF", parentSession: page.sessionId as string });
    await page.refreshFrames();
    expect([...page.frames.keys()]).toEqual(["FRAME-MAIN", "OOPIF", "INNER"]);
    expect(page.frames.get("OOPIF")?.parent).toBe("FRAME-MAIN");
    expect(page.sessionFor("INNER")).toBe("CHILD");
    expect(page.sessionFor("FRAME-MAIN")).toBe(page.sessionId);
    await page.send("Runtime.evaluate", { expression: "1" }, { session: page.sessionFor("INNER") });
    expect(browser.sent.at(-1)?.session).toBe("CHILD");
    state.onEvent("Inspector.targetCrashed", {}, "CHILD");
    expect(page.crashed).toBe(false);
    state.onEvent("Target.detachedFromTarget", { sessionId: "CHILD" }, page.sessionId);
    expect(page.oopifs.size).toBe(0);
    expect(page.frames.has("OOPIF")).toBe(false);
    expect(page.sessionFor("INNER")).toBe(page.sessionId);
    expect(state.sessions.has("CHILD")).toBe(false);
  });

  test("a worker or page target attached by mistake is detached at once", async () => {
    const { browser, state } = attachedPage();
    const page = await state.page("TARGET");
    state.onEvent("Target.attachedToTarget", { sessionId: "WORKER", targetInfo: { type: "worker", targetId: "W" } }, page.sessionId);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(page.oopifs.size).toBe(0);
    expect(browser.sent.some((entry) => entry.method === "Target.detachFromTarget" && entry.params["sessionId"] === "WORKER")).toBe(true);
  });

  test("a page that detaches forgets its iframe sessions", async () => {
    const { state } = attachedPage();
    const page = await state.page("TARGET");
    state.onEvent("Target.attachedToTarget", { sessionId: "CHILD", targetInfo: { type: "iframe", targetId: "OOPIF" } }, page.sessionId);
    page.detach();
    expect(page.oopifs.size + page.frameSessions.size).toBe(0);
    expect(state.sessions.has("CHILD")).toBe(false);
    expect(page instanceof Page).toBe(true);
    expect(oopif.AUTO_ATTACH.filter).toEqual([{ type: "iframe" }, { exclude: true }]);
  });
});

const SELF_SIGNED = (() => {
  const dir = spawnSync("mktemp", ["-d"]).stdout.toString().trim();
  spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${dir}/key.pem`, "-out", `${dir}/cert.pem`, "-days", "1", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
  const read = (name: string) => require("node:fs").readFileSync(`${dir}/${name}`, "utf8") as string;
  const pair = { cert: read("cert.pem"), key: read("key.pem") };
  require("node:fs").rmSync(dir, { recursive: true, force: true });
  return pair;
})();
