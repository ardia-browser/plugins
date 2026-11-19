import { closeSync, constants, mkdtempSync, openSync, readFileSync, rmdirSync, unlinkSync, writeSync } from "node:fs";
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

const POINTER = 8;
const DARWIN_USER_TEMP_DIR = 65537;
const PATH_MAX = 1024;

type RawProcess = { argv: Buffer[]; env: Buffer[] };
type Found = { raw: RawProcess; privateRoot: string | undefined };

function nulSeparated(data: Buffer): Buffer[] {
  const words: Buffer[] = [];
  let start = 0;
  for (let end = data.indexOf(0); end !== -1; end = data.indexOf(0, start)) {
    words.push(data.subarray(start, end));
    start = end + 1;
  }
  return words;
}

async function darwinProcess(): Promise<Found> {
  const { dlopen, FFIType, ptr, read, toBuffer } = await import("bun:ffi");
  const libc = dlopen("/usr/lib/libSystem.B.dylib", {
    _NSGetArgc: { args: [], returns: FFIType.ptr },
    _NSGetArgv: { args: [], returns: FFIType.ptr },
    _NSGetEnviron: { args: [], returns: FFIType.ptr },
    strlen: { args: [FFIType.ptr], returns: FFIType.u64 },
    confstr: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.u64 },
  });
  try {
    const text = (at: number) => Buffer.from(toBuffer(at, 0, Number(libc.symbols.strlen(at))));
    const argcAt = libc.symbols._NSGetArgc();
    const argvAt = libc.symbols._NSGetArgv();
    const environAt = libc.symbols._NSGetEnviron();
    if (argcAt === null || argvAt === null || environAt === null) throw new Error("no process arguments");
    const argvList = read.ptr(argvAt, 0);
    const argv = Array.from({ length: read.i32(argcAt, 0) }, (_, index) => text(read.ptr(argvList, index * POINTER)));
    const environ = read.ptr(environAt, 0);
    const env: Buffer[] = [];
    for (let index = 0, at = read.ptr(environ, 0); at; index += 1, at = read.ptr(environ, index * POINTER)) env.push(text(at));
    const root = Buffer.alloc(PATH_MAX);
    const length = Number(libc.symbols.confstr(DARWIN_USER_TEMP_DIR, ptr(root), BigInt(PATH_MAX)));
    const privateRoot = length > 1 && length <= PATH_MAX ? root.subarray(0, length - 1).toString("utf8") : undefined;
    return { raw: { argv, env }, privateRoot: privateRoot?.includes("�") ? undefined : privateRoot };
  } finally {
    libc.close();
  }
}

async function rawProcess(): Promise<Found> {
  if (process.platform === "darwin") return darwinProcess();
  return {
    raw: { argv: nulSeparated(readFileSync("/proc/self/cmdline")), env: nulSeparated(readFileSync("/proc/self/environ")) },
    privateRoot: process.env.XDG_RUNTIME_DIR,
  };
}

function removeParcel(folder: string): void {
  for (const remove of [() => unlinkSync(join(folder, "parcel")), () => rmdirSync(folder)]) {
    try {
      remove();
    } catch {}
  }
}

function writeParcel(root: string, raw: RawProcess): string {
  const folder = mkdtempSync(join(root, "ardia-handoff-"));
  try {
    const fd = openSync(join(folder, "parcel"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const args = raw.argv.slice(1);
      const body = Buffer.concat([Buffer.from(`${args.length}\0`), ...[...args, ...raw.env].flatMap((word) => [word, Buffer.of(0)])]);
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

export async function parcelRawWords(): Promise<string | undefined> {
  try {
    const { raw, privateRoot } = await rawProcess();
    if (raw.argv.length === 0) return undefined;
    for (const root of [privateRoot, tmpdir(), "/tmp"]) {
      if (root === undefined || root === "") continue;
      try {
        return writeParcel(root, raw);
      } catch {}
    }
  } catch {}
  return undefined;
}

const hex = (text: string) => Buffer.from(text, "utf8").toString("hex");

export function execTrampoline(python: string, folder: string, lease: string | undefined): void {
  try {
    process.execve?.(python, [python, "-I", "-S", "-c", TRAMPOLINE, hex(python), hex(folder), hex(lease ?? "")], {});
  } finally {
    removeParcel(folder);
  }
}
