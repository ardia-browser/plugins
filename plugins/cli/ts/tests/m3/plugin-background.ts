import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const CHROME = process.env["ARDIA_F1_CHROME"] ?? "";
const CHROME_PORT = Number(process.env["ARDIA_F1_BACKGROUND_PORT"] ?? "9690");
const SITE_PORT = CHROME_PORT + 1;
if (!CHROME) {
  process.stderr.write("usage: ARDIA_F1_CHROME=<full Chrome for Testing binary> bun tests/m3/plugin-background.ts\n");
  process.exit(64);
}
const FORM = `<!doctype html><title>Background form</title>
<form id="f" onsubmit="event.preventDefault(); document.getElementById('log').textContent = 'submitted:' + document.getElementById('field').value">
<input id="field" aria-label="Field"></form>
<p id="log">nothing yet</p>
<div style="height:3000px"></div>
<div id="lower" style="height:200px;overflow:auto"><p>lower area</p></div>`;
const FRONT = `<!doctype html><title>Front</title><p>visible tab</p>`;

type Msg = { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message: string }; sessionId?: string };

class Cdp {
  private next = 1;
  private waiting = new Map<number, (m: Msg) => void>();
  constructor(private ws: WebSocket) {
    ws.onmessage = (event) => {
      const m = JSON.parse(String(event.data)) as Msg;
      if (m.id !== undefined) this.waiting.get(m.id)?.(m);
    };
  }
  static async open(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    return new Cdp(ws);
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const id = this.next++;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} got no answer in 10 s`)), 10_000);
      this.waiting.set(id, (m) => {
        clearTimeout(timer);
        if (m.error) reject(new Error(`${method}: ${m.error.message}`));
        else resolve(m.result ?? {});
      });
    });
  }
  close(): void {
    this.ws.close();
  }
}

const results: Record<string, unknown> = {};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const site = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end(request.url === "/form" ? FORM : FRONT);
});
await new Promise<void>((resolve) => site.listen(SITE_PORT, "127.0.0.1", resolve));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "f1e-d-"));
const chrome = spawn(CHROME, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--mute-audio", "--window-size=1000,800", `--remote-debugging-port=${CHROME_PORT}`, `--user-data-dir=${profile}`, `http://127.0.0.1:${SITE_PORT}/front`], { stdio: "ignore", detached: true });
results["chrome_pid"] = chrome.pid;
try {
  let version: { webSocketDebuggerUrl: string } | null = null;
  for (let i = 0; i < 300 && version === null; i += 1) {
    try {
      version = (await (await fetch(`http://127.0.0.1:${CHROME_PORT}/json/version`)).json()) as { webSocketDebuggerUrl: string };
    } catch {
      await sleep(100);
    }
  }
  results["browser"] = (version as unknown as Record<string, string>)["Browser"];
  const plugin = await Cdp.open((version as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl);
  const owner = await Cdp.open((version as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl);
  const created = await owner.send("Target.createTarget", { url: `http://127.0.0.1:${SITE_PORT}/form`, background: true });
  const target = String(created["targetId"]);
  const ownerSession = String((await owner.send("Target.attachToTarget", { targetId: target, flatten: true }))["sessionId"]);
  const visibility = async () => ((await owner.send("Runtime.evaluate", { expression: "document.visibilityState", returnByValue: true }, ownerSession))["result"] as { value: string }).value;
  for (let i = 0; i < 100; i += 1) {
    const ready = ((await owner.send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }, ownerSession))["result"] as { value: string }).value;
    if (ready === "complete") break;
    await sleep(50);
  }
  results["visibility_before"] = await visibility();
  const targets = ((await plugin.send("Target.getTargets"))["targetInfos"] as { targetId: string; type: string; attached: boolean; url: string }[]).filter((info) => info.type === "page").map((info) => ({ url: info.url, front: info.targetId !== target }));
  results["tabs"] = targets;

  const sent: string[] = [];
  const session = String((await plugin.send("Target.attachToTarget", { targetId: target, flatten: true }))["sessionId"]);
  const p = async (method: string, params: Record<string, unknown> = {}) => {
    sent.push(method);
    results["last_step"] = method;
    const steps = (results["steps"] ??= []) as string[];
    const label = method === "Input.dispatchMouseEvent" || method === "Input.dispatchKeyEvent" ? `${method}:${String(params["type"])}` : method;
    steps.push(label);
    return plugin.send(method, params, session);
  };
  await p("Page.enable");
  const root = (await p("DOM.getDocument", { depth: 0 }))["root"] as { nodeId: number };
  const backendOf = async (selector: string) => {
    const nodeId = (await p("DOM.querySelector", { nodeId: root.nodeId, selector }))["nodeId"] as number;
    return ((await p("DOM.describeNode", { nodeId }))["node"] as { backendNodeId: number }).backendNodeId;
  };
  const at = (border: number[], index: number) => border[index] ?? 0;
  const center = (border: number[]): [number, number] => [(at(border, 0) + at(border, 2) + at(border, 4) + at(border, 6)) / 4, (at(border, 1) + at(border, 3) + at(border, 5) + at(border, 7)) / 4];
  const boxOf = async (backend: number) => ((await p("DOM.getBoxModel", { backendNodeId: backend }))["model"] as { border: number[] }).border;
  const axProps = async (backend: number) => {
    const nodes = (await p("Accessibility.getPartialAXTree", { backendNodeId: backend, fetchRelatives: false }))["nodes"] as { backendDOMNodeId: number; value?: { value: unknown }; properties?: { name: string; value: { value: unknown } }[] }[];
    const node = nodes.find((item) => item.backendDOMNodeId === backend);
    return { value: node?.value?.value, focused: Boolean(node?.properties?.find((prop) => prop.name === "focused")?.value.value) };
  };

  const field = await backendOf("#field");
  const [x, y] = center(await boxOf(field));
  const hit = await p("DOM.getNodeForLocation", { x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: false, ignorePointerEventsNone: false });
  results["hit_test_found_field_without_fresh_layout"] = hit["backendNodeId"] === field;
  results["field_focused_before_click"] = (await axProps(field)).focused;
  await p("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await p("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  results["click_stand_in"] = "Input.dispatchMouseEvent pressed+released (stock Chrome has no Ardia.dispatchClick)";
  results["field_focused_before_insert"] = (await axProps(field)).focused;
  await p("Input.insertText", { text: "hello" });
  await p("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" });
  await p("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await sleep(200);

  results["field_value_after_enter"] = (await axProps(field)).value;
  const earlyLog = await backendOf("#log");
  results["submission_after_enter"] = String((await p("DOM.getOuterHTML", { backendNodeId: earlyLog }))["outerHTML"]).replace(/<[^>]+>/gu, "");
  results["visibility_after_enter"] = await visibility();
  try {
  const lower = await backendOf("#lower");
  const metrics = async () => (await p("Page.getLayoutMetrics"))["cssLayoutViewport"] as { pageY: number; clientHeight: number; clientWidth: number };
  const startY = (await metrics()).pageY;
  let inView = false;
  let tries = 0;
  for (; tries < 8 && !inView; tries += 1) {
    const view = await metrics();
    const border = await boxOf(lower);
    const top = Math.min(at(border, 1), at(border, 3), at(border, 5), at(border, 7));
    const bottom = Math.max(at(border, 1), at(border, 3), at(border, 5), at(border, 7));
    if (top >= 0 && bottom <= view.clientHeight) {
      inView = true;
      break;
    }
    const delta = top < 0 ? top - 20 : bottom - view.clientHeight + 20;
    await p("Input.dispatchMouseEvent", { type: "mouseWheel", x: view.clientWidth / 2, y: view.clientHeight / 2, deltaX: 0, deltaY: delta, button: "none", buttons: 0 });
    await sleep(150);
  }
  const endY = (await metrics()).pageY;
  results["scroll"] = { startY, endY, inView, wheels: tries };
  } catch (error) {
    results["scroll_error"] = String(error);
    results["pageY_after_unanswered_wheel"] = ((await p("Page.getLayoutMetrics"))["cssLayoutViewport"] as { pageY: number }).pageY;
    try {
      await p("Input.dispatchKeyEvent", { type: "keyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 8 });
      await p("Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 });
      results["key_after_unanswered_wheel"] = "answered";
    } catch (keyError) {
      results["key_after_unanswered_wheel"] = String(keyError);
    }
    const after = await new Promise<string>((resolve) => setTimeout(async () => resolve(String(await visibility())), 0));
    results["visibility_at_scroll_error"] = after;
  }

  results["field_value"] = (await axProps(field)).value;
  const log = await backendOf("#log");
  const logText = String((await p("DOM.getOuterHTML", { backendNodeId: log }))["outerHTML"]);
  results["submission"] = logText.replace(/<[^>]+>/gu, "");
  results["visibility_after"] = await visibility();
  results["plugin_methods"] = [...new Set(sent)];
  results["checks"] = {
    field_holds_hello: results["field_value"] === "hello",
    submission_recorded: results["submission"] === "submitted:hello",
    scroll_moved: Boolean((results["scroll"] as { endY?: number; startY?: number; inView?: boolean } | undefined)?.inView),
    tab_stayed_hidden: results["visibility_before"] === "hidden" && results["visibility_after"] === "hidden",
    no_runtime_on_plugin_session: !sent.some((method) => method.startsWith("Runtime.")),
  };
  plugin.close();
  owner.close();
} catch (error) {
  results["error"] = String(error);
} finally {
  try {
    process.kill(-(chrome.pid as number), "SIGKILL");
  } catch {}
  site.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify(results, null, 1)}\n`);
const checks = (results["checks"] ?? {}) as Record<string, boolean>;
process.exit(results["error"] === undefined && Object.values(checks).length > 0 && Object.values(checks).every(Boolean) ? 0 : 1);
