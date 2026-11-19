declare namespace Bun {
  interface Socket {
    write(data: Uint8Array): number;
    end(): void;
    terminate(): void;
  }
  interface SocketHandlers {
    open?(socket: Socket): void;
    data?(socket: Socket, data: Uint8Array): void;
    drain?(socket: Socket): void;
    end?(socket: Socket): void;
    close?(socket: Socket, error?: Error): void;
    error?(socket: Socket, error: Error): void;
  }
  function connect(options: { fd: number; allowHalfOpen?: boolean; socket: SocketHandlers }): Promise<Socket>;
}
