import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import "./libc-loaded.ts";
import { SYNTHETIC_DROP, syntheticDrop } from "../src/browse/act/drag.ts";
import { editCell } from "../src/browse/act/fields.ts";
import { HOVER_MARK, HOVER_REVEALED, hoverResult, revealedLines } from "../src/browse/act/reveal.ts";
import { markOtpBoxes, OTP_BOXES, otpCode, otpRequest } from "../src/browse/commands/interact.ts";
import { DESCRIBE_REVEALED, revealedAfter } from "../src/browse/act/reveal.ts";
import { isSecret } from "../src/browse/state/secrets.ts";
import { RECORDER_SOURCE, QUEUE } from "../src/browse/commands/record.ts";
import { settledClicks } from "../src/browse/flows/compile.ts";
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
  try {
    await whenReady(runner);
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

  test("page.totp hands back an opaque handle, and page.fillOtp sends only the profile name", async () => {
    const { requests, result } = await once("const code = page.totp('acme'); await page.fillOtp(code); await page.fillOtp({ profile: 'work' }); await page.fillOtp('123456', { within: 'Verify' }); return [String(code), JSON.stringify(code)];");
    expect(argvs(requests)).toEqual([["fill-otp", "--profile", "acme"], ["fill-otp", "--profile", "work"], ["fill-otp", "123456", "--within", "Verify"]]);
    expect(requests.some((request) => request["op"] === "totp")).toBe(false);
    expect(result["value"]).toEqual(["[one-time code for acme]", '"[one-time code for acme]"']);
  });

  test("page.totp refuses a missing profile name before asking", async () => {
    const { result, requests } = await once("page.totp('');");
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

  test("fill-otp parses its flags around the code, and allows --within with --profile", () => {
    expect(otpRequest(["123 456", "--within", "Verify", "--sensitive"])).toEqual({ profile: null, code: "123456", within: "Verify", instant: false });
    expect(otpRequest(["--within=Card", "--no-humanize", "AB12"])).toEqual({ profile: null, code: "AB12", within: "Card", instant: true });
    expect(otpRequest(["--profile", "acme"])).toEqual({ profile: "acme", code: null, within: null, instant: false });
    expect(otpRequest(["--profile", "acme", "--within", "#verify"])).toEqual({ profile: "acme", code: null, within: "#verify", instant: false });
    expect(() => otpRequest(["--profile", "acme", "123456"])).toThrow("not both");
    expect(() => otpRequest(["--profile", "../x"])).toThrow("saved auth profile");
  });

  test("every OTP box is marked secret before anything is typed", () => {
    const state = {};
    const page = { targetId: "T", loader: (frame: string | null) => `L-${frame}`, frames: new Map([["F", { loader: "L-F" }]]) } as unknown as Page;
    const boxes = [1, 2, 3, 4, 5, 6].map((backend) => new Element("F", `O${backend}`, backend, `box ${backend}`));
    markOtpBoxes(state, page, boxes);
    expect(boxes.every((box) => isSecret(state, page as never, "F", "L-F", box.backendId))).toBe(true);
    expect(isSecret(state, page as never, "F", "L-F", 99)).toBe(false);
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
    expect(dragText({ html5: true, started: true, dropped: false })).toBe("✓ Done (HTML5 drag; the target didn't accept the drop, so the page got no drop event)");
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
    const unknown = compileEvents([{ kind: "click", at: 1, target: { tag: "div", role: "menuitemcheckbox", name: "Bold", ariaLabel: "Bold" }, checked: null }], "https://app.example.com/");
    expect(unknown.steps.at(-1)?.action.type).toBe("click");
    expect(unknown.steps.at(-1)?.action.desired_state).toBeUndefined();
    const recorded: RecEvent[] = [
      { kind: "click", pointer: "p1", at: 1, target: { tag: "div", role: "switch", name: "Wifi", ariaLabel: "Wifi" }, checked: null },
      { kind: "confirm", pointer: "p1", at: 2, checked: false },
    ];
    expect(settledClicks(recorded)).toMatchObject([{ kind: "click", checked: false }]);
    const off = compileEvents(recorded, "https://app.example.com/").steps.at(-1)?.action;
    expect([off?.type, off?.desired_state]).toEqual(["uncheck", false]);
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
<ul id="board" style="margin:0;padding:0;list-style:none"><li id="card" draggable="true" style="width:200px;height:20px">Card</li></ul>
<div id="lane" style="height:80px;width:200px">Lane</div>
<div id="otp"><input maxlength="1"><input maxlength="1"><input maxlength="1"><input maxlength="1"><input maxlength="1"><input maxlength="1"></div>
<form id="single"><input id="one" autocomplete="one-time-code"></form>
<button id="more">More</button>
<div id="menu" role="menu" style="display:none"><div role="menuitem">Rename</div><div role="menuitem">Delete</div></div>
<div class="tooltip" style="display:none" id="tip">Saved 2 min ago</div>
<div id="lane2" style="height:80px;width:200px">Closed lane</div>
<div id="secretmenu" role="menu" style="display:none"><input id="pw" type="password" value="hunter2"><input id="tok" value="tok-123" aria-label="Token"><div role="menuitem" style="visibility:hidden">Ghost</div></div>
<div role="switch" id="wifi" aria-checked="true" tabindex="0" style="width:60px;height:30px">Wifi</div>
<div id="otp2"><input maxlength="1" id="d1"><input maxlength="1"><input maxlength="1"><input maxlength="1"></div>
<script>
const lane = document.getElementById("lane");
window.dropped = [];
lane.addEventListener("dragover", (event) => event.preventDefault());
lane.addEventListener("drop", (event) => { event.preventDefault(); window.dropped.push(event.dataTransfer.getData("text/plain")); });
document.getElementById("card").addEventListener("dragstart", (event) => event.dataTransfer.setData("text/plain", "card-1"));
window.drops = [];
lane.addEventListener("drop", (event) => window.drops.push(event.clientY - lane.getBoundingClientRect().top));
window.lane2drops = 0;
document.getElementById("lane2").addEventListener("drop", () => { window.lane2drops += 1; });
const wifi = document.getElementById("wifi");
wifi.addEventListener("click", () => wifi.setAttribute("aria-checked", wifi.getAttribute("aria-checked") === "true" ? "false" : "true"));
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
    expect(await run("window.drops")).toEqual([60]);
    await run(`(${SYNTHETIC_DROP})(document.getElementById("card"), document.getElementById("lane"), "before")`);
    expect(await run("window.drops[1]")).toBe(20);
  });

  test("a dropzone that doesn't accept dragover gets no drop", async () => {
    expect(await run(`(${SYNTHETIC_DROP})(document.getElementById("card"), document.getElementById("lane2"), null)`)).toEqual({ started: true, accepted: false, dropped: false });
    expect(await run("window.lane2drops")).toBe(0);
  });

  test("revealed names never read a field's value, and hidden items are left out", async () => {
    await run(`(${HOVER_MARK})()`);
    await run(`document.getElementById("secretmenu").style.display = "block"`);
    const names = await run(`(${HOVER_REVEALED})().map((el) => (${DESCRIBE_REVEALED})(el))`);
    expect(JSON.stringify(names)).not.toContain("hunter2");
    expect(JSON.stringify(names)).not.toContain("tok-123");
    expect(JSON.stringify(names)).not.toContain("Ghost");
    expect(names).toEqual([{ role: "textbox", name: "" }, { role: "textbox", name: "Token" }]);
    await run(`document.getElementById("secretmenu").style.display = "none"`);
  });

  async function press(selector: string): Promise<void> {
    const box = (await run(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`)) as [number, number];
    for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: box[0], y: box[1], button: "left", clickCount: 1 });
  }

  test("the recorder reads an ARIA toggle's state after the page handles the click, and hides split OTP digits", async () => {
    await run(RECORDER_SOURCE);
    await press("#wifi");
    await press("#d1");
    await send("Input.insertText", { text: "7" });
    await press("#wifi");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const events = ((await run(`globalThis[${JSON.stringify(QUEUE)}].map((line) => JSON.parse(line))`)) as Record<string, unknown>[]);
    const clicks = events.filter((event) => event["kind"] === "click" && (event["target"] as Record<string, unknown>)["role"] === "switch");
    const confirms = events.filter((event) => event["kind"] === "confirm");
    expect(clicks[0]?.["checked"]).toBeNull();
    expect(confirms.map((event) => event["checked"])).toEqual([false, true]);
    const fill = events.find((event) => event["kind"] === "fill");
    expect(fill).toMatchObject({ secret: true, value: "" });
    await run("globalThis.__ardiaRecorderStop && globalThis.__ardiaRecorderStop()");
  });

  test("the recorder hides digits in sensitive fields including camelCase passWord/PassPhrase and records post-click state on keyboard ARIA toggles", async () => {
    await run(`(() => {
      for (const [id, name] of [["named-code", "code"], ["named-verif", "verification"], ["camel-otp", "otpInput"], ["camel-token", "accessToken"], ["camel-pw", "passWord"], ["camel-pp", "PassPhrase"], ["plain-note", "notes"]]) {
        if (!document.getElementById(id)) {
          const input = document.createElement("input");
          input.id = id;
          input.name = name;
          document.body.appendChild(input);
        }
      }
      if (!document.getElementById("kbd-switch")) {
        const button = document.createElement("button");
        button.id = "kbd-switch";
        button.setAttribute("role", "switch");
        button.setAttribute("aria-checked", "false");
        button.textContent = "Alerts";
        button.addEventListener("click", () => button.setAttribute("aria-checked", button.getAttribute("aria-checked") === "true" ? "false" : "true"));
        document.body.appendChild(button);
      } else {
        document.getElementById("kbd-switch").setAttribute("aria-checked", "false");
      }
    })()`);
    await run(RECORDER_SOURCE);
    await run(`globalThis[${JSON.stringify(QUEUE)}].length = 0`);
    const pairs: [string, string][] = [["#named-code", "123456"], ["#named-verif", "654321"], ["#camel-otp", "112233"], ["#camel-token", "tok-secret"], ["#camel-pw", "my-pass"], ["#camel-pp", "my-phrase"], ["#plain-note", "hello"]];
    for (const [sel, val] of pairs) {
      await press(sel);
      await send("Input.insertText", { text: val });
    }
    await run(`document.getElementById("kbd-switch").focus()`);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const events = ((await run(`globalThis[${JSON.stringify(QUEUE)}].map((line) => JSON.parse(line))`)) as Record<string, unknown>[]);
    for (const fieldName of ["code", "verification", "otpInput", "accessToken", "passWord", "PassPhrase"]) {
      const found = events.find((event) => event["kind"] === "fill" && (event["target"] as Record<string, unknown>)["fieldName"] === fieldName);
      expect(found).toMatchObject({ secret: true, value: "" });
    }
    const plain = events.find((event) => event["kind"] === "fill" && (event["target"] as Record<string, unknown>)["fieldName"] === "notes");
    expect(plain).toMatchObject({ secret: false, value: "hello" });
    const switchClicks = events.filter((event) => event["kind"] === "click" && (event["target"] as Record<string, unknown>)["id"] === "kbd-switch");
    expect(switchClicks.length).toBeGreaterThanOrEqual(1);
    const click = switchClicks[0] as Record<string, unknown>;
    expect(click["checked"]).toBeNull();
    const confirm = events.find((event) => event["kind"] === "confirm" && event["pointer"] === click["pointer"]);
    expect(confirm?.["checked"]).toBe(true);
    await run("globalThis.__ardiaRecorderStop && globalThis.__ardiaRecorderStop()");
  });

  test("revealedAfter skips registering refs if the document loader navigates during description", async () => {
    let currentLoader = "loader-1";
    const added: string[] = [];
    const el = new Element("obj-1", "f1", 42, "revealed");
    const page = {
      loader: () => currentLoader,
      call: async (fn: string) => {
        if (fn === DESCRIBE_REVEALED) {
          currentLoader = "loader-2";
          return { role: "menuitem", name: "Delete" };
        }
        return {};
      },
      elementsFrom: async () => [el],
    } as unknown as Page;
    const ctx = {
      state: {
        addRef: () => {
          added.push("e1");
          return "e1";
        },
      },
    } as unknown as import("../src/browse/commands/ctx.ts").Ctx;
    const found = await revealedAfter(ctx, page, "f1", [0], "loader-1");
    expect(found).toEqual([]);
    expect(added).toEqual([]);
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

describe("the CLI hands fill-otp --profile to the daemon", () => {
  test("--profile is a fill-otp flag, still refused as a launch option elsewhere", async () => {
    const { splitGlobals } = await import("../src/browse/args.ts");
    expect(splitGlobals(["fill-otp", "--profile", "acme"]).rest).toEqual(["fill-otp", "--profile", "acme"]);
    expect(() => splitGlobals(["open", "--profile", "x"])).toThrow("launch options have no effect");
  });
});
