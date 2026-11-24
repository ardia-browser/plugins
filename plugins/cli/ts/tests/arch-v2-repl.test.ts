import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import "./libc-loaded.ts";
import { Runner, whenReady } from "../src/browse/script/host.ts";
import { declaredNames, replSource } from "../src/browse/script/repl.ts";
import { SPILL_CHARS } from "../src/browse/script/runner.ts";

setDefaultTimeout(30_000);

type Answer = { ok: boolean; text?: string; data?: unknown; error?: string; code?: string; call?: number };
type Turn = { result: Record<string, unknown>; requests: Record<string, unknown>[]; logs: string[]; state: string | null };
type Answerer = (request: Record<string, unknown>) => Answer;

const PLAIN: Answerer = (request) => {
  const argv = request["argv"] as string[] | undefined;
  if (argv?.[0] === "get" && argv[1] === "count") return { ok: true, text: "3", data: { count: 3 } };
  return { ok: true, text: "✓ done", data: { result: 7, url: "https://x.test/a", title: "T", text: "row", visible: true, value: "v" } };
};

async function session(): Promise<Runner> {
  const runner = new Runner();
  await whenReady(runner);
  return runner;
}

async function turn(runner: Runner, source: string, options: { repl?: boolean; spill?: number; state?: string; answer?: Answerer } = {}): Promise<Turn> {
  const answer = options.answer ?? PLAIN;
  const repl = options.repl ?? true;
  runner.send({ type: "start", source, state: options.state ?? "{}", readBatch: 100, stateLimit: 1 << 24, ...(repl ? { repl: true, spill: options.spill ?? 0 } : {}) });
  const requests: Record<string, unknown>[] = [];
  const logs: string[] = [];
  let state: string | null = null;
  for (;;) {
    const event = await runner.next();
    if (event.type === "request") {
      const request = JSON.parse(event.request) as Record<string, unknown>;
      requests.push(request);
      setTimeout(() => runner.send({ type: "reply", id: request["id"] as number, answer: JSON.stringify(answer(request)) }), 1);
    } else if (event.type === "log") logs.push(event.line);
    else if (event.type === "state") state = event.value;
    else if (event.type === "done") return { result: JSON.parse(event.result) as Record<string, unknown>, requests, logs, state };
    else if (event.type === "exit") throw new Error(`runner exited: ${JSON.stringify(event)}`);
  }
}

async function once(source: string, answer: Answerer = PLAIN): Promise<Turn> {
  const runner = await session();
  try {
    return await turn(runner, source, { repl: false, answer });
  } finally {
    runner.kill();
  }
}

const argvOf = (requests: Record<string, unknown>[]) => requests.map((request) => request["argv"]);

describe("repl source rewriting", () => {
  test("finds every top-level binding and nothing nested", () => {
    const source = `
      const a = 1, b = [2, 3];
      let { c, d: [e, ...f], ...g } = obj;
      var [h, , i = 4] = list
      function named(x) { const inner = 1; return x }
      async function later() {}
      function* gen() {}
      class Box extends Base {}
      const arrow = async (p) => { let hidden = p; return hidden };
      for (let loop = 0; loop < 2; loop++) { const nested = loop }
      if (a) { var blockVar = 1 }
      const text = \`\${"const fake = 1"} } {\`, re = /const notReal = 1/g;
      \x2F/ const commented = 1
      \x2F* let alsoCommented = 2 *\x2F
      const last = 3
      let = 5
      x = function notDeclared() {}
    `;
    expect(declaredNames(source).sort()).toEqual(["a", "arrow", "b", "Box", "c", "e", "f", "g", "gen", "h", "i", "last", "later", "named", "re", "text"].sort());
  });

  test("ends a declaration at a newline when ASI would", () => {
    expect(declaredNames("const a = 1\nfoo(b, c)\nconst d = 2")).toEqual(["a", "d"]);
    expect(declaredNames("const a = b\n  .map((x) => x)\n  .filter(Boolean)\nlet z")).toEqual(["a", "z"]);
  });

  test("keeps line numbers: the capture sits on line 1", () => {
    const wrapped = replSource("const a = 1;\nthrow new Error('x');");
    expect(wrapped.split("\n")).toHaveLength(3);
    expect(wrapped).toContain('__ardiaKept__["a"] = a');
  });

  test("auto-returns a trailing expression while keeping statements untouched", () => {
    expect(replSource("const h = 1; ({ h })")).toContain("return ({ h })");
    expect(replSource("const a = 1;\na + 2")).toContain("\nreturn a + 2");
    expect(replSource("const a = 1;\nreturn a;")).not.toContain("return return");
    expect(replSource("for (let i = 0; i < 3; i += 1) {}")).not.toContain("return for");
    expect(replSource("for (const c of /[{]/.source) {} 42")).toContain("return 42");
    expect(replSource("for await (const c of /[{]/.source) {} 42")).toContain("return 42");
    expect(replSource("const of = 8; const half = of / 2; half")).toContain("return half");
    expect(replSource("const of = 8; for (let i = of / 2; i < 1; i += 1) {} 42")).toContain("return 42");
  });
});

describe("persistent repl runner", () => {
  test("declarations, functions and classes survive across calls; redeclaring is fine", async () => {
    const runner = await session();
    try {
      const first = await turn(runner, `
        const a = 1;
        let list = [1];
        function double(x) { return x * 2 }
        class Box { constructor(v) { this.v = v } }
        var { c, d: [e] } = { c: 3, d: [4] };
        { const hidden = 1 }
        return a;
      `);
      expect(first.result).toMatchObject({ kind: "done", value: 1 });
      expect((first.result["kept"] as string[]).sort()).toEqual(["Box", "a", "c", "double", "e", "list"].sort());
      const second = await turn(runner, "list.push(2); return [a, list, double(5), new Box(9).v, c, e, typeof hidden];");
      expect(second.result["value"]).toEqual([1, [1, 2], 10, 9, 3, 4, "undefined"]);
      const third = await turn(runner, "const a = 10; a2 = a + 1; return a;");
      expect(third.result["value"]).toBe(10);
      const fourth = await turn(runner, "a = a + 5; return [a, a2];");
      expect(fourth.result["value"]).toEqual([15, 11]);
      const fifth = await turn(runner, "return a;");
      expect(fifth.result["value"]).toBe(15);
    } finally {
      runner.kill();
    }
  });

  test("a failing call keeps what it assigned before the throw and the runner stays usable", async () => {
    const runner = await session();
    try {
      const failed = await turn(runner, "const z = 9;\nthrow new Error('boom');");
      expect(failed.result).toMatchObject({ kind: "error", message: "boom", line: 2 });
      const syntax = await turn(runner, "const = ;");
      expect(syntax.result).toMatchObject({ kind: "error", code: "script_syntax" });
      const after = await turn(runner, "return z * 2;");
      expect(after.result["value"]).toBe(18);
    } finally {
      runner.kill();
    }
  });

  test("the script API and builtins can't be clobbered by a repl binding", async () => {
    const runner = await session();
    try {
      await turn(runner, "const page = 5; const JSON = 1; const state = 3; let mine = page; return mine;");
      const next = await turn(runner, "return [typeof page.click, typeof JSON.parse, typeof state, mine];");
      expect(next.result["value"]).toEqual(["function", "function", "object", 5]);
    } finally {
      runner.kill();
    }
  });

  test("state keeps its live object across calls unless another script changed it", async () => {
    const runner = await session();
    try {
      const first = await turn(runner, "state.rows = [1]; const keepRef = state.rows; return 1;", { state: "{}" });
      const synced = first.state as string;
      expect(JSON.parse(synced)).toEqual({ rows: [1] });
      const same = await turn(runner, "return keepRef === state.rows;", { state: synced });
      expect(same.result["value"]).toBe(true);
      const changed = await turn(runner, "return [keepRef === state.rows, state.rows];", { state: '{"rows": [7]}' });
      expect(changed.result["value"]).toEqual([false, [7]]);
    } finally {
      runner.kill();
    }
  });

  test("a large result spills to $outN with a preview, and the next call can filter it", async () => {
    const runner = await session();
    try {
      const big = await turn(runner, "return Array.from({ length: 2000 }, (_, i) => ({ i, name: 'row' + i }));", { spill: SPILL_CHARS });
      const shown = String(big.result["value"]);
      expect(big.result["spilled"]).toBe("$out1");
      expect(shown.length).toBeLessThan(2300);
      expect(shown).toContain('{"i":0,"name":"row0"}');
      expect(shown).toContain("[stored in $out1 (array, 2,000 items,");
      expect(shown).toContain("inspect or filter in next repl call]");
      const filtered = await turn(runner, "return [$out1.length, $out1.filter((r) => r.i < 2)];", { spill: SPILL_CHARS });
      expect(filtered.result["value"]).toEqual([2000, [{ i: 0, name: "row0" }, { i: 1, name: "row1" }]]);
      const object = await turn(runner, "return { blob: 'x'.repeat(9000), other: 1 };", { spill: SPILL_CHARS });
      expect(String(object.result["value"])).toContain("[stored in $out2 (object, 2 keys: blob, other;");
      const small = await turn(runner, "return 'x'.repeat(8000);", { spill: SPILL_CHARS });
      expect(small.result["spilled"]).toBeUndefined();
      const full = await turn(runner, "return 'y'.repeat(9000);", { spill: 0 });
      expect(String(full.result["value"])).toHaveLength(9000);
    } finally {
      runner.kill();
    }
  });

  test("logs past the limit spill to $outN as lines", async () => {
    const runner = await session();
    try {
      const noisy = await turn(runner, "for (let i = 0; i < 400; i++) log('line ' + i + ' ' + 'z'.repeat(40)); return 'ok';", { spill: SPILL_CHARS });
      const spilled = noisy.result["logSpill"] as Record<string, unknown>;
      expect(spilled).toMatchObject({ name: "$out1", lines: 400 });
      expect(String(spilled["preview"]).length).toBeLessThanOrEqual(2001);
      const read = await turn(runner, "return [$out1.length, $out1[399].startsWith('line 399')];", { spill: SPILL_CHARS });
      expect(read.result["value"]).toEqual([400, true]);
    } finally {
      runner.kill();
    }
  });

  test("closures and top-level variables stay synchronized across REPL turns, const stays immutable, and multiline binary continuations stay intact", async () => {
    const runner = await session();
    try {
      await turn(runner, "let n = 0, page = 0; const getN = () => n;");
      const second = await turn(runner, "n++; [n, getN()]");
      expect(second.result["value"]).toEqual([1, 1]);
      const third = await turn(runner, "let x = 1\nx\n+ 2");
      expect(third.result["value"]).toBe(3);
      const constErr = await turn(runner, "const k = 1; k = 2; k");
      expect(constErr.result["kind"]).toBe("error");
      expect(constErr.result["name"]).toBe("TypeError");
      const redeclare = await turn(runner, "const k = 5; k");
      expect(redeclare.result["value"]).toBe(5);
    } finally {
      runner.kill();
    }
  });

  test("user-thrown errors cannot forge internal error codes like usage", async () => {
    const runner = await session();
    try {
      const forged = await turn(runner, "const e = new Error('Unknown flag: --repl'); e.code = 'usage'; throw e;");
      expect(forged.result["kind"]).toBe("error");
      expect(forged.result["code"]).toBeNull();
    } finally {
      runner.kill();
    }
  });

  test("assertText does not reuse a receipt after refresh, tab switch, concurrent tab switch, or a new REPL turn", async () => {
    const runner = await session();
    try {
      const first = await turn(runner, "await page.click('#save', { receipt: true }); return await page.assertText('changes were saved');", { answer: RECEIPT });
      expect(first.result["value"]).toBe(true);
      const second = await turn(runner, "return await page.assertText('changes were saved');", { answer: RECEIPT });
      expect(second.result["kind"]).toBe("error");
      expect(second.result["code"]).toBe("assertion");
      const afterRefresh = await turn(runner, "await page.click('#save', { receipt: true }); await browse('refresh'); return await page.assertText('changes were saved');", { answer: RECEIPT });
      expect(afterRefresh.result["kind"]).toBe("error");
      expect(afterRefresh.result["code"]).toBe("assertion");
      const afterHere = await turn(runner, "await page.click('#save', { receipt: true }); await page.here(); return await page.assertText('changes were saved');", { answer: RECEIPT });
      expect(afterHere.result["kind"]).toBe("error");
      expect(afterHere.result["code"]).toBe("assertion");
      const removedOnly = await turn(runner, "await page.click('#dismiss', { receipt: true }); return await page.assertText('Success');", {
        answer: (request) => {
          const argv = request["argv"] as string[];
          if (argv[0] === "get" && argv[1] === "text") return { ok: true, text: "Gone", data: { text: "Gone" } };
          return {
            ok: true,
            text: '✓ Done\nchanges:\n- status "Success"',
            data: { changes: { added: [], removed: [{ role: "status", name: "Success" }], changed: [], text: { lines: [], more: false, where: null } } },
          };
        },
      });
      expect(removedOnly.result["kind"]).toBe("error");
      expect(removedOnly.result["code"]).toBe("assertion");
      const concurrent = await turn(runner, "await Promise.all([page.click('#save', { receipt: true }), useTab('t2')]); return await page.assertText('changes were saved');", { answer: RECEIPT });
      expect(concurrent.result["kind"]).toBe("error");
      expect(concurrent.result["code"]).toBe("assertion");
      const evalAnswer: Answerer = (request) => (request["op"] === "call" ? RECEIPT(request) : { ok: true, data: { result: null } });
      const afterEvaluate = await turn(runner, "await page.click('#save', { receipt: true }); await page.evaluate(() => null); return await page.assertText('changes were saved');", { answer: evalAnswer });
      expect(afterEvaluate.result["kind"]).toBe("error");
      expect(afterEvaluate.result["code"]).toBe("assertion");
      const afterDollarEval = await turn(runner, "await page.click('#save', { receipt: true }); await page.$eval('#save', (el) => el); return await page.assertText('changes were saved');", { answer: evalAnswer });
      expect(afterDollarEval.result["kind"]).toBe("error");
      expect(afterDollarEval.result["code"]).toBe("assertion");
      const afterFillForm = await turn(runner, "await page.click('#save', { receipt: true }); await page.fillForm({ '#name': 'Ada' }); return await page.assertText('changes were saved');", { answer: RECEIPT });
      expect(afterFillForm.result["kind"]).toBe("error");
      expect(afterFillForm.result["code"]).toBe("assertion");
      const afterBrowseFill = await turn(runner, "await page.click('#save', { receipt: true }); await browse('fill', '#name', 'Ada'); return await page.assertText('changes were saved');", { answer: RECEIPT });
      expect(afterBrowseFill.result["kind"]).toBe("error");
      expect(afterBrowseFill.result["code"]).toBe("assertion");
      const afterBrowseClick = await turn(runner, "await page.click('#save', { receipt: true }); await browse('click', '#other'); return await page.assertText('changes were saved');", { answer: RECEIPT });
      expect(afterBrowseClick.result["kind"]).toBe("error");
      expect(afterBrowseClick.result["code"]).toBe("assertion");
      const afterWait = await turn(runner, "await page.click('#save', { receipt: true }); await page.waitForURL('/done'); return await page.assertText('changes were saved');", { answer: RECEIPT });
      expect(afterWait.result["kind"]).toBe("error");
      expect(afterWait.result["code"]).toBe("assertion");
    } finally {
      runner.kill();
    }
  });

  test("locator regexes respect ASCII /i, anchors, and alternation, and reject unsupported syntax, flags, or Unicode /i", async () => {
    const { requests, result } = await once(`
      await page.getByRole('button', { name: /^save$/i }).click();
      await page.getByRole('button', { name: /save|cancel/i }).click();
      let rejected = null;
      let badFlag = null;
      let unicodeFold = null;
      try { page.getByRole('button', { name: /item \\d+/i }); } catch (e) { rejected = e.name; }
      try { page.getByText(/^save$/m); } catch (e) { badFlag = e.name; }
      try { page.getByRole('button', { name: /^σ$/iu }); } catch (e) { unicodeFold = e.name; }
      return [rejected, badFlag, unicodeFold];
    `);
    expect(result["value"]).toEqual(["TypeError", "TypeError", "TypeError"]);
    const selectors = (argvOf(requests) as string[][]).map((row) => row[1]);
    expect(selectors[0]).toContain('translate(normalize-space(@aria-label), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")="save"');
    expect(selectors[1]).toContain('contains(translate(normalize-space(@aria-label), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "save") or contains(translate(normalize-space(@aria-label), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "cancel")');
  });

  test("a non-repl runner still takes exactly one script", async () => {
    const runner = await session();
    try {
      const first = await turn(runner, "const a = 1; return a;", { repl: false });
      expect(first.result["value"]).toBe(1);
      expect(first.result["kept"]).toBeUndefined();
      runner.send({ type: "start", source: "return 2", state: "{}", readBatch: 100, stateLimit: 1 << 24, repl: true });
      const next = await Promise.race([runner.next(), new Promise((resolve) => setTimeout(() => resolve("silent"), 500))]);
      expect(next).toBe("silent");
    } finally {
      runner.kill();
    }
  });
});

describe("locators compile to ardia selectors", () => {
  test("page.locator chains nth, first, last, locator and filter", async () => {
    const { requests, result } = await once(`
      await page.locator('.row').first().click();
      await page.locator('form').locator('input').nth(2).fill('v');
      await page.locator('li').last().hover();
      const n = await page.locator('li').filter({ hasText: 'Apple' }).count();
      await page.locator('a, button').filter({ hasText: 'Go', exact: true }).click();
      await page.locator('role=button').filter({ hasText: 'Save' }).click();
      await page.locator('article', { has: 'h4' }).first().click();
      await page.locator('#x').press('Enter');
      return [n, String(page.locator('p').nth(-1)), page.locator('p').selector];
    `);
    expect(result["value"]).toEqual([3, "p >> nth=-1", "p"]);
    expect(argvOf(requests)).toEqual([
      ["click", ".row >> nth=0"],
      ["fill", "form >> input >> nth=2", "v"],
      ["hover", "li >> nth=-1"],
      ["get", "count", 'li:has-text("Apple")'],
      ["click", ':is(a, button):text-is("Go")'],
      ["click", 'role=button >> xpath=self::*[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "save")]'],
      ["click", "article:has(h4) >> nth=0"],
      ["press", "#x", "Enter"],
    ]);
  });

  test("getBy* locators read and act", async () => {
    const { requests } = await once(`
      await page.getByRole('button', { name: 'Save' }).click();
      await page.getByRole('link', { within: page.locator('nav'), nth: 1 }).click();
      await page.getByText('Hello', { exact: true }).text();
      await page.getByText('Hello').innerText();
      await page.getByPlaceholder('Search').fill('x');
      await page.getByTestId('go').click();
      await page.locator('main').getByRole('heading').count();
    `);
    expect(argvOf(requests)).toEqual([
      ["click", 'role=button[name="Save"]'],
      ["click", "nav >> role=link >> nth=1"],
      ["get", "text", 'text="Hello"'],
      ["get", "text", "text=Hello"],
      ["fill", '[placeholder*="Search" i]', "x"],
      ["click", '[data-testid="go"]'],
      ["get", "count", "main >> role=heading"],
    ]);
  });

  test("getByRole exact and getByLabel use XPath tests", async () => {
    const { requests } = await once(`
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByLabel('Email').fill('a@b.test');
    `);
    const [exact, label] = argvOf(requests) as string[][];
    expect(exact?.[1]).toStartWith("role=button >> xpath=self::*[normalize-space(@aria-label)=\"Save\" or normalize-space(.)=\"Save\"");
    expect(label?.[0]).toBe("fill");
    expect(label?.[1]).toStartWith("xpath=.//*[self::input or self::textarea or self::select");
    expect(label?.[1]).toContain('//label[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "email")]/@for');
  });

  test("isVisible on a missing element is false, not an error", async () => {
    const { result } = await once("return [await page.locator('#gone').isVisible(), await page.locator('#gone').isHidden()];", (request) => {
      const argv = request["argv"] as string[];
      if (argv[0] === "is") return { ok: false, error: "Element not found: #gone", code: "not_found" };
      return PLAIN(request);
    });
    expect(result["value"]).toEqual([false, true]);
  });

  test("a missing page method no longer claims there are no locators", async () => {
    const { result } = await once("await page.route('**', () => {});");
    expect(result).toMatchObject({ kind: "error", code: "usage" });
    expect(String(result["message"])).not.toContain("no element handles or locators");
    expect(String(result["message"])).toContain("locator");
  });
});

const RECEIPT: Answerer = (request) => {
  const argv = request["argv"] as string[];
  if (argv[0] === "get" && argv[1] === "text") return { ok: true, text: "Welcome home", data: { text: "Welcome home" } };
  if (argv[0] === "click" || argv[0] === "fill") {
    return {
      ok: true,
      text: "✓ Done\nchanges:\nurl: https://x.test/a → https://x.test/b\n+ status \"Saved!\"",
      data: {
        changes: {
          document: "same",
          url: { from: "https://x.test/a", to: "https://x.test/b" },
          title: null,
          added: [{ ref: "e9", level: 1, role: "status", name: "Saved!" }],
          removed: [],
          changed: [{ ref: "e3", from: { role: "button", name: "Save" }, to: { role: "button", name: "Saving" } }],
          network: [{ method: "POST", status: 200 }],
          text: { lines: ["Your changes were saved"], more: false, where: null },
          dialogs: [{ type: "alert", message: "hi" }],
        },
      },
    };
  }
  return PLAIN(request);
};

describe("structured receipts and assertions", () => {
  test("{ receipt: true } and page.act return a receipt; plain calls still return text", async () => {
    const { result, requests } = await once(`
      const plain = await page.click('#save');
      const r = await page.click('#save', { receipt: true });
      const viaAct = await page.act.fill('#name', 'Ada');
      const viaCall = await page.act('click', '#save');
      const fromLocator = await page.locator('#save').click({ receipt: true });
      return {
        plain,
        ok: r.ok,
        url: r.url,
        navigated: r.navigated,
        changedText: r.changedText,
        dialog: r.dialog,
        network: r.network.length,
        includes: r.includes('Saved!'),
        asText: String(r).startsWith('✓ Done'),
        last: page.lastReceipt === fromLocator,
        actReceipt: viaAct.added[0].name,
        callReceipt: viaCall.url,
      };
    `, RECEIPT);
    expect(result["value"]).toEqual({
      plain: "✓ Done\nchanges:\nurl: https://x.test/a → https://x.test/b\n+ status \"Saved!\"",
      ok: true,
      url: "https://x.test/b",
      navigated: true,
      changedText: "Your changes were saved\nstatus Saved!\nbutton Saving",
      dialog: { type: "alert", message: "hi" },
      network: 1,
      includes: true,
      asText: true,
      last: true,
      actReceipt: "Saved!",
      callReceipt: "https://x.test/b",
    });
    expect(requests.map((request) => [request["argv"], request["light"] ?? false, request["receipt"] ?? false])).toEqual([
      [["click", "#save"], true, false],
      [["click", "#save"], true, true],
      [["fill", "#name", "Ada"], true, true],
      [["click", "#save"], true, true],
      [["click", "#save"], true, true],
    ]);
  });

  test("parseReceipt reads the text form when there is no data", async () => {
    const { result } = await once("const r = parseReceipt('✓ Done\\nchanges:\\n+ heading \"Thanks\"', null); return [r.changedText, r.added.length, r.url, r, { ...r }.ok];");
    expect(result["value"]).toEqual(['+ heading "Thanks"', 0, null, '✓ Done\nchanges:\n+ heading "Thanks"', true]);
  });

  test("assertText passes from the receipt with no extra call, else reads the page, else throws", async () => {
    const { result, requests } = await once(`
      await page.click('#save', { receipt: true });
      const fromReceipt = await page.assertText('changes were saved');
      const fromPage = await page.assertText('welcome HOME', { ignoreCase: true });
      let failure = null;
      try { await page.assertText('Order placed'); } catch (e) { failure = [e.name, e.code, e.message]; }
      await page.click('#save');
      return [fromReceipt, fromPage, failure, page.lastReceipt];
    `, RECEIPT);
    const [fromReceipt, fromPage, failure, last] = result["value"] as unknown[];
    expect([fromReceipt, fromPage, last]).toEqual([true, true, null]);
    expect((failure as string[])[0]).toBe("AssertionError");
    expect((failure as string[])[1]).toBe("assertion");
    expect((failure as string[])[2]).toContain('expected "Order placed" on the page');
    expect((failure as string[])[2]).toContain("Welcome home");
    expect(argvOf(requests)).toEqual([["click", "#save"], ["get", "text", "body"], ["get", "text", "body"], ["click", "#save"]]);
  });
});

describe("page and tab helpers", () => {
  test("read, form, query and screenshot wrap their commands", async () => {
    const { requests, result } = await once(`
      const text = await page.read({ selector: 'main', full: true });
      const outline = await page.read({ outline: true, filter: 'price' });
      const form = await page.form({ selector: '#signup' });
      const rows = await page.query('tr', { fields: { name: 'td.name', link: 'a@href' }, limit: 5 });
      const shot = await page.screenshot({ fullPage: true, path: 'a.png' });
      return [text, outline, form.text, Array.isArray(form.fields), rows, shot.result];
    `);
    expect(argvOf(requests)).toEqual([
      ["read", "-s", "main"],
      ["read", "--outline", "--filter", "price"],
      ["form", "-s", "#signup"],
      ["query", "tr", "--fields", "name=td.name,link=a@href", "--limit", "5"],
      ["screenshot", "--full", "--out", "a.png"],
    ]);
    expect(requests[0]?.["options"]).toEqual({ full: true });
    expect(requests[1]?.["options"]).toBeUndefined();
    expect(result["value"]).toEqual(["✓ done", "✓ done", "✓ done", true, [], 7]);
  });

  test("openTab, listTabs, useTab, closeTab and readUrls", async () => {
    const { requests, result } = await once(`
      const opened = await openTab('https://x.test/new');
      await openTab();
      const tabs = await listTabs();
      await useTab({ tabId: 't2' });
      await closeTab('t2');
      await closeTab();
      const pages = await readUrls(['https://a.test', 'https://b.test'], { selector: 'main', maxChars: 500 });
      return [opened.url, tabs, pages];
    `, (request) => {
      const argv = request["argv"] as string[];
      if (argv[0] === "tab" && argv[1] === "list") return { ok: true, text: "", data: { tabs: [{ tabId: "t1" }] } };
      if (argv[0] === "read-urls") return { ok: true, text: "", data: { results: [{ url: "https://a.test" }] } };
      return PLAIN(request);
    });
    expect(argvOf(requests)).toEqual([
      ["tab", "new", "https://x.test/new"],
      ["tab", "new"],
      ["tab", "list"],
      ["tab", "t2"],
      ["tab", "close", "t2"],
      ["tab", "close"],
      ["read-urls", "https://a.test", "https://b.test", "-s", "main", "--max-chars", "500"],
    ]);
    expect(result["value"]).toEqual(["https://x.test/a", [{ tabId: "t1" }], [{ url: "https://a.test" }]]);
  });

  test("page.fetch runs fetch in the page with the tab's cookies and parses JSON", async () => {
    const { requests, result } = await once(`
      const got = await page.fetch('/api/items?x=1', { method: 'post', body: { a: 1 } });
      const html = await page.fetch('https://x.test/page');
      return [got.ok, got.status, got.json, html.json, html.text];
    `, (request) => {
      if (request["op"] === "evaluate") {
        const args = request["args"] as unknown[];
        const json = String(args[0]).includes("/api/");
        return { ok: true, data: { result: { ok: true, status: 201, url: String(args[0]), contentType: json ? "application/json; charset=utf-8" : "text/html", text: json ? '{"items":[1,2]}' : "<p>hi</p>", truncated: false, bytes: 9, headers: {} } } };
      }
      return PLAIN(request);
    });
    expect(result["value"]).toEqual([true, 201, { items: [1, 2] }, null, "<p>hi</p>"]);
    const evaluate = requests.find((request) => request["op"] === "evaluate") as Record<string, unknown>;
    const [target, init, limit] = evaluate["args"] as [string, Record<string, unknown>, number];
    expect(target).toBe("https://x.test/api/items?x=1");
    expect(init).toEqual({ method: "POST", headers: { "content-type": "application/json" }, credentials: "include", redirect: "follow", body: '{"a":1}' });
    expect(limit).toBe(2 * 1024 * 1024);
    expect(String(evaluate["fn"])).toContain("getReader");
  });
});

const CHROME = process.env["ARDIA_M3_CHROME"];
const PROGRAM = process.env["ARDIA_M3_TS_PROGRAM"];
const PORT = Number(process.env["ARDIA_M3_PORT_BASE"] ?? "9400") + 41;
const PAGE = `<!doctype html><title>Shop</title>
<nav><a href="#a">Home</a><a href="#b">Cart</a></nav>
<main>
  <ul><li>Apple</li><li>Banana</li><li>Cherry</li></ul>
  <label for="email">Email</label><input id="email" placeholder="you@example.com">
  <label>Name <input id="name"></label>
  <button data-testid="save" onclick="document.querySelector('#out').textContent = 'Saved ' + document.querySelector('#name').value">Save</button>
  <p id="out"></p>
</main>`;

describe.skipIf(!CHROME || !PROGRAM)("repl, locators and receipts against headless Chrome", () => {
  let root = "";
  let chrome: ChildProcess | null = null;
  let server: http.Server | null = null;
  let origin = "";

  const browse = async (args: string[], input?: string) => {
    const env = { ...process.env, HOME: path.join(root, "home"), ARDIA_DATA_DIR: path.join(root, "data"), ARDIA_TELEMETRY: "off" };
    const child = Bun.spawn([PROGRAM as string, "browse", "--port", String(PORT), "--session", "replv2", ...args], {
      env,
      cwd: root,
      stdin: input === undefined ? "ignore" : new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 45_000,
    });
    const [out, err, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { out, err, status };
  };
  const repl = (source: string, ...flags: string[]) => browse(["script", "--repl", ...flags], source);
  const ready = () =>
    new Promise<boolean>((resolve) => {
      const request = http.get({ host: "127.0.0.1", port: PORT, path: "/json/version", timeout: 500, agent: false }, (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      });
      request.on("error", () => resolve(false));
      request.on("timeout", () => request.destroy());
    });

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ardia-repl-live-"));
    fs.mkdirSync(path.join(root, "home"));
    fs.mkdirSync(path.join(root, "data"), { mode: 0o700 });
    server = http.createServer((request, response) => {
      const json = request.url?.startsWith("/api") ?? false;
      response.writeHead(200, { "content-type": json ? "application/json" : "text/html" });
      response.end(json ? JSON.stringify({ items: [1, 2, 3], cookie: request.headers.cookie ?? null }) : PAGE);
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    chrome = spawn(CHROME as string, ["--headless", "--no-first-run", `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(root, "profile")}`, "about:blank"], { stdio: "ignore", detached: true });
    const deadline = performance.now() + 30_000;
    while (performance.now() < deadline && !(await ready())) await new Promise((resolve) => setTimeout(resolve, 100));
    const opened = await browse(["open", `${origin}/`]);
    expect(opened.status).toBe(0);
  }, 60_000);

  afterAll(async () => {
    if (root) await browse(["close"]);
    if (chrome?.pid) {
      try {
        process.kill(-chrome.pid, "SIGKILL");
      } catch {}
    }
    server?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  test("variables persist across --repl calls and --reset clears them", async () => {
    const value = (ran: { out: string }) => JSON.parse(ran.out).data.value;
    const first = await repl("const fruits = await page.locator('li').allTexts();\nfunction shout(s) { return s.toUpperCase() }\nreturn fruits.length;", "--json");
    expect(first.status).toBe(0);
    expect(value(first)).toBe(3);
    expect(JSON.parse(first.out).data.repl.kept.sort()).toEqual(["fruits", "shout"]);
    const second = await repl("return fruits.map(shout).join(',');", "--json");
    expect(value(second)).toBe("APPLE,BANANA,CHERRY");
    const plain = await browse(["script", "--json"], "return typeof fruits;");
    expect(value(plain)).toBe("undefined");
    const reset = await browse(["script", "--reset"]);
    expect(reset.out).toContain("REPL scope reset");
    const after = await repl("return typeof fruits;", "--json");
    expect(value(after)).toBe("undefined");
  });

  test("locators find real elements", async () => {
    const done = await repl(`
      return [
        await page.locator('li').filter({ hasText: 'ban' }).text(),
        await page.locator('li').nth(-1).text(),
        await page.getByRole('link', { name: 'Cart' }).getAttribute('href'),
        await page.getByRole('button', { name: 'Save', exact: true }).count(),
        await page.getByLabel('Email').getAttribute('id'),
        await page.getByLabel('Name').getAttribute('id'),
        await page.getByPlaceholder('example.com').getAttribute('id'),
        await page.getByText('Cherry', { exact: true }).count(),
        await page.getByTestId('save').text(),
        await page.locator('nav').getByRole('link').count(),
        await page.locator('#nope').isVisible(),
      ];
    `, "--json");
    expect(done.err).toBe("");
    expect(JSON.parse(done.out).data.value).toEqual(["Banana", "Cherry", "#b", 1, "email", "name", "email", 1, "Save", 2, false]);
  });

  test("a receipt lets the script check its own action, and page.fetch uses the tab", async () => {
    const done = await repl(`
      await page.getByLabel('Name').fill('Ada');
      const r = await page.getByTestId('save').click({ receipt: true });
      await page.assertText('Saved Ada');
      const api = await page.fetch('/api/items');
      return [r.ok, typeof r.changedText, api.status, api.json.items];
    `, "--json");
    expect(done.status).toBe(0);
    expect(JSON.parse(done.out).data.value).toEqual([true, "string", 200, [1, 2, 3]]);
  });

  test("a big result spills to $out1 and the next call reads it", async () => {
    const big = await repl("return Array.from({ length: 3000 }, (_, i) => ({ i }));");
    expect(big.out).toMatch(/\[stored in \$out\d+ \(array, 3,000 items/u);
    const name = /\[stored in (\$out\d+)/u.exec(big.out)?.[1] as string;
    const next = await repl(`return ${name}.filter((row) => row.i % 1000 === 0).map((row) => row.i);`, "--json");
    expect(JSON.parse(next.out).data.value).toEqual([0, 1000, 2000]);
    const full = await browse(["--full", "script", "--repl"], "return Array.from({ length: 3000 }, (_, i) => ({ i }));");
    expect(full.out).not.toContain("[stored in");
  });
});
