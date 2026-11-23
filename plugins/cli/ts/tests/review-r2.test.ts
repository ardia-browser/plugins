import "./libc-loaded.ts";
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { RECORDER_SOURCE } from "../src/browse/commands/record.ts";
import { BrowseError } from "../src/browse/daemon-errors.ts";
import type { Action } from "../src/browse/flows/actions.ts";
import { loadEpisodes, proposals } from "../src/browse/flows/episodes.ts";
import { fixtureDir, writeFixture } from "../src/browse/flows/fixture.ts";
import { driver, needsConfirmation, replayFlow } from "../src/browse/flows/flowrun.ts";
import { type Driver, replayStep } from "../src/browse/flows/replay.ts";
import { fetchUrl, run as fetchRun } from "../src/browse/read/fetch.ts";
import { hopGuard, privateAddress } from "../src/browse/read/netguard.ts";
import { listedMarkdown } from "../src/browse/read/fastpath.ts";

const temps: string[] = [];
const servers: { stop: (force?: boolean) => void }[] = [];
afterAll(() => {
  for (const server of servers) server.stop(true);
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ardia-r2-")));
  temps.push(dir);
  return dir;
}

function serve(handler: (request: Request) => Response): { port: number; hits: string[] } {
  const hits: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      hits.push(new URL(request.url).pathname);
      return handler(request);
    },
  });
  servers.push(server);
  return { port: server.port as number, hits };
}

async function refusal(work: Promise<unknown>): Promise<string | null> {
  try {
    await work;
    return null;
  } catch (error) {
    return error instanceof BrowseError ? (error.code ?? "browse_error") : String(error);
  }
}

describe("pinned connections", () => {
  test("site-local fec0::/10 is private", () => {
    expect(privateAddress("fec0::1")).toBe(true);
    expect(privateAddress("feff::1")).toBe(true);
  });

  test("a request connects to the address the guard checked, not a fresh lookup", async () => {
    const site = serve(() => new Response("pinned body", { headers: { "content-type": "text/plain" } }));
    const guard = hopGuard(`http://docs.pinned.test:${site.port}/`, async () => ["127.0.0.1"]);
    const [status, , text] = await fetchUrl(`http://docs.pinned.test:${site.port}/a`, 3, "text/plain", "refuse", guard);
    expect(status).toBe(200);
    expect(text).toBe("pinned body");
    expect(site.hits).toEqual(["/a"]);
  });

  test("a host that answered public first and private later is refused before connecting", async () => {
    const site = serve(() => new Response("should not be read"));
    const answers = [["93.184.216.34"], ["127.0.0.1"]];
    const guard = hopGuard(`http://rebind.test:${site.port}/`, async () => answers.shift() ?? ["127.0.0.1"]);
    expect(await guard.check(`http://rebind.test:${site.port}/`)).not.toBeNull();
    expect(await refusal(fetchUrl(`http://rebind.test:${site.port}/llms.txt`, 3, "text/plain", "skip", guard))).toBe("unsafe_address");
    expect(site.hits).toEqual([]);
  });

  test("another port on the page's own private host is not the page's origin", async () => {
    const guard = hopGuard("http://127.0.0.1:8765/", async () => []);
    expect(await guard.check("http://127.0.0.1:8765/llms.txt")).toEqual({ url: "http://127.0.0.1:8765/llms.txt", address: "127.0.0.1" });
    expect(await guard.check("http://127.0.0.1:22/")).toBeNull();
  });
});

describe("the binary fallback keeps the guard", () => {
  test("a binary page whose second answer redirects to the metadata address is refused, and the refusal is not a miss", async () => {
    let calls = 0;
    const site = serve((request) => {
      calls += 1;
      if (calls === 1) return new Response(new Uint8Array([0, 1, 2, 3, 255, 254]), { headers: { "content-type": "application/octet-stream" } });
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
    });
    const code = await refusal(fetchRun(`http://127.0.0.1:${site.port}/file`, { fast: true, timeout: "3000" }, {}));
    expect(code).toBe("unsafe_address");
    expect(calls).toBe(2);
  });
});

class Counting implements Driver {
  readonly ran: string[][] = [];
  constructor(private readonly matches: number) {}
  async run(argv: string[]): Promise<void> {
    this.ran.push(argv);
  }
  async snapshot(): Promise<string> {
    return "";
  }
  url(): string {
    return "https://app.example.com/";
  }
  async count(): Promise<number> {
    return this.matches;
  }
}

describe("replay confirmation and uniqueness", () => {
  const click: Action = { type: "click", intent: "click", candidates: [{ by: "text", value: "Go" }], fingerprint: null };
  const flowWith = (writes: boolean | undefined, actions: Action[]) => ({ writes, steps: actions.map((action, index) => ({ seq: index + 1, action })) });

  test("a mutating step needs --yes whatever the file's writes says", () => {
    expect(needsConfirmation(flowWith(false, [click]))).toBe(true);
    expect(needsConfirmation(flowWith(undefined, []))).toBe(true);
    const open: Action = { type: "open", intent: "open", candidates: [], fingerprint: null, value: "https://app.example.com/" };
    const wait: Action = { type: "wait", intent: "wait", candidates: [], fingerprint: null, argv: ["wait", "500"] };
    expect(needsConfirmation(flowWith(false, [open, wait]))).toBe(false);
  });

  test("a role-based press or submit acts only on a single match", async () => {
    for (const type of ["press", "submit"]) {
      const action: Action = { type, intent: type, candidates: [{ by: "role", value: "textbox", name: "Search" }], fingerprint: { role: "textbox", name: "Search" }, value: "Enter" };
      const several = new Counting(2);
      const outcome = await replayStep(several, { seq: 1, action }, {});
      expect(outcome.ok).toBe(false);
      expect(several.ran.filter((argv) => !(argv[0] === "press" && argv[1] === "Escape"))).toEqual([]);
      expect(outcome.attempts[0]).toMatchObject({ ok: false, code: "ambiguous" });
      const one = new Counting(1);
      expect((await replayStep(one, { seq: 1, action }, {})).ok).toBe(true);
      expect(one.ran[0]).toEqual(["press", 'role=textbox[name="Search"]', "Enter"]);
    }
  });
});

describe("episodes never keep a secret, even one that is also a plain param", () => {
  test("the stored episode masks the value everywhere", async () => {
    const root = tempDir();
    const failing: Driver = {
      run: async () => {
        throw new BrowseError("No field shows 4321", null, "not_found");
      },
      snapshot: async () => "- textbox \"Note\": 4321",
      url: () => "https://app.example.com/",
      count: async () => 1,
    };
    const live = driver.live;
    driver.live = () => failing;
    try {
      const flow = {
        name: "pinflow",
        site: "example.com",
        verified: true,
        params: [{ name: "pin", example: null, source: "secret" }, { name: "note", example: null, source: "typed" }],
        steps: [{ seq: 1, action: { type: "fill", intent: "enter {{note}}", candidates: [{ by: "aria-label", value: "Note" }], fingerprint: null, value: "{{note}}" } }],
      };
      expect(await refusal(replayFlow({} as never, root, flow, { pin: "4321", note: "4321" }))).toBe("flow_step_failed");
    } finally {
      driver.live = live;
    }
    const stored = loadEpisodes(root, "example.com", "pinflow");
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain("4321");
  });
});

describe("recorder sensitivity", () => {
  function element(extra: Record<string, unknown>) {
    const el: Record<string, unknown> = {
      nodeType: 1,
      localName: "input",
      type: "text",
      id: "",
      value: "hunter22",
      labels: [],
      classList: [],
      parentElement: null,
      previousElementSibling: null,
      isContentEditable: false,
      innerText: "",
      textContent: "",
      ...extra,
    };
    el["getAttribute"] = (name: string) => ((extra["attributes"] as Record<string, string> | undefined) ?? {})[name] ?? (name === "type" ? el["type"] : null);
    el["hasAttribute"] = () => false;
    el["closest"] = () => el;
    el["ownerDocument"] = { querySelectorAll: () => [el], getElementById: (id: string) => (id === "pinlabel" ? { textContent: "Your PIN" } : null) };
    return el;
  }

  function recorder() {
    const handlers: Record<string, (event: unknown) => void> = {};
    const sent: Record<string, any>[] = [];
    const context = vm.createContext({
      __ardiaRecordQueue: { get length() { return sent.length; }, push: (payload: string) => sent.push(JSON.parse(payload)) },
      addEventListener: (name: string, handler: (event: unknown) => void) => {
        handlers[name] = handler;
      },
      removeEventListener: () => {},
      CSS: { escape: (text: string) => text },
      document: { activeElement: null, body: {} },
      location: { href: "https://app.example.com/" },
      Date,
      JSON,
    });
    vm.runInContext("var globalThis = this; var window = this; window.top = window;", context);
    vm.runInContext(RECORDER_SOURCE, context);
    return { handlers, sent };
  }

  test("a field whose <label> or aria-labelledby text says password or PIN sends no value", () => {
    for (const el of [element({ labels: [{ innerText: "Password" }] }), element({ attributes: { "aria-labelledby": "pinlabel" } })]) {
      const { handlers, sent } = recorder();
      handlers["input"]!({ isTrusted: true, composedPath: () => [el] });
      handlers["change"]!({ isTrusted: true, target: el });
      expect(sent[0]).toMatchObject({ kind: "fill", value: "", secret: true });
    }
  });

  test("a secret contenteditable is described without its text", () => {
    const el = element({ localName: "div", type: undefined, isContentEditable: true, innerText: "my secret note", textContent: "my secret note", attributes: { "aria-label": "Recovery code" } });
    const { handlers, sent } = recorder();
    handlers["input"]!({ isTrusted: true, composedPath: () => [el] });
    handlers["change"]!({ isTrusted: true, target: el });
    handlers["keydown"]!({ isTrusted: true, key: "Enter", composedPath: () => [el] });
    expect(JSON.stringify(sent)).not.toContain("my secret note");
    expect(sent.some((event) => event.target?.name === "Recovery code")).toBe(true);
  });
});

describe("heal compares tags", () => {
  test("a select never stands in for an input of the same name", () => {
    const flow = { name: "f", params: [], steps: [{ seq: 1, action: { type: "fill", intent: "x", fingerprint: null, candidates: [{ by: "css", value: "#gone" }, { by: "name", value: "search", tag: "input" }] } }] };
    const episode = { kind: "healed" as const, at: "t", flow: "f", site: "s", seq: 1, type: "fill", intent: "x", url: "", tier: "candidate" as const, candidate: 1, fingerprint: null, tried: [] };
    expect(proposals(flow, [{ ...episode, matched: { by: "name", value: "search", tag: "select" } }])).toEqual([]);
    expect(proposals(flow, [{ ...episode, matched: { by: "name", value: "search", tag: "input" } }])[0]!.candidates[0]).toEqual({ by: "name", value: "search", tag: "input" });
  });
});

describe("fixture paths keep their links visible", () => {
  test("the destination is resolved without following links, so a linked folder is refused", () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, "real"));
    fs.symlinkSync(path.join(root, "real"), path.join(root, "link"));
    expect(fixtureDir(root, "link")).toBe(path.join(root, "link"));
    expect(fixtureDir(root, "~/x", "/home/u")).toBe("/home/u/x");
    expect(() => writeFixture(fixtureDir(root, "link"), { "a.txt": "x" })).toThrow("link");
    expect(fs.readdirSync(path.join(root, "real"))).toEqual([]);
  });
});

describe("Markdown a page lists", () => {
  test("is taken whatever generic type it's served as, but never HTML", () => {
    expect(listedMarkdown("application/octet-stream", "# Shop")).toBe(true);
    expect(listedMarkdown("text/markdown", "# Shop")).toBe(true);
    expect(listedMarkdown("text/html", "# Shop")).toBe(false);
    expect(listedMarkdown("application/octet-stream", "<!doctype html><p>x")).toBe(false);
  });
});
