import { readFileSync } from "node:fs";
import { Browser, type CdpResult } from "../../src/browse/cdp/browser.ts";
import { Cancelled, sleep } from "../../src/browse/cdp/cancel.ts";
import { checkMessage } from "../../src/browse/cdp/guard.ts";

type Op = Record<string, any>;
type Outcome = Record<string, unknown>;

const [url, scriptPath, tapPortText] = process.argv.slice(2) as [string, string, string];
const tapPort = Number(tapPortText);

async function tap(path: string, body: unknown): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${tapPort}${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  await response.text();
}

function lookup(saved: Map<string, unknown>, reference: string): unknown {
  const [name, ...path] = reference.slice(1).split(".");
  let value: unknown = saved.get(name as string) ?? null;
  for (const part of path) value = value !== null && typeof value === "object" && !Array.isArray(value) ? ((value as Record<string, unknown>)[part] ?? null) : null;
  return value;
}

function resolved(value: unknown, saved: Map<string, unknown>, index?: number): unknown {
  if (typeof value === "string" && value.startsWith("@")) return lookup(saved, value);
  if (typeof value === "string" && index !== undefined) return value.replaceAll("{i}", String(index));
  if (Array.isArray(value)) return value.map((item) => resolved(item, saved, index));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolved(item, saved, index)]));
  return value;
}

function shaped(result: CdpResult, keep: unknown): unknown {
  if (keep === "keys") return Object.keys(result).sort();
  if (keep !== null && typeof keep === "object" && "len" in keep) {
    let value: unknown = result;
    for (const part of String((keep as { len: string }).len).split(".")) value = value !== null && typeof value === "object" ? (value as Record<string, unknown>)[part] : null;
    return { len: typeof value === "string" ? [...value].length : null };
  }
  return result;
}

function failed(error: unknown): Outcome {
  if (error instanceof Cancelled) return { error: { type: "CancelledError", message: "", code: null } };
  const named = error as { constructor?: { name?: string }; message?: string; code?: unknown };
  return { error: { type: named.constructor?.name ?? "Error", message: named.message ?? String(error), code: named.code ?? null } };
}

function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item !== null && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : item,
  );
}

class Driver {
  browser: Browser | null = null;
  readonly saved = new Map<string, unknown>();
  readonly events = new Map<string, number>();

  async open(at?: string): Promise<Outcome> {
    this.browser = new Browser({ ws: (at ?? url).replaceAll("{tap}", String(tapPort)), instance: null }, (method) => this.events.set(method, (this.events.get(method) ?? 0) + 1), (error) => {
      const detail = (error instanceof Error && error.message) || (error instanceof Error ? error.name : "Error");
      return `can't connect to --port ${tapPort} (${detail})`;
    });
    try {
      await this.browser.open();
      return { ok: true };
    } catch (error) {
      return failed(error);
    }
  }

  async send(op: Op, index?: number, signal?: AbortSignal): Promise<Outcome> {
    const params = resolved(op["params"], this.saved, index) as CdpResult | undefined;
    const session = resolved(op["session"], this.saved) as string | null | undefined;
    try {
      const result = await (this.browser as Browser).send(op["method"], params, {
        session: session ?? null,
        timeout: op["timeout"] ?? 30,
        mutation: op["mutation"] ?? false,
        ...(signal ? { signal } : {}),
      });
      if (op["save"]) this.saved.set(op["save"], result);
      return { ok: shaped(result, op["keep"] ?? "full") };
    } catch (error) {
      return failed(error);
    }
  }

  async run(op: Op): Promise<Outcome> {
    switch (op["op"]) {
      case "open":
        return this.open(op["url"]);
      case "send":
        return this.send(op);
      case "gather":
        return { all: await Promise.all((op["sends"] as Op[]).map((one) => this.send(one))) };
      case "pipeline": {
        const results = await Promise.all(Array.from({ length: op["count"] as number }, (_, index) => this.send(op["send"], index)));
        if (op["keep_all"]) return { all: results };
        return { count: results.length, ok: results.filter((one) => "ok" in one).length, distinct: new Set(results.map(sortedJson)).size };
      }
      case "cancel": {
        const controller = new AbortController();
        const sending = this.send(op["send"], undefined, controller.signal);
        await sleep(op["after"] ?? 0.2, null);
        controller.abort();
        const outcome = await sending;
        return "ok" in outcome ? { ok: outcome["ok"] } : outcome;
      }
      case "fault":
        await tap("/tap/fault", op["fault"]);
        return { ok: true };
      case "sleep":
        await sleep(op["seconds"], null);
        return { ok: true };
      case "close":
        await (this.browser as Browser).close();
        return { alive: (this.browser as Browser).alive };
      case "alive":
        return { alive: (this.browser as Browser).alive };
      case "wait_lost": {
        const deadline = performance.now() + (op["seconds"] ?? 5) * 1000;
        while ((this.browser as Browser).alive && performance.now() < deadline) await sleep(0.02, null);
        return { alive: (this.browser as Browser).alive };
      }
      case "events":
        return { seen: (op["names"] as string[]).filter((name) => this.events.get(name)).sort() };
      case "guard":
        try {
          checkMessage(op["message"]);
          return { ok: true };
        } catch (error) {
          return failed(error);
        }
    }
    throw new Error(`unknown op ${op["op"]}`);
  }

  async script(ops: Op[]): Promise<Outcome[]> {
    const out: Outcome[] = [];
    for (const [index, op] of ops.entries()) {
      await tap("/tap/mark", { step: index });
      out.push(await this.run(op));
    }
    if (this.browser?.alive) {
      await tap("/tap/mark", { step: "teardown" });
      await this.browser.close();
    }
    return out;
  }
}

const ops = (JSON.parse(readFileSync(scriptPath, "utf8")) as { ops: Op[] }).ops;
const deadline = setTimeout(() => {
  process.stderr.write("link-driver: the script ran past 600 s\n");
  process.exit(3);
}, 600_000);
const results = await new Driver().script(ops);
clearTimeout(deadline);
process.stdout.write(`${JSON.stringify(results)}\n`);
process.exit(0);
