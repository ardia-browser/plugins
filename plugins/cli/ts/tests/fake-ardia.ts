import net from "node:net";

export type Request = { method: string; params: Record<string, unknown> | undefined };
type Reply = (params: Record<string, unknown> | undefined) => unknown;

export class FakeArdia {
  requests: Request[] = [];
  subscribers = new Set<net.Socket>();
  sockets = new Set<net.Socket>();
  connections = 0;
  replies = new Map<string, Reply>();
  private server: net.Server;

  constructor(readonly path: string) {
    this.server = net.createServer((socket) => this.client(socket));
  }

  start(): Promise<this> {
    return new Promise((resolve) => this.server.listen(this.path, () => resolve(this)));
  }

  private client(socket: net.Socket): void {
    this.connections += 1;
    this.sockets.add(socket);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const request = JSON.parse(line) as { id: number; method: string; params?: Record<string, unknown> };
        this.requests.push({ method: request.method, params: request.params });
        socket.write(`${JSON.stringify({ id: request.id, result: this.answer(request.method, request.params, socket) })}\n`);
      }
    });
    socket.on("close", () => {
      this.subscribers.delete(socket);
      this.sockets.delete(socket);
    });
    socket.on("error", () => {});
  }

  private answer(method: string, params: Record<string, unknown> | undefined, socket: net.Socket): unknown {
    const custom = this.replies.get(method);
    if (custom !== undefined) return custom(params);
    if (method === "hello") return { app: "Ardia", version: "9.9", protocol: 4 };
    if (method === "subscribe") {
      this.subscribers.add(socket);
      const hooks = (params?.hooks as { name: string }[] | undefined) ?? [];
      return { revisions: Object.fromEntries(hooks.map((hook) => [hook.name, `rev-${hook.name}`])), served: hooks.map((hook) => hook.name) };
    }
    if (method === "commands") return [{ id: "newTab", scope: "window" }, { id: "reload", scope: "page" }];
    return true;
  }

  send(message: unknown): void {
    const line = `${JSON.stringify(message)}\n`;
    for (const socket of this.subscribers) socket.write(line);
  }

  of(method: string): Request[] {
    return this.requests.filter((request) => request.method === method);
  }

  dropClients(): void {
    for (const socket of this.sockets) socket.destroy();
  }

  stop(): Promise<void> {
    this.dropClients();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

export async function until(check: () => boolean, seconds = 5): Promise<void> {
  const deadline = performance.now() + seconds * 1000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
