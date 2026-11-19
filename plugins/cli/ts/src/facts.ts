import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { Process } from "./caller.ts";

export type Facts = { interruptsIgnored: boolean; peerUid: number | undefined; chain: Process[] };

const FACTS_SCRIPT = String.raw`
import json, signal, socket, struct, sys

def peer_uid():
    try:
        sock = socket.socket(fileno=3)
    except OSError:
        return None
    try:
        if sys.platform.startswith("linux"):
            raw = sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
            return struct.unpack_from("=iII", raw)[1] if len(raw) >= 12 else None
        raw = sock.getsockopt(0, 1, 76)
        return struct.unpack_from("=II", raw)[1] if len(raw) >= 8 else None
    except OSError:
        return None
    finally:
        sock.detach()

class LibProc:
    def __init__(self):
        import ctypes
        self.ctypes = ctypes
        self.lib = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        self.libc = ctypes.CDLL(None, use_errno=True)
        self.info = ctypes.create_string_buffer(64)
        self.path_buffer = ctypes.create_string_buffer(4096)
        value = ctypes.c_int(0)
        size = ctypes.c_size_t(ctypes.sizeof(value))
        mib = (ctypes.c_int * 2)(1, 8)
        failed = self.libc.sysctl(mib, 2, ctypes.byref(value), ctypes.byref(size), None, ctypes.c_size_t(0)) != 0 or value.value <= 0
        self.args_size = 256 * 1024 if failed else min(value.value, 256 * 1024)
        self.args = ctypes.create_string_buffer(self.args_size)

    def parent(self, pid):
        if self.lib.proc_pidinfo(pid, 13, self.ctypes.c_uint64(0), self.info, 64) != 64:
            return None
        return struct.unpack_from("=I", self.info.raw, 4)[0]

    def path(self, pid):
        size = self.lib.proc_pidpath(pid, self.path_buffer, 4096)
        return self.path_buffer.raw[:size] if size > 0 else b""

    def argv(self, pid):
        ctypes = self.ctypes
        mib = (ctypes.c_int * 3)(1, 49, pid)
        size = ctypes.c_size_t(self.args_size)
        if self.libc.sysctl(mib, 3, self.args, ctypes.byref(size), None, ctypes.c_size_t(0)) != 0 or size.value < 4:
            return []
        raw = self.args.raw[: size.value]
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
            fields = raw[raw.rindex(b")") + 1:].split()
            return int(fields[1])
        except (OSError, ValueError, IndexError):
            return None

    def path(self, pid):
        import os
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
        reader = ProcFs() if sys.platform.startswith("linux") else LibProc()
    except OSError:
        return []
    out, seen, pid = [], set(), start
    while pid > 1 and pid not in seen and len(out) < 64:
        seen.add(pid)
        ppid = reader.parent(pid)
        if ppid is None:
            break
        out.append([pid, ppid, reader.path(pid).hex(), [word.hex() for word in reader.argv(pid)]])
        pid = ppid
    return out

ignored = signal.getsignal(signal.SIGINT) == signal.SIG_IGN
sys.stdout.write(json.dumps({"ignored": ignored, "peer": peer_uid(), "chain": chain(int(sys.argv[1]))}))
`;

function text(hex: unknown): string {
  return typeof hex === "string" ? new TextDecoder().decode(Buffer.from(hex, "hex")) : "";
}

function chainOf(rows: unknown): Process[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((row: unknown[]) => ({
    pid: Number(row[0]),
    ppid: Number(row[1]),
    path: text(row[2]),
    argv: Array.isArray(row[3]) ? row[3].map(text) : [],
  }));
}

export function askPython(python: string | null, socketFd: number): Facts | undefined {
  if (python === null || !existsSync(python)) return undefined;
  const done = spawnSync(python, ["-I", "-S", "-c", FACTS_SCRIPT, String(process.ppid)], {
    stdio: ["ignore", "pipe", "ignore", socketFd],
    cwd: "/",
    env: {},
    timeout: 20_000,
  });
  if (done.status !== 0 || done.stdout === null) return undefined;
  try {
    const answer = JSON.parse(done.stdout.toString("utf8")) as { ignored?: unknown; peer?: unknown; chain?: unknown };
    return {
      interruptsIgnored: answer.ignored === true,
      peerUid: typeof answer.peer === "number" ? answer.peer : undefined,
      chain: chainOf(answer.chain),
    };
  } catch {
    return undefined;
  }
}
