import "./libc-loaded.ts";
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { capture, DRAIN, drainFrames, drainSource, finalDrain, type Pages, RECORDER_SOURCE, recordedFlow, STOP_DRAIN } from "../src/browse/commands/record.ts";
import { BrowseError, OutcomeUnknown, Usage } from "../src/browse/daemon-errors.ts";
import type { Action } from "../src/browse/flows/actions.ts";
import { compileEvents } from "../src/browse/flows/compile.ts";
import { applyPatch, parsePatch, proposals } from "../src/browse/flows/episodes.ts";
import { writeFixture } from "../src/browse/flows/fixture.ts";
import { validate } from "../src/browse/flows/flows.ts";
import { type Driver, replay, replayStep } from "../src/browse/flows/replay.ts";
import { type Fetched, type Fetcher, fastRead, markdownSibling, pickReadable, type Probe } from "../src/browse/read/fastpath.ts";
import { hopGuard, privateAddress } from "../src/browse/read/netguard.ts";
import { isConsequential } from "../src/browse/read/webmcp.ts";

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ardia-r1-")));
  temps.push(dir);
  return dir;
}

const BUTTON = { tag: "button", role: "button", name: "Save", text: "Save", css: "main > button", xpath: "/html[1]/body[1]/main[1]/button[1]", type: "button" };

describe("site tools cannot waive confirmation", () => {
  test("readOnlyHint never clears a destructive name or annotation", () => {
    expect(isConsequential("delete_all", { readOnlyHint: true })).toBe(true);
    expect(isConsequential("lookup", { readOnlyHint: true, destructiveHint: true })).toBe(true);
  });
});

describe("read --fast stays off private networks", () => {
  test("private, loopback, link-local, metadata and mapped addresses are private", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a9fe:a9fe", "224.0.0.1"]) {
      expect(privateAddress(ip)).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(privateAddress(ip)).toBe(false);
  });

  test("a hop is allowed on the page's own origin or on a host that resolves only to public addresses", async () => {
    const resolve = async (host: string) => ({ "public.example": ["93.184.216.34"], "rebind.example": ["93.184.216.34", "10.0.0.5"], "inside.example": ["192.168.0.10"] })[host] ?? [];
    const guard = hopGuard("http://127.0.0.1:8765/docs", resolve);
    expect(await guard.check("http://127.0.0.1:8765/llms.txt")).not.toBeNull();
    expect(await guard.check("http://127.0.0.1:9999/")).toBeNull();
    expect(await guard.check("http://169.254.169.254/latest/meta-data")).toBeNull();
    expect(await guard.check("http://[::ffff:a9fe:a9fe]/")).toBeNull();
    expect(await guard.check("https://public.example/guide.md")).not.toBeNull();
    expect(await guard.check("https://rebind.example/guide.md")).toBeNull();
    expect(await guard.check("https://inside.example/guide.md")).toBeNull();
    expect(await guard.check("http://localhost/")).toBeNull();
    expect(await guard.check("file:///etc/passwd")).toBeNull();
  });

  test("an ard.json entry pointing at the metadata service is never fetched", async () => {
    const asked: string[] = [];
    const ard = JSON.stringify({ documents: [{ url: "/guide", markdown: "http://169.254.169.254/latest/meta-data/iam" }] });
    const fetcher: Fetcher = async (url, _timeout, _accept, _binary, guard) => {
      if (guard && !(await guard.check(url))) throw new BrowseError(`refused ${url}`, null, "unsafe_address");
      asked.push(url);
      if (url === "https://docs.example.com/.well-known/ard.json") return [200, "application/json", ard, url] as Fetched;
      if (url === "https://docs.example.com/guide") return [200, "text/html", "<html><body><main><p>Guide text here.</p></main></body></html>", url] as Fetched;
      return [404, "", "", url] as Fetched;
    };
    let refused: unknown = null;
    try {
      await fastRead("https://docs.example.com/guide", 2, fetcher, {}, true, { tried: [], binary: null }, async () => ["93.184.216.34"]);
    } catch (error) {
      refused = error;
    }
    expect(asked).not.toContain("http://169.254.169.254/latest/meta-data/iam");
    expect((refused as BrowseError).code).toBe("unsafe_address");
  });
});

describe("read --fast edge cases", () => {
  test("the .md sibling of a directory URL keeps the host", () => {
    expect(markdownSibling("https://docs.example.org/")).toBe("https://docs.example.org/index.md");
    expect(markdownSibling("https://docs.example.org")).toBe("https://docs.example.org/index.md");
    expect(markdownSibling("https://docs.example.org/guide?x=1#top")).toBe("https://docs.example.org/guide.md");
    expect(markdownSibling("https://docs.example.org/guide.md")).toBeNull();
  });

  test("a short page the reader empties reads as raw", () => {
    expect(pickReadable("", "Sign in to continue")).toMatchObject({ method: "raw", content: "Sign in to continue" });
  });

  test("a binary first answer is reported, not retried as HTML", async () => {
    let calls = 0;
    const fetcher: Fetcher = async (url) => {
      calls += 1;
      return [200, "application/pdf", "", url, new Uint8Array()] as Fetched;
    };
    const probe: Probe = { tried: [], binary: null };
    expect(await fastRead("https://docs.example.com/a.pdf", 2, fetcher, {}, true, probe)).toBeNull();
    expect(probe.tried).toEqual(["markdown"]);
    expect(probe.binary).toBe("application/pdf");
    expect(typeof probe.guard?.request).toBe("function");
    expect(calls).toBe(1);
  });
});

describe("recorded flows need confirmation", () => {
  test("a JS button click with no form still marks the flow as writing", () => {
    expect(compileEvents([{ kind: "click", at: 1, target: BUTTON }], "https://app.example.com/").writes).toBe(true);
    expect(compileEvents([], "https://app.example.com/").writes).toBe(false);
  });
});

class Driven implements Driver {
  readonly ran: string[][] = [];
  constructor(
    private readonly answer: (argv: string[]) => Error | null,
    private readonly matches: (selector: string) => number = () => 1,
  ) {}
  async run(argv: string[]): Promise<void> {
    this.ran.push(argv);
    const error = this.answer(argv);
    if (error) throw error;
  }
  async snapshot(): Promise<string> {
    return "";
  }
  url(): string {
    return "https://app.example.com/";
  }
  async count(selector: string): Promise<number> {
    return this.matches(selector);
  }
}

const save: Action = {
  type: "click",
  intent: 'click the "Save" button',
  candidates: [
    { by: "aria-label", value: "Save" },
    { by: "text", value: "Save" },
  ],
  fingerprint: { role: "button", name: "Save" },
};

describe("replay never guesses", () => {
  test("an unknown outcome from the Escape press stops the step", async () => {
    const driver = new Driven((argv) => (argv[0] === "press" ? new OutcomeUnknown("press", "the page navigated") : new BrowseError("covered", null, "covered")));
    const outcome = await replayStep(driver, { seq: 1, action: save }, {});
    expect(outcome.ok).toBe(false);
    expect(outcome.fatal).toContain("unknown");
    expect(driver.ran.map((argv) => argv[0])).toEqual(["click", "click", "press"]);
  });

  test("a locator that matches several elements is skipped, never clicked", async () => {
    const driver = new Driven(() => null, (selector) => (selector === '[aria-label="Save"]' ? 3 : 1));
    const outcome = await replayStep(driver, { seq: 1, action: save }, {});
    expect(outcome).toMatchObject({ ok: true, tier: "candidate", candidate: 1 });
    expect(outcome.attempts[0]).toMatchObject({ ok: false, code: "ambiguous" });
    expect(driver.ran).toEqual([["click", 'text="Save"']]);
  });

  test("secrets are scrubbed from every field of an episode", async () => {
    const driver = new Driven(() => new BrowseError("No field holds hunter22", null, "not_found"), () => 1);
    const report = await replay(driver, { name: "login", site: "example.com" }, [{ seq: 1, action: { ...save, intent: "enter hunter22" } }], {}, ["hunter22"]);
    expect(JSON.stringify(report)).not.toContain("hunter22");
  });
});

describe("recording drains a queue in ardia's own page world", () => {
  const payload = (kind: string, at: number) => JSON.stringify({ kind, at, target: { tag: "button", role: "button", name: "Save" } });
  function fakePages(script: Record<string, unknown[][]>, closed = false): Pages & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      frames: () => ["main", "child"],
      call: async (fn, frame) => {
        const kind = fn === STOP_DRAIN ? "stop" : fn === DRAIN || fn === drainSource("t0") ? "drain" : "?";
        calls.push(`${kind} ${frame}`);
        if (frame === "child" && kind === "drain") throw new Error("frame gone");
        return script[kind]?.shift() ?? [];
      },
      closed: () => closed,
    };
  }

  test("each drain reads every frame, skips a frame that fails, and keeps only valid events", async () => {
    const pages = fakePages({ drain: [[payload("click", 2), "not json", JSON.stringify({ kind: "eval", at: 1 })]] });
    const into: never[] = [];
    expect(await drainFrames(pages, DRAIN, into)).toBe(1);
    expect(pages.calls).toEqual(["drain main", "drain child"]);
  });

  test("the final drain stops the listeners and keeps what they flushed, even when the command is interrupted", async () => {
    const pages = fakePages({ stop: [[payload("fill", 9)], [payload("fill", 10)]] });
    const into: { kind: string }[] = [];
    const aborted = new AbortController();
    aborted.abort();
    const { withSignal } = await import("../src/browse/cdp/cancel.ts");
    await withSignal(aborted.signal, () => finalDrain(pages, into as never));
    expect(into.map((event) => event.kind)).toEqual(["fill", "fill"]);
    const closed = fakePages({ stop: [[payload("fill", 9)]] }, true);
    await finalDrain(closed, []);
    expect(closed.calls).toEqual([]);
  });

  test("capture polls until idle and ends with a stop drain, with no binding or init script", async () => {
    const pages = fakePages({ drain: [[payload("click", 1)]], stop: [[payload("fill", 5)]] });
    const sent: string[] = [];
    const page = { url: "https://app.example.com/", crashed: false, refreshFrames: async () => new Map(), send: async (method: string) => sent.push(method) };
    const ctx = { state: { listeners: [] as unknown[] } };
    const { events, stoppedBy } = await capture(ctx as never, page as never, 5, 0.3, pages, "t0");
    expect(stoppedBy).toBe("idle");
    expect(events.map((event) => event.kind)).toEqual(["click", "fill"]);
    expect(pages.calls.at(-2)).toBe("stop main");
    expect(sent).toEqual([]);
    expect(ctx.state.listeners).toEqual([]);
  });
});

describe("recorder privacy", () => {
  function field(type: string) {
    const el: Record<string, unknown> = {
      nodeType: 1,
      localName: "input",
      type,
      id: "",
      value: "hunter22",
      labels: [],
      classList: [],
      parentElement: null,
      previousElementSibling: null,
      isContentEditable: false,
      getAttribute: (name: string) => (name === "type" ? el["type"] : null),
      hasAttribute: () => false,
    };
    el["closest"] = () => el;
    el["ownerDocument"] = { querySelectorAll: () => [el], getElementById: () => null };
    return el;
  }

  test("a field that was a password when typed into stays secret after it turns into text", () => {
    const handlers: Record<string, (event: unknown) => void> = {};
    const sent: Record<string, unknown>[] = [];
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
    const el = field("password");
    handlers["input"]!({ isTrusted: true, composedPath: () => [el] });
    el["type"] = "text";
    handlers["change"]!({ isTrusted: true, target: el });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "fill", value: "", secret: true });
  });

  test("ordinary typed text with spaces records and validates, keeping no example it can't store", () => {
    const target = { tag: "input", role: "textbox", name: "Note", ariaLabel: "Note", fieldName: "note", type: "text" };
    const { flow } = recordedFlow("note", [{ kind: "fill", at: 1, target, value: "hello world, see you at 5" }, { kind: "click", at: 2, target: BUTTON }], "https://app.example.com/");
    expect(validate(flow)).toBe(flow);
    expect(flow["params"]).toEqual([{ name: "note", example: null, source: "typed" }]);
    expect(flow["writes"]).toBe(true);
  });
});

describe("heal stays on the locator that worked", () => {
  const flow = {
    name: "f",
    params: [],
    steps: [{ seq: 1, action: { ...save, candidates: [{ by: "css", value: "main > button.save" }, { by: "text", value: "Save" }, { by: "aria-label", value: "Save" }] } }],
  };
  const healed = (extra: Record<string, unknown>) => ({ kind: "healed" as const, at: "t", flow: "f", site: "example.com", seq: 1, type: "click", intent: "x", url: "", candidate: null, fingerprint: null, tried: [], tier: null, ...extra });

  test("the winner is found by value, not by its old index", () => {
    const changes = proposals(flow, [healed({ tier: "candidate", candidate: 1, matched: { by: "aria-label", value: "Save" } })]);
    expect(changes[0]!.candidates[0]).toEqual({ by: "aria-label", value: "Save" });
  });

  test("stale episodes propose nothing", () => {
    expect(proposals(flow, [healed({ tier: "candidate", candidate: 1, matched: { by: "text", value: "Gone" } })])).toEqual([]);
    expect(proposals(flow, [healed({ tier: "fingerprint", fingerprint: { role: "button", name: "Old name" } })])).toEqual([]);
    expect(proposals(flow, [healed({ tier: "candidate", candidate: 1 })])).toEqual([]);
  });

  test("malformed patches are refused up front with a usage error", () => {
    for (const patch of [
      {},
      { steps: [] },
      { steps: [{ seq: "1", selector: "#a" }] },
      { steps: [{ seq: 1, selector: 5 }] },
      { steps: [{ seq: 1, candidates: [{ by: "css" }] }] },
      { steps: [{ seq: 1, candidates: [{ by: "magic", value: "x" }] }] },
      { steps: [{ seq: 1, fingerprint: { role: "button" } }] },
      { steps: [{ seq: 1 }] },
      { steps: [{ seq: 1, selector: "#a" }, { seq: 1, selector: "#b" }] },
      { steps: [{ seq: 1, selector: "#a", extra: true }] },
      { steps: [{ seq: 1, selector: "#a" }], more: 1 },
    ]) {
      expect(() => parsePatch(patch)).toThrow(Usage);
    }
    expect(applyPatch(flow, parsePatch({ steps: [{ seq: 1, selector: "[aria-label='Save changes']" }] })).rejected).toEqual([]);
  });
});

describe("fixture export is exclusive", () => {
  const files = { "a.txt": "one", "b.txt": "two" };

  test("files are new, 0600, and never overwrite", () => {
    const dir = path.join(tempDir(), "out");
    writeFixture(dir, files);
    expect(fs.statSync(path.join(dir, "a.txt")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(() => writeFixture(dir, files)).toThrow("already there");
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("one");
  });

  test("a linked folder or a planted link is refused and nothing is written through it", () => {
    const root = tempDir();
    const real = path.join(root, "real");
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(root, "link"));
    expect(() => writeFixture(path.join(root, "link"), files)).toThrow("link");
    expect(fs.readdirSync(real)).toEqual([]);
    const planted = path.join(root, "planted");
    fs.mkdirSync(planted, { mode: 0o700 });
    fs.symlinkSync(path.join(root, "victim.txt"), path.join(planted, "b.txt"));
    expect(() => writeFixture(planted, files)).toThrow("already there");
    expect(fs.existsSync(path.join(root, "victim.txt"))).toBe(false);
    expect(fs.existsSync(path.join(planted, "a.txt"))).toBe(false);
  });

  test("a file name with a path is refused", () => {
    expect(() => writeFixture(path.join(tempDir(), "x"), { "../escape.txt": "no" })).toThrow("plain file name");
  });
});
