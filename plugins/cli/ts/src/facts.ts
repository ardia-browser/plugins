import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const PEER_UID_SCRIPT = String.raw`
import ctypes, struct, sys

LINUX = sys.platform.startswith("linux")
libc = ctypes.CDLL(None, use_errno=True)
libc.getsockopt.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32)]
level, option, size = (1, 17, 12) if LINUX else (0, 1, 76)
buffer = ctypes.create_string_buffer(size)
length = ctypes.c_uint32(size)
if libc.getsockopt(3, level, option, buffer, ctypes.byref(length)) != 0 or length.value < (12 if LINUX else 8):
    sys.exit(1)
sys.stdout.write(str(struct.unpack_from("=I", buffer.raw, 4)[0]) + "\n")
`;

export function peerUid(python: string | null, socketFd: number): Promise<number | undefined> {
  if (python === null || !existsSync(python)) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let child;
    try {
      child = spawn(python, ["-I", "-S", "-c", PEER_UID_SCRIPT], { stdio: ["ignore", "pipe", "ignore", socketFd], cwd: "/", env: {}, timeout: 20_000 });
    } catch {
      resolve(undefined);
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", () => resolve(undefined));
    child.once("close", (code) => {
      const text = Buffer.concat(chunks).toString("latin1").trim();
      resolve(code === 0 && /^[0-9]+$/.test(text) ? Number(text) : undefined);
    });
  });
}
