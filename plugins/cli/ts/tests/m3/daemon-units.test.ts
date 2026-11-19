import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Cancelled } from "../../src/browse/cdp/cancel.ts";
import { BadConfig, parseConfig } from "../../src/browse/daemon/config.ts";
import { FifoLock } from "../../src/browse/daemon/lock.ts";
import { cap, capNotice, encodeAnswer, joinedBatch, MAX_RESPONSE, render, Result, spillFolder } from "../../src/browse/daemon/render.ts";
import { BrowseError, ConnectionLost } from "../../src/browse/daemon-errors.ts";
import { browseDir, closeFd, sessionKey } from "../../src/browse/paths.ts";
import { Registry } from "../../src/browse/state/registry.ts";
import { seedTokens, tokenHex } from "../../src/browse/tokens.ts";
import { CLI_DIR, PYTHON, type Scratch, scratch } from "./daemon-helpers.ts";

setDefaultTimeout(60_000);
const made: Scratch[] = [];

afterAll(() => {
  for (const found of made.splice(0)) found.done();
});

function python(code: string, input: unknown, env: Record<string, string> = {}): unknown {
  const done = spawnSync(PYTHON, ["-I", "-c", `import sys, json; sys.path.insert(0, ${JSON.stringify(CLI_DIR)})\n${code}`], {
    input: JSON.stringify(input),
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (done.status !== 0) throw new Error(done.stderr);
  return JSON.parse(done.stdout);
}

describe("render", () => {
  const texts = ["short", "x".repeat(12001), `${"line\n".repeat(3000)}tail`, `${"é😀".repeat(7000)}`, `${"a\n".repeat(5000)}${"b".repeat(3000)}`];
  const optionSets = [{}, { full: true }, { max_output: 100 }, { max_output: 0 }];

  test("cap, its notice and the spill match Python's", () => {
    const found = scratch();
    made.push(found);
    const tmp = path.join(found.root, "tmp");
    fs.mkdirSync(tmp);
    const previous = process.env["TMPDIR"];
    process.env["TMPDIR"] = tmp;
    try {
      const cases = texts.flatMap((text) => optionSets.flatMap((options) => ["get", "script", "snapshot", "other"].map((name) => ({ text, options, name }))));
      const expected = python(
        "from ardia_cli.browse import daemon\ncases = json.load(sys.stdin)\nout = []\nfor c in cases:\n    t = daemon.cap(c['text'], c['options'], c['name'])\n    out.append([t, daemon.cap_notice(t)])\nprint(json.dumps(out))",
        cases,
        { TMPDIR: tmp },
      ) as [string, string][];
      const mask = (text: string) => text.replace(/output-[a-z0-9_]{8}\.txt/gu, "output-X.txt");
      cases.forEach((one, index) => {
        const got = cap(one.text, one.options, one.name);
        expect(mask(got)).toBe(mask((expected[index] as [string, string])[0]));
        expect(mask(capNotice(got))).toBe(mask((expected[index] as [string, string])[1]));
      });
      expect(spillFolder()).toBe(path.join(tmp, `ardia-browse-output-${process.getuid?.()}`));
      const saved = fs.readdirSync(spillFolder());
      expect(saved.length).toBe(40);
      expect(fs.statSync(spillFolder()).mode & 0o777).toBe(0o700);
    } finally {
      if (previous === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = previous;
    }
  });

  test("errors and results render as Python's do", () => {
    const cases = [
      { error: ["Gone", null, null, "plain"], options: {}, name: "get" },
      { error: ["Gone", { tabId: "t1" }, "tab_gone", "plain"], options: { json: true }, name: "get" },
      { error: ["Ardia closed the connection (Stop was pressed, control was turned off, or Ardia quit)", null, "connection_lost", "lost"], options: {}, name: "open" },
      { error: ["bell \u0007 in it", null, null, "plain"], options: {}, name: "wait" },
      { result: [{ title: "T\u0085x", n: 3, f: 1.5, l: [1, true, null] }, "T\u0085x", true], options: {}, name: "get" },
      { result: [{ title: "T\u0085x", n: 3, f: 1.5 }, "T", true], options: { json: true }, name: "get" },
      { result: [{ ms: 50, waited: "timeout" }, "✓ Done", false], options: {}, name: "wait" },
      { result: [{}, null, false], options: {}, name: "wait" },
    ];
    const expected = python(
      [
        "from ardia_cli.browse import daemon",
        "from ardia_cli.browse.commands import Result",
        "from ardia_cli.browse.errors import BrowseError, ConnectionLost",
        "out = []",
        "for c in json.load(sys.stdin):",
        "    if 'error' in c:",
        "        m, d, code, kind = c['error']",
        "        e = ConnectionLost() if kind == 'lost' else BrowseError(m, d, code)",
        "        out.append(daemon.render(c['options'], error=e, name=c['name']))",
        "    else:",
        "        data, text, page = c['result']",
        "        out.append(daemon.render(c['options'], result=Result(data, text, page), name=c['name']))",
        "print(json.dumps(out))",
      ].join("\n"),
      cases,
    ) as [number, string, string][];
    cases.forEach((one, index) => {
      let got;
      if (one.error) {
        const [message, data, code, kind] = one.error as [string, Record<string, unknown> | null, string | null, string];
        got = render(one.options, null, kind === "lost" ? new ConnectionLost() : new BrowseError(message, data, code), one.name);
      } else {
        const [data, text, page] = one.result as [unknown, string | null, boolean];
        got = render(one.options, new Result(data, text, page), null, one.name);
      }
      expect(got).toEqual(expected[index] as [number, string, string]);
    });
  });

  test("an answer over the limit becomes the too-large error, and the real limit is 256 MB", () => {
    expect(MAX_RESPONSE).toBe(256 * 1024 * 1024);
    const small = encodeAnswer(0, "x".repeat(500), "", [["daemon", "ts/1.2.3"]], 200);
    const parsed = JSON.parse(small.toString("utf8"));
    expect(parsed).toEqual({ exit: 1, out: "", err: expect.stringMatching(/^✗ The answer was too large \(5[0-9]{2} bytes, the limit is 200\); narrow it/u), daemon: "ts/1.2.3" });
    expect(encodeAnswer(0, "é", "", [], 200).toString("utf8")).toBe('{"exit": 0, "out": "é", "err": ""}\n');
  });

  test("a closing batch is joined as Python joins it", () => {
    expect(joinedBatch("a\n", "✓ closed\n", {})).toBe("a\n\n✓ closed\n");
    expect(joinedBatch("  \n", "✓ closed\n", {})).toBe("✓ closed\n");
    expect(joinedBatch('[{"command":["x"],"success":true}]\n', '{"success":true,"data":{"closed":true},"error":null}\n', { json: true })).toBe(
      '[{"command":["x"],"success":true},{"command":["close"],"success":true,"result":{"closed":true},"error":null}]\n',
    );
  });
});

describe("the command lock", () => {
  test("is first come, first served, and a timed-out waiter leaves the queue", async () => {
    const lock = new FifoLock();
    const order: string[] = [];
    expect(await lock.acquire()).toBe(true);
    const first = lock.acquire(5).then((got) => order.push(`a:${got}`));
    const quitter = lock.acquire(0.05).then((got) => order.push(`q:${got}`));
    const second = lock.acquire(5).then((got) => order.push(`b:${got}`));
    await quitter;
    lock.release();
    await first;
    lock.release();
    await second;
    lock.release();
    expect(order).toEqual(["q:false", "a:true", "b:true"]);
    expect(lock.locked).toBe(false);
  });

  test("a cancelled waiter leaves the queue and never holds the lock", async () => {
    const lock = new FifoLock();
    await lock.acquire();
    const stop = new AbortController();
    const waiting = lock.acquire(null, stop.signal).catch((error: unknown) => error);
    stop.abort();
    expect(await waiting).toBeInstanceOf(Cancelled);
    lock.release();
    expect(lock.locked).toBe(false);
  });
});

describe("files shared with Python", () => {
  test("session keys match", () => {
    const cases = [["", "port:9222", "default"], ["team", "ws:ws://127.0.0.1:1/devtools/browser/x", "s.1"], ["", "token:/tmp/é", "a"]];
    const expected = python("from ardia_cli.browse import paths\nprint(json.dumps([paths.session_key(*c) for c in json.load(sys.stdin)]))", cases);
    expect(cases.map(([a, b, c]) => sessionKey(a as string, b as string, c as string))).toEqual(expected as string[]);
  });

  test("seeded tokens match the harness's Python tokens", () => {
    seedTokens(1234);
    const ours = [tokenHex(8), tokenHex(14), tokenHex(4)];
    seedTokens(null);
    const expected = python("import random\nt = random.Random(1235)\nprint(json.dumps([t.randbytes(8).hex(), t.randbytes(14).hex(), t.randbytes(4).hex()]))", null);
    expect(ours).toEqual(expected as string[]);
  });

  test("the tab registry reads and writes the same file as Python's", () => {
    const found = scratch();
    made.push(found);
    const dir = browseDir(found.data);
    try {
      const registry = new Registry(dir, "a".repeat(24), "ts-side");
      const lock = fs.openSync(path.join(found.browse, `${"a".repeat(24)}.lock`), "w", 0o600);
      fs.closeSync(lock);
      const numbers = registry.numbers("inst", ["T1", "T2"]);
      registry.noteOpened("inst", "T1");
      registry.noteUsing("inst", "T2");
      expect([...numbers]).toEqual([["T1", "t1"], ["T2", "t2"]]);
      const fromPython = python(
        [
          "import os, fcntl",
          "from ardia_cli.browse import paths",
          "from ardia_cli.browse.tabs import Registry",
          "root = json.load(sys.stdin)",
          "fd = paths.browse_dir(__import__('pathlib').Path(root))",
          "held = paths.take_lock('" + "a".repeat(24) + ".lock', fd)",
          "r = Registry(fd, 'b' * 24, 'py-side')",
          "nums = r.numbers('inst', ['T2', 'T3'])",
          "opened, using = r.others('inst')",
          "print(json.dumps({'numbers': nums, 'opened': opened, 'using': using}))",
        ].join("\n"),
        found.data,
      ) as Record<string, unknown>;
      expect(fromPython).toEqual({ numbers: { T2: "t2", T3: "t3" }, opened: { T1: "ts-side" }, using: { T2: ["ts-side"] } });
      const file = fs.readdirSync(found.browse).find((name) => name.startsWith("tabs-")) as string;
      expect(file).toBe(Registry.fileFor("inst"));
      const text = fs.readFileSync(path.join(found.browse, file), "utf8");
      const parsed = JSON.parse(text);
      expect(Object.keys(parsed)).toEqual(["version", "instance", "next", "ids", "opened", "using", "closing"]);
      expect(parsed.next).toBe(4);
      expect(registry.numbers("inst", ["T3"]).get("T3")).toBe("t3");
    } finally {
      closeFd(dir);
    }
  });
});

describe("the spawn config", () => {
  const base = { session: "s", key: "0".repeat(24), data_root: "/tmp/x" };

  test("takes the fields Python's client writes", () => {
    const parsed = parseConfig(
      JSON.stringify({ ...base, namespace: "", ws: null, port: 9222, data_dir: null, endpoint_label: "--port 9222", idle_timeout_ms: 1500.5, debug: true, no_auto_dialog: false, pin_tab: null }),
    );
    expect(parsed).toMatchObject({ session: "s", port: 9222, idleTimeoutMs: 1500.5, debug: true, pinTab: false, harnessSeed: null });
  });

  test.each([
    [{ ...base, key: "../../etc" }, "key must be 24 lowercase hex digits"],
    [{ ...base, data_root: "relative" }, "data_root must be an absolute path"],
    [{ ...base, session: "a/b" }, "session must be 1 to 64 letters, digits, '.', '_' or '-'"],
    [{ ...base, port: 70000 }, "port must be a whole number from 1 to 65535"],
    [{ ...base, debug: "yes" }, "debug must be true or false"],
  ])("refuses %j", (config, message) => {
    expect(() => parseConfig(JSON.stringify(config))).toThrow(new BadConfig(message));
  });
});
