import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Cancelled, shield, sleep, withSignal } from "../../src/browse/cdp/cancel.ts";
import { checkMessage, FORBIDDEN_METHODS, ForbiddenCommand } from "../../src/browse/cdp/guard.ts";
import { CdpLink, CommandFailed, CommandTimeout, ConnectionLost, OpenFailed } from "../../src/browse/cdp/link.ts";
import { pyText, pyTruthy } from "../../src/browse/cdp/pyvalue.ts";
import { BINARY, type Conn, echo, frame, PING, RawPeer, TEXT, until } from "./rawpeer.ts";

setDefaultTimeout(30_000);
const peers: RawPeer[] = [];
const links: CdpLink[] = [];

async function peer(onMessage: (message: Record<string, any>, conn: Conn) => void = echo): Promise<RawPeer> {
  const started = await new RawPeer(onMessage).start();
  peers.push(started);
  return started;
}

async function linked(on: RawPeer, maxSize: number | null = null): Promise<CdpLink> {
  const link = new CdpLink(on.url, maxSize);
  links.push(link);
  await link.open(5);
  return link;
}

afterEach(async () => {
  for (const link of links.splice(0)) await link.close();
  for (const one of peers.splice(0)) await one.stop();
});

function serve(message: Record<string, any>, conn: Conn): void {
  const id = message["id"];
  switch (message["method"]) {
    case "Test.fragmented": {
      const reply = JSON.stringify({ id, result: { value: "x".repeat(5000) } });
      conn.write(frame(TEXT, reply.slice(0, 10), false), frame(PING, "mid"), frame(0, reply.slice(10, 3000), false), frame(0, reply.slice(3000)));
      return;
    }
    case "Test.large":
      return conn.send({ id, result: { value: "y".repeat(9 << 20) } });
    case "Test.ping":
      conn.write(frame(PING, "hi"));
      return void setTimeout(() => conn.send({ id, result: { ponged: conn.frames.some((one) => one.opcode === 0xa && one.payload.toString() === "hi") } }), 100);
    case "Test.error":
      return conn.send({ id, error: { code: -32000, message: "nope" } });
    case "Test.event":
      return conn.write(frame(TEXT, JSON.stringify({ method: "Page.loadEventFired", params: { n: 1 }, sessionId: "S" })), frame(TEXT, JSON.stringify({ id, result: {} })));
    case "Test.silent":
      return;
    case "Test.hangup":
      return conn.close(1001, "going away");
    default:
      echo(message, conn);
  }
}

describe("the link", () => {
  test("the handshake carries no Origin and no compression", async () => {
    const on = await peer();
    const link = await linked(on);
    const head = on.conns[0]?.head ?? "";
    expect(head).toStartWith("GET /devtools/browser/x?token=t HTTP/1.1\r\n");
    expect(head).not.toMatch(/^origin:/im);
    expect(head).not.toMatch(/^sec-websocket-extensions:/im);
    expect(link.extensions).toBe("");
  });

  test("commands, events, frames and errors", async () => {
    const on = await peer(serve);
    const link = await linked(on, 64 << 20);
    const events: unknown[] = [];
    link.on("Page.loadEventFired", (method, params, session) => events.push([method, params, session]));
    const [echoed, fragmented, large, ponged] = await Promise.all([
      link.execute({ method: "Test.echo", params: { a: "é".repeat(70000) } }),
      link.execute({ method: "Test.fragmented" }),
      link.execute({ method: "Test.large" }),
      link.execute({ method: "Test.ping" }),
      link.execute({ method: "Test.event" }),
    ]);
    const failed = await link.execute({ method: "Test.error" }).catch((error: unknown) => error);
    const silent = await link.execute({ method: "Test.silent" }, 0.2).catch((error: unknown) => error);
    const after = await link.execute({ method: "Test.echo", params: { b: 1 } });
    expect((echoed["result"] as any).echo).toEqual({ a: "é".repeat(70000) });
    expect((fragmented["result"] as any).value.length).toBe(5000);
    expect((large["result"] as any).value.length).toBe(9 << 20);
    expect((ponged["result"] as any).ponged).toBe(true);
    expect(events).toEqual([["Page.loadEventFired", { n: 1 }, "S"]]);
    expect(failed).toBeInstanceOf(CommandFailed);
    expect([(failed as CommandFailed).method, (failed as CommandFailed).code, (failed as CommandFailed).detail]).toEqual(["Test.error", -32000, "nope"]);
    expect(silent).toBeInstanceOf(CommandTimeout);
    expect((silent as Error).message).toBe("Test.silent got no answer in 0.2s");
    expect((after["result"] as any).echo).toEqual({ b: 1 });
    await link.close();
    expect(link.lost).toBe(true);
    expect(link.pending.size).toBe(0);
  });

  test("a peer closing fails pending commands and the link stays lost", async () => {
    const on = await peer(serve);
    const link = await linked(on);
    const waiting = link.execute({ method: "Test.silent" }, 10).catch((error: unknown) => error);
    await Bun.sleep(50);
    expect(await link.execute({ method: "Test.hangup" }, 10).catch((error: unknown) => error)).toBeInstanceOf(ConnectionLost);
    expect(await waiting).toBeInstanceOf(ConnectionLost);
    await link.whenLost();
    expect(await link.execute({ method: "Test.echo" }).catch((error: unknown) => error)).toBeInstanceOf(ConnectionLost);
    expect(await link.open(1).catch((error: unknown) => error)).toBeInstanceOf(ConnectionLost);
    expect(link.pending.size).toBe(0);
  });

  test.each([
    ["1000", (conn: Conn) => conn.close(1000)],
    ["1001", (conn: Conn) => conn.close(1001, "going away")],
    ["1011", (conn: Conn) => conn.close(1011, "internal")],
    ["4000", (conn: Conn) => conn.close(4000)],
    ["reset", (conn: Conn) => conn.socket.destroy()],
    ["text that isn't UTF-8", (conn: Conn) => conn.write(frame(TEXT, Buffer.from([0x7b, 0xff, 0x7d])))],
  ])("closing with %s ends in ConnectionLost", async (_label, end) => {
    const on = await peer((message, conn) => (message["method"] === "Test.end" ? end(conn) : undefined));
    const link = await linked(on);
    const waiting = link.execute({ method: "Test.silent" }, 10).catch((error: unknown) => error);
    void link.execute({ method: "Test.end" }, 10).catch(() => {});
    expect(await waiting).toBeInstanceOf(ConnectionLost);
    expect(link.lost).toBe(true);
  });

  test("send after close is refused with ConnectionLost and nothing reaches the wire", async () => {
    const on = await peer();
    const link = await linked(on);
    on.conns[0]?.socket.destroy();
    await link.whenLost();
    expect(await link.execute({ method: "Test.echo" }).catch((error: unknown) => error)).toBeInstanceOf(ConnectionLost);
    expect(await link.executeNoWait({ method: "Test.echo" }).catch((error: unknown) => error)).toBeInstanceOf(ConnectionLost);
    const other = await linked(on);
    const closing = other.close();
    expect(await other.execute({ method: "Test.late" }).catch((error: unknown) => error)).toBeInstanceOf(ConnectionLost);
    await closing;
    expect(on.methods("Test.echo")).toEqual([]);
    expect(on.methods("Test.late")).toEqual([]);
  });

  test("a message over the cap ends the link; one at the cap arrives whole", async () => {
    const limit = 1 << 20;
    const body = (size: number) => {
      const head = '{"id":1,"result":{"v":"';
      return head + "é".repeat(Math.floor((size - head.length - 3) / 2)) + "x".repeat((size - head.length - 3) % 2) + '"}}';
    };
    for (const [size, kind] of [[limit, TEXT], [limit + 1, TEXT], [limit, BINARY], [limit + 1, BINARY]] as const) {
      const on = await peer((message, conn) => conn.write(frame(kind, Buffer.from(body(size)))));
      const link = await linked(on, limit);
      const reply = await link.execute({ method: "Test.big" }, 10).catch((error: unknown) => error);
      if (size === limit) expect(Buffer.byteLength(((reply as any).result.v as string), "utf8") + 26).toBe(limit);
      else expect(reply).toBeInstanceOf(ConnectionLost);
      expect(link.lost).toBe(size > limit);
    }
  });

  test("forbidden commands never reach the wire", async () => {
    const on = await peer();
    const link = await linked(on);
    for (const method of [...FORBIDDEN_METHODS].sort()) {
      expect(await link.execute({ method }).catch((error: unknown) => error)).toBeInstanceOf(ForbiddenCommand);
      expect(await link.executeNoWait({ method }).catch((error: unknown) => error)).toBeInstanceOf(ForbiddenCommand);
      expect(() => checkMessage(JSON.stringify({ id: 1, method }))).toThrow(ForbiddenCommand);
      expect(() => checkMessage(Buffer.from(JSON.stringify([{ id: 1, method: "Page.enable" }, { id: 2, method }])))).toThrow(ForbiddenCommand);
    }
    expect(() => checkMessage("not json")).toThrow("ardia only sends JSON commands");
    expect(() => checkMessage(JSON.stringify({ id: 1, method: "Page.enable" }))).not.toThrow();
    await link.execute({ method: "Test.echo" });
    expect(on.messages.map((message) => message["method"])).toEqual(["Test.echo"]);
  });

  test("binary frames are decoded as fatal UTF-8; bad ones are skipped like Python's json.loads", async () => {
    const on = await peer((message, conn) => {
      if (message["method"] === "Test.bad") conn.write(frame(BINARY, Buffer.from([0x7b, 0xff, 0x7d])), frame(TEXT, JSON.stringify({ id: message["id"], result: { after: true } })));
      else conn.write(frame(BINARY, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({ id: message["id"], result: { v: "é" } }))])));
    });
    const link = await linked(on);
    expect(await link.execute({ method: "Test.bom" })).toEqual({ id: 1, result: { v: "é" } });
    expect(await link.execute({ method: "Test.bad" })).toEqual({ id: 2, result: { after: true } });
    expect(link.lost).toBe(false);
  });

  test("ids, junk and events are routed as cdp.py routes them", async () => {
    const on = await peer((message, conn) => {
      conn.text("not json");
      conn.send([1, 2]);
      conn.send(null);
      conn.send({ id: "x", method: "Odd.event", params: [] });
      conn.send({ method: "Page.frameNavigated", params: 0 });
      conn.send({ method: "Page.frameNavigated", params: { a: 1 }, sessionId: null });
      conn.send({ id: true, result: { first: true } });
    });
    const link = await linked(on);
    const seen: unknown[] = [];
    link.on("Page.frameNavigated", () => {
      throw new Error("a broken handler");
    });
    link.on("Page.frameNavigated", (method, params, session) => seen.push(["handler", params, session]));
    link.listeners.push((method, params, session) => seen.push([method, params, session]));
    expect(await link.execute({ method: "Test.go" })).toEqual({ id: true, result: { first: true } });
    expect(seen).toEqual([
      ["Odd.event", {}, null],
      ["handler", {}, null],
      ["Page.frameNavigated", {}, null],
      ["handler", { a: 1 }, null],
      ["Page.frameNavigated", { a: 1 }, null],
    ]);
  });

  test("events that arrive with a reply run before the command that waited resumes", async () => {
    const on = await peer((message, conn) =>
      conn.write(frame(TEXT, JSON.stringify({ id: message["id"], result: {} })), frame(TEXT, JSON.stringify({ method: "Page.frameNavigated", params: { n: 1 } }))),
    );
    const link = await linked(on);
    const seen: string[] = [];
    link.on("Page.frameNavigated", () => seen.push("event"));
    await link.execute({ method: "Test.go" });
    seen.push("resumed");
    expect(seen).toEqual(["event", "resumed"]);
  });

  test("timeouts: late replies are ignored, a zero timeout never sends, a long one doesn't fire early", async () => {
    const on = await peer((message, conn) => setTimeout(() => echo(message, conn), message["params"]?.delay ?? 0));
    const link = await linked(on);
    expect(await link.execute({ method: "Test.slow", params: { delay: 300 } }, 0.05).catch((error: unknown) => error)).toBeInstanceOf(CommandTimeout);
    expect(await link.execute({ method: "Test.zero" }, 0).catch((error: unknown) => (error as Error).message)).toBe("Test.zero got no answer in 0s");
    expect(await link.execute({ method: "Test.huge" }, 10 ** 9)).toMatchObject({ result: { echo: null } });
    await Bun.sleep(400);
    expect(on.methods("Test.zero")).toEqual([]);
    expect(link.pending.size).toBe(0);
    expect(link.lost).toBe(false);
  });

  test("cancellation stops at the next call and leaves nothing pending", async () => {
    const on = await peer((message, conn) => setTimeout(() => echo(message, conn), 200));
    const link = await linked(on);
    const controller = new AbortController();
    const waiting = link.execute({ method: "Test.wait" }, 10, undefined, controller.signal).catch((error: unknown) => error);
    await Bun.sleep(20);
    controller.abort();
    expect(await waiting).toBeInstanceOf(Cancelled);
    expect(link.pending.size).toBe(0);
    const ambient = withSignal(controller.signal, () => link.execute({ method: "Test.never" }).catch((error: unknown) => error));
    expect(await ambient).toBeInstanceOf(Cancelled);
    expect(await withSignal(controller.signal, () => shield(() => link.execute({ method: "Test.shielded" })))).toMatchObject({ result: { echo: null } });
    expect(await withSignal(controller.signal, () => sleep(5).catch((error: unknown) => error))).toBeInstanceOf(Cancelled);
    const sleeper = new AbortController();
    const sleeping = sleep(5, sleeper.signal).catch((error: unknown) => error);
    sleeper.abort();
    expect(await sleeping).toBeInstanceOf(Cancelled);
    await Bun.sleep(300);
    expect(on.methods("Test.never")).toEqual([]);
    expect(on.methods("Test.wait").length).toBe(1);
    expect(link.lost).toBe(false);
  });

  test("many pipelined commands all come back to their callers", async () => {
    const on = await peer();
    const link = await linked(on);
    const replies = await Promise.all(Array.from({ length: 20_000 }, (_, index) => link.execute({ method: "Test.echo", params: { index } })));
    expect(replies.every((reply, index) => (reply["result"] as any).echo.index === index)).toBe(true);
    expect(new Set(on.messages.map((message) => message["id"])).size).toBe(20_000);
    expect(link.pending.size).toBe(0);
  });

  test("open: refused, rejected, silent and malformed endpoints", async () => {
    const refused = await new CdpLink("ws://127.0.0.1:9/x").open(5).catch((error: unknown) => error);
    expect([(refused as OpenFailed).name, (refused as Error).message]).toEqual(["ConnectionError", "Failed to connect"]);
    const rejecting = await new RawPeer(undefined, (_head, socket) => (socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"), false)).start();
    peers.push(rejecting);
    const rejected = await new CdpLink(rejecting.url).open(5).catch((error: unknown) => error);
    expect((rejected as OpenFailed).name).toBe("HandshakeError");
    expect((rejected as Error).message).not.toContain("token=t");
    const silent = await new RawPeer(undefined, () => false).start();
    peers.push(silent);
    const started = performance.now();
    const timedOut = await new CdpLink(silent.url).open(0.3).catch((error: unknown) => error);
    expect([(timedOut as OpenFailed).name, (timedOut as Error).message]).toEqual(["TimeoutError", ""]);
    expect(performance.now() - started).toBeLessThan(3000);
    for (const [url, scheme] of [["http://127.0.0.1:9/x", "http"], ["ws:///x", "ws"], ["127.0.0.1:9", ""]]) {
      expect(await new CdpLink(url as string).open(1).catch((error: unknown) => (error as Error).message)).toBe(`not a ws:// URL: ${scheme}://`);
    }
    expect(await new CdpLink("WS://[::1/x").open(1).catch((error: unknown) => [(error as Error).name, (error as Error).message])).toEqual(["ValueError", "Invalid IPv6 URL"]);
  });
});

describe("Python values", () => {
  test("truthiness and str() of JSON values", () => {
    expect([null, false, 0, "", [], {}].map(pyTruthy)).toEqual([false, false, false, false, false, false]);
    expect([true, 1, "a", [0], { a: 0 }].map(pyTruthy)).toEqual([true, true, true, true, true]);
    expect([null, true, -32000, 1.5, 1e21, "x", [1, "a"], { k: null }].map(pyText)).toEqual(["None", "True", "-32000", "1.5", "1000000000000000000000", "x", "[1, 'a']", "{'k': None}"]);
  });
});
