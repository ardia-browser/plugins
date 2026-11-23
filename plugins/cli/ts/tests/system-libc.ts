import { dlopen, FFIType, ptr } from "bun:ffi";

const LIBRARY = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
const SEEK_CUR = 1;

const system = dlopen(LIBRARY, {
  strerror: { args: [FFIType.i32], returns: FFIType.cstring },
  lseek: { args: [FFIType.i32, FFIType.i64, FFIType.i32], returns: FFIType.i64 },
  pipe: { args: [FFIType.ptr], returns: FFIType.i32 },
});

export function systemStrerror(code: number): string {
  return String(system.symbols.strerror(code));
}

export function offsetOf(fd: number): number {
  const at = Number(system.symbols.lseek(fd, 0, SEEK_CUR));
  if (at < 0) throw new Error(`lseek(${fd}) failed`);
  return at;
}

export function systemPipe(): { read: number; write: number } {
  const ends = new Int32Array(2);
  if (system.symbols.pipe(ptr(ends)) !== 0) throw new Error("pipe() failed");
  return { read: ends[0] as number, write: ends[1] as number };
}
