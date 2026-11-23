import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Browser, claimedAttach, MAX_LATE_ATTACHES } from "../../src/browse/cdp/browser.ts";
import { ForbiddenCommand } from "../../src/browse/cdp/guard.ts";
import { CdpLink, ConnectionLost as LinkLost, linkLog, OpenFailed } from "../../src/browse/cdp/link.ts";
import { BrowseError, CdpTimeout, ConnectionLost, Unreachable } from "../../src/browse/daemon-errors.ts";
import { begin } from "../../src/browse/metrics.ts";
import { type Conn, echo, RawPeer, until } from "./rawpeer.ts";

setDefaultTimeout(30_000);
const TOKEN = "DUMMY-TOKEN-6f1c";
const peers: RawPeer[] = [];
const cleanup: (() => Promise<void>)[] = [];

async function peer(onMessage: (message: Record<string, any>, conn: Conn) => void = echo, handshake?: (head: string, socket: any) => boolean): Promise<RawPeer> {
  const started = await new RawPeer(onMessage, handshake).start();
  peers.push(started);
  return started;
}

afterEach(async () => {
  for (const step of cleanup.splice(0)) await step();
  for (const one of peers.splice(0)) await one.stop();
  linkLog.problem = () => {};
});

const caught = (work: Promise<unknown>) => work.then(() => null, (error: unknown) => error);

function everything(error: unknown): string {
  const shaped = error as { name?: unknown; message?: unknown; stack?: unknown; endpoint?: unknown; cause?: unknown };
  return [String(error), shaped.name, shaped.message, shaped.stack, shaped.endpoint, String(shaped.cause ?? ""), JSON.stringify(error)].join("\n");
}

describe("review fixes", () => {
  test("no error, log line or metric from a failed open carries the token", async () => {
    const logged: string[] = [];
    linkLog.problem = (what, error) => logged.push(`${what}\n${everything(error)}`);
    const rejecting = await peer(echo, (_head, socket) => (socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"), false));
    const silent = await peer(echo, () => false);
    const endpoints: [string, string, string][] = [
      [`ws://127.0.0.1:99999/x?token=${TOKEN}`, "ValueError", "Port out of range 0-65535"],
      [`ws://127.0.0.1:abc/x?token=${TOKEN}`, "ValueError", "the endpoint's port isn't a number"],
      [`ws://[zz]/x?token=${TOKEN}`, "ValueError", "the endpoint's bracketed host isn't an IPv4 or IPv6 address"],
      [`ws://bad host/x?token=${TOKEN}`, "ValueError", "the endpoint isn't a URL a WebSocket can open (<invalid endpoint>)"],
      [`ws://%zz/x?token=${TOKEN}`, "ValueError", "the endpoint isn't a URL a WebSocket can open (<invalid endpoint>)"],
      [`ws://user:${TOKEN}@127.0.0.1:9/x`, "ConnectionError", "Failed to connect"],
      [`ws://127.0.0.1:9/x?token=${TOKEN}`, "ConnectionError", "Failed to connect"],
      [`ws://127.0.0.1:${rejecting.port}/x?token=${TOKEN}`, "HandshakeError", "server rejected WebSocket connection (Expected 101 status code)"],
      [`ws://127.0.0.1:${silent.port}/x?token=${TOKEN}`, "TimeoutError", ""],
    ];
    const metrics = await begin({ argv: ["open"] }, async (active) => {
      for (const [url, name, message] of endpoints) {
        const failed = await caught(new CdpLink(url).open(0.5));
        expect([url, (failed as OpenFailed).name, (failed as OpenFailed).message]).toEqual([url, name, message]);
        expect(everything(failed)).not.toContain(TOKEN);
        expect((failed as OpenFailed).endpoint).not.toContain("?");
        const browser = new Browser({ ws: url }, () => {}, (error) => everything(error));
        const unreachable = await caught(browser.open());
        expect(unreachable).toBeInstanceOf(Unreachable);
        expect(everything(unreachable)).not.toContain(TOKEN);
        await browser.close();
      }
      return JSON.stringify([...active.values]);
    });
    expect(metrics).not.toContain(TOKEN);
    expect(logged.join("\n")).not.toContain(TOKEN);
  });

  test("close() while connecting kills the socket and the open rejects with ConnectionLost", async () => {
    const on = await peer();
    on.holding = true;
    const link = new CdpLink(on.url);
    const opening = caught(link.open(5));
    await until(() => on.held.length === 1);
    await link.close();
    on.release();
    expect(await opening).toBeInstanceOf(LinkLost);
    expect(link.lost).toBe(true);
    await until(() => on.openSockets() === 0);
    expect(await caught(link.execute({ method: "Test.echo" }))).toBeInstanceOf(LinkLost);
  });

  test("a second open while one is in flight joins it, and close() leaves no socket", async () => {
    const on = await peer();
    on.holding = true;
    const link = new CdpLink(on.url);
    const first = link.open(5);
    const second = link.open(5);
    await until(() => on.accepted.length >= 1);
    await Bun.sleep(100);
    on.release();
    await Promise.all([first, second]);
    expect(on.accepted.length).toBe(1);
    expect(await caught(link.open(5))).toBeInstanceOf(LinkLost);
    await link.close();
    await until(() => on.openSockets() === 0);
  });

  test("Browser: concurrent opens share one link; close during open leaves no socket", async () => {
    const on = await peer();
    on.holding = true;
    const browser = new Browser({ ws: on.url }, () => {});
    const opens = [browser.open(), browser.open()];
    await until(() => on.held.length === 1);
    await Bun.sleep(50);
    on.release();
    await Promise.all(opens);
    expect(on.accepted.length).toBe(1);
    await browser.close();
    await until(() => on.openSockets() === 0);

    const later = await peer();
    later.holding = true;
    const closing = new Browser({ ws: later.url }, () => {});
    const opening = caught(closing.open());
    await until(() => later.held.length === 1);
    await closing.close();
    later.release();
    expect(await opening).toBeInstanceOf(ConnectionLost);
    expect(closing.alive).toBe(false);
    await until(() => later.openSockets() === 0);
  });

  test("a send that throws leaves nothing pending and releases its attach slot", async () => {
    const on = await peer();
    const link = new CdpLink(on.url);
    cleanup.push(() => link.close());
    await link.open(5);
    const socket = (link as unknown as { socket: WebSocket }).socket;
    socket.send = () => {
      throw new Error("injected");
    };
    const ident = link.reserveAttach(MAX_LATE_ATTACHES) as number;
    expect(await caught(link.execute({ method: "Target.attachToTarget", params: { targetId: "T" } }, 5, ident))).toBeInstanceOf(LinkLost);
    expect(link.pending.size).toBe(0);
    expect(link.attaching.size).toBe(0);
    expect(link.lost).toBe(true);
  });

  test("Browser.send routes raw attaches through the attach bookkeeping", async () => {
    const on = await peer((message, conn) => (String(message["method"]).startsWith("Target.attachTo") ? undefined : echo(message, conn)));
    const browser = new Browser({ ws: on.url }, () => {});
    cleanup.push(() => browser.close());
    await browser.open();
    for (let index = 0; index < MAX_LATE_ATTACHES; index++) {
      expect(await caught(browser.send("Target.attachToTarget", { targetId: `T${index}` }, { timeout: 0.01 }))).toBeInstanceOf(CdpTimeout);
    }
    const refused = (await caught(browser.send("Target.attachToBrowserTarget", null, { session: "S" }))) as BrowseError;
    expect(refused.code).toBe("attaches_unanswered");
    expect(await caught(claimedAttach(browser, "Target.attachToTarget", { targetId: "x" }))).toHaveProperty("code", "attaches_unanswered");
    expect(on.methods("Target.attachToTarget").length).toBe(16);
    expect(on.methods("Target.attachToBrowserTarget")).toEqual([]);
    const first = on.methods("Target.attachToTarget")[0] as Record<string, any>;
    on.conns[0]?.send({ id: first["id"], result: { sessionId: "S-late" } });
    await until(() => on.methods("Target.detachFromTarget").length === 1);
    expect((on.methods("Target.detachFromTarget")[0] as Record<string, any>)["params"]).toEqual({ sessionId: "S-late" });
  });

  test("the link refuses an attach with no reservation, and guards the serialized envelope", async () => {
    const on = await peer();
    const link = new CdpLink(on.url);
    cleanup.push(() => link.close());
    await link.open(5);
    expect(await caught(link.execute({ method: "Target.attachToTarget", params: {} }))).toBeInstanceOf(ForbiddenCommand);
    expect(await caught(link.executeNoWait({ method: "Target.attachToBrowserTarget" }))).toBeInstanceOf(ForbiddenCommand);
    const sneaky = { method: "Test.sneaky", toJSON: () => ({ method: "Browser.close" }) };
    await link.execute(sneaky);
    await link.executeNoWait(sneaky);
    const renamed = { method: "Test.renamed", toJSON: () => ({ method: "Target.attachToTarget", id: 1 }) };
    await link.execute(renamed);
    expect(link.pending.size).toBe(0);
    await link.execute({ method: "Test.echo" });
    expect(on.messages.map((message) => message["method"])).toEqual(["Test.sneaky", "Test.sneaky", "Test.renamed", "Test.echo"]);
  });
});
