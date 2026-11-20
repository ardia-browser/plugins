import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import "../libc-loaded.ts";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Browser } from "../../src/browse/cdp/browser.ts";
import { collect } from "../../src/browse/snapshot/collect.ts";
import type { Page } from "../../src/browse/state/page.ts";
import * as pierce from "../../src/browse/state/pierce.ts";
import { State } from "../../src/browse/state/state.ts";
import { monotonic } from "../../src/browse/state/wait.ts";
import { BrowseError } from "../../src/browse/daemon-errors.ts";

const CHROME = process.env["ARDIA_M3_CHROME"];
const PORT = Number(process.env["ARDIA_D4_CHROME_PORT"] ?? "9437");
const PAGE = `<!doctype html><title>shadows</title><p>outside</p><div id="host"></div><script>
const outer = document.getElementById("host").attachShadow({ mode: "closed" });
outer.innerHTML = '<p class="x" id="outer-p">outer text</p><div id="inner"></div>';
const inner = outer.getElementById("inner").attachShadow({ mode: "open" });
inner.innerHTML = '<p class="x" id="deep">deep text</p>';
</script>`;
const DOM_EVENTS = ["DOM.setChildNodes", "DOM.childNodeInserted", "DOM.childNodeRemoved", "DOM.attributeModified", "DOM.childNodeCountUpdated", "DOM.documentUpdated", "DOM.shadowRootPushed"];

let child: ChildProcess | null = null;
let profile = "";
let state: State;

async function answers(): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    return String(((await response.json()) as Record<string, unknown>)["webSocketDebuggerUrl"]);
  } catch {
    return null;
  }
}

async function freshPage(): Promise<Page> {
  const browser = state.browser as Browser;
  const { targetId } = (await browser.send("Target.createTarget", { url: "about:blank", background: true })) as { targetId: string };
  state.targetInfos.set(targetId, { targetId, type: "page", url: "about:blank", title: "" });
  const page = await state.page(targetId);
  await page.send("Page.navigate", { url: `data:text/html,${encodeURIComponent(PAGE)}` });
  for (let tries = 0; tries < 50; tries += 1) {
    await page.refreshFrames();
    if (page.url.startsWith("data:")) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  return page;
}

describe.skipIf(!CHROME)("reads against headless Chrome", () => {
  beforeAll(async () => {
    profile = fs.mkdtempSync(path.join(os.tmpdir(), "ardia-d4-live-"));
    child = spawn(CHROME as string, ["--headless", "--no-first-run", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
    let ws: string | null = null;
    for (let tries = 0; tries < 300 && ws === null; tries += 1) {
      ws = await answers();
      if (ws === null) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (ws === null) throw new Error("headless Chrome didn't answer");
    const endpoint = { ws, source: `--port ${PORT}`, explicit: true, active: null, instance: "live" };
    state = new State({ session: "d4-live", key: "", browseFd: null, noAutoDialog: false, pinTab: false }, async () => endpoint);
    await state.connect();
  }, 40_000);

  afterAll(async () => {
    await state?.disconnect().catch(() => {});
    child?.kill("SIGKILL");
    fs.rmSync(profile, { recursive: true, force: true });
  });

  test("an element in an open root nested in a closed root is found once", async () => {
    const page = await freshPage();
    const roots = await pierce.shadowRoots(page, page.mainFrame as string);
    expect(roots.length).toBe(2);
    const old = "(s, ...roots) => roots.flatMap((root) => ardiaBrowse.queryAll(s, root)).length";
    expect(await page.call(old, ["text=deep text", ...roots], { frame: page.mainFrame, read: true })).toBe(2);
    expect(await pierce.countAll(page, page.mainFrame as string, "text=deep text")).toBe(1);
    expect((await pierce.queryAll(page, page.mainFrame as string, "p.x")).length).toBe(2);
    expect((await pierce.readAll(page, page.mainFrame as string, "text=deep text"))?.matched).toBe(1);
    const [, element] = await state.locate("#deep", page);
    expect(await page.call("(el) => el.textContent", [element], { frame: element.frame })).toBe("deep text");
  }, 30_000);

  test("a pierce read leaves the DOM domain off: no DOM events reach the daemon afterwards", async () => {
    const link = (state.browser as Browser).link;
    const seen: string[] = [];
    for (const name of DOM_EVENTS) link?.on(name, (method) => seen.push(method));
    const control = await freshPage();
    await control.send("DOM.getDocument", { depth: -1, pierce: true });
    await control.call("() => { document.body.append(document.createElement('span')); return true; }", [], { frame: control.mainFrame });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(seen.length).toBeGreaterThan(0);
    await control.send("DOM.disable");
    seen.length = 0;
    const page = await freshPage();
    expect(await pierce.countAll(page, page.mainFrame as string, "p.x")).toBe(2);
    await page.call("() => { document.body.append(document.createElement('span')); return true; }", [], { frame: page.mainFrame });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(seen).toEqual([]);
  }, 30_000);

  test("an element in a closed root is found on the first poll, not after the whole wait", async () => {
    const page = await freshPage();
    const timed = async () => {
      const started = monotonic();
      await state.locate("#deep", page, 3);
      return monotonic() - started;
    };
    const saved = pierce.cadence.locate;
    pierce.cadence.locate = Number.NaN;
    const before = await timed();
    pierce.cadence.locate = saved;
    const after = await timed();
    console.log(`closed-root locate: last-poll-only ${before.toFixed(2)} s, first poll ${after.toFixed(2)} s`);
    expect(before).toBeGreaterThan(2.5);
    expect(after).toBeLessThan(1);
  }, 30_000);

  test("a snapshot refuses refs when its document changed while it was collected", async () => {
    const page = await freshPage();
    const original = page.call.bind(page);
    let navigated = false;
    page.call = (async (fn: string, args: unknown[] = [], options = {}) => {
      if (!navigated && fn.includes("clickables")) {
        navigated = true;
        await page.send("Page.navigate", { url: `data:text/html,${encodeURIComponent("<title>next</title><button>Go</button>")}` });
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      return original(fn, args, options);
    }) as typeof page.call;
    const failure = await collect(state, page).catch((error: unknown) => error);
    page.call = original;
    expect(failure).toBeInstanceOf(BrowseError);
    expect((failure as BrowseError).code).toBe("document_changed");
  }, 30_000);
});
