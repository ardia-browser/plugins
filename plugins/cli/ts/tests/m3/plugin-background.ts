import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const CHROME = process.env["ARDIA_F1_CHROME"] ?? "";
const CHROME_PORT = Number(process.env["ARDIA_F1_BACKGROUND_PORT"] ?? "9460");
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
<div id="lower" style="height:200px;overflow:auto"><p>lower area</p><button id="low" onclick="document.getElementById('lowlog').textContent = 'clicked'">Low</button></div>
<p id="lowlog">not clicked</p>`;
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
  const front = String(((await owner.send("Target.getTargets"))["targetInfos"] as { targetId: string; type: string; url: string }[]).find((info) => info.type === "page" && info.url.endsWith("/front"))?.targetId);
  const holds: { act: string; during: string; after: string }[] = [];
  const act = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    await owner.send("Target.activateTarget", { targetId: target });
    await sleep(150);
    const during = await visibility();
    try {
      return await run();
    } finally {
      await owner.send("Target.activateTarget", { targetId: front });
      await sleep(150);
      holds.push({ act: name, during, after: await visibility() });
    }
  };
  results["hold"] = "emulated by the harness: Target.activateTarget on the owner session around each act (the engine's act visibility hold)";
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
  await act("type and submit", async () => {
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
  });
  results["field_value_after_enter"] = (await axProps(field)).value;
  try {
    await act("scroll into view and click", async () => {
      const low = await backendOf("#low");
      const metrics = async () => (await p("Page.getLayoutMetrics"))["cssLayoutViewport"] as { pageY: number; clientHeight: number; clientWidth: number };
      const startY = (await metrics()).pageY;
      let point = center(await boxOf(low));
      let view = await metrics();
      let wheels = 0;
      const inside = () => point[0] >= 2 && point[1] >= 2 && point[0] <= view.clientWidth - 2 && point[1] <= view.clientHeight - 2;
      while (!inside() && wheels < 4) {
        await p("Input.dispatchMouseEvent", { type: "mouseWheel", x: view.clientWidth / 2, y: view.clientHeight / 2, deltaX: 0, deltaY: point[1] - view.clientHeight / 2, button: "none", buttons: 0 });
        wheels += 1;
        await sleep(150);
        point = center(await boxOf(low));
        view = await metrics();
      }
      const inView = inside();
      if (inView) {
        await p("Input.dispatchMouseEvent", { type: "mousePressed", x: point[0], y: point[1], button: "left", buttons: 1, clickCount: 1 });
        await p("Input.dispatchMouseEvent", { type: "mouseReleased", x: point[0], y: point[1], button: "left", buttons: 0, clickCount: 1 });
        await sleep(200);
      }
      const lowlog = await backendOf("#lowlog");
      const clicked = String((await p("DOM.getOuterHTML", { backendNodeId: lowlog }))["outerHTML"]).replace(/<[^>]+>/gu, "");
      results["scroll"] = { startY, endY: (await metrics()).pageY, inView, wheels, clicked };
    });
  } catch (error) {
    results["scroll_error"] = String(error);
  }
  results["holds"] = holds;

  results["field_value"] = (await axProps(field)).value;
  const log = await backendOf("#log");
  const logText = String((await p("DOM.getOuterHTML", { backendNodeId: log }))["outerHTML"]);
  results["submission"] = logText.replace(/<[^>]+>/gu, "");
  results["visibility_after"] = await visibility();
  results["plugin_methods"] = [...new Set(sent)];
  results["checks"] = {
    field_holds_hello: results["field_value"] === "hello",
    submission_recorded: results["submission"] === "submitted:hello",
    wheeled_into_view_and_clicked: (() => {
      const scroll = results["scroll"] as { endY?: number; startY?: number; inView?: boolean; clicked?: string; wheels?: number } | undefined;
      return Boolean(scroll?.inView) && (scroll?.endY ?? 0) > (scroll?.startY ?? 0) && scroll?.clicked === "clicked" && (scroll?.wheels ?? 9) <= 4;
    })(),
    hidden_before_and_after_every_act: results["visibility_before"] === "hidden" && results["visibility_after"] === "hidden" && holds.length === 2 && holds.every((held) => held.during === "visible" && held.after === "hidden"),
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
