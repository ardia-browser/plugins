import net from "node:net";
import { peerUid } from "../../libc.ts";
import { uid } from "../../paths.ts";
import { type Caller, PROTOCOL, wire } from "../daemon/announce.ts";
import { type AppTabState, ControlRefused, controlSocket, MethodUnknown, NotConnected, socketProblem } from "./apptabs.ts";
import { record } from "./records.ts";

export const LINK_OPEN_TIMEOUT = 5;
const MAX_LINE = 4 * 1024 * 1024;
const HELLO_ID = 1;

type Waiting = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

export class ControlLink {
  private buffer = Buffer.alloc(0);
  private readonly waiting = new Map<number, Waiting>();
  private nextId = HELLO_ID + 1;
  private closedWith: Error | null = null;
  private readonly closeListeners: (() => void)[] = [];

  private constructor(private readonly socket: net.Socket) {}

  get closed(): boolean {
    return this.closedWith !== null;
  }

  onClose(listener: () => void): void {
    if (this.closed) listener();
    else this.closeListeners.push(listener);
  }

  static open(file: string, caller: Caller | null, timeout = LINK_OPEN_TIMEOUT): Promise<ControlLink> {
    const problem = socketProblem(file);
    if (problem === "missing") return Promise.reject(new NotConnected("the control socket isn't there"));
    if (problem === "unsafe") return Promise.reject(new ControlRefused("unsafe", "the control socket isn't a socket the user owns"));
    return new Promise<ControlLink>((resolve, reject) => {
      const socket = net.connect(file);
      const link = new ControlLink(socket);
      let greeted = false;
      const timer = setTimeout(() => link.fail(new ControlRefused("timeout", "the control socket didn't answer hello in time")), timeout * 1000);
      link.waiting.set(HELLO_ID, {
        timer,
        resolve: (result) => {
          if (record(result)["app"] !== "Ardia") {
            const wrong = new ControlRefused("unreachable", "something other than Ardia answers on the control socket");
            reject(wrong);
            link.fail(wrong);
            return;
          }
          greeted = true;
          resolve(link);
        },
        reject: (error) => {
          if (greeted) return;
          reject(error);
          link.fail(error);
        },
      });
      socket.on("error", (error) => link.fail(greeted ? new ControlRefused("unreachable", error.message) : new NotConnected(error.message)));
      socket.on("close", () => link.fail(new ControlRefused("unreachable", "the control socket closed")));
      socket.on("data", (chunk: Buffer) => link.take(chunk));
      socket.once("connect", () => {
        const fd = (socket as unknown as { _handle?: { fd?: unknown } })._handle?.fd;
        let peer: number | null = null;
        try {
          peer = typeof fd === "number" ? peerUid(fd) : null;
        } catch {}
        if (peer !== uid()) {
          link.fail(new ControlRefused("unreachable", "the control socket is served by another user"));
          return;
        }
        const hello: Record<string, unknown> = { protocol: PROTOCOL };
        if (caller !== null) hello["caller"] = wire(caller);
        socket.write(`${JSON.stringify({ id: HELLO_ID, method: "hello", params: hello })}\n`);
      });
    });
  }

  call(method: string, params: Record<string, unknown> | null, timeout: number): Promise<unknown> {
    if (this.closedWith !== null) return Promise.reject(this.closedWith);
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new ControlRefused("timeout", `the control socket didn't answer ${method} in time`));
      }, timeout * 1000);
      this.waiting.set(id, { resolve, reject, timer });
      const request: Record<string, unknown> = { id, method };
      if (params !== null) request["params"] = params;
      this.socket.write(`${JSON.stringify(request)}\n`);
    });
  }

  close(): void {
    this.fail(new ControlRefused("unreachable", "the control link was closed"));
  }

  private take(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_LINE) {
      this.fail(new ControlRefused("too_long", "the control socket's answer is too long"));
      return;
    }
    for (let at = this.buffer.indexOf(0x0a); at >= 0; at = this.buffer.indexOf(0x0a)) {
      const line = this.buffer.subarray(0, at).toString("utf8");
      this.buffer = this.buffer.subarray(at + 1);
      let reply: Record<string, unknown>;
      try {
        reply = record(JSON.parse(line));
      } catch {
        this.fail(new ControlRefused("bad_reply", "the control socket's answer isn't JSON"));
        return;
      }
      const failed = record(reply["error"]);
      if (reply["id"] === null && reply["error"] !== undefined) {
        this.fail(new ControlRefused("refused", String(failed["message"] || "Ardia turned this program away")));
        return;
      }
      if (typeof reply["id"] !== "number") continue;
      const waiter = this.waiting.get(reply["id"]);
      if (waiter === undefined) continue;
      this.waiting.delete(reply["id"]);
      clearTimeout(waiter.timer);
      if (reply["error"] === undefined) {
        waiter.resolve(reply["result"] ?? null);
        continue;
      }
      const code = String(failed["code"] || "failed");
      const message = String(failed["message"] || "failed");
      waiter.reject(reply["id"] === HELLO_ID ? new ControlRefused("unreachable", "something other than Ardia answers on the control socket") : code === "unknown_method" ? new MethodUnknown(message) : new ControlRefused(code === "not_connected" ? "failed" : code, message));
    }
  }

  private fail(error: Error): void {
    if (this.closedWith !== null) return;
    this.closedWith = error;
    this.socket.destroy();
    for (const [, waiter] of this.waiting) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiting.clear();
    for (const listener of this.closeListeners.splice(0)) listener();
  }
}

export async function openLink(state: AppTabState): Promise<ControlLink | null> {
  const file = controlSocket(state);
  if (file === null) return null;
  return ControlLink.open(file, state.caller);
}
