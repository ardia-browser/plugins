import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Browser, claimedAttach, EVENTS, MAX_LATE_ATTACHES, MAX_MESSAGE } from "../../src/browse/cdp/browser.ts";
import { Cancelled } from "../../src/browse/cdp/cancel.ts";
import { ForbiddenCommand } from "../../src/browse/cdp/guard.ts";
import { BrowseError, CdpError, CdpTimeout, ConnectionLost, Gated, OutcomeUnknown, Unreachable } from "../../src/browse/daemon-errors.ts";
import { begin } from "../../src/browse/metrics.ts";
import { type Conn, echo, frame, RawPeer, TEXT, until } from "./rawpeer.ts";

setDefaultTimeout(60_000);
const peers: RawPeer[] = [];
const browsers: Browser[] = [];

async function opened(onMessage: (message: Record<string, any>, conn: Conn) => void = echo, onEvent: (...event: unknown[]) => void = () => {}): Promise<[Browser, RawPeer]> {
  const peer = await new RawPeer(onMessage).start();
  peers.push(peer);
  const browser = new Browser({ ws: peer.url }, onEvent, (error) => `can't connect (${(error as Error).message || (error as Error).name})`);
  browsers.push(browser);
  await browser.open();
  return [browser, peer];
}

afterEach(async () => {
  for (const browser of browsers.splice(0)) await browser.close();
  for (const peer of peers.splice(0)) await peer.stop();
});

const caught = (work: Promise<unknown>) => work.then(() => null, (error: unknown) => error);
const attachesSilently = (message: Record<string, any>, conn: Conn) => (String(message["method"]).startsWith("Target.attachTo") ? undefined : echo(message, conn));

describe("Browser", () => {
  test("send maps failures, timeouts and loss as connection.py does", async () => {
    const replies: Record<string, unknown> = {
      "Test.nope": { error: { code: -32000, message: "nope" } },
      "Page.navigate": { error: { code: -32000, message: "ardia: Page.navigate to that URL isn't allowed for the ardia command" } },
      "Test.odd": { error: "boom" },
      "Test.number": { error: { code: null, message: 5 } },
      "Test.null": { result: null },
      "Test.list": { result: [1] },
    };
    const [browser, peer] = await opened((message, conn) => {
      if (message["method"] in replies) conn.send({ id: message["id"], ...(replies[message["method"]] as object) });
      else if (!String(message["method"]).match(/^(Test\.silent|Input|Emulation|Page\.reload)/)) echo(message, conn);
    });
    const nope = (await caught(browser.send("Test.nope"))) as CdpError;
    expect([nope.constructor, nope.message, nope.cdpCode, nope.code]).toEqual([CdpError, "Test.nope: nope", -32000, null]);
    const gated = (await caught(browser.send("Page.navigate"))) as Gated;
    expect([gated.constructor, gated.reason, gated.code]).toEqual([Gated, "to that URL", "policy_refused"]);
    const odd = (await caught(browser.send("Test.odd"))) as CdpError;
    expect([odd.message, odd.cdpCode]).toEqual(["Test.odd: The browser rejected the command", 0]);
    expect(((await caught(browser.send("Test.number"))) as CdpError).message).toBe("Test.number: 5");
    expect(await browser.send("Test.null")).toEqual({});
    expect(await browser.send("Test.list")).toEqual([1] as never);
    const late = (await caught(browser.send("Test.silent", null, { timeout: 0.05 }))) as CdpTimeout;
    expect([late.constructor, late.message]).toEqual([CdpTimeout, "Test.silent got no answer in 0.05s"]);
    for (const [method, mutation] of [["Input.dispatchKeyEvent", false], ["Emulation.setFocusEmulationEnabled", false], ["Page.reload", false], ["Test.silent", true]] as const) {
      const unknown = (await caught(browser.send(method, {}, { timeout: 0.05, mutation }))) as OutcomeUnknown;
      expect([unknown.constructor, unknown.code, unknown.message]).toEqual([
        OutcomeUnknown,
        "outcome_unknown",
        `Ardia didn't answer ${method} in 0.05s after it was sent; the outcome of \`${method}\` is unknown, so it wasn't retried`,
      ]);
    }
    expect(await caught(browser.send("Browser.close"))).toBeInstanceOf(ForbiddenCommand);
    await browser.send("Test.echo", { a: 1 }, { session: "S1" });
    await browser.send("Test.echo", { a: 2 }, { session: "" });
    expect(peer.methods("Test.echo").map((message) => [message["sessionId"], message["params"]])).toEqual([["S1", { a: 1 }], [undefined, { a: 2 }]]);
    expect(peer.methods("Browser.close")).toEqual([]);
    const counted = await begin({ argv: ["get"] }, async (metrics) => {
      await browser.send("Test.echo");
      await caught(browser.send("Test.nope"));
      return metrics.values.get("cdp_calls");
    });
    expect(counted).toBe(1);
    peer.conns[0]?.socket.destroy();
    await until(() => !browser.alive);
    const lost = (await caught(browser.send("Test.echo"))) as ConnectionLost;
    expect([lost.constructor, lost.code, lost.exitCode]).toEqual([ConnectionLost, "connection_lost", 2]);
    expect(browser.closedByUs).toBe(false);
    await browser.close();
    expect(browser.closedByUs).toBe(true);
  });

  test("open: an unreachable endpoint is Unreachable; events reach on_event and a failing handler stops nothing", async () => {
    const nowhere = new Browser({ ws: "ws://127.0.0.1:9/devtools/browser/x" }, () => {}, (error) => `can't connect (${(error as Error).message})`);
    const refused = (await caught(nowhere.open())) as Unreachable;
    expect([refused.constructor, refused.message, refused.exitCode]).toEqual([Unreachable, "can't connect (Failed to connect)", 2]);
    expect(nowhere.alive).toBe(true);
    expect(await caught(nowhere.send("Test.echo"))).toBeInstanceOf(ConnectionLost);
    const seen: unknown[] = [];
    const [browser] = await opened(
      (message, conn) => {
        for (const method of ["Page.frameNavigated", "Not.listed", "Inspector.detached"]) conn.send({ method, params: { m: method }, sessionId: "S" });
        echo(message, conn);
      },
      (method, params, session) => {
        seen.push([method, params, session]);
        if (method === "Page.frameNavigated") throw new Error("a broken handler");
      },
    );
    await browser.send("Test.go");
    expect(seen).toEqual([["Page.frameNavigated", { m: "Page.frameNavigated" }, "S"], ["Inspector.detached", { m: "Inspector.detached" }, "S"]]);
    expect(EVENTS.length).toBe(37);
    expect(MAX_MESSAGE).toBe(256 * 1024 * 1024);
  });

  test("a 256 MiB message arrives whole and one byte more ends the connection", async () => {
    const body = (size: number) => {
      const head = '{"id":1,"result":{"v":"';
      return head + "x".repeat(size - head.length - 3) + '"}}';
    };
    for (const size of [MAX_MESSAGE, MAX_MESSAGE + 1]) {
      const [browser] = await opened((message, conn) => conn.write(frame(TEXT, body(size))));
      const reply = await caught(browser.send("Test.big", null, { timeout: 120 }).then((result) => (result["v"] as string).length));
      if (size === MAX_MESSAGE) expect(reply).toBeNull();
      else expect(reply).toBeInstanceOf(ConnectionLost);
      expect(browser.alive).toBe(size === MAX_MESSAGE);
      await browser.close();
      for (const peer of peers.splice(0)) await peer.stop();
    }
  });
});

describe("claimed attaches (plugins#11)", () => {
  test("a late answer to an abandoned attach is detached on the session it was sent on", async () => {
    for (const giveUp of ["cancel", "timeout"]) {
      for (const [method, session] of [["Target.attachToTarget", null], ["Target.attachToBrowserTarget", "S-browser"]] as const) {
        const [browser, peer] = await opened(attachesSilently);
        const controller = new AbortController();
        const attaching = caught(claimedAttach(browser, method, { targetId: "T" }, { wait: giveUp === "timeout" ? 0.05 : 30, session, signal: controller.signal }));
        await until(() => peer.methods(method).length === 1);
        if (giveUp === "cancel") controller.abort();
        expect(await attaching).toBeInstanceOf(giveUp === "cancel" ? Cancelled : CdpTimeout);
        expect(browser.link?.attaching.size).toBe(1);
        const sent = peer.methods(method)[0] as Record<string, any>;
        peer.conns[0]?.send({ id: sent["id"], result: { sessionId: "S-late" } });
        await until(() => peer.methods("Target.detachFromTarget").length === 1);
        const detach = peer.methods("Target.detachFromTarget")[0] as Record<string, any>;
        expect([detach["params"], detach["sessionId"]]).toEqual([{ sessionId: "S-late" }, session ?? undefined]);
        expect(sent["sessionId"]).toBe(session ?? undefined);
        expect(browser.link?.attaching.size).toBe(0);
        await browser.close();
      }
    }
  });

  test("attaches that never answer are bounded per connection", async () => {
    const [browser, peer] = await opened(attachesSilently);
    for (let index = 0; index < MAX_LATE_ATTACHES; index++) {
      expect(await caught(claimedAttach(browser, "Target.attachToTarget", { targetId: `T${index}` }, { wait: 0.01 }))).toBeInstanceOf(CdpTimeout);
    }
    expect(await browser.send("Test.echo")).toEqual({ echo: {} });
    const refused = (await caught(claimedAttach(browser, "Target.attachToTarget", { targetId: "T16" }, { wait: 0.01 }))) as BrowseError;
    expect([refused.constructor, refused.code]).toEqual([BrowseError, "attaches_unanswered"]);
    expect(refused.message).toBe(
      "Target.attachToTarget wasn't sent: 16 DevTools attaches on this connection haven't been answered. Try again once Ardia " +
        "catches up, or `ardia browse close` this session to start its connection over",
    );
    expect(peer.methods("Target.attachToTarget").length).toBe(16);
    const first = peer.methods("Target.attachToTarget")[0] as Record<string, any>;
    peer.conns[0]?.send({ id: first["id"], result: { sessionId: "S-late" } });
    await until(() => peer.methods("Target.detachFromTarget").length === 1);
    expect(await caught(claimedAttach(browser, "Target.attachToTarget", { targetId: "T17" }, { wait: 0.01 }))).toBeInstanceOf(CdpTimeout);
    expect(peer.methods("Target.attachToTarget").length).toBe(17);
    const unknown = (await caught(
      (async () => {
        const answered = peer.methods("Target.attachToTarget")[1] as Record<string, any>;
        peer.conns[0]?.send({ id: answered["id"], error: { code: -32000, message: "gone" } });
        await until(() => (browser.link?.attaching.size ?? 0) === 15);
        return claimedAttach(browser, "Target.attachToBrowserTarget", null, { wait: 0.01, unknown: true });
      })(),
    )) as OutcomeUnknown;
    expect([unknown.constructor, unknown.message]).toEqual([
      OutcomeUnknown,
      "Ardia didn't answer Target.attachToBrowserTarget in 0.01s after it was sent; the outcome of `Target.attachToBrowserTarget` is unknown, so it wasn't retried",
    ]);
    peer.conns[0]?.socket.destroy();
    await until(() => !browser.alive);
    expect(browser.link?.attaching.size).toBe(0);
  });

  test("an attach answered at the cap frees its slot at once, in the reader, before anything else sees the reply", async () => {
    const [browser, peer] = await opened((message, conn) => {
      if (message["method"] !== "Target.attachToTarget") return echo(message, conn);
      if (message["params"]?.targetId === "fresh") return conn.send({ id: message["id"], result: { sessionId: "S-fresh" } });
    });
    for (let index = 0; index < MAX_LATE_ATTACHES; index++) await caught(claimedAttach(browser, "Target.attachToTarget", { targetId: `T${index}` }, { wait: 0.01 }));
    const link = browser.link as NonNullable<typeof browser.link>;
    const first = peer.methods("Target.attachToTarget")[0] as Record<string, any>;
    const heldAtEvent: boolean[] = [];
    link.on("Probe.after", () => heldAtEvent.push(link.attaching.has(first["id"])));
    peer.conns[0]?.write(
      frame(TEXT, JSON.stringify({ id: first["id"], result: { sessionId: "S-late" } })),
      frame(TEXT, JSON.stringify({ method: "Probe.after", params: {} })),
    );
    await until(() => heldAtEvent.length === 1);
    expect(heldAtEvent).toEqual([false]);
    expect(await claimedAttach(browser, "Target.attachToTarget", { targetId: "fresh" }, { wait: 1 })).toEqual({ sessionId: "S-fresh" });
  });

  test("concurrent attaches past the cap are refused before sending; a cancelled caller sends nothing", async () => {
    const [browser, peer] = await opened(attachesSilently);
    const results = await Promise.all(Array.from({ length: 32 }, (_, index) => caught(claimedAttach(browser, "Target.attachToTarget", { targetId: `T${index}` }, { wait: 0.05 }))));
    expect(results.filter((error) => error instanceof CdpTimeout).length).toBe(16);
    expect(results.filter((error) => (error as BrowseError).code === "attaches_unanswered").length).toBe(16);
    expect(peer.methods("Target.attachToTarget").length).toBe(16);
    const aborted = new AbortController();
    aborted.abort();
    const fresh = await opened(attachesSilently);
    expect(await caught(claimedAttach(fresh[0], "Target.attachToTarget", { targetId: "T" }, { signal: aborted.signal }))).toBeInstanceOf(Cancelled);
    expect(fresh[1].methods("Target.attachToTarget")).toEqual([]);
    expect(fresh[0].link?.attaching.size).toBe(0);
  });
});
