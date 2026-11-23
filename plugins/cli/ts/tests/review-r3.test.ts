import "./libc-loaded.ts";
import { afterAll, describe, expect, test } from "bun:test";
import { bindTools, type Sender } from "../src/browse/commands/tool.ts";
import { BrowseError } from "../src/browse/daemon-errors.ts";
import type { Action } from "../src/browse/flows/actions.ts";
import { type Driver, replay, replayStep } from "../src/browse/flows/replay.ts";
import { fetchUrl } from "../src/browse/read/fetch.ts";
import { listedMarkdown } from "../src/browse/read/fastpath.ts";
import { hopGuard } from "../src/browse/read/netguard.ts";

const servers: { stop: (force?: boolean) => void }[] = [];
afterAll(() => {
  for (const server of servers) server.stop(true);
});

async function codeOf(work: Promise<unknown>): Promise<string | null> {
  try {
    await work;
    return null;
  } catch (error) {
    return error instanceof BrowseError ? (error.code ?? "browse_error") : String(error);
  }
}

describe("site tool handles", () => {
  function sender(listed: Record<string, unknown>, log: string[]): Sender {
    return async (method, params) => {
      log.push(method);
      if (method === "Runtime.evaluate") return { result: { type: "object", objectId: "obj-1" } };
      if (method === "Runtime.callFunctionOn") return listed;
      if (method === "Runtime.releaseObject") {
        log.push(`released ${String(params["objectId"])}`);
        return {};
      }
      return {};
    };
  }

  test("a listing that throws in the page is a page_script_error, and the handle is released", async () => {
    const log: string[] = [];
    const listed = { exceptionDetails: { text: "Uncaught", exception: { description: "TypeError: boom\n    at x" } } };
    expect(await codeOf(bindTools(sender(listed, log)))).toBe("page_script_error");
    expect(log).toContain("released obj-1");
  });

  test("a listing that fails at the protocol level still releases the handle", async () => {
    const log: string[] = [];
    const failing: Sender = async (method, params) => {
      log.push(method);
      if (method === "Runtime.evaluate") return { result: { objectId: "obj-2" } };
      if (method === "Runtime.callFunctionOn") throw new BrowseError("gone", null, "tab_detached");
      if (method === "Runtime.releaseObject") log.push(`released ${String(params["objectId"])}`);
      return {};
    };
    expect(await codeOf(bindTools(failing))).toBe("tab_detached");
    expect(log).toContain("released obj-2");
  });

  test("a discovery that throws in the page is reported, not mistaken for no tools", async () => {
    const thrown: Sender = async (method) => (method === "Runtime.evaluate" ? { result: { objectId: "obj-3" }, exceptionDetails: { text: "ReferenceError: x" } } : {});
    expect(await codeOf(bindTools(thrown))).toBe("page_script_error");
  });

  test("a clean listing keeps the handle for the call", async () => {
    const log: string[] = [];
    const bound = await bindTools(sender({ result: { value: { tools: [{ name: "lookup", source: "document.modelContext", fingerprint: "f" }] } } }, log));
    expect(bound.objectId).toBe("obj-1");
    expect(bound.tools.map((tool) => tool.name)).toEqual(["lookup"]);
    expect(log).not.toContain("released obj-1");
  });
});

describe("an unconfirmed replay never presses Escape", () => {
  const click: Action = { type: "hover", intent: "hover", candidates: [{ by: "text", value: "Menu" }], fingerprint: null };
  const missing: Driver = {
    ran: [] as string[][],
    run: async function (this: { ran: string[][] }, argv: string[]) {
      this.ran.push(argv);
      throw new BrowseError("Nothing matches", null, "not_found");
    },
    snapshot: async () => "",
    url: () => "https://app.example.com/",
    count: async () => 1,
  } as Driver & { ran: string[][] };

  test("without confirmation the Escape tier is skipped; with it, Escape runs", async () => {
    const quiet = { ...missing, ran: [] as string[][] };
    await replayStep(quiet, { seq: 1, action: click }, {}, [], { escape: false });
    expect(quiet.ran.some((argv) => argv[0] === "press")).toBe(false);
    const confirmed = { ...missing, ran: [] as string[][] };
    await replayStep(confirmed, { seq: 1, action: click }, {}, [], { escape: true });
    expect(confirmed.ran.some((argv) => argv[0] === "press" && argv[1] === "Escape")).toBe(true);
    const viaReplay = { ...missing, ran: [] as string[][] };
    await replay(viaReplay, { name: "f", site: "s" }, [{ seq: 1, action: click }], {}, [], undefined, { escape: false });
    expect(viaReplay.ran.some((argv) => argv[0] === "press")).toBe(false);
  });
});

describe("one lookup per hop", () => {
  test("a guarded fetch resolves each hop's name exactly once, redirects included", async () => {
    let port = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => (new URL(request.url).pathname === "/start" ? new Response(null, { status: 302, headers: { location: `http://next.local-test:${port}/end` } }) : new Response("done")),
    });
    servers.push(server);
    port = server.port as number;
    const lookups: string[] = [];
    const guard = hopGuard(`http://docs.local-test:${port}/`, async (host) => {
      lookups.push(host);
      return ["127.0.0.1"];
    });
    const pinned = await guard.check(`http://docs.local-test:${port}/start`);
    expect(pinned).toEqual({ url: `http://docs.local-test:${port}/start`, address: "127.0.0.1" });
    lookups.length = 0;
    const code = await codeOf(fetchUrl(`http://docs.local-test:${port}/start`, 2, "text/plain", "skip", guard));
    expect(lookups).toEqual(["docs.local-test", "next.local-test"]);
    expect(code).toBe("unsafe_address");
  });
});

describe("listed Markdown is never JSON", () => {
  test("a JSON body under a generic type is refused, prose that starts with a bracket is kept", () => {
    expect(listedMarkdown("application/octet-stream", '{"secret": "value"}')).toBe(false);
    expect(listedMarkdown("text/plain", '  [1, 2, 3]  ')).toBe(false);
    expect(listedMarkdown("application/octet-stream", "[Guide](/guide.md) explains setup")).toBe(true);
    expect(listedMarkdown("application/octet-stream", "# Guide")).toBe(true);
  });
});

