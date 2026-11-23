import { dlopen, FFIType, ptr } from "bun:ffi";

const FIOCLEX = process.platform === "darwin" ? 0x20006601 : 0x5451;
const LOCK_EX = 2;

const libc = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
  openpty: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  ioctl: { args: [FFIType.i32, FFIType.u64], returns: FFIType.i32 },
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  pipe: { args: [FFIType.ptr], returns: FFIType.i32 },
  shutdown: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  bind: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  listen: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  accept: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  recv: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i64 },
  send: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i64 },
  poll: { args: [FFIType.ptr, FFIType.u32, FFIType.i32], returns: FFIType.i32 },
  setsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
});

const DARWIN = process.platform === "darwin";
const AF_UNIX = 1;
const SOCK_STREAM = 1;
const SHUT_WR = 1;
const MSG_DONTWAIT = DARWIN ? 0x80 : 0x40;
const MSG_NOSIGNAL = DARWIN ? 0 : 0x4000;
const SOL_SOCKET = DARWIN ? 0xffff : 1;
const SO_NOSIGPIPE = 0x1022;
const POLLIN = 0x1;
const POLLOUT = 0x4;
const SUN_PATH = DARWIN ? 104 : 108;

export function shutdownWrites(fd: number): void {
  libc.symbols.shutdown(fd, SHUT_WR);
}

export function closeFd(fd: number): void {
  libc.symbols.close(fd);
}

function prepared(fd: number): number {
  closeOnExec(fd);
  if (DARWIN) libc.symbols.setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, ptr(new Int32Array([1])), 4);
  return fd;
}

export function listenUnix(path: string, backlog: number): number {
  const name = Buffer.from(path, "utf8");
  if (name.length >= SUN_PATH) throw new Error(`socket path too long: ${path}`);
  const address = Buffer.alloc(DARWIN ? 2 + SUN_PATH : 2 + SUN_PATH);
  if (DARWIN) {
    address[0] = address.length;
    address[1] = AF_UNIX;
  } else address.writeUInt16LE(AF_UNIX, 0);
  name.copy(address, 2);
  const fd = libc.symbols.socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) throw new Error("socket failed");
  prepared(fd);
  if (libc.symbols.bind(fd, ptr(address), address.length) !== 0 || libc.symbols.listen(fd, backlog) !== 0) {
    libc.symbols.close(fd);
    throw new Error(`could not listen on ${path}`);
  }
  return fd;
}

export function readiness(fd: number, events: number): number {
  const entry = new Int16Array(4);
  new Int32Array(entry.buffer, 0, 1)[0] = fd;
  entry[2] = events;
  const found = libc.symbols.poll(ptr(entry), 1, 0);
  return found > 0 ? entry[3]! : 0;
}

export const READABLE = POLLIN;
export const WRITABLE = POLLOUT;

export function acceptReady(listener: number): number | undefined {
  if (!readiness(listener, POLLIN)) return undefined;
  const fd = libc.symbols.accept(listener, null, null);
  return fd < 0 ? undefined : prepared(fd);
}

export function receive(fd: number, size: number): Buffer | null | undefined {
  if (!readiness(fd, POLLIN)) return undefined;
  const buffer = Buffer.alloc(size);
  const count = Number(libc.symbols.recv(fd, ptr(buffer), BigInt(size), MSG_DONTWAIT));
  if (count < 0) throw new Error("recv failed");
  return count === 0 ? null : buffer.subarray(0, count);
}

export function sendSome(fd: number, data: Buffer): number | undefined {
  if (!readiness(fd, POLLOUT)) return undefined;
  const count = Number(libc.symbols.send(fd, ptr(data), BigInt(data.length), MSG_DONTWAIT | MSG_NOSIGNAL));
  if (count < 0) throw new Error("send failed");
  return count;
}

function checked(result: number, what: string): void {
  if (result !== 0) throw new Error(`${what} failed`);
}

function closeOnExec(fd: number): number {
  checked(libc.symbols.ioctl(fd, BigInt(FIOCLEX)), "ioctl FIOCLEX");
  return fd;
}

export function openpty(): [number, number] {
  const leader = new Int32Array(1);
  const follower = new Int32Array(1);
  checked(libc.symbols.openpty(ptr(leader), ptr(follower), null, null, null), "openpty");
  return [closeOnExec(leader[0]!), closeOnExec(follower[0]!)];
}

export function lockExclusive(fd: number): void {
  checked(libc.symbols.flock(fd, LOCK_EX), "flock");
}

export type Pipe = { read: number; write: number };

export function pipe(): Pipe {
  const fds = new Int32Array(2);
  checked(libc.symbols.pipe(ptr(fds)), "pipe");
  return { read: closeOnExec(fds[0]!), write: closeOnExec(fds[1]!) };
}
