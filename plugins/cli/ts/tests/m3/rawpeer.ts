import { createHash } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";

export const TEXT = 0x1;
export const BINARY = 0x2;
export const CLOSE = 0x8;
export const PING = 0x9;
export const PONG = 0xa;

export type Received = { opcode: number; payload: Buffer };
export type Conn = {
  socket: Socket;
  head: string;
  frames: Received[];
  messages: Record<string, any>[];
  send(message: unknown): void;
  text(text: string): void;
  frame(opcode: number, payload: Buffer | string, fin?: boolean): Buffer;
  write(...chunks: Buffer[]): void;
  close(code: number, reason?: string): void;
};

export function frame(opcode: number, payload: Buffer | string, fin = true): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const first = (fin ? 0x80 : 0) | opcode;
  let head: Buffer;
  if (body.length < 126) head = Buffer.from([first, body.length]);
  else if (body.length < 65536) {
    head = Buffer.alloc(4);
    head[0] = first;
    head[1] = 126;
    head.writeUInt16BE(body.length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = first;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([head, body]);
}

function acceptKey(head: string): string {
  const key = /^sec-websocket-key:\s*(.+)$/im.exec(head)?.[1]?.trim() ?? "";
  return createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
}

export class RawPeer {
  readonly conns: Conn[] = [];
  private server: Server | null = null;
  port = 0;

  constructor(
    private readonly onMessage: (message: Record<string, any>, conn: Conn) => void = () => {},
    private readonly handshake: (head: string, socket: Socket) => boolean = () => true,
  ) {}

  async start(): Promise<this> {
    this.server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as { port: number }).port;
    return this;
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}/devtools/browser/x?token=t`;
  }

  get messages(): Record<string, any>[] {
    return this.conns.flatMap((conn) => conn.messages);
  }

  methods(name: string): Record<string, any>[] {
    return this.messages.filter((message) => message["method"] === name);
  }

  async stop(): Promise<void> {
    for (const conn of this.conns) conn.socket.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private accept(socket: Socket): void {
    let buffer: Buffer = Buffer.alloc(0);
    let conn: Conn | null = null;
    socket.on("error", () => {});
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (conn === null) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = buffer.subarray(0, end + 4).toString("latin1");
        buffer = buffer.subarray(end + 4);
        if (!this.handshake(head, socket)) return;
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(head)}\r\n\r\n`);
        conn = this.makeConn(socket, head);
        this.conns.push(conn);
      }
      buffer = this.parse(conn, buffer);
    });
  }

  private makeConn(socket: Socket, head: string): Conn {
    const write = (...chunks: Buffer[]) => {
      if (!socket.destroyed) socket.write(Buffer.concat(chunks));
    };
    return {
      socket,
      head,
      frames: [],
      messages: [],
      frame,
      write,
      send: (message) => write(frame(TEXT, JSON.stringify(message))),
      text: (text) => write(frame(TEXT, text)),
      close: (code, reason = "") => {
        const payload = Buffer.alloc(2);
        payload.writeUInt16BE(code);
        write(frame(CLOSE, Buffer.concat([payload, Buffer.from(reason)])));
        setTimeout(() => socket.end(), 20);
      },
    };
  }

  private parse(conn: Conn, buffer: Buffer): Buffer {
    while (buffer.length >= 2) {
      const opcode = (buffer[0] as number) & 0x0f;
      let length = (buffer[1] as number) & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) break;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) break;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (buffer.length < offset + 4 + length) break;
      const key = buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
      for (let index = 0; index < payload.length; index++) payload[index] = (payload[index] as number) ^ (key[index % 4] as number);
      buffer = buffer.subarray(offset + 4 + length);
      conn.frames.push({ opcode, payload });
      if (opcode === CLOSE) {
        conn.write(frame(CLOSE, payload.subarray(0, 2)));
        setTimeout(() => conn.socket.end(), 10);
      } else if (opcode === TEXT || opcode === BINARY) {
        const message = JSON.parse(payload.toString("utf8")) as Record<string, any>;
        conn.messages.push(message);
        this.onMessage(message, conn);
      }
    }
    return buffer;
  }
}

export function echo(message: Record<string, any>, conn: Conn): void {
  conn.send({ id: message["id"], result: { echo: message["params"] ?? null } });
}

export async function until(check: () => boolean, seconds = 5): Promise<void> {
  const deadline = performance.now() + seconds * 1000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}
