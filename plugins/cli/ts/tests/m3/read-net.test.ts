import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import "../libc-loaded.ts";
import { spawnSync } from "node:child_process";
import CODECS from "../../src/browse/read/codecs.gen.json" with { type: "json" };
import { APPROXIMATE, codecOf, decode, normalizeEncoding } from "../../src/browse/read/charset.ts";
import { fetchUrl, run as fetchRun, trustedRoots } from "../../src/browse/read/fetch.ts";
import { shadowBackends } from "../../src/browse/state/pierce.ts";
import { frameOffset } from "../../src/browse/state/offsets.ts";
import * as oopif from "../../src/browse/state/oopif.ts";
import { Page } from "../../src/browse/state/page.ts";
import { FakeBrowser, stateWith } from "./core-helpers.ts";
import { BrowseError, CdpError, ConnectionLost } from "../../src/browse/daemon-errors.ts";
import { fieldValues } from "../../src/browse/snapshot/collect.ts";
import { Cancelled, withSignal } from "../../src/browse/cdp/cancel.ts";
import { oracle } from "../oracle-fixtures.ts";

type Decoded = string | { error: string };
const FROZEN = oracle<{ codecs: [string, string, Decoded][]; utf: [string, string, Decoded][] }>("read-net");
const NAMES = Object.keys((CODECS as { names: Record<string, string> }).names);

function tsDecode(hexed: string, name: string): string | { error: string } {
  try {
    return decode(Buffer.from(hexed, "hex"), name);
  } catch (error) {
    return { error: `${(error as Error).name}: ${(error as Error).message}` };
  }
}

describe("charset decoding against CPython", () => {
  test("every codec name and spelling resolves to Python's codec or Python's LookupError", () => {
    const approximate = APPROXIMATE;
    let compared = 0;
    const differences: string[] = [];
    for (const [hexed, name, want] of FROZEN.codecs) {
      const got = tsDecode(hexed, name);
      let codec: string | null = null;
      try {
        codec = codecOf(name);
      } catch {}
      if (codec !== null && approximate.has(codec) && typeof want === "string") continue;
      compared += 1;
      if (JSON.stringify(want) !== JSON.stringify(got)) differences.push(`${name} ${hexed}: ${JSON.stringify(want)} vs ${JSON.stringify(got)}`);
    }
    expect(differences.slice(0, 5)).toEqual([]);
    expect(compared).toBeGreaterThan(2000);
    const frozenNames = new Set(FROZEN.codecs.map(([, name]) => name));
    expect(NAMES.filter((name) => !frozenNames.has(name))).toEqual([]);
  });

  test("utf-8, utf-16 and utf-32 replace bad bytes as Python does", () => {
    const differences = FROZEN.utf.filter(([hexed, name, want]) => JSON.stringify(want) !== JSON.stringify(tsDecode(hexed, name)));
    expect(differences.slice(0, 5)).toEqual([]);
    expect(FROZEN.utf.length).toBe(3200);
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
      if (url.pathname === "/to-file") return new Response(null, { status: 302, headers: { location: "file:///etc/hosts" } });
      if (url.pathname === "/to-data") return new Response(null, { status: 302, headers: { location: "data:text/plain,secret" } });
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

  test("a redirect to file: or data: is refused with the redirect's status, as urllib refuses it", async () => {
    expect(await fetchUrl(`${base}/to-file`, 5)).toEqual([302, "", "", `${base}/to-file`]);
    expect(await fetchUrl(`${base}/to-data`, 5)).toEqual([302, "", "", `${base}/to-data`]);
    const result = await fetchRun(`${base}/to-file`, { raw: true }, {});
    expect(result.text).not.toContain("localhost");
    await expect(fetchUrl("file:///etc/hosts", 5)).rejects.toThrow("read fetches http(s) URLs only, not file:///etc/hosts");
    await expect(fetchUrl("data:text/plain,secret", 5)).rejects.toThrow("read fetches http(s) URLs only");
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

describe("frame offsets across out-of-process iframes (get box, D5's clicks)", () => {
  test("a frame two OOPIF levels down adds each owner's offset, each asked in the session that holds the owner", async () => {
    const owners: Record<string, number> = { "SESSION-1|A": 11, "CHILD1|B": 22, "CHILD2|C": 33 };
    const quads: Record<string, number[]> = {
      "SESSION-1|11": [100, 50, 400, 50, 400, 250, 100, 250],
      "CHILD1|22": [10, 20, 200, 20, 200, 120, 10, 120],
      "CHILD2|33": [3, 4, 50, 4, 50, 40, 3, 40],
    };
    const browser = new FakeBrowser((method, params, session) => {
      if (method === "DOM.getFrameOwner") {
        const backend = owners[`${session}|${params["frameId"]}`];
        return backend === undefined ? new Error(`no owner of ${params["frameId"]} in ${session}`) : { backendNodeId: backend };
      }
      if (method === "DOM.getContentQuads") return { quads: [quads[`${session}|${params["backendNodeId"]}`]] };
      return undefined;
    });
    const state = stateWith(browser);
    const page = await state.page("TARGET");
    const top = page.sessionId as string;
    page.oopifs.set("CHILD1", { root: "A", parentSession: top });
    page.oopifs.set("CHILD2", { root: "B", parentSession: "CHILD1" });
    for (const [frame, session] of [["A", "CHILD1"], ["B", "CHILD2"], ["C", "CHILD2"]]) page.frameSessions.set(frame as string, session as string);
    page.frames.set("A", { id: "A", url: "", loader: "LA", parent: "FRAME-MAIN", name: "", origin: "" });
    page.frames.set("B", { id: "B", url: "", loader: "LB", parent: "A", name: "", origin: "" });
    page.frames.set("C", { id: "C", url: "", loader: "LC", parent: "B", name: "", origin: "" });
    expect(await frameOffset(page, "C")).toEqual([113, 74]);
    expect(await frameOffset(page, "B")).toEqual([110, 70]);
    expect(await frameOffset(page, "FRAME-MAIN")).toEqual([0, 0]);
    const asked = browser.sent.filter((entry) => entry.method === "DOM.getFrameOwner").map((entry) => `${entry.session}|${entry.params["frameId"]}`);
    expect(asked.slice(0, 3)).toEqual(["CHILD2|C", "CHILD1|B", "SESSION-1|A"]);
  });
});


describe("iframe sessions that go away", () => {
  test("a call to a frame whose iframe session is gone says the frame is gone, not that the tab detached", async () => {
    const browser = new FakeBrowser((method, _params, session) =>
      session === "CHILD" && method === "Runtime.evaluate" ? new CdpError(method, "Session with given id not found.") : undefined,
    );
    const state = stateWith(browser);
    const page = await state.page("TARGET");
    state.onEvent("Target.attachedToTarget", { sessionId: "CHILD", targetInfo: { type: "iframe", targetId: "OOPIF" } }, page.sessionId);
    const answered = (await page.send("Runtime.evaluate", { expression: "1" }, { session: "CHILD" }).catch((error: unknown) => error)) as BrowseError;
    expect(answered.code).toBe("frame_gone");
    state.onEvent("Target.detachedFromTarget", { sessionId: "CHILD" }, page.sessionId);
    const refused = (await page.send("Runtime.evaluate", { expression: "1" }, { session: "CHILD" }).catch((error: unknown) => error)) as BrowseError;
    expect(refused.code).toBe("frame_gone");
    expect(page.sessionId).not.toBeNull();
  });
});

describe("settledAll", () => {
  test("a lost connection inside one field's lookup is swallowed with the rest, as Python's gather(return_exceptions=True) does", async () => {
    const page = {
      resolveBackend: async () => {
        throw new ConnectionLost();
      },
    };
    const node = { role: "textbox", name: "", value: "", props: new Map([["inputType", "text"]]), backend: 5, children: [], ref: null, hints: null, url: null, frame: "F" };
    await fieldValues(page as unknown as Page, [node as never]);
    expect(node.value).toBe("");
  });
});
