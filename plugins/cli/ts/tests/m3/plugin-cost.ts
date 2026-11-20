#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import os from "node:os";
import { CHROME, CREDENTIAL, pageTarget, resetPage, startWorld, step, stopWorld, type World } from "./plugin-world.ts";

const MAX_LOAD = Number(process.env["ARDIA_F1_MAX_LOAD"] ?? "10");
const RUNS = Number(process.env["ARDIA_F1_RUNS"] ?? "12");
const report: Record<string, unknown> = {};

function strayYes(): number {
  try {
    return execFileSync("pgrep", ["-x", "yes"], { encoding: "utf8" }).trim().split("\n").filter((line) => line).length;
  } catch {
    return 0;
  }
}

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

async function ownerSession(world: World, target: string) {
  const version = (await (await fetch(`http://127.0.0.1:${world.chromePort}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve) => (socket.onopen = resolve));
  let next = 0;
  const waiting = new Map<number, (value: Record<string, unknown>) => void>();
  const traced: Record<string, unknown>[] = [];
  let traceDone: (() => void) | null = null;
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> };
    if (message.id !== undefined) waiting.get(message.id)?.(message.result ?? {});
    else if (message.method === "Tracing.dataCollected") traced.push(...((message.params?.["value"] as Record<string, unknown>[]) ?? []));
    else if (message.method === "Tracing.tracingComplete") traceDone?.();
  };
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
    next += 1;
    socket.send(JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise<Record<string, unknown>>((resolve) => waiting.set(next, resolve));
  };
  const session = String((await send("Target.attachToTarget", { targetId: target, flatten: true }))["sessionId"]);
  await send("Performance.enable", {}, session);
  const taskSeconds = async () => {
    const metrics = (await send("Performance.getMetrics", {}, session))["metrics"] as { name: string; value: number }[];
    return metrics.find((metric) => metric.name === "TaskDuration")?.value ?? 0;
  };
  const longestTask = async (run: () => Promise<unknown>) => {
    traced.length = 0;
    await send("Tracing.start", { traceConfig: { includedCategories: ["devtools.timeline", "disabled-by-default-devtools.timeline"] }, transferMode: "ReportEvents" });
    await run();
    const done = new Promise<void>((resolve) => (traceDone = resolve));
    await send("Tracing.end");
    await done;
    const mains = new Set(traced.filter((event) => event["name"] === "thread_name" && (event["args"] as { name?: string } | undefined)?.name === "CrRendererMain").map((event) => `${String(event["pid"])}:${String(event["tid"])}`));
    const tasks = traced.filter((event) => event["name"] === "RunTask" && event["ph"] === "X" && mains.has(`${String(event["pid"])}:${String(event["tid"])}`));
    return Math.max(0, ...tasks.map((event) => Number(event["dur"] ?? 0) / 1000));
  };
  return { taskSeconds, longestTask, close: () => socket.close() };
}

function article(): string {
  const paragraphs = Array.from({ length: 900 }, (_, index) => `<p>Paragraph ${index} with <a href="#p${index}">a link</a> and <b>some bold</b> words.</p>`).join("");
  return `<!doctype html><title>Form page</title><article><h1>Long article</h1>${paragraphs}</article>`;
}

function table(): string {
  const rows = Array.from({ length: 2000 }, (_, index) => `<tr><td>${index}</td><td>name ${index}</td><td><button>Row ${index}</button></td></tr>`).join("");
  return `<!doctype html><title>Form page</title><table>${rows}</table>`;
}

async function main(): Promise<number> {
  if (!CHROME) {
    process.stderr.write("usage: ARDIA_M3_CHROME=<chrome-headless-shell> ARDIA_M3_TS_PROGRAM=<ardia-ts> bun tests/m3/plugin-cost.ts\n");
    return 64;
  }
  const load = os.loadavg()[0] as number;
  const yes = strayYes();
  report["load"] = Number(load.toFixed(1));
  report["stray_yes"] = yes;
  const timingsAllowed = load < MAX_LOAD && yes === 0;
  const pages: Record<string, string> = { article: article(), table: table() };
  const world = await startWorld(Number(process.env["ARDIA_F1_PORTS"] ?? "9460"));
  try {
    const target = await pageTarget(world);
    const picked = await step(world, ["tab", target], { json: true });
    let loader = String((JSON.parse(picked.out) as { data: { loader: string } }).data.loader);
    const started = performance.now();
    const waited = await step(world, ["wait", "--text=Never shown anywhere", "--timeout=10000"], { expect_loader: loader });
    const seconds = (performance.now() - started) / 1000;
    const polls = Number(waited.metrics?.["plugin_wait_polls"] ?? 0);
    report["5_wait_text_10s"] = { exit: waited.exit, code: waited.code, polls, seconds: Number(seconds.toFixed(2)), polls_per_second: Number((polls / seconds).toFixed(2)) };
    if (!timingsAllowed) {
      report["6_snapshot_cost"] = `deferred: load ${load.toFixed(1)}${yes ? `, ${yes} stray yes` : ""}`;
      return 0;
    }
    const cost: Record<string, unknown> = {};
    for (const [name, html] of Object.entries(pages)) {
      const url = `data:text/html;base64,${Buffer.from(html).toString("base64")}`;
      await resetPage(world, target, url);
      loader = String((JSON.parse((await step(world, ["tab", target], { json: true })).out) as { data: { loader: string } }).data.loader);
      const owner = await ownerSession(world, target);
      const snapshot: number[] = [];
      const control: number[] = [];
      const mainThread: number[] = [];
      for (let run = 0; run < RUNS; run += 1) {
        const before = await owner.taskSeconds();
        const t0 = performance.now();
        const shot = await step(world, ["snapshot", "-c"], { expect_loader: loader, max_output: 0 }, CREDENTIAL);
        snapshot.push(performance.now() - t0);
        mainThread.push((await owner.taskSeconds() - before) * 1000);
        if (shot.exit !== 0) throw new Error(`snapshot failed: ${shot.err}`);
        const c0 = performance.now();
        await step(world, ["get", "title"], { expect_loader: loader });
        control.push(performance.now() - c0);
      }
      const longest = await owner.longestTask(() => step(world, ["snapshot", "-c"], { expect_loader: loader, max_output: 0 }));
      owner.close();
      cost[name] = {
        runs: RUNS,
        snapshot_ms: { p50: Math.round(quantile(snapshot, 0.5)), p95: Math.round(quantile(snapshot, 0.95)) },
        control_get_title_ms: { p50: Math.round(quantile(control, 0.5)), p95: Math.round(quantile(control, 0.95)) },
        renderer_task_ms_per_snapshot: { p50: Math.round(quantile(mainThread, 0.5)), p95: Math.round(quantile(mainThread, 0.95)) },
        longest_renderer_main_task_ms: Math.round(longest),
      };
    }
    report["6_snapshot_cost"] = cost;
    return 0;
  } finally {
    await stopWorld(world);
    process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
  }
}

process.exit(await main());
