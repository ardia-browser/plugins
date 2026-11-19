import { closeSync, constants, mkdtempSync, openSync, readFileSync, rmdirSync, unlinkSync, writeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TRAMPOLINE = String.raw`
import os, sys
python, folder, lease = (bytes.fromhex(word) for word in sys.argv[1:4])
parcel = os.path.join(folder, b"parcel")

def give_up(reason):
    sys.stderr.write(f"ardia: couldn't run {python.decode('utf-8', 'replace')}: {reason}\n")
    if lease:
        try:
            os.unlink(lease)
        except OSError:
            pass
    sys.exit(127)

try:
    with open(parcel, "rb") as source:
        data = source.read()
except OSError as error:
    data = None
    reason = os.strerror(error.errno or 0)
finally:
    for path, remove in ((parcel, os.unlink), (folder, os.rmdir)):
        try:
            remove(path)
        except OSError:
            pass
if data is None:
    give_up(reason)
count, _, rest = data.partition(b"\0")
words = rest.split(b"\0")[:-1]
args = words[: int(count)]
environment = dict(entry.split(b"=", 1) for entry in words[int(count):] if b"=" in entry)
try:
    os.execve(python, [python, b"-I", b"-m", b"ardia_cli", *args], environment)
except OSError as error:
    give_up(os.strerror(error.errno))
`;

const WRITER = String.raw`
import ctypes, os, struct, sys

def private_root():
    try:
        libc = ctypes.CDLL(None)
        buffer = ctypes.create_string_buffer(1024)
        size = libc.confstr(65537, buffer, 1024)
        if 1 < size <= 1024:
            return buffer.value
    except OSError:
        pass
    return None

def parent_argv(pid):
    libc = ctypes.CDLL(None, use_errno=True)
    most = ctypes.c_int(0)
    size = ctypes.c_size_t(ctypes.sizeof(most))
    if libc.sysctl((ctypes.c_int * 2)(1, 8), 2, ctypes.byref(most), ctypes.byref(size), None, ctypes.c_size_t(0)) != 0 or most.value <= 0:
        return None
    buffer = ctypes.create_string_buffer(most.value)
    size = ctypes.c_size_t(most.value)
    if libc.sysctl((ctypes.c_int * 3)(1, 49, pid), 3, buffer, ctypes.byref(size), None, ctypes.c_size_t(0)) != 0 or size.value < 4:
        return None
    raw = buffer.raw[: size.value]
    argc = struct.unpack_from("=i", raw, 0)[0]
    rest = raw[4:]
    end = rest.find(b"\0")
    if argc < 1 or end < 0:
        return None
    words = rest[end:].lstrip(b"\0").split(b"\0")
    return words[:argc] if len(words) > argc else None

argv = parent_argv(os.getppid())
if argv is None:
    sys.exit(3)
body = b"".join([str(len(argv) - 1).encode(), b"\0", *(word + b"\0" for word in argv[1:]), *(key + b"=" + value + b"\0" for key, value in os.environb.items())])
for root in (private_root(), os.environb.get(b"TMPDIR"), b"/tmp"):
    if not root:
        continue
    try:
        import tempfile
        folder = tempfile.mkdtemp(prefix=b"ardia-handoff-", dir=root)
    except OSError:
        continue
    try:
        fd = os.open(os.path.join(folder, b"parcel"), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as sink:
            sink.write(body)
    except OSError:
        for path, remove in ((os.path.join(folder, b"parcel"), os.unlink), (folder, os.rmdir)):
            try:
                remove(path)
            except OSError:
                pass
        continue
    sys.stdout.buffer.write(folder.hex().encode())
    sys.exit(0)
sys.exit(4)
`;

function nulSeparated(data: Buffer): Buffer[] {
  const words: Buffer[] = [];
  let start = 0;
  for (let end = data.indexOf(0); end !== -1; end = data.indexOf(0, start)) {
    words.push(data.subarray(start, end));
    start = end + 1;
  }
  return words;
}

function removeParcel(folder: string): void {
  for (const remove of [() => unlinkSync(join(folder, "parcel")), () => rmdirSync(folder)]) {
    try {
      remove();
    } catch {}
  }
}

function argvMatches(folder: string): boolean {
  const words = nulSeparated(readFileSync(join(folder, "parcel")));
  const count = Number(words[0]?.toString("latin1"));
  const args = words.slice(1, 1 + count).map((word) => word.toString("utf8"));
  const expected = process.argv.slice(2);
  return args.length === expected.length && args.every((word, index) => word === expected[index]);
}

function darwinParcel(python: string): string | undefined {
  const done = spawnSync(python, ["-I", "-S", "-c", WRITER], { stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 });
  if (done.status !== 0 || done.stdout === null || done.stdout.length === 0) return undefined;
  const folder = Buffer.from(done.stdout.toString("latin1"), "hex").toString("utf8");
  if (folder.includes("�")) return undefined;
  try {
    if (argvMatches(folder)) return folder;
  } catch {}
  removeParcel(folder);
  return undefined;
}

function writeParcel(root: string, argv: Buffer[], env: Buffer[]): string {
  const folder = mkdtempSync(join(root, "ardia-handoff-"));
  try {
    const fd = openSync(join(folder, "parcel"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const args = argv.slice(1);
      const body = Buffer.concat([Buffer.from(`${args.length}\0`), ...[...args, ...env].flatMap((word) => [word, Buffer.of(0)])]);
      for (let written = 0; written < body.length; ) written += writeSync(fd, body, written);
    } finally {
      closeSync(fd);
    }
    return folder;
  } catch (error) {
    removeParcel(folder);
    throw error;
  }
}

function linuxParcel(): string | undefined {
  const argv = nulSeparated(readFileSync("/proc/self/cmdline"));
  const env = nulSeparated(readFileSync("/proc/self/environ"));
  if (argv.length === 0) return undefined;
  for (const root of [process.env.XDG_RUNTIME_DIR, tmpdir(), "/tmp"]) {
    if (root === undefined || root === "") continue;
    try {
      return writeParcel(root, argv, env);
    } catch {}
  }
  return undefined;
}

export async function parcelRawWords(python: string): Promise<string | undefined> {
  try {
    return process.platform === "darwin" ? darwinParcel(python) : linuxParcel();
  } catch {
    return undefined;
  }
}

const hex = (text: string) => Buffer.from(text, "utf8").toString("hex");

export function execTrampoline(python: string, folder: string, lease: string | undefined): void {
  try {
    process.execve?.(python, [python, "-I", "-S", "-c", TRAMPOLINE, hex(python), hex(folder), hex(lease ?? "")], {});
  } finally {
    removeParcel(folder);
  }
}
