#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import os from "node:os";
import { CREDENTIAL, pageTarget, startWorld, step, stopWorld, type World } from "./plugin-world.ts";

const MAX_LOAD = Number(process.env["ARDIA_F1_MAX_LOAD"] ?? "10");
const ROUNDS = Number(process.env["ARDIA_F1_ROUNDS"] ?? "20");
const PERSON_PAGE = `<!doctype html><title>Person</title><textarea id="t" style="width:600px;height:100px"></textarea><div style="height:20000px">tall</div>
<script>window.__frames = []; window.__last = 0; addEventListener('scroll', () => requestAnimationFrame(() => { window.__last = performance.now(); }), { passive: true });
document.getElementById('t').addEventListener('input', () => requestAnimationFrame(() => { window.__last = performance.now(); }));</script>`;

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

async function person(world: World) {
  const version = (await (await fetch(`http://127.0.0.1:${world.chromePort}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve) => (socket.onopen = resolve));
  let next = 0;
  const waiting = new Map<number, (value: Record<string, unknown>) => void>();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; error?: unknown };
    if (message.id !== undefined) waiting.get(message.id)?.(message.result ?? { error: message.error });
  };
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
    next += 1;
    socket.send(JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) }));
    const id = next;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} got no answer in 10 s`)), 10_000);
      waiting.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  };
  const target = String((await send("Target.createTarget", { url: `data:text/html;base64,${Buffer.from(PERSON_PAGE).toString("base64")}` }))["targetId"]);
  const session = String((await send("Target.attachToTarget", { targetId: target, flatten: true }))["sessionId"]);
  await send("Target.activateTarget", { targetId: target });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const value = async (expression: string) => ((await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, session))["result"] as { value: unknown }).value;
  const settle = async (before: number) => {
    const deadline = performance.now() + 2000;
    while (performance.now() < deadline) {
      const last = Number(await value("window.__last"));
      if (last > before) return last;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    return Number.NaN;
  };
  const scrollMs = async () => {
    const before = Number(await value("performance.now()"));
    await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 300, y: 300, deltaX: 0, deltaY: 120 }, session);
    return (await settle(before)) - before;
  };
  const typeMs = async () => {
    await value("document.getElementById('t').focus(); 0");
    const before = Number(await value("performance.now()"));
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, text: "a" }, session);
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65 }, session);
    return (await settle(before)) - before;
  };
  return { scrollMs, typeMs, close: () => socket.close() };
}

async function main(): Promise<number> {
  const engine = process.env["ARDIA_F1_ENGINE"] === "2808";
  const load = os.loadavg()[0] as number;
  let yes = 0;
  try {
    yes = execFileSync("pgrep", ["-x", "yes"], { encoding: "utf8" }).trim().split("\n").filter((line) => line).length;
  } catch {}
  const report: Record<string, unknown> = { engine: engine ? "ardia#2808 build" : "stock Chrome for Testing (smoke only, not the measurement)", load: Number(load.toFixed(1)), stray_yes: yes };
  if (load >= MAX_LOAD || yes > 0) {
    report["result"] = `deferred: load ${load.toFixed(1)}`;
    process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
    return 0;
  }
  const world = await startWorld(Number(process.env["ARDIA_F1_PORTS"] ?? "9750"));
  try {
    const target = await pageTarget(world);
    await step(world, ["tab", target], { json: true });
    const front = await person(world);
    let acting = false;
    let stopping = false;
    let acts = 0;
    const plugin = (async () => {
      while (!stopping) {
        if (!acting) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          continue;
        }
        await step(world, ["fill", "--", "input", `plugin ${acts}`], { no_changes: true }, CREDENTIAL);
        await step(world, ["snapshot", "-c"], {}, CREDENTIAL);
        acts += 1;
      }
    })();
    const samples: Record<string, number[]> = { scroll_alone: [], scroll_with_plugin: [], type_alone: [], type_with_plugin: [] };
    for (let round = 0; round < ROUNDS; round += 1) {
      for (const withPlugin of [false, true]) {
        acting = withPlugin;
        await new Promise((resolve) => setTimeout(resolve, 100));
        samples[withPlugin ? "scroll_with_plugin" : "scroll_alone"]?.push(await front.scrollMs());
        samples[withPlugin ? "type_with_plugin" : "type_alone"]?.push(await front.typeMs());
      }
    }
    acting = false;
    stopping = true;
    await plugin;
    report["plugin_steps_during_measurement"] = acts * 2;
    front.close();
    report["rounds"] = ROUNDS;
    report["latency_ms"] = Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, { p50: Number(quantile(values, 0.5).toFixed(1)), p95: Number(quantile(values, 0.95).toFixed(1)) }]));
    return 0;
  } catch (error) {
    report["error"] = String(error);
    return 1;
  } finally {
    await stopWorld(world);
    process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
  }
}

process.exit(await main());
