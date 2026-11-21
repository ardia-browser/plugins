import { type JsonObject, type Value } from "../json.ts";
import { zoneName } from "../libc.ts";
import { DAYS, type Hook } from "./model.ts";
import type { LogSink } from "./log.ts";
import { addDays, epochOf, wallAt } from "./zones.ts";

export const CHECK_INTERVAL = 20;
export const ON_TIME = 90;

export function nextAt(hook: Hook, after: number): number {
  const zone = hook.timezone;
  const at = hook.at as string;
  const hour = Number(at.slice(0, 2));
  const minute = Number(at.slice(3));
  const start = wallAt(after, zone);
  for (let offset = 0; offset < 8; offset += 1) {
    const day = addDays(start, offset);
    const stamp = epochOf({ year: day.year, month: day.month, day: day.day, hour, minute }, zone);
    if (stamp <= after) continue;
    if (hook.days.length > 0 && !hook.days.includes(DAYS[day.weekday] as string)) continue;
    return stamp;
  }
  throw new Error(`hook ${hook.name}: no time matches at ${hook.at}`);
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

export function occurrence(hook: Hook, stamp: number): string {
  const wall = wallAt(stamp, hook.timezone);
  return `${hook.name}@${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}`;
}

type State = { due?: number; dueMono?: number; lastWall?: number };

export type Clock = { wall: () => number; mono: () => number };

const SYSTEM_CLOCK: Clock = { wall: () => Date.now() / 1000, mono: () => performance.now() / 1000 };

export class Scheduler {
  state = new Map<string, State>();
  hooks = new Map<string, Hook>();
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly fire: (hook: Hook, event: JsonObject) => void,
    private readonly log: LogSink,
    private readonly clock: Clock = SYSTEM_CLOCK,
  ) {}

  setHooks(hooks: readonly Hook[]): void {
    const wanted = new Map(hooks.filter((hook) => hook.scheduled).map((hook) => [hook.name, hook]));
    for (const name of [...this.state.keys()]) {
      const previous = this.hooks.get(name);
      const next = wanted.get(name);
      if (previous === undefined || next === undefined || !previous.equals(next)) this.state.delete(name);
    }
    this.hooks = wanted;
    for (const [name, hook] of wanted) {
      if (this.state.has(name)) continue;
      if (hook.at !== null) this.state.set(name, { due: nextAt(hook, this.clock.wall()) });
      else this.state.set(name, { dueMono: this.clock.mono() + (hook.every as number), lastWall: this.clock.wall() });
    }
  }

  check(): JsonObject[] {
    const fired: JsonObject[] = [];
    const now = this.clock.wall();
    const mono = this.clock.mono();
    for (const [name, hook] of this.hooks) {
      const state = this.state.get(name) as State;
      if (hook.at !== null) {
        if (now < (state.due as number)) continue;
        const late = now - (state.due as number);
        fired.push(this.event(hook, state.due as number, "at", late > ON_TIME));
        state.due = nextAt(hook, now);
        continue;
      }
      const every = hook.every as number;
      const slept = now - (state.lastWall as number) >= every + ON_TIME && mono < (state.dueMono as number);
      if (mono >= (state.dueMono as number) || slept) {
        const scheduled = (state.lastWall as number) + every;
        fired.push(this.event(hook, scheduled, "every", slept || now - scheduled > ON_TIME));
        state.dueMono = mono + every;
        state.lastWall = now;
      }
    }
    for (const event of fired) {
      const data = event.get("data") as JsonObject;
      this.fire(this.hooks.get(data.get("hook") as string) as Hook, event);
    }
    return fired;
  }

  private event(hook: Hook, scheduled: number, kind: string, catchUp: boolean): JsonObject {
    const data = new Map<string, Value>([
      ["hook", hook.name],
      ["schedule", kind],
      ["occurrence", occurrence(hook, scheduled)],
      ["scheduledAt", BigInt(Math.trunc(scheduled * 1000))],
      ["catchUp", catchUp],
    ]);
    if (hook.at !== null) data.set("timezone", hook.timezone || zoneName(this.clock.wall()));
    return new Map<string, Value>([
      ["event", "schedule.fired"],
      ["time", BigInt(Math.trunc(this.clock.wall() * 1000))],
      ["data", data],
    ]);
  }

  waitTime(): number {
    const waits = [CHECK_INTERVAL];
    const now = this.clock.wall();
    const mono = this.clock.mono();
    for (const [name, hook] of this.hooks) {
      const state = this.state.get(name) as State;
      waits.push(hook.at !== null ? (state.due as number) - now : (state.dueMono as number) - mono);
    }
    return Math.max(Math.min(...waits), 0.05);
  }

  run(): Promise<void> {
    return new Promise((resolve) => {
      const tick = () => {
        if (this.stopped) {
          resolve();
          return;
        }
        try {
          this.check();
        } catch (error) {
          const name = error instanceof Error ? error.constructor.name : "Error";
          this.log.write(`schedules: ${name === "Error" ? "ValueError" : name}: ${error instanceof Error ? error.message : String(error)}`);
        }
        this.timer = setTimeout(tick, this.waitTime() * 1000);
      };
      this.stopResolve = resolve;
      tick();
    });
  }

  private stopResolve: (() => void) | undefined;

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.stopResolve?.();
  }
}
