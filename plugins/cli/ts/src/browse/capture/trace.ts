import fs from "node:fs";
import path from "node:path";
import { dumps } from "../../json.ts";
import { untilCancelled } from "../cdp/cancel.ts";
import type { Ctx } from "../commands/ctx.ts";
import { register } from "../commands/index.ts";
import { need, parse } from "../commands/parse.ts";
import { BrowseError, Gated, Usage } from "../daemon-errors.ts";
import { pyValue, Result } from "../daemon/render.ts";
import { defaultPath } from "../media/paths.ts";
import { pyError } from "../pyerror.ts";
import type { Listener } from "../state/state.ts";
import { activate, captureOf, releaseClaim, removeListener, type Tracing } from "./store.ts";

export const TRACE_EVENT_LIMIT = 2_000_000;
export const TRACE_END_WAIT = 60;
export const DEFAULT_CATEGORIES = [
  "-*",
  "devtools.timeline",
  "v8.execute",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "toplevel",
  "blink.console",
  "blink.user_timing",
  "latencyInfo",
  "disabled-by-default-devtools.timeline.stack",
  "disabled-by-default-v8.cpu_profiler",
];

function within<T>(work: Promise<T>, seconds: number): Promise<T> {
  return untilCancelled(
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(pyError("TimeoutError", "")), seconds * 1000);
      work.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    }),
  );
}

export function traceConfig(categories: readonly string[]): Record<string, unknown> {
  return {
    includedCategories: categories.filter((category) => !category.startsWith("-")),
    excludedCategories: categories.filter((category) => category.startsWith("-") && category !== "-*").map((category) => category.slice(1)),
  };
}

export async function tracing(ctx: Ctx, argv: string[], kind: string): Promise<Result> {
  const [options, args] = parse(argv, { "--categories": "value" });
  need(args, 1, `${kind} start|stop [path]`);
  const page = await ctx.state.page();
  const capture = captureOf(ctx.state);
  if (args[0] === "start") {
    if (capture.tracing !== null) throw new BrowseError("A trace is already recording; stop it first");
    const categories = options["categories"] ? (options["categories"] as string).split(",") : DEFAULT_CATEGORIES;
    let finish = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const listener: Listener = (eventPage, method, params) => {
      if (eventPage === null || eventPage.targetId !== record.target) return;
      if (method === "Tracing.dataCollected") {
        const value = params["value"];
        for (const event of Array.isArray(value) ? value : []) {
          if (record.events.length < TRACE_EVENT_LIMIT) record.events.push(event);
          else record.dropped += 1;
        }
      } else if (method === "Tracing.tracingComplete") record.finish();
    };
    const record: Tracing = { events: [], done, finish: () => finish(), target: page.targetId, dropped: 0, listener };
    await activate(ctx, page, "trace", async () => {
      try {
        await page.send("Tracing.start", { traceConfig: traceConfig(categories), transferMode: "ReportEvents" });
      } catch (error) {
        if (error instanceof Gated) throw error.during(`${kind} start`);
        throw error;
      }
    });
    ctx.state.listeners.push(listener);
    capture.tracing = record;
    ctx.state.leases.add("trace");
    return new Result({ started: true }, kind === "profiler" ? "✓ Profiling started" : "✓ Recording started");
  }
  if (args[0] !== "stop") throw new Usage(`Usage: ardia browse ${kind} start|stop [path]`);
  const record = capture.tracing;
  capture.tracing = null;
  if (record === null) throw new BrowseError(`No ${kind} is recording`);
  try {
    await page.send("Tracing.end");
    await within(record.done, TRACE_END_WAIT);
  } finally {
    removeListener(ctx.state, record.listener);
    ctx.state.leases.delete("trace");
    releaseClaim(ctx, record.target, "trace");
  }
  const named = args[1];
  const target = named !== undefined ? ctx.path(named) : path.join(path.dirname(defaultPath(ctx, "png")), `trace-${Math.floor(Date.now() / 1000)}.json`);
  fs.writeFileSync(target, dumps(new Map([["traceEvents", pyValue(record.events)]]), "spaced", true), "utf8");
  const shown = named ?? target;
  const count = record.events.length;
  if (kind === "profiler") return new Result({ path: shown, events: count }, `✓ Profile saved to ${shown} (${count} events)`);
  return new Result({ path: shown, events: count }, `✓ Trace saved to ${shown}`);
}

register("trace", (ctx, argv) => tracing(ctx, argv, "trace"));
register("profiler", (ctx, argv) => tracing(ctx, argv, "profiler"));
