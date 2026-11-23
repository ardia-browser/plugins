import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { test } from "bun:test";
import { caseFromRow, checkCaseFitsExec, LINUX_MAX_ARG_STRLEN, loadCases, PARITY, PLACEHOLDER_ROOM, UnsafeCase, type Case } from "./cases.ts";
import { compare, datedFiles, decodeExpected, fallbackRequests, TODAY_MARK, type Comparable } from "./compare.ts";
import { DEFAULT_HELLO, FakeArdia } from "./fakes.ts";
import { Install, isoTime, materialize, reap, runSide, scrubTimes, timeMarker, translatePattern, writeStubForTest } from "./observe.ts";
import { canonical, dumps, fromJs, loads, PyFloat, PyJsonError, type Py } from "./pyjson.ts";
import { programPath, runCases } from "./run.ts";

const QUICK = 5000;
const SLOW = 60_000;

function expectThrows(body: () => unknown, kind: new (...args: never[]) => Error, pattern?: RegExp): void {
  try {
    body();
  } catch (error) {
    if (!(error instanceof kind)) throw new Error(`threw ${String(error)}, not ${kind.name}`);
    if (pattern && !pattern.test((error as Error).message)) throw new Error(`${(error as Error).message} doesn't match ${pattern}`);
    return;
  }
  throw new Error(`did not throw ${kind.name}`);
}

function equal(actual: unknown, expected: unknown, what = "value"): void {
  const left = JSON.stringify(actual, (_, value) => (typeof value === "bigint" ? `${value}n` : value instanceof Map ? Object.fromEntries(value) : value));
  const right = JSON.stringify(expected, (_, value) => (typeof value === "bigint" ? `${value}n` : value instanceof Map ? Object.fromEntries(value) : value));
  if (left !== right) throw new Error(`${what}: ${left} != ${right}`);
}

function kase(row: Record<string, unknown>): Case {
  return caseFromRow(fromJs({ id: "t", command: "windows", argv: ["windows"], ...row }), "test");
}

function scratch(prefix: string): string {
  return realpathSync(mkdtempSync(join("/tmp", prefix)));
}

const NO_PROGRAM = !existsSync(programPath());

test("a case cannot reach outside its sandbox", () => {
  for (const row of [{ files: { "../x": "y" } }, { files: { "data/../../x": "y" } }, { files: { "/etc/x": "y" } }, { files: { "elsewhere/x": "y" } },
    { argv: ["windows", "--data-dir", "/d"] }, { argv: ["windows", "--data-dir=/d"] }, { argv: ["windows", "--data-dir", "{data}/../../x"] },
    { argv: ["config", "path", "~/x"] }, { argv: ["plugins", "install", "../../x"] }, { argv: ["plugins", "install", "{cli}/../x"] }, { env: { HOME: null } },
    { env: { ARDIA_CLI_HOME: "/x" } }, { env: { PATH: "/bin" } }, { env: { ARDIA_DATA_DIR: "/Users/someone/Ardia" } }, { helpers: { "../launchctl": {} } },
    { helpers: { "/bin/sh": {} } }, { env: { ARDIA_CONFIG_HOME: "{box}/../sibling" } }, { env: { XDG_CONFIG_HOME: "/elsewhere" } },
    { env: { XDG_DATA_HOME: "../.." } }, { env: { ARDIA_CONFIG_HOME: "{cli}/x" } }, { env: { SOME_DIR: "/elsewhere" } }]) {
    expectThrows(() => kase(row), UnsafeCase);
  }
  kase({ argv: ["windows", "--data-dir", "{box}/elsewhere"], env: { ARDIA_DATA_DIR: null, COLUMNS: "80" } });
  kase({ argv: ["theme", "check", "../evil"] });
  kase({ argv: ["plugins", "call", "x", '{"who": "you/../me"}'] });
}, QUICK);

test("a case Linux cannot exec is refused when loaded, and every case fits", () => {
  const nearLimit = LINUX_MAX_ARG_STRLEN - PLACEHOLDER_ROOM;
  for (const row of [{ argv: ["call", "history.search", "--params", "[".repeat(nearLimit)] }, { env: { COLUMNS: "8".repeat(nearLimit) } },
    { argv: ["windows", ...Array.from({ length: 20 }, () => "x".repeat(60000))] }]) {
    expectThrows(() => kase(row), UnsafeCase, /Linux|exec limit/);
  }
  kase({ argv: ["call", "history.search", "--params", "[".repeat(nearLimit - 2)] });
  for (const each of loadCases()) checkCaseFitsExec(each);
}, SLOW);

test("every case carries an expected outcome", () => {
  const missing = loadCases().filter((each) => each.expected === undefined).map((each) => each.id);
  equal(missing, [], "cases without expected");
}, SLOW);

const hello = (id: number) => fromJs({ id, method: "hello", params: { protocol: 4 } });

test("a fallback may only ask read-only questions first, once, and only in a fallback case", () => {
  const python = [[hello(1), fromJs({ id: 2, method: "apply", params: { ops: [] } })]];
  const readFirst = [[hello(1), fromJs({ id: 2, method: "workspace" })], ...python];
  const mutateFirst = [[hello(1), fromJs({ id: 2, method: "apply", params: { ops: [] } })], ...python];
  equal(canonical(fallbackRequests(readFirst, python)), canonical(python));
  equal(canonical(fallbackRequests(mutateFirst, python)), canonical(mutateFirst));
  const asked = [[hello(1), fromJs({ id: 2, method: "workspace" })]];
  const once = [[hello(1), fromJs({ id: 2, method: "windows" })], ...asked];
  const twice = [[hello(1), fromJs({ id: 2, method: "windows" })], [hello(1), fromJs({ id: 2, method: "windows" })], ...asked];
  const side = (requests: Py): Comparable => ({ status: 0, stdout: { bytes: Buffer.alloc(0) }, stderr: { bytes: Buffer.alloc(0) }, requests, daemon_requests: [], telemetry: [],
    queued: [], usage: null, flush: null, files: new Map(), helpers: [], timed_out: false });
  equal(compare(side(once), side(asked), true), []);
  equal(compare(side(twice), side(asked), true).map(([field]) => field), ["requests"]);
  equal(compare(side(once), side(asked), false).map(([field]) => field), ["requests"]);
}, QUICK);

test("times are scrubbed only when they are now, and flush deadlines compare as offsets", () => {
  const window: [number, number] = [1_763_500_000.0, 1_763_500_001.0];
  const scrubbed = scrubTimes(loads('{"last_at": 1763500000.5, "first_ms": 1763500000000, "next_at": 0, "open_at": false, "done_at": null, "count": 5, "later_at": 9999999999.0, "earlier_at": 1700000000}'), window);
  equal(dumps(scrubbed), dumps(loads('{"last_at": "<now float s>", "first_ms": "<now int ms>", "next_at": 0, "open_at": false, "done_at": null, "count": 5, "later_at": 9999999999.0, "earlier_at": 1700000000}')));
  const offset = (value: number, at: [number, number]) => dumps(scrubTimes(new Map([["next_at", new PyFloat(value)]]), at));
  if (offset(1_763_500_002.0, window) === offset(1_763_500_101.0, window)) throw new Error("deadlines a minute apart compare equal");
  equal(offset(1_763_500_061.2, window), offset(1_763_500_060.9, [1_763_499_999.8, 1_763_500_000.8]));
}, QUICK);

test("telemetry timestamps are checked against the run", () => {
  const window: [number, number] = [1_763_500_000.0, 1_763_500_001.0];
  equal(timeMarker(new PyFloat(isoTime("2025-11-18T21:06:40.500Z")!), window), "<now float s>");
  equal(dumps(timeMarker(new PyFloat(isoTime("2000-01-01T00:00:00.000Z")!), window)), "946684800.0");
}, QUICK);

test("comparisons keep JSON types", () => {
  const different = (left: string, right: string) => {
    if (canonical(loads(left)) === canonical(loads(right))) throw new Error(`${left} and ${right} compare equal`);
  };
  different('[[{"id": true, "method": "hello"}]]', '[[{"id": 1, "method": "hello"}]]');
  different('[{"id": 2, "method": "windows"}]', '[{"id": 2, "method": "windows", "params": "<absent>"}]');
  different('[{"id": 2, "method": "windows"}]', '[{"id": 2, "method": "windows", "extra": 1}]');
  different('{"usage": true}', '{"usage": 1}');
  different('{"n": 1.0}', '{"n": 1}');
  equal(canonical(loads('{"b": 1, "a": [1.5, -0.0, 1e16, 0.0001, 1e-05, 9000000000000.0, NaN]}')), '{"a": [1.5, -0.0, 1e+16, 0.0001, 1e-05, 9000000000000.0, NaN], "b": 1}');
  equal(dumps(loads('"caf\\u00e9 \\ud83d\\ude00 \\u007f"')), '"caf\\u00e9 \\ud83d\\ude00 \\u007f"');
  equal(dumps("é\u0001", { ensureAscii: false }), '"é\\u0001"');
  for (const bad of ["﻿{}", '{"a": 1} x', '"a\u0001"', "01", "[1,]", "{'a': 1}"]) expectThrows(() => loads(bad), PyJsonError);
}, QUICK);

test("normalizers read like Python's bytes patterns", () => {
  const run = (pattern: string, text: string) => new RegExp(translatePattern(pattern), "g").test(text);
  if (!run("^a.b$", "a\rb")) throw new Error(". must match a carriage return");
  if (run("^a\\sb$", "a b")) throw new Error("\\s must not match a no-break space byte");
  if (!run("x$", "x\n")) throw new Error("$ must match before a final newline");
  if (!run("(?P<n>q)(?P=n)", "qq")) throw new Error("named groups must translate");
}, QUICK);

test("fixtures are never written through a link", () => {
  const outside = scratch("arpout");
  const box = join(scratch("arpbox"), "c1");
  try {
    expectThrows(() => materialize(box, kase({ files: { "data/away": { link: outside }, "data/away/sub/file": "x" } }), "parity"), UnsafeCase);
    equal(readdirSync(outside), []);
  } finally {
    rmSync(outside, { recursive: true, force: true });
    rmSync(join(box, ".."), { recursive: true, force: true });
  }
}, QUICK);

test("a data dir through a fixture link is refused before the program runs", async () => {
  if (NO_PROGRAM) throw new Error(`build ardia-ts first (${programPath()})`);
  const install = new Install(programPath());
  const outside = scratch("arpout");
  try {
    let refused = false;
    try {
      await runSide(install, kase({ argv: ["config", "init", "--data-dir", "{data}/away"], files: { "data/away": { link: outside } } }), install.box());
    } catch (error) {
      refused = error instanceof UnsafeCase;
    }
    if (!refused) throw new Error("the case ran");
    equal(readdirSync(outside), []);
  } finally {
    install.close();
    rmSync(outside, { recursive: true, force: true });
  }
}, SLOW);

test("the addon comes from beside the chosen program", () => {
  if (NO_PROGRAM) throw new Error(`build ardia-ts first (${programPath()})`);
  const elsewhere = scratch("arpprog");
  try {
    copyFileSync(programPath(), join(elsewhere, "ardia-ts"));
    expectThrows(() => new Install(join(elsewhere, "ardia-ts")), Error, new RegExp(`${elsewhere}/ardia-libc\\.so`));
  } finally {
    rmSync(elsewhere, { recursive: true, force: true });
  }
}, SLOW);

test("a reply that cannot be written does not hide the next request", async () => {
  const folder = scratch("arpsock");
  const fake = new FakeArdia(join(folder, "s.sock"), DEFAULT_HELLO, fromJs({ windows: { result: ["x".repeat(65536)] } }) as Map<string, Py>, []);
  try {
    await new Promise<void>((resolve) => {
      const client = net.createConnection(join(folder, "s.sock"), () => {
        client.write('{"id":1,"method":"windows"}\n{"id":2,"method":"commands"}\n', () => {
          client.destroy();
          resolve();
        });
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
  } finally {
    await fake.close();
    rmSync(folder, { recursive: true, force: true });
  }
  equal(fake.requests.map(([method]) => method), ["windows", "commands"]);
  if (!fake.complete) throw new Error("the transcript was marked incomplete");
}, QUICK);

test("helpers log each argument whole", () => {
  const folder = scratch("arpstub");
  try {
    const log = join(folder, "log");
    writeStubForTest(folder, "tool", log);
    for (const argv of [["a b"], ["a", "b"], ["x\ny"], ["x\ry"], [""], []]) spawnSync(join(folder, "tool"), argv);
    const lines = readFileSync(log, "utf8").split("\n").filter(Boolean);
    equal(lines.length, 6);
    equal(new Set(lines).size, 6);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}, QUICK);

test("the sandbox keeps writes, sockets and helpers inside", () => {
  if (process.platform !== "darwin") return;
  if (NO_PROGRAM) throw new Error(`build ardia-ts first (${programPath()})`);
  const install = new Install(programPath());
  try {
    const box = install.box();
    mkdirSync(box);
    const outside = join(install.scratch, "outside-the-box");
    const script = `echo in > ${box}/in; echo out > ${outside}; /bin/launchctl list >/dev/null 2>&1 || echo launchctl-denied; /usr/bin/python3 -c 1 >/dev/null 2>&1 || echo python-denied`;
    const done = spawnSync(install.confined(["/bin/sh", "-c", script], box)[0]!, install.confined(["/bin/sh", "-c", script], box).slice(1), { encoding: "utf8", timeout: 30_000 });
    if (!existsSync(join(box, "in"))) throw new Error("a write inside the box was refused");
    if (existsSync(outside)) throw new Error("a write outside the box went through");
    if (!done.stdout.includes("launchctl-denied")) throw new Error("launchctl ran");
    if (!done.stdout.includes("python-denied")) throw new Error("python ran");
  } finally {
    install.close();
  }
}, SLOW);

test("detached children are reaped", async () => {
  const box = scratch("reap");
  try {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { env: { ARDIA_PARITY_BOX: box }, detached: true, stdio: "ignore" });
    const ended = new Promise<string | null>((resolve) => child.on("exit", (_, signal) => resolve(signal)));
    const deadline = Date.now() + 5000;
    if (process.platform === "darwin") {
      while (!spawnSync("/bin/ps", ["-x", "-E", "-ww", "-o", "command="]).stdout.toString().includes(box) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    reap(box);
    equal(await Promise.race([ended, new Promise((resolve) => setTimeout(() => resolve("still running"), 5000))]), "SIGKILL");
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
}, QUICK + 10_000);

test("a local telemetry copy counts as the run's only when it is dated inside the run", () => {
  const noon: [number, number] = [1795262400.0, 1795262401.0];
  const acrossMidnight: [number, number] = [1795305599.0, 1795305601.0];
  const today = `data/Telemetry/local/cli-${TODAY_MARK}.jsonl`;
  equal([...datedFiles(new Map([["data/Telemetry/local/cli-2026-11-21.jsonl", 1]]), noon).keys()], [today]);
  equal([...datedFiles(new Map([["data/Telemetry/local/cli-2026-99-99.jsonl", 1]]), noon).keys()], ["data/Telemetry/local/cli-2026-99-99.jsonl"]);
  for (const day of ["2026-11-21", "2026-11-22"]) equal([...datedFiles(new Map([[`data/Telemetry/local/cli-${day}.jsonl`, 1]]), acrossMidnight).keys()], [today]);
}, QUICK);

test("a case whose program cannot start fails alone", async () => {
  if (NO_PROGRAM) throw new Error(`build ardia-ts first (${programPath()})`);
  const fine = loadCases().filter((each) => each.id === "version--version");
  equal(fine.length, 1);
  const refused = caseFromRow(fromJs({ id: "t-refused", command: "windows", argv: ["windows", "--exec-refused"], expected: fine[0]!.row.get("expected") }), "test");
  const { outcomes } = await runCases([refused, ...fine], programPath(), {
    spawner: (argv, options) => {
      if (argv.includes("--exec-refused")) throw Object.assign(new Error("spawn E2BIG"), { code: "E2BIG" });
      return spawn(argv[0]!, argv.slice(1), { ...options, detached: true });
    },
  });
  if (!outcomes[0]!.problems.join(" ").includes("didn't start")) throw new Error(JSON.stringify(outcomes[0]));
  if (outcomes[1]!.problems.length || outcomes[1]!.mismatches.length) throw new Error(JSON.stringify(outcomes[1]));
}, SLOW);

test("a selection that matches no case is an error", () => {
  const done = spawnSync(process.execPath, [join(PARITY, "engine.ts"), "--out", join(scratch("arpsel"), "r.json"), "--only", "no-such-case"], { encoding: "utf8", timeout: 60_000 });
  equal(done.status, 2);
  if (!done.stderr.includes("no parity case")) throw new Error(done.stderr);
}, SLOW);

test("an expected body kept by digest is compared by digest", () => {
  const big = Buffer.alloc(20 * 1024, "p");
  const digest = createHash("sha256").update(big).digest("hex");
  const row = loads(`{"status": 0, "stdout": {"sha256": "${digest}", "size": ${big.length}}, "stderr": {"text": ""}, "files": {}, "helpers": [], "timed_out": false}`);
  const expected = decodeExpected(row as Map<string, Py>);
  const side = (stdout: Buffer): Comparable => ({ ...expected, stdout: { bytes: stdout }, requests: [], daemon_requests: [], telemetry: [], queued: [], usage: null, flush: null });
  equal(compare(side(big), expected, false).map(([field]) => field), []);
  const changed = Buffer.from(big);
  changed[100] = 0x71;
  equal(compare(side(changed), expected, false).map(([field]) => field), ["stdout"]);
}, QUICK);
