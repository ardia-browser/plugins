import "./libc-loaded.ts";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { withSignal } from "../src/browse/cdp/cancel.ts";
import { parseConfig } from "../src/browse/daemon/config.ts";
import { laneOf, SESSION_LANE } from "../src/browse/daemon/lanes.ts";
import { Result } from "../src/browse/daemon/render.ts";
import { TabScheduler } from "../src/browse/daemon/scheduler.ts";
import { Daemon } from "../src/browse/daemon/server.ts";
import { closeFd } from "../src/browse/paths.ts";
import { dumps } from "../src/json.ts";
import { config, quietWatchdog, type Scratch, scratch } from "./m3/daemon-helpers.ts";

setDefaultTimeout(30_000);
const made: Scratch[] = [];
afterAll(() => {
  for (const found of made.splice(0)) found.done();
});

function gate(): { open: () => void; wait: Promise<void> } {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, wait };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("the scheduler", () => {
  test("different tabs run together, the same tab queues", async () => {
    const lock = new TabScheduler();
    const a = await lock.enter(() => ["t1"]);
    const b = await lock.enter(() => ["t2"]);
    expect(a).not.toBeNull();
    expect(b?.parallel).toBe(true);
    let sameRan = false;
    const same = lock.enter(() => ["t1"]).then((grant) => {
      sameRan = true;
      return grant;
    });
    await tick();
    expect(sameRan).toBe(false);
    a?.release();
    const third = await same;
    expect(sameRan).toBe(true);
    b?.release();
    third?.release();
    expect(lock.locked).toBe(false);
  });

  test("a browser-wide command waits for every tab and holds later ones back fairly", async () => {
    const lock = new TabScheduler();
    const order: string[] = [];
    const a = await lock.enter(() => ["t1"]);
    const wide = lock.acquire().then(() => order.push("wide"));
    const later = lock.enter(() => ["t2"]).then((grant) => {
      order.push("t2");
      return grant;
    });
    await tick();
    expect(order).toEqual([]);
    a?.release();
    await wide;
    await tick();
    expect(order).toEqual(["wide"]);
    lock.release();
    (await later)?.release();
    expect(order).toEqual(["wide", "t2"]);
  });

  test("waits time out and cancel cleanly without wedging the queue", async () => {
    const lock = new TabScheduler();
    await lock.acquire();
    expect(await lock.enter(() => ["t1"], 0.05)).toBeNull();
    expect(await lock.acquire(0.05)).toBe(false);
    const stop = new AbortController();
    const cancelled = lock.enter(() => ["t2"], null, stop.signal).catch((error: unknown) => error);
    stop.abort();
    expect(await cancelled).toBeDefined();
    lock.release();
    const next = await lock.enter(() => ["t3"], 0.5);
    expect(next).not.toBeNull();
    next?.release();
    expect(lock.queued).toBe(0);
  });

  test("an unresolvable target falls back to browser-wide", async () => {
    const lock = new TabScheduler();
    const grant = await lock.enter(() => null);
    expect(lock.exclusive).toBe(true);
    grant?.release();
    expect(lock.locked).toBe(false);
  });

  test("reads never wait", async () => {
    const lock = new TabScheduler();
    await lock.acquire();
    expect(await lock.read(async () => lock.readers)).toBe(1);
    lock.release();
  });
});

describe("lanes", () => {
  function fakeState(current: string | null) {
    return {
      current,
      lost: false,
      connected: true,
      labels: new Map([["work", "T2"]]),
      tabIds: new Map([["T1", "t1"], ["T2", "t2"]]),
      targetInfos: new Map([["T1", {}], ["T2", {}]]),
      pages: new Map([["T1", { runtimeOn: true }]]),
      attachedFully: () => true,
    } as never;
  }

  test("commands map to read, tab and browser-wide lanes", () => {
    const state = fakeState("T1");
    expect(laneOf("session", ["info"], state).kind).toBe("read");
    expect(laneOf("console", [], state).kind).toBe("read");
    expect(laneOf("console", ["--clear"], state).kind).toBe("tab");
    expect(laneOf("tab", ["new"], state).kind).toBe("exclusive");
    expect(laneOf("cdp", ["Page.reload", "--target", "browser"], state).kind).toBe("exclusive");
    const other = laneOf("cdp", ["Runtime.evaluate", "--target", "t2"], state);
    expect(other.kind === "tab" && other.keys()).toEqual(["T2"]);
    const mine = laneOf("cdp", ["Runtime.evaluate", "--target", "t1"], state);
    expect(mine.kind === "tab" && mine.keys()).toEqual([SESSION_LANE, "T1"]);
    const labelled = laneOf("notes", ["--tab", "work", "get"], state);
    expect(labelled.kind === "tab" && labelled.keys()).toEqual(["T2"]);
    const unknown = laneOf("notes", ["--tab", "t9", "get"], state);
    expect(unknown.kind === "tab" && unknown.keys()).toBeNull();
    const snapshot = laneOf("snapshot", ["-i"], state);
    expect(snapshot.kind === "tab" && snapshot.primary && snapshot.keys()).toEqual([SESSION_LANE, "T1"]);
  });

  test("lanes read flags exactly as the handlers do", () => {
    const state = fakeState("T1");
    const twice = laneOf("cdp", ["Runtime.evaluate", "--target", "t1", "--target", "t2"], state);
    expect(twice.kind === "tab" && twice.keys()).toEqual(["T2"]);
    expect(twice.kind === "tab" && twice.bound()).toBe("T2");
    expect(laneOf("cdp", ["Runtime.evaluate", "--target=browser"], state).kind).toBe("exclusive");
    expect(laneOf("cdp", ["Runtime.evaluate", "--target", "t2", "--target", "browser"], state).kind).toBe("exclusive");
    expect(laneOf("cdp", ["Runtime.evaluate", "--bogus"], state).kind).toBe("exclusive");
    expect(laneOf("console", ["--clear=true"], state).kind).toBe("tab");
    expect(laneOf("console", ["--clear=yes"], state).kind).toBe("tab");
    expect(laneOf("errors", ["--clear=false"], state).kind).toBe("tab");
    expect(laneOf("console", ["--json"], state).kind).toBe("tab");
    expect(laneOf("session", ["info", "extra"], state).kind).toBe("tab");
    expect(laneOf("notes", ["--tab", "t1", "--tab", "t2", "get"], state).kind).toBe("exclusive");
    const notes = laneOf("notes", ["--tab=work", "get"], state);
    expect(notes.kind === "tab" && notes.keys()).toEqual(["T2"]);
  });

  test("console stays queued until its tab is attached with Runtime on", () => {
    expect(laneOf("console", [], fakeState(null)).kind).toBe("tab");
  });
});

describe("the daemon runs other tabs beside the session's command", () => {
  test("a cdp call on another tab finishes while a snapshot is still running, and a tab switch waits for both", async () => {
    const found = scratch();
    made.push(found);
    const daemon = quietWatchdog(new Daemon(parseConfig(dumps(config(found.data, "parallel", {}, 9), "spaced"))));
    const state = daemon.state as unknown as { current: string | null; tabIds: Map<string, string>; targetInfos: Map<string, unknown> };
    state.current = "T1";
    state.tabIds.set("T1", "t1");
    state.tabIds.set("T2", "t2");
    state.targetInfos.set("T1", {});
    state.targetInfos.set("T2", {});
    const snapshotGate = gate();
    const events: string[] = [];
    const bound: (string | null)[] = [];
    daemon.dispatch = async (ctx, name, argv) => {
      bound.push(ctx.boundTarget);
      events.push(`start ${name} ${argv.join(" ")}`.trim());
      if (name === "snapshot") await snapshotGate.wait;
      events.push(`end ${name}`);
      return new Result({}, `${name} done`);
    };
    const run = (argv: string[]) => withSignal(null, () => daemon.execute({ argv, options: {} }));
    const snapshot = run(["snapshot"]);
    await tick();
    const other = await Promise.race([run(["cdp", "Runtime.evaluate", "--target", "t2"]), new Promise((resolve) => setTimeout(() => resolve("stuck"), 3000))]);
    expect(other).not.toBe("stuck");
    expect((other as [number, string])[1]).toBe("cdp done\n");
    const switched = run(["tab", "t2"]);
    await tick();
    expect(events).toEqual(["start snapshot", "start cdp Runtime.evaluate --target t2", "end cdp"]);
    snapshotGate.open();
    await snapshot;
    await switched;
    expect(events.slice(3)).toEqual(["end snapshot", "start tab t2", "end tab"]);
    expect(bound).toEqual([null, "T2", null]);
    const sameTab = gate();
    daemon.dispatch = async (_ctx, name) => {
      events.push(`start ${name}`);
      if (name === "snapshot") await sameTab.wait;
      events.push(`end ${name}`);
      return new Result({}, "ok");
    };
    events.length = 0;
    const first = run(["snapshot"]);
    await tick();
    const queued = run(["cdp", "Runtime.evaluate", "--target", "t1"]);
    await tick();
    expect(events).toEqual(["start snapshot"]);
    sameTab.open();
    await first;
    await queued;
    expect(events).toEqual(["start snapshot", "end snapshot", "start cdp", "end cdp"]);
    closeFd(daemon.lockFd);
  });
});
