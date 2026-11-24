import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUILT_LIBC } from "./libc-loaded.ts";
import { Runner, type RunnerEvent, whenReady } from "../src/browse/script/host.ts";
import { LOG_TOTAL, type RunnerInbound, type RunnerOutbound, startRunner } from "../src/browse/script/runner.ts";

setDefaultTimeout(30_000);

type Answer = { ok: boolean; text?: string; data?: unknown; error?: string; code?: string; call?: number };
type Outcome = { confined: number; result: Record<string, unknown> | null; exit: RunnerEvent | null; logs: string[]; requests: Record<string, unknown>[]; runner: Runner };

const DEFAULT_ANSWER = (request: Record<string, unknown>): Answer =>
  request["op"] === "frames"
    ? { ok: true, data: { frames: [{ id: "F1", url: "https://x.test/", main: true, crossProcess: false }, { id: "F2", url: "https://y.test/", main: false, crossProcess: true }] } }
    : { ok: true, text: "✓ done", data: { result: 7, url: "https://x.test/a/b", title: "T", text: "row" } };

async function runScript(source: string, answer: (request: Record<string, unknown>) => Answer = DEFAULT_ANSWER, setup?: (runner: Runner) => void): Promise<Outcome> {
  const runner = new Runner();
  const confined = await whenReady(runner);
  setup?.(runner);
  runner.send({ type: "start", source, state: '{"seen": 1}', readBatch: 100, stateLimit: 1 << 24 });
  const logs: string[] = [];
  const requests: Record<string, unknown>[] = [];
  try {
    for (;;) {
      const event = await runner.next();
      if (event.type === "request") {
        const request = JSON.parse(event.request) as Record<string, unknown>;
        requests.push(request);
        setTimeout(() => runner.send({ type: "reply", id: request["id"] as number, answer: JSON.stringify(answer(request)) }), 1);
      } else if (event.type === "log") logs.push(event.line);
      else if (event.type === "done") return { confined, result: JSON.parse(event.result) as Record<string, unknown>, exit: null, logs, requests, runner };
      else if (event.type === "exit") return { confined, result: null, exit: event, logs, requests, runner };
    }
  } finally {
    runner.kill();
  }
}

const WALK = `
const root = Object.prototype;
const seen = new Set();
const queue = [[globalThis, "globalThis"]];
const foreign = [];
const rootOf = (o) => { let p = o; let last = null; for (let i = 0; i < 100 && p !== null; i++) { last = p; p = Object.getPrototypeOf(p); } return last; };
while (queue.length) {
  const [o, where] = queue.shift();
  if (o === null || (typeof o !== "object" && typeof o !== "function") || seen.has(o)) continue;
  seen.add(o);
  const top = rootOf(o);
  if (top !== root && top !== o) foreign.push(where);
  queue.push([Object.getPrototypeOf(o), where + ".__proto__"]);
  let keys = [];
  try { keys = Reflect.ownKeys(o); } catch (e) {}
  for (const key of keys) {
    let d;
    try { d = Object.getOwnPropertyDescriptor(o, key); } catch (e) { continue; }
    if (!d) continue;
    const name = where + "." + String(key);
    if ("value" in d) queue.push([d.value, name]);
    if (d.get) queue.push([d.get, name + "<get>"]);
    if (d.set) queue.push([d.set, name + "<set>"]);
  }
}
const probes = [
  () => globalThis.constructor.constructor("return typeof process")(),
  () => Function("return typeof process + typeof Bun + typeof require + typeof fetch")(),
  () => eval("typeof process"),
  () => (function () { return this; })().constructor.constructor("return typeof Bun")(),
  () => typeof ShadowRealm + typeof WebSocket + typeof Worker + typeof XMLHttpRequest,
  () => page.constructor.constructor("return typeof process")(),
  () => page.click.constructor("return typeof process")(),
  () => console.log.constructor("return typeof process")(),
];
const answers = probes.map((probe) => { try { return String(probe()); } catch (e) { return "threw " + (e instanceof Error); } });
let imported = "refused";
try { await import("node:fs"); imported = "IMPORTED"; } catch (e) { imported = e instanceof Error ? "refused" : "foreign error"; }
return { objects: seen.size, foreign, answers, imported };
`;

describe("the script runner", () => {
  test("is sandboxed by the OS where it can be", async () => {
    const { confined } = await runScript("return 1");
    if (process.platform === "darwin") expect(confined).toBe(1);
    else expect(confined).toBeGreaterThanOrEqual(0);
  });

  test("nothing a script can reach belongs to the runner's own realm", async () => {
    const { result } = await runScript(WALK);
    const value = result?.["value"] as Record<string, unknown>;
    expect(result?.["kind"]).toBe("done");
    expect(value["foreign"]).toEqual([]);
    expect(Number(value["objects"])).toBeGreaterThan(300);
    expect(value["answers"]).toEqual(["undefined", "undefinedundefinedundefinedundefined", "undefined", "undefined", "undefinedundefinedundefinedundefined", "undefined", "undefined", "undefined"]);
    expect(value["imported"]).toBe("refused");
  });

  test("every error a script can provoke is one of its own realm", async () => {
    const { result } = await runScript(`
      const out = [];
      const check = async (label, run) => {
        try { await run(); out.push(label + ":no error"); }
        catch (e) { out.push(label + ":" + (e instanceof Error ? "own" : "foreign")); }
      };
      await check("import", () => import("node:fs"));
      await check("eval import", () => eval("import('node:fs')"));
      await check("Function import", () => Function("return import('node:fs')")());
      await check("indirect eval import", () => (0, eval)("import('fs')"));
      await check("later import", () => Promise.resolve().then(() => import("x")));
      await check("overflow", () => { const f = () => f(); f(); });
      await check("regexp", () => new RegExp("["));
      await check("intl", () => new Intl.DateTimeFormat("xx-??"));
      await check("json", () => JSON.parse("{"));
      await check("eval syntax", () => eval("let = = 1"));
      await check("bad url", () => new URL("::"));
      await check("bad base64", () => atob("*"));
      await check("timer", () => setTimeout(1));
      await check("wasm", () => new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])));
      return out;
    `);
    expect((result?.["value"] as string[]).filter((line) => !line.endsWith(":own"))).toEqual([]);
  });

  test("a confined process can't read files, write files, connect, signal others or run programs", async () => {
    if (process.platform !== "darwin") return;
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ardia-confine-"));
    const readable = path.join(scratch, "readable.txt");
    fs.writeFileSync(readable, "x");
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reached") });
    const probe = `
      import { loadLibc, confineProcess } from ${JSON.stringify(path.resolve(import.meta.dir, "..", "src", "libc.ts"))};
      import fs from "node:fs";
      loadLibc(${JSON.stringify(BUILT_LIBC)});
      const tries = { confined: process.env.ARDIA_PROBE_CONFINE === "1" ? confineProcess() : 0 };
      for (const [name, run] of Object.entries({
        read: () => fs.readFileSync(process.env.ARDIA_PROBE_READ),
        readEtc: () => fs.readFileSync("/etc/hosts"),
        write: () => fs.writeFileSync(process.env.ARDIA_PROBE_WRITE, "x"),
        spawn: () => { if (Bun.spawnSync(["/bin/echo", "hi"]).exitCode !== 0) throw new Error("no"); },
        signal: () => process.kill(Number(process.env.ARDIA_SIGNAL_TARGET), "SIGTERM"),
      })) { try { run(); tries[name] = "allowed"; } catch (e) { tries[name] = "denied"; } }
      try { const answer = await fetch(process.env.ARDIA_PROBE_URL); tries.connect = (await answer.text()) === "reached" ? "allowed" : "denied"; } catch (e) { tries.connect = "denied"; }
      console.log(JSON.stringify(tries));
    `;
    const run = async (confine: boolean) => {
      const target = Bun.spawn(["/bin/sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });
      const child = Bun.spawn([process.execPath, "-e", probe], {
        stdout: "pipe",
        stderr: "ignore",
        timeout: 20_000,
        env: {
          ...process.env,
          ARDIA_PROBE_CONFINE: confine ? "1" : "0",
          ARDIA_PROBE_READ: readable,
          ARDIA_PROBE_WRITE: path.join(scratch, confine ? "confined-write" : "open-write"),
          ARDIA_PROBE_URL: `http://127.0.0.1:${server.port}/`,
          ARDIA_SIGNAL_TARGET: String(target.pid),
        },
      });
      const out = await new Response(child.stdout).text();
      await child.exited;
      await new Promise((resolve) => setTimeout(resolve, 300));
      let targetAlive = true;
      try {
        process.kill(target.pid, 0);
      } catch {
        targetAlive = false;
      }
      target.kill("SIGKILL");
      return { tries: JSON.parse(out.trim().split("\n").at(-1) as string) as Record<string, unknown>, targetAlive };
    };
    try {
      const open = await run(false);
      expect(open.tries).toEqual({ confined: 0, read: "allowed", readEtc: "allowed", write: "allowed", spawn: "allowed", signal: "allowed", connect: "allowed" });
      expect(open.targetAlive).toBe(false);
      const confined = await run(true);
      expect(confined.tries).toEqual({ confined: 1, read: "denied", readEtc: "denied", write: "denied", spawn: "denied", signal: "denied", connect: "denied" });
      expect(confined.targetAlive).toBe(true);
    } finally {
      server.stop(true);
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("errors carry the script's own line numbers", async () => {
    const thrown = await runScript("const a = 1;\nconst b = 2;\nthrow new Error('boom');");
    expect(thrown.result).toMatchObject({ kind: "error", message: "boom", name: "Error", line: 3 });
    const syntax = await runScript("const a = 1;\nlet = = 2;");
    expect(syntax.result).toMatchObject({ kind: "error", message: "SyntaxError: Unexpected token '='", line: 2, code: "script_syntax" });
    const failedCall = await runScript("log('x');\nawait page.click('#gone');", (request) => ({ ok: false, error: "No element matches #gone", code: "not_found", call: 1 }));
    expect(failedCall.result).toMatchObject({ kind: "error", message: "No element matches #gone", line: 2, code: "not_found", command: ["click", "#gone"], call: 1 });
    expect(failedCall.logs).toEqual(["x"]);
  });

  test("timers, URL, base64 and state work without the runner's own globals", async () => {
    const { result } = await runScript(`
      const started = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 30));
      let ticks = 0;
      await new Promise((resolve) => { const id = setInterval(() => { if (++ticks === 3) { clearInterval(id); resolve(); } }, 2); });
      const url = new URL("/x?a=1", "https://e.test/p");
      url.searchParams.set("page", 2);
      url.pathname = "/models";
      state.seen += 1;
      return [Date.now() - started >= 30, ticks, url.href, url.host, URL.canParse("nope"), new URLSearchParams({ q: "a b" }).toString(), btoa("hi"), atob("aGk="), state.seen, structuredClone({ a: [1] })];
    `);
    expect(result?.["value"]).toEqual([true, 3, "https://e.test/models?a=1&page=2", "e.test", false, "q=a+b", "aGk=", "hi", 2, { a: [1] }]);
  });

  test("page calls go out together and carry their arguments", async () => {
    const { result, requests } = await runScript(`
      return await Promise.all([
        page.evaluate((a, b) => a + b, 1, 2),
        page.$$eval("a.model", (links, max) => links.slice(0, max).map((a) => a.href), 5),
        page.$eval("h1", (h) => h.textContent),
        page.title(),
        page.frames().then((frames) => frames.map((f) => [f.id, f.crossProcess, typeof f.$$eval])),
      ]);
    `);
    expect(result?.["value"]).toEqual([7, 7, 7, "T", [["F1", false, "function"], ["F2", true, "function"]]]);
    expect(requests.map((request) => request["op"])).toEqual(["evaluate", "$$eval", "$eval", "call", "frames"]);
    expect(requests[0]).toMatchObject({ fn: "(a, b) => a + b", isFunction: true, args: [1, 2] });
    expect(requests[1]).toMatchObject({ selector: "a.model", args: [5] });
  });

  test("actions ask for no receipt unless the script wants one", async () => {
    const { requests } = await runScript("await page.click('#a'); await page.fill('#b', 'x', { receipt: true }); await page.press('#b', 'Enter'); await page.select('#c', 'one', 'two'); await browse('click', '#a'); await page.keyboard.press('Escape');");
    expect(requests.map((request) => [request["argv"], request["light"] ?? false, request["receipt"] ?? false])).toEqual([
      [["click", "#a"], true, false],
      [["fill", "#b", "x"], true, true],
      [["press", "#b", "Enter"], true, false],
      [["select", "#c", "one", "two"], true, false],
      [["click", "#a"], false, false],
      [["press", "Escape"], true, false],
    ]);
  });

  test("searchParams a script holds follows later edits of the URL", async () => {
    const { result } = await runScript(`
      const u = new URL("https://x.test/models?page=1");
      const params = u.searchParams;
      u.search = "?page=2&sort=likes";
      const afterSearch = [params.get("page"), params.get("sort"), u.searchParams === params];
      params.set("page", 3);
      const afterSet = u.href;
      u.href = "https://x.test/other?q=a+b";
      return [afterSearch, afterSet, params.get("q"), params.get("page"), [...params.keys()]];
    `);
    expect(result?.["value"]).toEqual([["2", "likes", true], "https://x.test/models?page=3&sort=likes", "a b", null, ["q"]]);
  });

  test("structuredClone keeps the types it should and refuses the ones it can't", async () => {
    const { result } = await runScript(`
      const source = { when: new Date(5), tags: new Set(["a"]), counts: new Map([["x", 1]]), re: /a+/gi, bytes: new Uint8Array([1, 2, 3]).subarray(1), err: new TypeError("bad"), big: 10n };
      source.self = source;
      const copy = structuredClone(source);
      let refused = "";
      try { structuredClone({ f() {} }); } catch (e) { refused = e.name; }
      return [
        copy !== source && copy.self === copy,
        copy.when instanceof Date && copy.when.getTime(),
        copy.tags instanceof Set && [...copy.tags],
        copy.counts instanceof Map && copy.counts.get("x"),
        copy.re instanceof RegExp && copy.re.flags,
        copy.bytes instanceof Uint8Array && [...copy.bytes],
        copy.err instanceof TypeError && copy.err.message,
        typeof copy.big === "bigint" && String(copy.big),
        refused,
      ];
    `);
    expect(result?.["value"]).toEqual([true, 5, ["a"], 1, "gi", [2, 3], "bad", "10", "DataCloneError"]);
  });

  test("the runner never sends more log text than its total, whatever the line sizes", async () => {
    const posted: RunnerOutbound[] = [];
    let deliver: (message: RunnerInbound) => void = () => {};
    const finished = new Promise<void>((resolve) => {
      startRunner({
        post: (message) => {
          posted.push(message);
          if (message.type === "done") resolve();
        },
        onMessage: (listener) => {
          deliver = listener;
        },
      });
    });
    deliver({ type: "start", source: "const line = 'x'.repeat(70 * 1024);\nfor (let i = 0; i < 100; i++) log(line);\nreturn 1;", state: "{}", readBatch: 100, stateLimit: 1 << 24 });
    await finished;
    const sent = posted.filter((message) => message.type === "log").reduce((total, message) => total + (message as { line: string }).line.length, 0);
    expect(sent).toBeGreaterThan(LOG_TOTAL - 70 * 1024);
    expect(sent).toBeLessThanOrEqual(LOG_TOTAL);
  });

  test("structuredClone keeps an own __proto__ key as data", async () => {
    const { result } = await runScript(`
      const source = JSON.parse('{"__proto__": {"x": 1}, "y": 2}');
      const copy = structuredClone(source);
      return [Object.keys(copy), Object.getPrototypeOf(copy) === Object.prototype, copy.x === undefined, Object.getOwnPropertyDescriptor(copy, "__proto__").value.x];
    `);
    expect(result?.["value"]).toEqual([["__proto__", "y"], true, true, 1]);
  });

  test("waitForSelector passes its state and timeout to wait", async () => {
    const { requests } = await runScript("await page.waitForSelector('#spinner', { state: 'hidden', timeout: '5s' }); await page.waitForSelector('#ready');");
    expect(requests.map((request) => request["argv"])).toEqual([["wait", "#spinner", "--state", "hidden", "--timeout", "5s"], ["wait", "#ready"]]);
  });

  test("a page method that doesn't exist says what to use instead", async () => {
    const { result } = await runScript("await page.route('**/*', () => {});");
    expect(result).toMatchObject({ kind: "error", name: "TypeError", code: "usage", line: 1 });
    expect(String(result?.["message"])).toContain("page.route isn't part of ardia's script API");
    expect(String(result?.["message"])).toContain("page.$$eval");
  });

  test("arguments over the limit in UTF-8 bytes are refused in the script, not left waiting", async () => {
    const { result, requests } = await runScript(`
      const started = Date.now();
      let refused = "";
      try { await page.evaluate((x) => x.length, "界".repeat(6 * 1024 * 1024)); } catch (e) { refused = e.name + ": " + e.message; }
      const fits = await page.evaluate((x) => x.length, "界".repeat(1024));
      return [refused, Date.now() - started < 10000, fits];
    `);
    expect(result?.["value"]).toEqual(["RangeError: the arguments of that call are over 16 MB", true, 7]);
    expect(requests).toHaveLength(1);
  });

  test("arguments that aren't JSON are refused in the script", async () => {
    const { result, requests } = await runScript("await page.evaluate((n) => n, 10n);");
    expect(result).toMatchObject({ kind: "error", name: "TypeError", message: "page.evaluate() takes JSON values as arguments" });
    expect(requests).toEqual([]);
  });

  test("a runaway script is stopped by its memory limit", async () => {
    const outcome = await runScript("const keep = []; for (;;) keep.push(new Array(1e6).fill(1));", DEFAULT_ANSWER, (runner) => runner.watchMemory(256 * 1024 * 1024, 50));
    expect(outcome.exit?.type).toBe("exit");
    expect(outcome.runner.overMemory).toBe(true);
  });

  test("a busy runner dies with the daemon that started it", async () => {
    const parent = `
      import ${JSON.stringify(path.resolve(import.meta.dir, "libc-loaded.ts"))};
      import { Runner, whenReady } from ${JSON.stringify(path.resolve(import.meta.dir, "..", "src", "browse", "script", "host.ts"))};
      const runner = new Runner();
      await whenReady(runner);
      runner.send({ type: "start", source: "for (;;) {}", state: "{}", readBatch: 100, stateLimit: 1 << 24 });
      await new Promise((resolve) => setTimeout(resolve, 200));
      console.log(runner.child.pid);
      process.exit(0);
    `;
    const done = spawnSync(process.execPath, ["-e", parent], { encoding: "utf8", timeout: 20_000 });
    const pid = Number(done.stdout.trim().split("\n").at(-1));
    expect(pid).toBeGreaterThan(0);
    let alive = true;
    for (let tries = 0; tries < 40 && alive; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
    }
    if (alive) process.kill(pid, "SIGKILL");
    expect(alive).toBe(false);
  });

  test("a busy loop is killed and the runner exits", async () => {
    const runner = new Runner();
    await whenReady(runner);
    runner.send({ type: "start", source: "for (;;) {}", state: "{}", readBatch: 100, stateLimit: 1 << 24 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    runner.kill();
    expect((await runner.next()).type).toBe("exit");
  });
});
