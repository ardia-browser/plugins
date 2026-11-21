import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Browser, claimedAttach, MAX_LATE_ATTACHES } from "../../src/browse/cdp/browser.ts";
import { Cancelled } from "../../src/browse/cdp/cancel.ts";
import { ForbiddenCommand } from "../../src/browse/cdp/guard.ts";
import { CdpLink, ConnectionLost as LinkLost, OpenFailed } from "../../src/browse/cdp/link.ts";
import { CdpTimeout, ConnectionLost } from "../../src/browse/daemon-errors.ts";
import { type Conn, echo, RawPeer, until } from "./rawpeer.ts";

setDefaultTimeout(30_000);
const peers: RawPeer[] = [];
const cleanup: (() => Promise<void>)[] = [];

async function peer(onMessage: (message: Record<string, any>, conn: Conn) => void = echo, handshake?: (head: string, socket: any) => boolean): Promise<RawPeer> {
  const started = await new RawPeer(onMessage, handshake).start();
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
});

const caught = (work: Promise<unknown>) => work.then(() => null, (error: unknown) => error);
const silentAttaches = (message: Record<string, any>, conn: Conn) => (String(message["method"]).startsWith("Target.attachTo") ? undefined : echo(message, conn));

describe("review round 4", () => {
  test("URL refusals name the problem without echoing the input", async () => {
    const cases: [string, string][] = [
      ["ws://127.0.0.1:MARKport/x", "MARKport"],
      ["ws://127.0.0.1:９９/x", "９９"],
      ["ws://[MARKhost]/x", "MARKhost"],
      ["ws://[vMARKfuture]/x", "MARKfuture"],
      ["MARKscheme://127.0.0.1/x", "MARKscheme"],
      ["wsMARKx://127.0.0.1/x", "MARKx"],
    ];
    for (const [url, marker] of cases) {
      const failed = (await caught(new CdpLink(url).open(1))) as OpenFailed;
      expect(failed).toBeInstanceOf(OpenFailed);
      const shown = `${failed.message}\n${failed.stack}\n${failed.endpoint}`;
      expect([url, shown.includes(marker), shown.toLowerCase().includes(marker.toLowerCase())]).toEqual([url, false, false]);
    }
    expect(((await caught(new CdpLink("http://127.0.0.1:9/x").open(1))) as Error).message).toBe("the endpoint isn't a ws:// or wss:// URL (http://127.0.0.1:9)");
    expect(((await caught(new CdpLink("ws://127.0.0.1:abc/x").open(1))) as Error).message).toBe("the endpoint's port isn't a number");
  });

  test("a retry started from the unreachable callback can't leak a link past close()", async () => {
    let calls = 0;
    const on = await peer(echo, (_head, socket) => {
      calls += 1;
      if (calls > 1) return true;
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      return false;
    });
    on.holding = true;
    let retry: Promise<unknown> | null = null;
    const browser = new Browser({ ws: on.url }, () => {}, () => {
      retry = caught(browser.open());
      return "refused";
    });
    const first = await caught(browser.open());
    expect((first as Error).message).toBe("refused");
    await until(() => retry !== null && on.held.length === 1);
    const joined = caught(browser.open());
    await Bun.sleep(50);
    expect(on.accepted.length).toBe(2);
    await browser.close();
    on.release();
    expect(await retry).toBeInstanceOf(ConnectionLost);
    expect(await joined).toBeInstanceOf(ConnectionLost);
    await until(() => on.openSockets() === 0);
    expect(on.accepted.length).toBe(2);
    expect(browser.alive).toBe(false);
  });

  test("toJSON re-entering execute can't send one reservation twice, and each reply reaches its caller", async () => {
    const on = await peer(silentAttaches);
    const opened = await link(on);
    const ident = opened.reserveAttach(MAX_LATE_ATTACHES) as number;
    let inner: Promise<unknown> | null = null;
    const params = {
      toJSON() {
        inner ??= opened.execute({ method: "Target.attachToTarget", params: { targetId: "inner" } }, 5, ident);
        return { targetId: "outer" };
      },
    };
    const outer = await caught(opened.execute({ method: "Target.attachToTarget", params }, 5, ident));
    expect(outer).toBeInstanceOf(ForbiddenCommand);
    await until(() => on.messages.some((message) => message["id"] === ident));
    await Bun.sleep(100);
    expect(on.messages.filter((message) => message["id"] === ident).map((message) => message["params"])).toEqual([{ targetId: "inner" }]);
    on.conns[0]?.send({ id: ident, result: { sessionId: "S" } });
    expect(await (inner as Promise<unknown> | null)).toEqual({ id: ident, result: { sessionId: "S" } });
    let innerReply: unknown = null;
    const echoes = await Promise.all([
      opened.execute({
        method: "Test.outer",
        params: {
          toJSON: () => {
            void opened.execute({ method: "Test.inner" }).then((reply) => (innerReply = reply));
            return { n: 1 };
          },
        },
      }),
    ]);
    await until(() => innerReply !== null);
    expect((echoes[0] as any).result.echo).toEqual({ n: 1 });
    expect(on.methods("Test.inner").length).toBe(1);
    expect((innerReply as any).id).not.toBe((echoes[0] as any).id);
  });

  test("refusals before the wire release their reservation, and a lost link reserves nothing", async () => {
    const on = await peer(silentAttaches);
    const opened = await link(on);
    const ident = opened.reserveAttach(MAX_LATE_ATTACHES) as number;
    const throwing = {
      get method(): string {
        throw new Error("a broken getter");
      },
    };
    expect(await caught(opened.execute(throwing as never, 5, ident))).toBeInstanceOf(Error);
    expect(opened.attaching.size).toBe(0);
    const second = opened.reserveAttach(MAX_LATE_ATTACHES) as number;
    expect(await caught(opened.execute({ method: 5 as never }, 5, second))).toBeInstanceOf(ForbiddenCommand);
    const third = opened.reserveAttach(MAX_LATE_ATTACHES) as number;
    expect(await caught(opened.execute({ method: "Test.x", params: { big: 1n } as never }, 5, third))).toBeInstanceOf(TypeError);
    expect(opened.attaching.size).toBe(0);
    const browser = new Browser({ ws: on.url }, () => {});
    await browser.open();
    await browser.close();
    for (let call = 0; call < MAX_LATE_ATTACHES + 1; call++) {
      expect(await caught(claimedAttach(browser, "Target.attachToTarget", { targetId: `T${call}` }, { wait: 0.01 }))).toBeInstanceOf(ConnectionLost);
    }
    expect(browser.link?.attaching.size).toBe(0);
    expect(browser.link?.reserveAttach(MAX_LATE_ATTACHES)).toBeNull();
    expect(on.methods("Target.attachToTarget")).toEqual([]);
  });

  test("a zero wait refuses before sending, as a plain timeout", async () => {
    const on = await peer(silentAttaches);
    const browser = new Browser({ ws: on.url }, () => {});
    cleanup.push(() => browser.close());
    await browser.open();
    expect(await caught(claimedAttach(browser, "Target.attachToTarget", { targetId: "T" }, { wait: 0, unknown: true }))).toBeInstanceOf(CdpTimeout);
    expect(await caught(browser.send("Target.attachToTarget", { targetId: "T" }, { timeout: 0, mutation: true }))).toBeInstanceOf(CdpTimeout);
    expect(await caught(browser.send("Input.dispatchKeyEvent", { type: "keyDown" }, { timeout: 0 }))).toBeInstanceOf(CdpTimeout);
    expect(await caught(browser.send("Test.x", {}, { timeout: 0, mutation: true }))).toBeInstanceOf(CdpTimeout);
    await Bun.sleep(50);
    expect(on.messages).toEqual([]);
    expect(browser.link?.attaching.size).toBe(0);
  });

  test("an abort during serialization stops the send", async () => {
    const on = await peer(silentAttaches);
    const opened = await link(on);
    const controller = new AbortController();
    const ident = opened.reserveAttach(MAX_LATE_ATTACHES) as number;
    const params = {
      toJSON() {
        controller.abort();
        return { targetId: "T" };
      },
    };
    expect(await caught(opened.execute({ method: "Target.attachToTarget", params }, 5, ident, controller.signal))).toBeInstanceOf(Cancelled);
    expect(opened.attaching.size).toBe(0);
    expect(on.messages).toEqual([]);
    expect(await caught(opened.executeNoWait({ method: "Test.x", params: { toJSON: () => { throw new Error("no"); } } }))).toBeInstanceOf(Error);
    expect(opened.lost).toBe(false);
    expect(await caught(new CdpLink("ws://127.0.0.1:9/x").execute({ method: "Test.x" }))).toBeInstanceOf(LinkLost);
  });
});
