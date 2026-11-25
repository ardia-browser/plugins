import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import "./libc-loaded.ts";
import { SYNTHETIC_DROP, syntheticDrop } from "../src/browse/act/drag.ts";
import { editCell } from "../src/browse/act/fields.ts";
import { HOVER_MARK, HOVER_REVEALED, hoverResult, revealedLines } from "../src/browse/act/reveal.ts";
import { OTP_BOXES, otpCode } from "../src/browse/commands/interact.ts";
import { dragText } from "../src/browse/commands/act.ts";
import { OWNERS } from "../src/browse/commands/index.ts";
import { compileEvents, type RecEvent, TOGGLE_ROLES } from "../src/browse/flows/compile.ts";
import { Runner, whenReady } from "../src/browse/script/host.ts";
import { BrowseError } from "../src/browse/daemon-errors.ts";
import { Element, type Page } from "../src/browse/state/page.ts";
import { MUTATING } from "../src/browse/daemon/names.ts";

setDefaultTimeout(30_000);

type Answer = { ok: boolean; text?: string; data?: unknown; error?: string; code?: string };

async function once(source: string, answer: (request: Record<string, unknown>) => Answer = () => ({ ok: true, text: "✓ Done", data: {} })) {
  const runner = new Runner();
  await whenReady(runner);
  try {
    runner.send({ type: "start", source, state: "{}", readBatch: 100, stateLimit: 1 << 24 });
    const requests: Record<string, unknown>[] = [];
    const logs: string[] = [];
    for (;;) {
      const event = await runner.next();
      if (event.type === "request") {
        const request = JSON.parse(event.request) as Record<string, unknown>;
        requests.push(request);
        setTimeout(() => runner.send({ type: "reply", id: request["id"] as number, answer: JSON.stringify(answer(request)) }), 1);
      } else if (event.type === "log") logs.push(event.line);
      else if (event.type === "done") return { result: JSON.parse(event.result) as Record<string, unknown>, requests, logs };
      else if (event.type === "exit") throw new Error(`runner exited: ${JSON.stringify(event)}`);
    }
  } finally {
    runner.kill();
  }
}

const argvs = (requests: Record<string, unknown>[]) => requests.map((request) => request["argv"] ?? request["op"]);

describe("script API for hard widgets", () => {
  test("page.drag takes selectors, refs or locators, and passes the side", async () => {
    const { requests } = await once("await page.drag(page.locator('.card'), '@f1e3', { after: true }); await page.locator('#a').dragTo('#b', { synthetic: true });");
    expect(argvs(requests)).toEqual([["drag", ".card", "@f1e3", "--after"], ["drag", "#a", "#b", "--synthetic"]]);
  });

  test("page.editCell and locator.editCell edit a cell in one call", async () => {
    const { requests } = await once("await page.editCell('@e5', 42, { commit: 'tab' }); await page.getByRole('gridcell', { name: 'Qty' }).editCell('3');");
    expect(argvs(requests)).toEqual([["edit-cell", "@e5", "42", "--commit", "tab"], ["edit-cell", 'role=gridcell[name="Qty"]', "3"]]);
  });

  test("page.totp feeds page.fillOtp, which then masks the code", async () => {
    const { requests, result } = await once("const code = await page.totp('acme'); await page.fillOtp(code); await page.fillOtp('123456'); return code.length;", (request) =>
      request["op"] === "totp" ? { ok: true, text: "", data: { code: "654321", remaining: 20 } } : { ok: true, text: "✓ Filled", data: {} });
    expect(requests[0]).toMatchObject({ op: "totp", name: "acme" });
    expect(argvs(requests).slice(1)).toEqual([["fill-otp", "654321", "--sensitive"], ["fill-otp", "123456"]]);
    expect(result["value"]).toBe(6);
  });

  test("page.totp refuses a missing profile name before asking", async () => {
    const { result, requests } = await once("await page.totp('');");
    expect(result["kind"]).toBe("error");
    expect(requests).toEqual([]);
  });

  test("a hover receipt carries what the hover revealed", async () => {
    const revealed = [{ ref: "e12", role: "menuitem", name: "Rename" }];
    const { result, requests } = await once("const r = await page.hover('@f1e2', { receipt: true, within: 'Toolbar' }); return r.revealed;", () => ({ ok: true, text: "✓ Done\nrevealed:\n  @e12 menuitem \"Rename\"", data: { hovered: "@f1e2", revealed } }));
    expect(argvs(requests)).toEqual([["hover", "@f1e2", "--within", "Toolbar"]]);
    expect(result["value"]).toEqual(revealed);
  });

  test("frame refs pass straight through every action", async () => {
    const { requests } = await once("await page.click('@f1e3'); await page.fill('@f2e4', 'x'); await page.locator('@f1e5').hover(); await page.select('@f1e6', 'b');");
    expect(argvs(requests)).toEqual([["click", "@f1e3"], ["fill", "@f2e4", "x"], ["hover", "@f1e5"], ["select", "@f1e6", "b"]]);
  });
});

describe("commands and helpers", () => {
  test("the new commands are registered and change the page", () => {
    for (const name of ["fill-otp", "edit-cell"]) {
      expect(Object.hasOwn(OWNERS, name)).toBe(true);
      expect(MUTATING.has(name)).toBe(true);
    }
    expect(Object.hasOwn(OWNERS, "handoff")).toBe(false);
  });

  test("one-time codes take 4 to 8 letters or digits, spaces and dashes dropped", () => {
    expect(otpCode("123 456")).toBe("123456");
    expect(otpCode("AB-12")).toBe("AB12");
    for (const bad of ["123", "123456789", "12 3!"]) expect(() => otpCode(bad)).toThrow("4 to 8 letters or digits");
  });

  test("hover results list revealed items with refs, and stay plain when nothing appeared", () => {
    expect(hoverResult("@e1", []).data).toEqual({ hovered: "@e1" });
    const shown = hoverResult("@e1", [{ ref: "f1e9", role: "menuitem", name: "Delete" }]);
    expect(shown.text).toBe('✓ Done\nrevealed:\n  @f1e9 menuitem "Delete"');
    expect(shown.pageContent).toBe(true);
    expect(revealedLines([])).toEqual([]);
  });

  test("drag text says when the drop went through page drag events", () => {
    expect(dragText({ html5: true, synthetic: true, started: true, dropped: true })).toBe("✓ Done (HTML5 drag and drop, sent as page drag events)");
    expect(dragText({ html5: true, interception: false, synthetic: true, dropped: false })).toContain("didn't accept the drop");
  });

  test("the page drag events run in the source frame with both ends", async () => {
    const calls: [string, unknown[], Record<string, unknown>][] = [];
    const page = { call: async (fn: string, args: unknown[], options: Record<string, unknown>) => (calls.push([fn, args, options]), { started: true, accepted: true, dropped: true }) } as unknown as Page;
    const [source, target] = [new Element("F", "S", 1, "@e1"), new Element("F", "T", 2, "@e2")];
    expect(await syntheticDrop(page, source, target, "before")).toEqual({ synthetic: true, started: true, dropped: true, accepted: true });
    expect(calls[0]?.[0]).toBe(SYNTHETIC_DROP);
    expect(calls[0]?.[1]).toEqual([source, target, "before"]);
    expect(calls[0]?.[2]).toMatchObject({ frame: "F" });
    await expect(syntheticDrop(page, source, new Element("G", "T", 2, "@f1e2"), null)).rejects.toBeInstanceOf(BrowseError);
  });

  test("edit-cell on something that isn't a cell says so", async () => {
    const page = { call: async () => null } as unknown as Page;
    const error = (await editCell(page, new Element("F", "X", 3, "#name"), "1", false).catch((caught: unknown) => caught)) as BrowseError;
    expect(error.code).toBe("not_a_cell");
  });
});

describe("flow record keeps the toggle state, ranked selectors and role/name", () => {
  test("ARIA checkboxes and switches become check/uncheck with desired_state", () => {
    expect([...TOGGLE_ROLES].sort()).toEqual(["checkbox", "menuitemcheckbox", "menuitemradio", "radio", "switch"]);
    const events: RecEvent[] = [
      { kind: "click", at: 1, target: { tag: "div", role: "checkbox", name: "Remember me", ariaLabel: "Remember me", css: "#remember", xpath: "//div[1]" }, checked: true },
      { kind: "click", at: 2, target: { tag: "button", role: "switch", name: "Dark mode", testId: "dark", css: "button.toggle" }, checked: false },
      { kind: "click", at: 3, target: { tag: "input", type: "checkbox", role: "checkbox", name: "Terms", fieldName: "terms" }, checked: true },
    ];
    const compiled = compileEvents(events, "https://app.example.com/settings");
    const actions = compiled.steps.map((step) => step.action).filter((action) => action.type !== "open");
    expect(actions.map((action) => [action.type, action.desired_state])).toEqual([["check", true], ["uncheck", false], ["check", true]]);
    expect(actions[0]?.candidates.map((candidate) => candidate.by)).toEqual(["aria-label", "css", "xpath"]);
    expect(actions[1]?.candidates[0]).toEqual({ by: "testid", value: "dark" });
    expect(actions[0]?.fingerprint).toEqual({ role: "checkbox", name: "Remember me" });
    expect(compiled.steps.find((step) => step.action.type === "uncheck")?.command[0]).toBe("uncheck");
  });
});

const HEADLESS = [
  process.env["ARDIA_M3_CHROME"],
  path.join(os.homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-mac-arm64/chrome-headless-shell"),
].find((candidate): candidate is string => typeof candidate === "string" && candidate !== "" && fs.existsSync(candidate));

const FIXTURE = `<!doctype html><meta charset="utf-8"><title>Widgets</title>
<ul id="board"><li id="card" draggable="true">Card</li></ul>
<div id="lane" style="height:80px;width:200px">Lane</div>
<div id="otp"><input maxlength="1"><input maxlength="1"><input maxlength="1"><input maxlength="1"><input maxlength="1"><input maxlength="1"></div>
<form id="single"><input id="one" autocomplete="one-time-code"></form>
<button id="more">More</button>
<div id="menu" role="menu" style="display:none"><div role="menuitem">Rename</div><div role="menuitem">Delete</div></div>
<div class="tooltip" style="display:none" id="tip">Saved 2 min ago</div>
<script>
const lane = document.getElementById("lane");
window.dropped = [];
lane.addEventListener("dragover", (event) => event.preventDefault());
lane.addEventListener("drop", (event) => { event.preventDefault(); window.dropped.push(event.dataTransfer.getData("text/plain")); });
document.getElementById("card").addEventListener("dragstart", (event) => event.dataTransfer.setData("text/plain", "card-1"));
</script>`;

describe.skipIf(HEADLESS === undefined)("page scripts in a real Chromium", () => {
  let chrome: ChildProcess | null = null;
  let socket: WebSocket | null = null;
  let next = 1;
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arch-v3-interact-"));

  function send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = next;
    next += 1;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      (socket as WebSocket).send(JSON.stringify({ id, method, params }));
    });
  }

  async function run(source: string): Promise<unknown> {
    const answer = await send("Runtime.evaluate", { expression: source, returnByValue: true, awaitPromise: true });
    const result = answer["result"] as Record<string, unknown>;
    if (result["exceptionDetails"]) throw new Error(JSON.stringify(result["exceptionDetails"]));
    return (result["result"] as Record<string, unknown> | undefined)?.["value"];
  }

  beforeAll(async () => {
    fs.writeFileSync(path.join(dir, "page.html"), FIXTURE);
    chrome = spawn(HEADLESS as string, ["--headless", "--remote-debugging-port=0", `--user-data-dir=${path.join(dir, "profile")}`, "--no-first-run", `file://${path.join(dir, "page.html")}`], { stdio: ["ignore", "ignore", "pipe"] });
    const endpoint = await new Promise<string>((resolve, reject) => {
      let seen = "";
      const timer = setTimeout(() => reject(new Error(`no DevTools endpoint: ${seen}`)), 20_000);
      chrome?.stderr?.on("data", (chunk: Buffer) => {
        seen += chunk.toString();
        const found = /DevTools listening on (ws:\/\/\S+)/u.exec(seen);
        if (found) {
          clearTimeout(timer);
          resolve(found[1] as string);
        }
      });
    });
    const port = new URL(endpoint).port;
    let target = "";
    for (let attempt = 0; attempt < 50 && !target; attempt += 1) {
      const listed = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
      target = listed.find((item) => item.type === "page" && item.url.endsWith("page.html"))?.webSocketDebuggerUrl ?? "";
      if (!target) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    socket = new WebSocket(target);
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      const resolve = pending.get(Number(message["id"]));
      if (resolve) {
        pending.delete(Number(message["id"]));
        resolve(message);
      }
    };
    await new Promise((resolve) => ((socket as WebSocket).onopen = resolve));
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if ((await run("document.readyState === 'complete' && !!document.getElementById('lane')")) === true) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, 30_000);

  afterAll(() => {
    socket?.close();
    chrome?.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("page drag events carry one DataTransfer from dragstart to the dropzone", async () => {
    const outcome = await run(`(${SYNTHETIC_DROP})(document.getElementById("card"), document.getElementById("lane"), null)`);
    expect(outcome).toEqual({ started: true, accepted: true, dropped: true });
    expect(await run("window.dropped")).toEqual(["card-1"]);
  });

  test("split boxes are found in order and limited to the code's length; a one-time-code field is the fallback", async () => {
    expect(await run(`(${OTP_BOXES})(null, 6).map((el) => el.parentElement.id)`)).toEqual(["otp", "otp", "otp", "otp", "otp", "otp"]);
    expect(await run(`(${OTP_BOXES})(null, 4).length`)).toBe(4);
    expect(await run(`(${OTP_BOXES})(document.getElementById("single"), 6).map((el) => el.id)`)).toEqual(["one"]);
  });

  test("only overlays that appear after the mark count as revealed", async () => {
    await run(`(${HOVER_MARK})()`);
    expect(await run(`(${HOVER_REVEALED})().length`)).toBe(0);
    await run(`document.getElementById("menu").style.display = "block"; document.getElementById("tip").style.display = "block";`);
    expect(await run(`(${HOVER_REVEALED})().map((el) => el.textContent.trim())`)).toEqual(["Rename", "Delete", "Saved 2 min ago"]);
  });
});
