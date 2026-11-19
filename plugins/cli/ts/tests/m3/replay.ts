import { type Entry, parse, replaceAll, requestForm } from "./canon.ts";

type Recorded = {
  index: number;
  id: number;
  session: string;
  form: string;
  group: number;
  consumed: boolean;
  skipped: boolean;
  liveId: number;
  response: Outgoing | null;
};
type Outgoing = { kind: "message" | "close"; text: string; respondsTo: Recorded | null; after: number; delay: number; code: number; sent: boolean };
type Found = { hit: Recorded } | { repeat: Recorded };

export type ReplayHooks = {
  batch(work: () => void): void;
  send(text: string): void;
  close(code: number): void;
  fail(report: string): void;
  note(kind: string, form: string): void;
};

export type Elastic = { lookahead: number; repeats(form: string): boolean };

const DELAY_CAP_MS = 2000;
const STALL_MS = 10000;
const HOIST_MS = 50;
const HOIST_WINDOW = 400;
const RESPONSE_ID = /^\{"id":(\d+),/;

export class ReplayConn {
  private readonly requests: Recorded[] = [];
  private readonly outgoing: Outgoing[] = [];
  private readonly happened = new Map<number, number>();
  private readonly groups = new Map<string, number[]>();
  private readonly members = new Map<number, Recorded[]>();
  private readonly position = new Map<string, number>();
  private cursor = 0;
  private lastEmit: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stall: ReturnType<typeof setTimeout> | null = null;
  private hoistTimer: ReturnType<typeof setTimeout> | null = null;
  private failed = false;

  constructor(entries: Entry[], private readonly hooks: ReplayHooks, private readonly elastic: Elastic, from: string | undefined, to: string | undefined,
              private readonly paced = false) {
    this.lastEmit = performance.now();
    const outstanding = new Map<string, Set<number>>();
    const byId = new Map<number, Recorded>();
    let lastOut = -1;
    let previousT = entries[0]?.t ?? 0;
    entries.forEach((entry, index) => {
      const t = entry.t ?? previousT;
      const gap = Math.max(0, Math.min(t - previousT, DELAY_CAP_MS));
      previousT = t;
      if (entry.k === "out" && entry.m !== undefined) {
        const message = parse(replaceAll(entry.m, from, to));
        if (!message || message.id === undefined || !message.method) return;
        const session = message.sessionId ?? "";
        const open = outstanding.get(session) ?? new Set<number>();
        outstanding.set(session, open);
        const list = this.groups.get(session) ?? [];
        this.groups.set(session, list);
        if (open.size === 0 || list.length === 0) list.push(index);
        open.add(message.id);
        const group = list[list.length - 1] ?? index;
        const recorded: Recorded = { index, id: message.id, session, form: requestForm(message), group, consumed: false, skipped: false, liveId: -1, response: null };
        this.requests.push(recorded);
        this.members.set(group, [...(this.members.get(group) ?? []), recorded]);
        byId.set(message.id, recorded);
        lastOut = index;
      } else if (entry.k === "in" && entry.m !== undefined) {
        const text = replaceAll(entry.m, from, to);
        const id = RESPONSE_ID.exec(text)?.[1] ?? parse(text)?.id?.toString();
        const respondsTo = id === undefined ? null : byId.get(Number(id)) ?? null;
        if (respondsTo) outstanding.get(respondsTo.session)?.delete(respondsTo.id);
        const item: Outgoing = { kind: "message", text, respondsTo, after: lastOut, delay: gap, code: 0, sent: false };
        if (respondsTo) respondsTo.response = item;
        this.outgoing.push(item);
      } else if (entry.k === "close" && entry.by === "browser") {
        this.outgoing.push({ kind: "close", text: "", respondsTo: null, after: lastOut, delay: gap, code: entry.code ?? 1006, sent: false });
      }
    });
  }

  start(): void {
    this.pump();
  }

  remaining(): string[] {
    return this.requests.filter((request) => !request.consumed && !request.skipped && !this.elastic.repeats(request.form)).map((request) => request.form);
  }

  request(text: string): void {
    if (this.failed) return;
    const message = parse(text);
    if (!message || message.id === undefined || !message.method) return;
    const session = message.sessionId ?? "";
    const form = requestForm(message);
    const found = this.find(session, form);
    if (!found) {
      this.fail(session, form);
      return;
    }
    if ("repeat" in found) {
      const answer = found.repeat.response;
      this.hooks.note("repeat", form);
      if (answer) this.hooks.batch(() => this.hooks.send(this.withId(answer.text, message.id ?? 0)));
      return;
    }
    found.hit.consumed = true;
    found.hit.liveId = message.id;
    this.happened.set(found.hit.index, performance.now());
    this.skipPassedProbes(found.hit.index);
    this.pump();
  }

  private open(group: number): Recorded[] {
    return (this.members.get(group) ?? []).filter((request) => !request.consumed && !request.skipped);
  }

  private startOf(session: string): number {
    const list = this.groups.get(session) ?? [];
    let at = this.position.get(session) ?? 0;
    while (at < list.length && this.open(list[at] ?? -1).length === 0) at += 1;
    this.position.set(session, at);
    return at;
  }

  private find(session: string, form: string): Found | null {
    const list = this.groups.get(session) ?? [];
    const start = this.startOf(session);
    for (let at = start; at < list.length && at <= start + this.elastic.lookahead; at += 1) {
      const hit = this.open(list[at] ?? -1).find((request) => request.form === form);
      if (!hit) continue;
      for (let before = start; before < at; before += 1) {
        for (const request of this.open(list[before] ?? -1)) {
          if (!this.elastic.repeats(request.form)) continue;
          request.skipped = true;
          this.happened.set(request.index, performance.now());
          this.hooks.note("skipped", request.form);
        }
      }
      this.startOf(session);
      return { hit };
    }
    if (!this.elastic.repeats(form)) return null;
    const same = this.requests.filter((request) => request.session === session && request.form === form && request.response);
    const repeat = [...same].reverse().find((request) => request.consumed) ?? same[0];
    return repeat ? { repeat } : null;
  }

  private fail(session: string, form: string): void {
    this.failed = true;
    const list = this.groups.get(session) ?? [];
    const start = this.startOf(session);
    const expected = list.slice(start, start + this.elastic.lookahead + 1).flatMap((group) => this.open(group));
    const lines = [`unexpected request on session ${JSON.stringify(session)}:`, `  actual:   ${form}`, "  expected one of:"];
    for (const request of expected.slice(0, 8)) lines.push(`    ${request.form.slice(0, 600)}`);
    if (expected.length === 0) lines.push("    (nothing more was recorded on this session)");
    this.hooks.fail(lines.join("\n"));
    this.hooks.close(4000);
  }

  private dropped(item: Outgoing): boolean {
    return item.sent || (item.respondsTo?.skipped ?? false);
  }

  private ready(item: Outgoing): number | null {
    if (item.after >= 0 && !this.happened.has(item.after)) return null;
    if (item.respondsTo && !item.respondsTo.consumed) return null;
    if (!this.paced) return 0;
    return Math.max(item.after >= 0 ? this.happened.get(item.after) ?? 0 : 0, this.lastEmit) + item.delay;
  }

  private pump(): void {
    if (this.timer || this.failed) return;
    this.hooks.batch(() => this.drain());
  }

  private drain(): void {
    while (this.cursor < this.outgoing.length) {
      const item = this.outgoing[this.cursor];
      if (!item) return;
      if (this.dropped(item)) {
        this.cursor += 1;
        continue;
      }
      const due = this.ready(item);
      if (due === null) {
        this.blocked();
        return;
      }
      const now = performance.now();
      if (due > now) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.pump();
        }, due - now);
        return;
      }
      this.clearTimers();
      this.cursor += 1;
      this.lastEmit = now;
      this.emit(item);
      if (item.kind === "close") return;
    }
  }

  private emit(item: Outgoing): void {
    item.sent = true;
    if (item.kind === "close") this.hooks.close(item.code);
    else this.hooks.send(item.respondsTo ? this.withId(item.text, item.respondsTo.liveId) : item.text);
  }

  private blocked(): void {
    const at = this.cursor;
    if (!this.hoistTimer) {
      this.hoistTimer = setTimeout(() => {
        this.hoistTimer = null;
        if (this.cursor !== at || this.failed) return;
        if (this.skipElasticBlockers(at)) {
          this.pump();
          return;
        }
        this.hooks.batch(() => {
          const end = Math.min(this.outgoing.length, at + HOIST_WINDOW);
          for (let index = at + 1; index < end; index += 1) {
            const item = this.outgoing[index];
            if (item && !this.dropped(item) && item.respondsTo?.consumed) {
              this.hooks.note("hoisted", item.respondsTo.form);
              this.emit(item);
            }
          }
        });
      }, HOIST_MS);
    }
    this.watchStall();
  }

  private skipPassedProbes(index: number): void {
    for (const request of this.requests) {
      if (request.index >= index) return;
      if (request.consumed || request.skipped || !this.elastic.repeats(request.form)) continue;
      request.skipped = true;
      this.happened.set(request.index, performance.now());
      this.hooks.note("skipped", request.form);
    }
  }

  private skipElasticBlockers(at: number): boolean {
    const head = this.outgoing[at];
    if (!head) return false;
    if (!this.requests.some((request) => request.consumed && request.response && !request.response.sent)) return false;
    const limit = Math.max(head.after, head.respondsTo?.index ?? -1);
    const blockers = this.requests.filter((request) => request.index <= limit && !request.consumed && !request.skipped && this.elastic.repeats(request.form));
    if (blockers.length === 0) return false;
    for (const request of blockers) {
      request.skipped = true;
      this.happened.set(request.index, performance.now());
      this.hooks.note("skipped", request.form);
    }
    return true;
  }

  private withId(text: string, id: number): string {
    if (RESPONSE_ID.test(text)) return text.replace(RESPONSE_ID, `{"id":${id},`);
    const message = parse(text) ?? {};
    return JSON.stringify({ ...message, id });
  }

  private watchStall(): void {
    if (this.stall) return;
    this.stall = setTimeout(() => {
      this.stall = null;
      const item = this.outgoing[this.cursor];
      const waiting = this.requests.filter((request) => request.consumed && !request.response?.sent);
      if (item && waiting.length > 0) {
        const blocker = this.requests.find((request) => request.index <= item.after && !request.consumed && !request.skipped);
        const own = item.respondsTo ? ` (it answers ${item.respondsTo.form.slice(0, 200)}, consumed ${item.respondsTo.consumed}, skipped ${item.respondsTo.skipped})` : "";
        const waits = waiting.map((request) => request.form.slice(0, 200)).join(" | ");
        this.failed = true;
        this.hooks.fail(`replay stalled: the daemon waits on ${waiting.length} answer(s) [${waits}], and the recording's next message${own} waits on a request it never sent: ${blocker?.form.slice(0, 600) ?? "(none)"}`);
        this.hooks.close(4001);
      }
    }, STALL_MS);
  }

  private clearTimers(): void {
    if (this.stall) clearTimeout(this.stall);
    if (this.hoistTimer) clearTimeout(this.hoistTimer);
    this.stall = null;
    this.hoistTimer = null;
  }
}
