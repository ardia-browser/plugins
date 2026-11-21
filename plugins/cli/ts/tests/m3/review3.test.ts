import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Browser, MAX_LATE_ATTACHES } from "../../src/browse/cdp/browser.ts";
import { checkEnvelope, ForbiddenCommand } from "../../src/browse/cdp/guard.ts";
import { CdpLink, CommandTimeout, ConnectionLost as LinkLost, linkLog, safeEndpoint } from "../../src/browse/cdp/link.ts";
import { Cancelled } from "../../src/browse/cdp/cancel.ts";
import { CdpTimeout, ConnectionLost } from "../../src/browse/daemon-errors.ts";
import { type Conn, echo, RawPeer, until } from "./rawpeer.ts";

setDefaultTimeout(30_000);
const SECRET = "S3CRET-6f1c";
const peers: RawPeer[] = [];
const cleanup: (() => Promise<void>)[] = [];

async function peer(onMessage: (message: Record<string, any>, conn: Conn) => void = echo): Promise<RawPeer> {
  const started = await new RawPeer(onMessage).start();
  peers.push(started);
  return started;
}

async function link(on: RawPeer): Promise<CdpLink> {
  const opened = new CdpLink(on.url);
  cleanup.push(() => opened.close());
  await opened.open(5);
  return opened;
}

afterEach(async () => {
  for (const step of cleanup.splice(0)) await step();
  for (const one of peers.splice(0)) await one.stop();
  linkLog.problem = () => {};
});

const caught = (work: Promise<unknown>) => work.then(() => null, (error: unknown) => error);
const silentAttaches = (message: Record<string, any>, conn: Conn) => (String(message["method"]).startsWith("Target.attachTo") ? undefined : echo(message, conn));

describe("review round 3", () => {
  test("the endpoint description comes only from a structured parse, with no userinfo, query or fragment", async () => {
    expect(safeEndpoint(`ws://user:${SECRET}@127.0.0.1:9/devtools/x?token=${SECRET}#${SECRET}`)).toBe("ws://127.0.0.1:9");
    expect(safeEndpoint("ws://127.0.0.1/devtools/browser/x")).toBe("ws://127.0.0.1");
    expect(safeEndpoint("wss://[::1]:9222/x")).toBe("wss://[::1]:9222");
    const malformed = [
      `ws:///user:${SECRET}@127.0.0.1:9/x`,
      `ws:////user:${SECRET}@127.0.0.1/x`,
      `ws:/\\user:${SECRET}@127.0.0.1/x`,
      `ws://user:${SECRET}@bad host/x`,
      `ws://user:${SECRET}@%zz/x`,
      `ws://[::1]:${SECRET}@/x`,
      `${SECRET}`,
      `ws:${SECRET}@127.0.0.1`,
      `ws://127.0.0.1/${SECRET}?token=${SECRET}`,
      `ws://user%40x:${SECRET}@127.0.0.1:99999/x`,
    ];
    for (const url of malformed) {
      const described = safeEndpoint(url);
      expect([url, described.includes(SECRET)]).toEqual([url, false]);
      const failed = await caught(new CdpLink(url).open(0.3));
      expect([url, `${String(failed)} ${(failed as { endpoint?: string }).endpoint}`.includes(SECRET)]).toEqual([url, false]);
      const browser = new Browser({ ws: url }, () => {}, (error) => `${String(error)} ${(error as { endpoint?: string }).endpoint}`);
      expect([url, String(await caught(browser.open())).includes(SECRET)]).toEqual([url, false]);
      await browser.close();
    }
    expect(safeEndpoint(`ws://bad host/x?token=${SECRET}`)).toBe("<invalid endpoint>");
    expect(safeEndpoint(SECRET)).toBe("<invalid endpoint>");
  });

  test("open() during close() is refused and never makes a second link", async () => {
    const on = await peer();
    const browser = new Browser({ ws: on.url }, () => {});
    await browser.open();
    const closing = browser.close();
    const reopened = await caught(browser.open());
    await closing;
    expect(reopened).toBeInstanceOf(ConnectionLost);
    expect(on.accepted.length).toBe(1);
    expect(browser.alive).toBe(false);
    expect(await caught(browser.open())).toBeInstanceOf(ConnectionLost);
    expect(on.accepted.length).toBe(1);
    await until(() => on.openSockets() === 0);
  });

  test("a reservation is used by one send only, and its slot lasts until Chromium answers or the link closes", async () => {
    const on = await peer(silentAttaches);
    const opened = await link(on);
    const ident = opened.reserveAttach(MAX_LATE_ATTACHES) as number;
    expect(await caught(opened.execute({ method: "Target.attachToTarget", params: { targetId: "A" } }, 0.05, ident))).toBeInstanceOf(CommandTimeout);
    expect(opened.attaching.has(ident)).toBe(true);
    expect(await caught(opened.execute({ method: "Target.attachToTarget", params: { targetId: "B" } }, 5, ident))).toBeInstanceOf(ForbiddenCommand);
    expect(on.methods("Target.attachToTarget").map((message) => message["params"].targetId)).toEqual(["A"]);
    on.conns[0]?.send({ id: ident, result: { sessionId: "S" } });
    await until(() => !opened.attaching.has(ident));
    const cancelled = opened.reserveAttach(MAX_LATE_ATTACHES) as number;
    const controller = new AbortController();
    const waiting = caught(opened.execute({ method: "Target.attachToTarget", params: { targetId: "C" } }, 5, cancelled, controller.signal));
    await until(() => on.methods("Target.attachToTarget").length === 2);
    controller.abort();
    expect(await waiting).toBeInstanceOf(Cancelled);
    expect(opened.attaching.has(cancelled)).toBe(true);
    on.conns[0]?.send({ id: cancelled, error: { code: -32000, message: "gone" } });
    await until(() => !opened.attaching.has(cancelled));
    const held = opened.reserveAttach(MAX_LATE_ATTACHES) as number;
    await caught(opened.execute({ method: "Target.attachToTarget", params: { targetId: "D" } }, 0.05, held));
    expect(opened.attaching.has(held)).toBe(true);
    await opened.close();
    expect(opened.attaching.size).toBe(0);
  });

  test("a zero timeout or a cancelled signal fails a raw attach before anything is sent", async () => {
    const on = await peer(silentAttaches);
    const browser = new Browser({ ws: on.url }, () => {});
    cleanup.push(() => browser.close());
    await browser.open();
    expect(await caught(browser.send("Target.attachToTarget", { targetId: "T" }, { timeout: 0 }))).toBeInstanceOf(CdpTimeout);
    expect(await caught(browser.send("Target.attachToBrowserTarget", null, { timeout: 0, mutation: true }))).toBeInstanceOf(CdpTimeout);
    const aborted = new AbortController();
    aborted.abort();
    expect(await caught(browser.send("Target.attachToTarget", { targetId: "T" }, { signal: aborted.signal }))).toBeInstanceOf(Cancelled);
    await Bun.sleep(100);
    expect(on.messages.filter((message) => String(message["method"]).startsWith("Target.attachTo"))).toEqual([]);
    expect(browser.link?.attaching.size).toBe(0);
  });

  test("a log hook that throws can't stop the link from failing every pending command", async () => {
    const on = await peer(() => {});
    const opened = await link(on);
    linkLog.problem = () => {
      throw new Error("the log is broken");
    };
    const first = caught(opened.execute({ method: "Test.silent" }, 5));
    const second = caught(opened.execute({ method: "Test.silent" }, 5));
    (opened as unknown as { socket: WebSocket }).socket.send = () => {
      throw new Error("injected");
    };
    expect(await caught(opened.execute({ method: "Test.third" }, 5))).toBeInstanceOf(LinkLost);
    expect(await first).toBeInstanceOf(LinkLost);
    expect(await second).toBeInstanceOf(LinkLost);
    expect([opened.lost, opened.pending.size]).toEqual([true, 0]);
  });

  test("the envelope must be one JSON object, never an array", async () => {
    expect(() => checkEnvelope('[{"method":"Page.enable","id":2}]')).toThrow(ForbiddenCommand);
    expect(() => checkEnvelope("[]")).toThrow(ForbiddenCommand);
    expect(() => checkEnvelope('"x"')).toThrow(ForbiddenCommand);
    expect(checkEnvelope('{"method":"Page.enable","id":2}')).toEqual({ method: "Page.enable", id: 2 });
    const on = await peer();
    const opened = await link(on);
    const listed = { method: "Test.listed", toJSON: () => [{ method: "Page.enable", id: 2 }] };
    await opened.execute(listed);
    expect(on.messages.map((message) => [Array.isArray(message), message["method"]])).toEqual([[false, "Test.listed"]]);
  });
});
