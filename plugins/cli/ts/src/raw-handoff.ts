import { spawnSync } from "node:child_process";

const READ_SCRIPT = String.raw`
import os, struct, sys

def argv_of(pid):
    if sys.platform.startswith("linux"):
        raw = open(f"/proc/{pid}/cmdline", "rb").read()
        return raw.split(b"\0")[:-1]
    import ctypes
    libc = ctypes.CDLL(None, use_errno=True)
    value = ctypes.c_int(0)
    size = ctypes.c_size_t(ctypes.sizeof(value))
    if libc.sysctl((ctypes.c_int * 2)(1, 8), 2, ctypes.byref(value), ctypes.byref(size), None, ctypes.c_size_t(0)) != 0:
        raise OSError("no argmax")
    buffer = ctypes.create_string_buffer(value.value)
    size = ctypes.c_size_t(value.value)
    if libc.sysctl((ctypes.c_int * 3)(1, 49, pid), 3, buffer, ctypes.byref(size), None, ctypes.c_size_t(0)) != 0:
        raise OSError("no procargs")
    raw = buffer.raw[: size.value]
    argc = struct.unpack_from("=i", raw, 0)[0]
    rest = raw[4:]
    rest = rest[rest.index(b"\0"):].lstrip(b"\0")
    words = rest.split(b"\0")
    if argc < 1 or len(words) < argc:
        raise OSError("short procargs")
    return words[:argc]

args = argv_of(os.getppid())[1:]
entries = [key + b"=" + value for key, value in os.environb.items()]
sys.stdout.write(" ".join([str(len(args)), *(word.hex() for word in args), *(entry.hex() for entry in entries)]))
`;

const TRAMPOLINE = String.raw`
import os, sys
python = bytes.fromhex(sys.argv[1])
count = int(sys.argv[2])
words = [bytes.fromhex(word) for word in sys.argv[3:]]
environment = dict(entry.split(b"=", 1) for entry in words[count:] if b"=" in entry)
try:
    os.execve(python, [python, b"-I", b"-m", b"ardia_cli", *words[:count]], environment)
except OSError as error:
    sys.stderr.write(f"ardia: couldn't run {python.decode('utf-8', 'replace')}: {os.strerror(error.errno)}\n")
    sys.exit(127)
`;

export function rawWords(python: string): string[] | undefined {
  const done = spawnSync(python, ["-I", "-S", "-c", READ_SCRIPT], { stdio: ["ignore", "pipe", "ignore"], cwd: "/", timeout: 20_000 });
  if (done.status !== 0 || done.stdout === null) return undefined;
  const words = done.stdout.toString("latin1").split(" ");
  return words.length > 0 && /^[0-9]+$/.test(words[0] ?? "") ? words : undefined;
}

export function execWithRawBytes(python: string, words: string[]): void {
  const pythonHex = Buffer.from(python, "utf8").toString("hex");
  process.execve?.(python, [python, "-I", "-S", "-c", TRAMPOLINE, pythonHex, ...words], {});
}
