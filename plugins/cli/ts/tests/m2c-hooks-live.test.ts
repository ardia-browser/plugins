import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import "./libc-loaded.ts";
import { Float, type JsonObject, type Value } from "../src/json.ts";
import { connectStream } from "../src/stream.ts";
import { hookFrom, type Hook } from "../src/hooks/model.ts";
import { HookRunner } from "../src/hooks/runner.ts";
import { Service } from "../src/hooks/service.ts";
import { liveGroups } from "../src/proc/group.ts";
import { FakeArdia, until } from "./fake-ardia.ts";

const scratch = fs.realpathSync(fs.mkdtempSync(path.join("/tmp", "m2c-")));
process.on("exit", () => fs.rmSync(scratch, { recursive: true, force: true }));
let counter = 0;

function folder(): string {
  counter += 1;
  const dir = path.join(scratch, `c${counter}`);
  fs.mkdirSync(dir);
  return dir;
}

function value(item: unknown): Value {
  if (Array.isArray(item)) return item.map(value);
  if (item !== null && typeof item === "object") return new Map(Object.entries(item).map(([key, inner]) => [key, value(inner)]));
  if (typeof item === "number") return Number.isInteger(item) ? BigInt(item) : new Float(item);
  return item as Value;
}

function hook(item: Record<string, unknown>): Hook {
  return hookFrom(value(item) as JsonObject);
}

function memoryLog(): { lines: string[]; write: (text: string) => void; close: () => void } {
  const lines: string[] = [];
  return { lines, write: (text) => lines.push(text), close: () => {} };
}

const caller = new Map<string, Value>([["name", "test"]]);

async function served(hooks: Hook[], run: (server: FakeArdia, service: Service, log: ReturnType<typeof memoryLog>) => Promise<void>, capture = true): Promise<void> {
  const dir = folder();
  const server = await new FakeArdia(path.join(dir, "s.sock")).start();
  const log = memoryLog();
  const service = new Service(server.path, log, capture, (where) => connectStream(where, caller), 0.05, 0.1, path.join(dir, "state.json"));
  service.setHooks(hooks);
  const running = service.runForever();
  try {
    await run(server, service, log);
  } finally {
    await service.stop();
    await running;
    await server.stop();
  }
}

test("an event runs its hook with the JSON line on stdin and the event in the environment", async () => {
  const dir = folder();
  const out = path.join(dir, "out.txt");
  const script = `cat > ${out}.stdin; printf '%s|%s|%s' "$ARDIA_EVENT" "$ARDIA_URL" "$ARDIA_TAB_ID" > ${out}; echo said-out; echo said-err >&2`;
  await served([hook({ name: "nav", on: ["tab.navigated"], run: ["/bin/sh", "-c", script] })], async (server, service, log) => {
    await until(() => server.of("subscribe").length > 0);
    assert.deepEqual(server.of("subscribe")[0]?.params, { events: ["tab.navigated"] });
    server.send({ event: "tab.opened", data: { url: "https://x/" } });
    server.send({ event: "tab.navigated", time: 1, data: { url: "https://a/b?q=1#f", tabId: "t9", score: 1.5 } });
    await until(() => fs.existsSync(out) && log.lines.some((line) => line === "[nav] said-err"));
    assert.equal(fs.readFileSync(out, "utf8"), "tab.navigated|https://a/b|t9");
    assert.equal(fs.readFileSync(`${out}.stdin`, "utf8"), '{"event":"tab.navigated","time":1,"data":{"url":"https://a/b","tabId":"t9","score":1.5}}\n');
    assert.ok(log.lines.includes("[nav] said-out"));
    assert.ok(log.lines.includes("connected to Ardia 9.9"));
    assert.equal(service.connections, 1);
  });
});

test("a run past its timeout loses its whole process group, and a failing one is logged", async () => {
  const dir = folder();
  const pidFile = path.join(dir, "pid");
  const log = memoryLog();
  const slow = new HookRunner(hook({ name: "slow", on: ["tab.opened"], run: ["/bin/sh", "-c", `sleep 30 & echo $! > ${pidFile}; wait`], timeout: 0.5 }), log, true, 100, 0.2);
  const started = performance.now();
  assert.equal(await slow.runOnce(value({ event: "tab.opened" }) as JsonObject), -15);
  assert.ok(performance.now() - started < 3000);
  const grandchild = Number(fs.readFileSync(pidFile, "utf8"));
  await until(() => {
    try {
      process.kill(grandchild, 0);
      return false;
    } catch {
      return true;
    }
  });
  assert.ok(log.lines.includes("hook slow: stopped after its 0.5 s timeout (with anything it left running)"));
  const failing = new HookRunner(hook({ name: "bad", on: ["tab.opened"], run: ["/bin/sh", "-c", "exit 3"] }), log, true);
  assert.equal(await failing.runOnce(value({ event: "tab.opened" }) as JsonObject), 3);
  assert.ok(log.lines.includes("hook bad: /bin/sh exited with status 3"));
  const missing = new HookRunner(hook({ name: "gone", on: ["tab.opened"], run: ["/nonexistent/x"] }), log, true);
  assert.equal(await missing.runOnce(value({ event: "tab.opened" }) as JsonObject), null);
  assert.ok(log.lines.includes("hook gone: can't run /nonexistent/x: No such file or directory"));
  for (const runner of [slow, failing, missing]) await runner.stop();
  await until(() => liveGroups().length === 0, 2);
});

test("a child that exits but leaves its stdout open is stopped at the deadline", async () => {
  const log = memoryLog();
  const runner = new HookRunner(hook({ name: "leak", on: ["tab.opened"], run: ["/bin/sh", "-c", "(sleep 30) & exit 0"], timeout: 0.4 }), log, true, 100, 0.2);
  await runner.runOnce(value({ event: "tab.opened" }) as JsonObject);
  assert.ok(log.lines.some((line) => line.startsWith("hook leak: stopped after its 0.4 s timeout")));
  await runner.stop();
});

test("long lines are cut at 64 KB and the queue drops its oldest event past the cap", async () => {
  const log = memoryLog();
  const runner = new HookRunner(hook({ name: "big", on: ["tab.opened"], run: ["/bin/sh", "-c", "head -c 70000 /dev/zero | tr '\\0' a; echo; echo tail"] }), log, true, 2);
  runner.offer(value({ event: "tab.opened" }) as JsonObject);
  runner.offer(value({ event: "tab.opened" }) as JsonObject);
  runner.offer(value({ event: "tab.opened" }) as JsonObject);
  runner.offer(value({ event: "tab.opened" }) as JsonObject);
  await until(() => log.lines.filter((line) => line === "[big] tail").length >= 2, 10);
  const cut = log.lines.find((line) => line.startsWith("[big] aaa"));
  assert.ok(cut?.endsWith(" …(line cut at 64 KB)"));
  assert.equal(cut?.length, "[big] ".length + 65536 + " …(line cut at 64 KB)".length);
  assert.ok(log.lines.some((line) => line.startsWith("warning: hook big: 2 events waiting, dropped the oldest")));
  await runner.stop();
});

test("a command hook runs in the event's window and stops after ten in ten seconds", async () => {
  await served([hook({ name: "loop", on: "tab.opened", command: "newTab" }), hook({ name: "page", on: "tab.closed", command: "reload" })], async (server, _service, log) => {
    await until(() => server.of("commands").length > 0);
    for (let index = 0; index < 15; index += 1) server.send({ event: "tab.opened", data: { windowId: "w1", tabId: `t${index}`, url: "https://a/" } });
    server.send({ event: "tab.closed", data: { windowId: "w2", tabId: "t2" } });
    await until(() => server.of("run").length >= 11 && log.lines.some((line) => line.includes("triggering itself")));
    const runs = server.of("run").map((request) => request.params);
    assert.deepEqual(runs[0], { command: "newTab", window: "w1" });
    assert.equal(runs.filter((params) => params?.command === "newTab").length, 10);
    assert.deepEqual(runs.find((params) => params?.command === "reload"), { command: "reload", window: "w2", tab: "t2" });
  });
});

test("decide programs answer, a slow one is stopped, and an unregistered revision never runs", async () => {
  const answering = `read line; case "$line" in *reddit*) printf '{"url": "https://old.reddit.com/r/x"}';; esac`;
  const items = [hook({ name: "rewrite", on: "tab.opening", run: ["/bin/sh", "-c", answering] }), hook({ name: "slow", on: "link.opening", run: ["/bin/sh", "-c", "sleep 5"] })];
  await served(items, async (server, _service, log) => {
    await until(() => server.of("subscribe").some((request) => Array.isArray(request.params?.hooks)));
    const sent = server.of("subscribe").at(-1)?.params?.hooks as { name: string }[];
    assert.deepEqual(sent.map((item) => item.name), ["rewrite", "slow"]);
    server.send({ decide: "x0", event: "tab.opening", hook: "rewrite", revision: "rev-edited", deadline: 1000, data: { url: "https://www.reddit.com/r/x" } });
    server.send({ decide: "d1", event: "tab.opening", hook: "rewrite", revision: "rev-rewrite", deadline: 2000, data: { url: "https://www.reddit.com/r/x?q" } });
    server.send({ decide: "d2", event: "link.opening", hook: "slow", revision: "rev-slow", deadline: 300, data: { url: "https://a/" } });
    server.send({ decide: "d3", event: "tab.opening", hook: "nope", deadline: 300, data: {} });
    await until(() => server.of("answer").length > 0 && log.lines.some((line) => line.includes("no answer in")));
    assert.deepEqual(server.of("answer").map((request) => request.params), [{ decide: "d1", answer: { url: "https://old.reddit.com/r/x" } }]);
    assert.ok(log.lines.includes("hook slow: no answer in 300 ms; Ardia used its default"));
    assert.ok(log.lines.includes("warning: hook rewrite: Ardia asked for a revision this runner didn't register; it uses its default"));
  });
});

test("the runner reconnects when Ardia goes away and says events may have been missed", async () => {
  await served([hook({ name: "x", on: "tab.opened", run: ["/bin/true"] })], async (server, service, log) => {
    await until(() => server.of("subscribe").length === 1);
    server.dropClients();
    await until(() => server.of("subscribe").length === 2, 5);
    assert.equal(service.connections, 2);
    assert.ok(log.lines.some((line) => line.startsWith("lost Ardia: ")));
    assert.ok(log.lines.includes("connected to Ardia 9.9 (events in between may have been missed)"));
  });
});

test("a launch runs each hook once per launch id, even after a restart", async () => {
  const dir = folder();
  const out = path.join(dir, "count");
  const items = [hook({ name: "boot", on: "app.launched", run: ["/bin/sh", "-c", `echo x >> ${out}`] })];
  await served(items, async (server) => {
    await until(() => server.of("subscribe").length > 0);
    server.send({ event: "app.launched", data: { launchId: "L1" } });
    server.send({ event: "app.launched", data: { launchId: "L1" } });
    server.send({ event: "app.launched", data: { launchId: "L2" } });
    await until(() => fs.existsSync(out) && fs.readFileSync(out, "utf8").split("\n").filter(Boolean).length === 2);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(fs.readFileSync(out, "utf8"), "x\nx\n");
  });
});

test("hooks run from a fake app survive a missing socket and log the retry once", async () => {
  const dir = folder();
  const log = memoryLog();
  const service = new Service(path.join(dir, "missing.sock"), log, true, (where) => connectStream(where, caller), 0.02, 0.05);
  service.setHooks([hook({ name: "x", on: "tab.opened", run: ["/bin/true"] })]);
  const running = service.runForever();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await service.stop();
  await running;
  assert.equal(log.lines.filter((line) => line.endsWith("; retrying")).length, 1);
  void os;
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const IGNORES_TERM = (pidFile: string) => `(trap '' TERM; exec >/dev/null 2>&1 </dev/null; echo $$ > ${pidFile}.self; exec sleep 30) & echo $! > ${pidFile}; wait`;

test("a timed-out hook's descendant that ignores SIGTERM and closed its output is killed at the end of the grace", async () => {
  const dir = folder();
  const pidFile = path.join(dir, "pid");
  const log = memoryLog();
  const runner = new HookRunner(hook({ name: "stubborn", on: ["tab.opened"], run: ["/bin/sh", "-c", IGNORES_TERM(pidFile)], timeout: 0.4 }), log, true, 100, 0.3);
  const started = performance.now();
  await runner.runOnce(value({ event: "tab.opened" }) as JsonObject);
  const descendant = Number(fs.readFileSync(pidFile, "utf8"));
  assert.ok(log.lines.some((line) => line.startsWith("hook stubborn: stopped after its 0.4 s timeout")));
  await until(() => !alive(descendant), 3);
  assert.ok(performance.now() - started >= 650);
  await until(() => liveGroups().length === 0, 2);
  await runner.stop();
});

test("stopping the runner kills a TERM-ignoring descendant once the grace is over", async () => {
  const dir = folder();
  const pidFile = path.join(dir, "pid");
  const runner = new HookRunner(hook({ name: "stubborn", on: ["tab.opened"], run: ["/bin/sh", "-c", IGNORES_TERM(pidFile)], timeout: 60 }), memoryLog(), true);
  runner.offer(value({ event: "tab.opened" }) as JsonObject);
  await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim() !== "");
  const descendant = Number(fs.readFileSync(pidFile, "utf8"));
  const started = performance.now();
  await runner.stop(0.3);
  assert.ok(performance.now() - started >= 250);
  await until(() => !alive(descendant), 2);
  assert.deepEqual(liveGroups(), []);
});
