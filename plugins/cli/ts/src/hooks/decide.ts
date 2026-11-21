import { dumps, Float, type JsonObject, type Value } from "../json.ts";
import { strOf } from "../py.ts";
import { pyStrip } from "../pystrings.ts";
import { loads } from "../pylib/jsonloads.ts";
import { strerror } from "../paths.ts";
import { type GroupChild, SpawnFailed, spawnGroup } from "../proc/group.ts";
import type { Hook } from "./model.ts";
import type { LogSink } from "./log.ts";
import { baseEnv, EVENT_VARIABLES, programArgv } from "./runner.ts";

export const OUTPUT_LIMIT = 64 * 1024;
const MAX_RUNNING = 16;
const MAX_PER_HOOK = 4;
const MARGIN = 0.02;
const MAX_DEADLINE = 5;

export type Answerer = { answer(decide: string, answer: Value): Promise<boolean> };
export type Accepted = Map<string, [string, Hook]>;

export function decideEnv(message: JsonObject, base: Record<string, string> = baseEnv()): Record<string, string> {
  const env = { ...base };
  for (const variable of EVENT_VARIABLES) delete env[variable];
  env.ARDIA_EVENT = message.has("event") ? strOf(message.get("event")) : "";
  return env;
}

export function minimizedUrl(url: string): string {
  const cuts = [url.indexOf("?"), url.indexOf("#")].filter((at) => at >= 0);
  return cuts.length > 0 ? url.slice(0, Math.min(...cuts)) : url;
}

export function parseAnswer(output: Buffer): Value | undefined {
  const text = pyStrip(new TextDecoder("utf-8", { fatal: false }).decode(output));
  if (text === "") return undefined;
  let value: Value;
  try {
    value = loads(text);
  } catch {
    return undefined;
  }
  return value instanceof Map || Array.isArray(value) || value === null ? value : undefined;
}

function roundedMs(seconds: number): string {
  const ms = seconds * 1000;
  const floor = Math.floor(ms);
  const fraction = ms - floor;
  if (fraction === 0.5) return String(floor % 2 === 0 ? floor : floor + 1);
  return String(Math.round(ms));
}

function deadlineSeconds(deadline: Value | undefined): number {
  let value = 0.25;
  if (typeof deadline === "bigint") value = Number(deadline) / 1000;
  else if (deadline instanceof Float) value = deadline.value / 1000;
  return Math.min(Math.max(value, 0.05), MAX_DEADLINE);
}

type Running = { hook: string; cancel: () => void; done: Promise<void> };

export class Decider {
  running = new Map<string, Running>();
  answered = 0;
  skipped = 0;

  constructor(
    private readonly log: LogSink,
    private readonly maxRunning: number = MAX_RUNNING,
    private readonly perHook: number = MAX_PER_HOOK,
  ) {}

  busy(hookName: string): boolean {
    if (this.running.size >= this.maxRunning) return true;
    return [...this.running.values()].filter((entry) => entry.hook === hookName).length >= this.perHook;
  }

  handle(message: JsonObject, accepted: Accepted, connection: Answerer): void {
    const ident = message.get("decide") as string;
    if (message.get("cancel") === true) {
      this.cancel(ident);
      return;
    }
    const hookName = message.get("hook");
    const entry = typeof hookName === "string" ? accepted.get(hookName) : undefined;
    if (entry === undefined || this.running.has(ident)) return;
    const [revision, hook] = entry;
    if (revision !== message.get("revision")) {
      this.log.write(`warning: hook ${hook.name}: Ardia asked for a revision this runner didn't register; it uses its default`);
      return;
    }
    if (!hook.served) return;
    if (this.busy(hook.name)) {
      this.skipped += 1;
      this.log.write(`warning: hook ${hook.name}: too many decisions at once; Ardia uses its default for this one`);
      return;
    }
    const controller = { cancelled: false, stop: (): void => {} };
    const done = this.run(ident, hook, message, connection, controller).finally(() => {
      if (this.running.get(ident)?.done === done) this.running.delete(ident);
    });
    this.running.set(ident, {
      hook: hook.name,
      cancel: () => {
        controller.cancelled = true;
        controller.stop();
      },
      done,
    });
  }

  cancel(ident: string): void {
    const entry = this.running.get(ident);
    if (entry === undefined) return;
    this.running.delete(ident);
    entry.cancel();
  }

  private async run(ident: string, hook: Hook, message: JsonObject, connection: Answerer, controller: { cancelled: boolean; stop: () => void }): Promise<void> {
    const deadline = message.get("deadline");
    const seconds = deadlineSeconds(deadline);
    let data = message.get("data");
    if (!hook.fullUrls && data instanceof Map && typeof data.get("url") === "string") {
      data = new Map(data);
      data.set("url", minimizedUrl(data.get("url") as string));
    }
    const payload = new Map<string, Value>([
      ["decide", ident],
      ["event", message.get("event") ?? null],
      ["deadline", deadline ?? null],
      ["data", data ?? null],
    ]);
    const bytes = Buffer.from(`${dumps(payload, "spaced")}\n`, "utf8");
    const argv = programArgv(hook.program);
    let child: GroupChild;
    try {
      child = await spawnGroup(argv, { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: decideEnv(message) });
    } catch (error) {
      this.log.write(`hook ${hook.name}: can't run ${argv[0]}: ${error instanceof SpawnFailed ? strerror(error.errno) : String(error)}`);
      return;
    }
    if (controller.cancelled) {
      this.kill(child);
      return;
    }
    const outcome = await new Promise<{ kind: "output"; output: Buffer } | { kind: "timeout" } | { kind: "cancelled" }>((resolve) => {
      const timer = setTimeout(() => resolve({ kind: "timeout" }), Math.max(seconds - MARGIN, 0.01) * 1000);
      controller.stop = () => {
        clearTimeout(timer);
        resolve({ kind: "cancelled" });
      };
      void this.exchange(child, bytes).then((output) => {
        clearTimeout(timer);
        resolve({ kind: "output", output });
      });
    });
    if (outcome.kind !== "output") {
      this.kill(child);
      if (outcome.kind === "timeout") this.log.write(`hook ${hook.name}: no answer in ${roundedMs(seconds)} ms; Ardia used its default`);
      return;
    }
    child.forget();
    const answer = parseAnswer(outcome.output);
    if (answer === undefined && !/^[ \t\n\r\x0b\x0c]*$/.test(outcome.output.toString("latin1"))) this.log.write(`hook ${hook.name}: the answer isn't a JSON object or list; Ardia used its default`);
    if (await connection.answer(ident, answer === undefined ? null : answer)) this.answered += 1;
  }

  private exchange(child: GroupChild, payload: Buffer): Promise<Buffer> {
    return new Promise((resolve) => {
      const stdin = child.child.stdin;
      if (stdin !== null) {
        stdin.on("error", () => {});
        stdin.end(payload);
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let over = false;
      const stdout = child.child.stdout;
      if (stdout === null) {
        resolve(Buffer.alloc(0));
        return;
      }
      stdout.on("data", (chunk: Buffer) => {
        if (over) return;
        chunks.push(chunk);
        size += chunk.length;
        if (size > OUTPUT_LIMIT) {
          over = true;
          this.kill(child);
          resolve(Buffer.alloc(0));
        }
      });
      stdout.on("end", () => {
        if (over) return;
        const output = Buffer.concat(chunks);
        if (child.exited) resolve(output);
        else child.child.once("exit", () => resolve(output));
      });
    });
  }

  private kill(child: GroupChild): void {
    child.signal("SIGKILL");
    child.forget();
  }

  async stop(): Promise<void> {
    const entries = [...this.running.values()];
    for (const entry of entries) entry.cancel();
    await Promise.all(entries.map((entry) => entry.done.catch(() => {})));
    this.running.clear();
  }
}
