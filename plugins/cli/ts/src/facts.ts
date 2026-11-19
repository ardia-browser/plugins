import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { Process } from "./caller.ts";

export type Facts = { interruptsIgnored: boolean; peerUid: number | undefined; chain: Process[] };

const FACTS_SCRIPT = String.raw`
import ctypes, os, struct, sys

LINUX = sys.platform.startswith("linux")
SIGINT_BIT = 1 << 1
libc = ctypes.CDLL(None, use_errno=True)
libc.getsockopt.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32)]

def peer_uid():
    level, option, size = (1, 17, 12) if LINUX else (0, 1, 76)
    buffer = ctypes.create_string_buffer(size)
    length = ctypes.c_uint32(size)
    if libc.getsockopt(3, level, option, buffer, ctypes.byref(length)) != 0:
        return None
    if length.value < (12 if LINUX else 8):
        return None
    return struct.unpack_from("=I", buffer.raw, 4)[0]

def sysctl(mib, size):
    buffer = ctypes.create_string_buffer(size)
    length = ctypes.c_size_t(size)
    if libc.sysctl((ctypes.c_int * len(mib))(*mib), len(mib), buffer, ctypes.byref(length), None, ctypes.c_size_t(0)) != 0:
        return None
    return buffer.raw[: length.value]

def interrupts_ignored(pid):
    if LINUX:
        try:
            for line in open(f"/proc/{pid}/status"):
                if line.startswith("SigIgn:"):
                    return bool(int(line.split()[1], 16) & SIGINT_BIT)
        except (OSError, ValueError, IndexError):
            return False
        return False
    info = sysctl([1, 14, 1, pid], 1024)
    return info is not None and len(info) >= 236 and bool(struct.unpack_from("=I", info, 232)[0] & SIGINT_BIT)

class LibProc:
    def __init__(self):
        self.lib = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        self.info = ctypes.create_string_buffer(64)
        self.path_buffer = ctypes.create_string_buffer(4096)
        most = sysctl([1, 8], ctypes.sizeof(ctypes.c_int))
        value = struct.unpack("=i", most)[0] if most is not None and len(most) == 4 else 0
        self.args_size = 256 * 1024 if value <= 0 else min(value, 256 * 1024)

    def parent(self, pid):
        if self.lib.proc_pidinfo(pid, 13, ctypes.c_uint64(0), self.info, 64) != 64:
            return None
        return struct.unpack_from("=I", self.info.raw, 4)[0]

    def path(self, pid):
        size = self.lib.proc_pidpath(pid, self.path_buffer, 4096)
        return self.path_buffer.raw[:size] if size > 0 else b""

    def argv(self, pid):
        raw = sysctl([1, 49, pid], self.args_size)
        if raw is None or len(raw) < 4:
            return []
        argc = struct.unpack_from("=i", raw, 0)[0]
        rest = raw[4:]
        end = rest.find(b"\0")
        if end < 0:
            return []
        return rest[end:].lstrip(b"\0").split(b"\0")[: max(0, min(argc, 2))]

class ProcFs:
    def parent(self, pid):
        try:
            raw = open(f"/proc/{pid}/stat", "rb").read()
            return int(raw[raw.rindex(b")") + 1:].split()[1])
        except (OSError, ValueError, IndexError):
            return None

    def path(self, pid):
        try:
            target = os.readlink(f"/proc/{pid}/exe".encode())
        except OSError:
            return b""
        return target[: -len(b" (deleted)")] if target.endswith(b" (deleted)") else target

    def argv(self, pid):
        try:
            raw = open(f"/proc/{pid}/cmdline", "rb").read()
        except OSError:
            return []
        return [word for word in raw.split(b"\0")[:2] if word]

def chain(start):
    try:
        reader = ProcFs() if LINUX else LibProc()
    except OSError:
        return
    seen, pid, depth = set(), start, 0
    while pid > 1 and pid not in seen and depth < 64:
        seen.add(pid)
        ppid = reader.parent(pid)
        if ppid is None:
            return
        words = reader.argv(pid)
        yield " ".join([str(pid), str(ppid), "x" + reader.path(pid).hex(), str(len(words)), *("x" + word.hex() for word in words)])
        pid = ppid
        depth += 1

peer = peer_uid()
head = ("1" if interrupts_ignored(int(sys.argv[1])) else "0") + " " + ("-" if peer is None else str(peer))
sys.stdout.write("\n".join([head, *chain(int(sys.argv[2]))]) + "\n")
`;

function text(word: string | undefined): string {
  return new TextDecoder().decode(Buffer.from((word ?? "x").slice(1), "hex"));
}

function processOf(line: string): Process {
  const [pid, ppid, path, count, ...argv] = line.split(" ");
  return { pid: Number(pid), ppid: Number(ppid), path: text(path), argv: argv.slice(0, Number(count)).map(text) };
}

export function askPython(python: string | null, socketFd: number): Facts | undefined {
  if (python === null || !existsSync(python)) return undefined;
  const done = spawnSync(python, ["-I", "-S", "-c", FACTS_SCRIPT, String(process.pid), String(process.ppid)], {
    stdio: ["ignore", "pipe", "ignore", socketFd],
    cwd: "/",
    env: {},
    timeout: 20_000,
  });
  if (done.status !== 0 || done.stdout === null) return undefined;
  const [head = "", ...rest] = done.stdout.toString("latin1").split("\n").filter((line) => line !== "");
  const [ignored, peer] = head.split(" ");
  if ((ignored !== "0" && ignored !== "1") || peer === undefined || (peer !== "-" && !/^[0-9]+$/.test(peer))) return undefined;
  return { interruptsIgnored: ignored === "1", peerUid: peer === "-" ? undefined : Number(peer), chain: rest.map(processOf) };
}
