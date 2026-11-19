import base64
import difflib
import hashlib
import json
import os
import re
import shlex
import shutil
import signal
import site
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

CLI = Path(__file__).resolve().parents[2]
CRATE = CLI / "rust"
TS_PROJECT = CLI / "ts"
SERVED_TABLE = CLI / "served.txt"
ENTRIES = ("rust", "ts")
SERVING_SIDES = ("rust", "ts")
CASES = Path(__file__).resolve().parent / "cases"
BLOBS = Path(__file__).resolve().parent / "blobs.json"
INSTALL_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
KEPT_ENV = ("PATH", "LANG", "LC_ALL", "LC_CTYPE", "USER", "LOGNAME", "SHELL")
PROTECTED_ENV = frozenset({"HOME", "ARDIA_CLI_HOME", "TMPDIR", "PATH", "ARDIA_TELEMETRY_URL", "http_proxy", "https_proxy",
                           "HTTP_PROXY", "HTTPS_PROXY", "no_proxy", "NO_PROXY", "ALL_PROXY", "all_proxy", "PYTHONPATH",
                           "PYTHONHOME", "PYTHONSTARTUP", "PYTHONDONTWRITEBYTECODE", "ARDIA_PARITY_BOX",
                           "DYLD_INSERT_LIBRARIES", "LD_PRELOAD"})
VOLATILE = ("uuid",)
VOLATILE_PROPERTIES = ("$session_id", "total_ms", "startup_ms", "served_by")
QUEUED = {"uuid": "0190a1b2-c3d4-7e5f-8a9b-000000000001", "event": "cli_command", "distinct_id": INSTALL_ID,
          "timestamp": "2026-01-01T00:00:00.000Z", "properties": {"command": "earlier"}}
DEFAULT_HELLO = {"result": {"app": "Ardia", "version": "1.0"}}
STUBBED_HELPERS = ("open", "xdg-open", "osascript", "security", "esbuild", "cua-driver", "git", "node", "pbcopy", "pbpaste",
                   "screencapture", "ffmpeg", "defaults", "launchctl", "say", "afplay", "codesign", "ditto", "systemctl")
DENIED_PROGRAMS = ("/bin/launchctl", "/usr/bin/security", "/usr/bin/codesign", "/usr/bin/ditto", "/usr/bin/osascript",
                   "/usr/bin/open", "/usr/bin/pbcopy", "/usr/bin/pbpaste", "/usr/sbin/screencapture", "/usr/bin/say",
                   "/usr/bin/afplay", "/usr/bin/defaults", "/usr/bin/curl", "/usr/bin/ssh")
ROOTS = ("home", "cli-home", "data", "cwd", "tmp", "outside")
PLACES = ("box", "home", "cli_home", "data", "cwd", "tmp", "outside", "cli")
HARNESS_FILES = ("helpers.log", "stubs")
FLUSH_FILE = "data/Telemetry/cli-flush.json"
CONTENT_APART = ("data/Telemetry/local", "data/Telemetry/cli-queue.jsonl", FLUSH_FILE, "cli-home/Usage/usage.json")
READ_ONLY_METHODS = frozenset({"hello", "workspace", "windows", "commands"})
PATH_ENV = frozenset({"ARDIA_DATA_DIR", "ARDIA_CONFIG_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
                      "XDG_RUNTIME_DIR"})
TIME_KEYS = re.compile(r"(_at|At|_ms|time|Time)$")
TIME_SLACK = 120
NOW_SLACK = 2
SIDES = ("new", "python")
TIMEOUT = 60
DRAIN_TIMEOUT = 5
HELPER_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
SANDBOX_PROFILE = """(version 1)
(allow default)
(deny network-outbound (remote ip))
(deny network-inbound (local ip))
(deny network-outbound (remote unix-socket))
(allow network-outbound (remote unix-socket (subpath (param "BOX"))))
(deny file-write* (require-not (require-any (subpath (param "BOX")) (subpath (param "ROUTES")) (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/fd/"))))
(deny process-exec {denied})
"""
TS_PROBE = """#!/bin/sh
printf 'ts\\n' >>{routes}/$PPID
exec "$(dirname "$0")/ardia-ts.bin" "$@"
"""
TS_LIBC = "ardia-libc.so"
TEST_ENTITLEMENTS = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>com.apple.security.cs.disable-library-validation</key><true/></dict></plist>
"""
ROUTE_PROBE = "import os as _parity_os\nopen({routes} + '/' + str(_parity_os.getsid(0)), 'a').write('python\\n')\n"


class UnsafeCase(ValueError):
    pass


def binary() -> Path | None:
    named = os.environ.get("ARDIA_RUST_CLI")
    if named:
        return Path(named)
    for profile in ("release", "debug"):
        found = CRATE / "target" / profile / "ardia"
        if found.exists():
            return found
    return None


def ts_binary() -> Path | None:
    named = os.environ.get("ARDIA_TS_CLI")
    if named:
        return Path(named)
    found = TS_PROJECT / "dist" / "ardia-ts"
    return found if found.exists() else None


def ts_libc(program: Path) -> Path:
    addon = program.with_name(TS_LIBC)
    if not addon.is_file():
        raise FileNotFoundError(f"the ts entry loads the addon beside its program, and there is no {addon}: build plugins/cli/ts "
                                f"(it puts {TS_LIBC} beside ardia-ts) or put one there")
    return addon


def codesign(*words: str) -> None:
    subprocess.run(["/usr/bin/codesign", "--force", *words], check=True, capture_output=True)


def sign_for_tests(libexec: Path) -> None:
    if sys.platform != "darwin":
        return
    with tempfile.NamedTemporaryFile("w", suffix=".entitlements") as entitlements:
        entitlements.write(TEST_ENTITLEMENTS)
        entitlements.flush()
        codesign("--sign", "-", "--options", "runtime", str(libexec / TS_LIBC))
        codesign("--sign", "-", "--options", "runtime", "--entitlements", entitlements.name, str(libexec / "ardia-ts.bin"))


def entry_binary(entry: str) -> Path | None:
    return binary() if entry == "rust" else ts_binary()


def sandbox_mode() -> str:
    if sys.platform == "darwin" and Path("/usr/bin/sandbox-exec").exists():
        return "sandbox-exec"
    if os.environ.get("CI") == "true" or os.environ.get("ARDIA_PARITY_UNSANDBOXED") == "1":
        return "none"
    raise RuntimeError("the parity harness runs both sides under sandbox-exec, which this system lacks; on a throwaway machine "
                       "(CI sets CI=true) or with ARDIA_PARITY_UNSANDBOXED=1 it runs them unconfined")


def command_of(argv: list, python_label: str | None) -> str | None:
    if list(argv) == ["--version"]:
        return "--version"
    if list(argv) in ([], ["--help"], ["-h"]):
        return "--help"
    return python_label


def served_table(path: Path = SERVED_TABLE) -> dict[str, str]:
    rows = {}
    for number, line in enumerate(path.read_text().splitlines(), 1):
        words = line.split()
        if not words:
            continue
        if len(words) != 2 or words[1] not in SERVING_SIDES or words[0] in rows:
            raise ValueError(f"{path.name}:{number}: each row is a command and who serves it ({' or '.join(SERVING_SIDES)}), once: {line!r}")
        rows[words[0]] = words[1]
    return rows


def served_commands(path: Path = SERVED_TABLE) -> list[str]:
    return list(served_table(path))


def route_from(lines: list[str]) -> str:
    if "python" in lines:
        return "python"
    return "ts" if "ts" in lines else "rust"


def expected_route(entry: str, served: dict[str, str], case: "Case", ts_installed: bool) -> str:
    if case.fallback or case.command not in served:
        return "python"
    side = "ts" if entry == "ts" else served[case.command]
    return "python" if side == "ts" and not ts_installed else side


_blob_store = {}


def blob_store() -> dict:
    if not _blob_store and BLOBS.exists():
        _blob_store.update(json.loads(BLOBS.read_text()))
    return _blob_store


def decode_blob(value) -> bytes:
    if value is None:
        return b""
    if isinstance(value, dict) and "blob" in value:
        return decode_blob(blob_store()[value["blob"]])
    if isinstance(value, dict) and "text" in value:
        return value["text"].encode()
    if isinstance(value, str):
        return value.encode()
    if isinstance(value, dict) and "base64" in value:
        return base64.b64decode(value["base64"])
    if isinstance(value, dict) and "json" in value:
        return json.dumps(value["json"]).encode()
    raise ValueError(f"not a blob: {value!r}")


def file_bytes(spec, places: dict) -> bytes:
    if isinstance(spec, dict) and "blob" in spec:
        return file_bytes(blob_store()[spec["blob"]], places)
    if isinstance(spec, str):
        return expand(spec, places).encode()
    if isinstance(spec, dict) and "text" in spec:
        return expand(spec["text"], places).encode()
    return decode_blob(spec)


@dataclass
class Case:
    id: str
    command: str
    argv: list
    stdin: object = None
    env: dict = field(default_factory=dict)
    control: dict | None = field(default_factory=dict)
    consent: dict = field(default_factory=dict)
    files: dict = field(default_factory=dict)
    helpers: dict = field(default_factory=dict)
    fallback: bool = False
    normalize: list = field(default_factory=list)
    source: str = ""
    note: str = ""

    @classmethod
    def from_dict(cls, row: dict, source: str) -> "Case":
        known = {name for name in cls.__dataclass_fields__}
        unknown = set(row) - known
        if unknown:
            raise ValueError(f"{source}: case {row.get('id')!r} has unknown keys {sorted(unknown)}")
        case = cls(**{**row, "source": source})
        check_case_is_contained(case)
        return case

    def to_dict(self) -> dict:
        row = {"id": self.id, "command": self.command, "argv": self.argv}
        defaults = Case(id="", command="", argv=[])
        for name in ("stdin", "env", "control", "consent", "files", "helpers", "fallback", "normalize", "note"):
            value = getattr(self, name)
            if value != getattr(defaults, name):
                row[name] = value
        return row


SKETCH = {"box": "/BOX", "home": "/BOX/home", "cli_home": "/BOX/cli-home", "data": "/BOX/data", "cwd": "/BOX/cwd", "tmp": "/BOX/tmp",
          "outside": "/BOX/outside", "cli": "/CLI"}


def contained_path(text: str, writable: bool = False) -> bool:
    import posixpath

    for name, sketch in SKETCH.items():
        mark = "{" + name + "}"
        if writable and name == "cli" and (text == mark or text.startswith(mark + "/")):
            return False
        if text == mark or text.startswith(mark + "/"):
            root = "/CLI" if name == "cli" else "/BOX"
            resolved = posixpath.normpath(sketch + text[len(mark):])
            return resolved == root or resolved.startswith(root + "/")
    if text.startswith("/"):
        return False
    resolved = posixpath.normpath(posixpath.join(SKETCH["cwd"], text))
    return resolved.startswith("/BOX/")


def check_case_is_contained(case: Case) -> None:
    where = f"case {case.id!r}"
    for rel in case.files:
        parts = Path(rel).parts
        if not parts or Path(rel).is_absolute() or ".." in parts or parts[0] not in ROOTS:
            raise UnsafeCase(f"{where}: file {rel!r} must be a plain path under one of {', '.join(ROOTS)}")
    for name in case.helpers:
        if not HELPER_NAME.match(name):
            raise UnsafeCase(f"{where}: helper name {name!r} isn't a plain program name")
    for key, value in case.env.items():
        if key in PROTECTED_ENV:
            raise UnsafeCase(f"{where}: ${key} belongs to the sandbox and can't be set or removed by a case")
        if value is not None and not isinstance(value, str):
            raise UnsafeCase(f"{where}: ${key} must be text or null")
        pathlike = key in PATH_ENV or (value or "").startswith(("/", "~", ".", "{"))
        if value and pathlike and not contained_path(value, writable=True):
            raise UnsafeCase(f"{where}: ${key} must be a path inside the sandbox, not {value!r}")
    for index, token in enumerate(case.argv):
        if token == "--data-dir" and index + 1 < len(case.argv) and not contained_path(str(case.argv[index + 1]), writable=True) \
                or isinstance(token, str) and token.startswith("--data-dir=") and not contained_path(token.split("=", 1)[1], writable=True):
            raise UnsafeCase(f"{where}: --data-dir must be a {{box}} path")
        if not isinstance(token, str):
            raise UnsafeCase(f"{where}: argv holds {token!r}, not text")
        candidates = [token] + ([token.split("=", 1)[1]] if token.startswith("--") and "=" in token else [])
        for candidate in candidates:
            if ("/" in candidate or candidate == "..") and not contained_path(candidate):
                raise UnsafeCase(f"{where}: argv path {candidate!r} is outside the sandbox (use {{data}}, {{home}}, {{outside}} …)")
            if candidate.startswith("~"):
                raise UnsafeCase(f"{where}: argv path {candidate!r} would expand outside the sandbox")


def load_cases(root: Path = CASES) -> list[Case]:
    cases, seen = [], {}
    for path in sorted(root.rglob("*.json")) + sorted(root.rglob("*.jsonl")):
        source = str(path.relative_to(root))
        if path.suffix == ".jsonl":
            rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
        else:
            rows = json.loads(path.read_text())
        for row in rows:
            case = Case.from_dict(row, source)
            if case.id in seen:
                raise ValueError(f"case id {case.id!r} is in both {seen[case.id]} and {source}")
            seen[case.id] = source
            cases.append(case)
    return cases


class FakeArdia:
    def __init__(self, path: Path, hello, replies: dict, events: list):
        self.hello = hello
        self.replies = {method: list(reply) if isinstance(reply, list) else [reply] for method, reply in replies.items()}
        self.events = events
        self.connections = []
        self.talkers = []
        self.endings = []
        self.lock = threading.Lock()
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(str(path))
        self.server.listen(16)
        self.server.settimeout(0.1)
        self.stopped = threading.Event()
        self.closing = threading.Event()
        self.complete = True
        self.thread = threading.Thread(target=self.accept, daemon=True)
        self.thread.start()

    @property
    def requests(self) -> list:
        with self.lock:
            return [(request.get("method"), request.get("params")) for transcript in self.connections for request in transcript]

    def transcript(self) -> list:
        with self.lock:
            return [list(transcript) for transcript in self.connections]

    def accept(self):
        while not self.closing.is_set():
            try:
                connection, _ = self.server.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            self.serve(connection)

    def serve(self, connection):
        with self.lock:
            transcript = []
            self.connections.append(transcript)
            talker = threading.Thread(target=self.talk, args=(connection, transcript), daemon=True)
            self.talkers.append(talker)
        talker.start()

    def next_reply(self, method):
        if method == "hello":
            return self.hello
        with self.lock:
            queue = self.replies.get(method)
            if not queue:
                return {"result": None}
            reply = queue.pop(0) if len(queue) > 1 else queue[0]
        return reply() if callable(reply) else reply

    def talk(self, connection, transcript):
        ending = "error"
        try:
            with connection, connection.makefile("rb") as lines:
                for line in lines:
                    try:
                        request = json.loads(line)
                    except ValueError:
                        request = None
                    if not isinstance(request, dict):
                        with self.lock:
                            transcript.append({"<raw line>": base64.b64encode(line).decode()})
                        continue
                    method = request.get("method")
                    with self.lock:
                        transcript.append(request)
                    reply = self.next_reply(method)
                    if reply == "close":
                        ending = "scripted"
                        return
                    if isinstance(reply, dict) and "hang" in reply:
                        self.stopped.wait(float(reply["hang"]))
                        ending = "scripted"
                        return
                    pause = float(reply.get("pause", 0)) if isinstance(reply, dict) else 0.0
                    then = reply.get("then") if isinstance(reply, dict) else None
                    if isinstance(reply, dict):
                        reply = {key: value for key, value in reply.items() if key not in ("pause", "then")}
                    if isinstance(reply, dict) and "raw" in reply:
                        self.send(connection, decode_blob(reply["raw"]))
                    else:
                        self.send(connection, json.dumps({"id": request.get("id"), **reply}).encode() + b"\n")
                    if then == "half-close":
                        connection.shutdown(socket.SHUT_WR)
                    if method == "subscribe":
                        for event in self.events:
                            self.send(connection, json.dumps(event).encode() + b"\n")
                    if pause:
                        self.stopped.wait(pause)
                ending = "eof"
        except OSError:
            pass
        finally:
            with self.lock:
                self.endings.append(ending)

    @staticmethod
    def send(connection, payload: bytes) -> None:
        try:
            connection.sendall(payload)
        except OSError:
            pass

    def close(self):
        self.closing.set()
        self.thread.join(2)
        self.server.setblocking(False)
        while True:
            try:
                connection, _ = self.server.accept()
            except (BlockingIOError, OSError):
                break
            connection.setblocking(True)
            self.serve(connection)
        self.server.close()
        deadline = time.monotonic() + DRAIN_TIMEOUT
        with self.lock:
            talkers = list(self.talkers)
        for talker in talkers:
            talker.join(max(0.0, deadline - time.monotonic()))
        with self.lock:
            self.complete = not any(talker.is_alive() for talker in talkers) and "error" not in self.endings
        self.stopped.set()


@dataclass
class Observed:
    stdout: bytes
    stderr: bytes
    status: int
    requests: list
    telemetry: list
    queued: list
    served_by: list
    usage: object
    files: dict
    helpers: list
    flush: object = None
    route: str = "new"
    timed_out: bool = False
    transcript_complete: bool = True


def tree(root: Path) -> dict:
    found = {}
    if not root.exists():
        return found
    for path in sorted(root.rglob("*")):
        rel = str(path.relative_to(root))
        if any(rel == own or rel.startswith(own + "/") for own in HARNESS_FILES):
            continue
        info = path.lstat()
        apart = any(rel == name or rel.startswith(name + "/") for name in CONTENT_APART)
        if stat.S_ISDIR(info.st_mode):
            found[rel] = ("dir", stat.S_IMODE(info.st_mode))
        elif stat.S_ISLNK(info.st_mode):
            found[rel] = ("link", os.readlink(path))
        elif stat.S_ISSOCK(info.st_mode):
            found[rel] = ("socket",)
        elif stat.S_ISREG(info.st_mode):
            found[rel] = ("file", stat.S_IMODE(info.st_mode), b"<compared apart>" if apart else path.read_bytes())
        else:
            found[rel] = ("other",)
    return found


def file_changes(before: dict, after: dict) -> dict:
    changes = {}
    for rel in sorted(set(before) | set(after)):
        old, new = before.get(rel), after.get(rel)
        if old == new:
            continue
        if new is None:
            changes[rel] = ("removed",)
        else:
            changes[rel] = ("written", *new)
    return changes


def scrub_times(value, window: tuple[float, float]):
    if isinstance(value, dict):
        return {key: time_marker(child, window) if TIME_KEYS.search(key) else scrub_times(child, window) for key, child in value.items()}
    if isinstance(value, list):
        return [scrub_times(child, window) for child in value]
    return value


def time_marker(value, window: tuple[float, float]):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return scrub_times(value, window)
    start, end = window
    for scale, unit in ((1, "s"), (1000, "ms")):
        if (start - TIME_SLACK) * scale <= value <= (end + TIME_SLACK) * scale:
            if start * scale - NOW_SLACK * scale <= value <= end * scale + NOW_SLACK * scale:
                return f"<now {type(value).__name__} {unit}>"
            offset = round(value / scale - (end if value / scale > end else start))
            return f"<now{offset:+d}s {type(value).__name__} {unit}>"
    return value


class Installation:
    def __init__(self, entry_program: Path, scratch: Path | None = None, entry: str = "rust", router: Path | None = None):
        if entry not in ENTRIES:
            raise ValueError(f"the entry is one of {', '.join(ENTRIES)}, not {entry!r}")
        self.entry = entry
        self.sandbox = sandbox_mode()
        self.scratch = Path(scratch or tempfile.mkdtemp(prefix="arp", dir="/tmp")).resolve()
        self.root = self.scratch / "cli"
        self.routes = self.scratch / "routes"
        self.routes.mkdir()
        (self.root / "bin").mkdir(parents=True)
        self.ts_installed = False
        try:
            if entry == "ts":
                self.install_ts(entry_program, router or binary(), every_row=True)
            else:
                shutil.copy2(entry_program, self.root / "bin" / "ardia")
                typescript = ts_binary()
                if "ts" in served_table().values() and typescript is not None and typescript.exists():
                    self.install_ts(typescript, None, every_row=False)
        except BaseException:
            shutil.rmtree(self.scratch, True)
            raise
        subprocess.run([sys.executable, "-m", "venv", "--without-pip", str(self.root / "python")], check=True)
        self.python = self.root / "python" / "bin" / "python3"
        self.source = self.scratch / "src"
        shutil.copytree(CLI / "ardia_cli", self.source / "ardia_cli", ignore=shutil.ignore_patterns("__pycache__"))
        self.packages = Path(subprocess.run([str(self.python), "-I", "-c", "import site; print(site.getsitepackages()[0])"],
                                            check=True, capture_output=True, text=True).stdout.strip())
        (self.packages / "ardia-checkout.pth").write_text("\n".join([str(self.source), *site.getsitepackages()]) + "\n")
        entry = self.source / "ardia_cli" / "cli.py"
        entry.write_text(ROUTE_PROBE.format(routes=repr(str(self.routes))) + entry.read_text())
        shutil.copytree(CLI / "tests" / "fixtures", self.source / "tests" / "fixtures")
        subprocess.run([str(self.python), "-I", "-m", "compileall", "-q", str(self.source)], check=True)
        self.profile = self.scratch / "sandbox.sb"
        self.profile.write_text(SANDBOX_PROFILE.format(denied=" ".join(f'(literal "{program}")' for program in DENIED_PROGRAMS)))
        self.counter = 0
        self.counter_lock = threading.Lock()

    def install_ts(self, program: Path, router: Path | None, every_row: bool):
        if every_row:
            if router is None or not router.exists():
                raise FileNotFoundError("the ts entry runs behind the Rust router: build plugins/cli/rust or set ARDIA_RUST_CLI")
            shutil.copy2(router, self.root / "bin" / "ardia")
        addon = ts_libc(program)
        libexec = self.root / "libexec"
        libexec.mkdir()
        shutil.copy2(program, libexec / "ardia-ts.bin")
        shutil.copy2(addon, libexec / TS_LIBC)
        sign_for_tests(libexec)
        (libexec / "ardia-ts").write_text(TS_PROBE.format(routes=shlex.quote(str(self.routes))))
        (libexec / "ardia-ts").chmod(0o755)
        self.ts_installed = True
        if every_row:
            (self.root / "served.txt").write_text("".join(f"{name} ts\n" for name in served_table()))

    def stray_routes(self) -> list[str]:
        return sorted(path.name for path in self.routes.iterdir())

    def close(self):
        reap(str(self.scratch))
        shutil.rmtree(self.scratch, True)

    def command(self, side: str) -> list[str]:
        return [str(self.root / "bin" / "ardia")] if side == "new" else [str(self.python), "-I", "-m", "ardia_cli"]

    def confined(self, argv: list[str], box: Path) -> list[str]:
        if self.sandbox == "sandbox-exec":
            return ["/usr/bin/sandbox-exec", "-f", str(self.profile), "-D", f"BOX={box}", "-D", f"ROUTES={self.routes}", *argv]
        return argv

    def route_of(self, pid: int) -> list[str]:
        path = self.routes / str(pid)
        try:
            lines = path.read_text().split()
        except FileNotFoundError:
            return []
        path.unlink()
        return lines

    def box(self) -> Path:
        with self.counter_lock:
            self.counter += 1
            number = self.counter
        return self.scratch / f"c{number}"


def reap(marker: str) -> None:
    if sys.platform == "darwin":
        listing = subprocess.run(["/bin/ps", "-x", "-E", "-ww", "-o", "pid=,command="], capture_output=True).stdout.decode("utf-8", "replace")
    else:
        listing = ""
        for entry in Path("/proc").glob("[0-9]*"):
            try:
                exe = os.readlink(entry / "exe")
            except OSError:
                exe = ""
            try:
                listing += f"{entry.name} {exe} " + ((entry / "cmdline").read_bytes() + b" " + (entry / "environ").read_bytes()).replace(b"\0", b" ").decode("utf-8", "replace") + "\n"
            except OSError:
                continue
    pattern = re.compile(rf"(ARDIA_PARITY_BOX=)?{re.escape(marker)}(/|\s|$)")
    for line in listing.splitlines():
        pid_text, _, rest = line.strip().partition(" ")
        if pid_text.isdigit() and int(pid_text) != os.getpid() and pattern.search(rest):
            try:
                os.kill(int(pid_text), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass


def write_stub(directory: Path, name: str, spec: dict, log: Path):
    stdout = base64.b64encode(decode_blob(spec.get("stdout"))).decode()
    status = int(spec.get("exit", 0))
    script = (
        "#!/bin/sh\n"
        f"line='{name}'\n"
        "for a in \"$@\"; do line=\"$line =$(printf '%s' \"$a\" | /usr/bin/base64 | /usr/bin/tr -d '\\n')\"; done\n"
        f"printf '%s\\n' \"$line\" >> '{log}'\n"
        f"printf '%s' '{stdout}' | /usr/bin/base64 -d 2>/dev/null || printf '%s' '{stdout}' | /usr/bin/base64 -D\n"
        f"exit {status}\n"
    )
    path = directory / name
    path.write_text(script)
    path.chmod(0o755)


def inside(box: Path, path: Path) -> bool:
    try:
        return path.resolve().is_relative_to(box.resolve())
    except OSError:
        return False


def no_links_below(box: Path, path: Path) -> bool:
    current = box
    for part in path.relative_to(box).parts:
        current = current / part
        if current.is_symlink():
            return False
    return True


def make_parents(box: Path, path: Path) -> None:
    current = box
    for part in path.relative_to(box).parts[:-1]:
        current = current / part
        if current.is_symlink():
            raise UnsafeCase(f"{path.relative_to(box)} would be written through a link")
        if not current.exists():
            current.mkdir()


def check_effective_paths(box: Path, case: Case, env: dict, argv: list, cwd: str) -> None:
    values = [env[key] for key in PATH_ENV if env.get(key)]
    values += [value for key, value in env.items() if key not in PATH_ENV and isinstance(value, str) and value.startswith("/")
               and key not in ("PATH", "SHELL")]
    for index, token in enumerate(argv):
        if token == "--data-dir" and index + 1 < len(argv):
            values.append(argv[index + 1])
        elif token.startswith("--data-dir="):
            values.append(token.split("=", 1)[1])
    for value in values:
        path = Path(value) if os.path.isabs(value) else Path(cwd) / value
        if not inside(box, path):
            raise UnsafeCase(f"case {case.id!r}: {value} leaves the sandbox once its links are followed")


def read_inside(box: Path, path: Path) -> str | None:
    if not path.exists() or not no_links_below(box, path):
        return None
    return path.read_text()


def places_of(box: Path) -> dict:
    return {"box": str(box), "home": str(box / "home"), "cli_home": str(box / "cli-home"), "data": str(box / "data"),
            "cwd": str(box / "cwd"), "tmp": str(box / "tmp"), "outside": str(box / "outside"), "cli": str(box.parent / "src")}


def materialize(box: Path, case: Case) -> dict:
    check_case_is_contained(case)
    box.mkdir(parents=True)
    for name in ROOTS:
        (box / name).mkdir(parents=True, exist_ok=True)
    data = box / "data"
    consent = case.consent
    if consent is not None and consent.get("absent") is not True:
        (data / "telemetry.json").write_text(json.dumps({"sharing": True, "installId": INSTALL_ID, **consent}))
    telemetry = data / "Telemetry"
    telemetry.mkdir(mode=0o700, exist_ok=True)
    if consent is not None and consent.get("sharing", True) is True:
        (telemetry / "cli-queue.jsonl").write_text(json.dumps(QUEUED) + "\n")
    places = places_of(box)
    for rel, spec in case.files.items():
        path = box / rel
        try:
            make_parents(box, path)
        except UnsafeCase as error:
            raise UnsafeCase(f"case {case.id!r}: {error}") from None
        if path.is_symlink():
            raise UnsafeCase(f"case {case.id!r}: {rel} would be written through a link")
        if isinstance(spec, dict) and spec.get("dir"):
            path.mkdir(exist_ok=True)
            continue
        if isinstance(spec, dict) and "link" in spec:
            os.symlink(expand(spec["link"], places), path)
            continue
        path.write_bytes(file_bytes(spec, places))
        if isinstance(spec, dict) and "mode" in spec:
            path.chmod(int(spec["mode"]))
    flush = telemetry / "cli-flush.json"
    if not no_links_below(box, flush):
        raise UnsafeCase(f"case {case.id!r}: its Telemetry folder leaves the sandbox")
    if FLUSH_FILE not in case.files:
        flush.write_text(json.dumps({"failures": 0, "next_at": 9e12}))
    stubs = box / "stubs"
    stubs.mkdir(exist_ok=True)
    log = box / "helpers.log"
    for name in STUBBED_HELPERS:
        write_stub(stubs, name, case.helpers.get(name, {}), log)
    for name, spec in case.helpers.items():
        if name not in STUBBED_HELPERS:
            write_stub(stubs, name, spec, log)
    return places


def expand(value, places: dict):
    if isinstance(value, str):
        for name, place in places.items():
            value = value.replace("{" + name + "}", place)
        return value
    if isinstance(value, list):
        return [expand(item, places) for item in value]
    if isinstance(value, dict):
        return {key: expand(item, places) for key, item in value.items()}
    return value


def environment(box: Path, places: dict, case: Case) -> dict:
    env = {key: os.environ[key] for key in KEPT_ENV if key in os.environ}
    env["PATH"] = str(box / "stubs") + os.pathsep + env.get("PATH", "/usr/bin:/bin")
    env.update({
        "HOME": places["home"],
        "ARDIA_CLI_HOME": places["cli_home"],
        "ARDIA_DATA_DIR": places["data"],
        "TMPDIR": places["tmp"],
        "ARDIA_TELEMETRY_URL": "http://127.0.0.1:9/v1/logs",
        "http_proxy": "http://127.0.0.1:9", "https_proxy": "http://127.0.0.1:9",
        "HTTP_PROXY": "http://127.0.0.1:9", "HTTPS_PROXY": "http://127.0.0.1:9", "no_proxy": "", "NO_PROXY": "",
        "COLUMNS": "100",
        "LINES": "40",
        "PYTHONDONTWRITEBYTECODE": "1",
        "ARDIA_PARITY_BOX": str(box),
    })
    for key, value in expand(case.env, places).items():
        if value is None:
            env.pop(key, None)
        else:
            env[key] = value
    return env


def iso_time(text) -> float | None:
    from datetime import datetime

    if not isinstance(text, str):
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def scrub_timestamp(record: dict, window: tuple[float, float]) -> None:
    moment = iso_time(record.get("timestamp"))
    if moment is not None and time_marker(moment, window) != moment:
        record["timestamp"] = time_marker(moment, window)


def read_telemetry(box: Path, data: Path, window: tuple[float, float]):
    local = data / "Telemetry" / "local"
    records = []
    for path in sorted(local.glob("cli-*.jsonl")) if local.exists() and no_links_below(box, local) else []:
        records += [json.loads(line) for line in (read_inside(box, path) or "").splitlines()]
    spool_text = read_inside(box, data / "Telemetry" / "cli-queue.jsonl")
    queued = [json.loads(line) for line in spool_text.splitlines()] if spool_text else []
    served = [record.get("properties", {}).get("served_by") for record in records if record.get("event") == "cli_command"]
    labels = [" ".join(part for part in (record.get("properties", {}).get("command"), record.get("properties", {}).get("subcommand")) if part)
              for record in records if record.get("event") == "cli_command"]
    for record in records + queued:
        for key in VOLATILE:
            record.pop(key, None)
        scrub_timestamp(record, window)
        for key in VOLATILE_PROPERTIES:
            record.get("properties", {}).pop(key, None)
    return records, queued, served, labels


def run_side(install: Installation, side: str, case: Case, box: Path) -> tuple[Observed, list]:
    places = materialize(box, case)
    control = case.control
    fake = None
    if control is not None:
        fake = FakeArdia(box / "data" / "ArdiaControl.sock", expand(control.get("hello", DEFAULT_HELLO), places),
                         expand(control.get("replies", {}), places), expand(control.get("events", []), places))
    before = tree(box)
    started = time.time()
    stdin = decode_blob(expand(case.stdin, places) if isinstance(case.stdin, str) else case.stdin)
    timed_out = False
    env = environment(box, places, case)
    argv = expand(list(case.argv), places)
    try:
        check_effective_paths(box, case, env, argv, places["cwd"])
    except UnsafeCase:
        if fake:
            fake.close()
        raise
    try:
        process = subprocess.Popen(install.confined(install.command(side) + argv, box), cwd=places["cwd"],
                                   env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, start_new_session=True)
        try:
            stdout, stderr = process.communicate(stdin, timeout=TIMEOUT)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(process.pid, signal.SIGKILL)
            reap(str(box))
            try:
                stdout, stderr = process.communicate(timeout=DRAIN_TIMEOUT)
            except subprocess.TimeoutExpired:
                process.kill()
                stdout, stderr = b"", b""
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    finally:
        reap(str(box))
        if fake:
            fake.close()
    window = (started, time.time())
    after = tree(box)
    records, queued, served, labels = read_telemetry(box, box / "data", window)
    usage_text = read_inside(box, box / "cli-home" / "Usage" / "usage.json")
    usage = scrub_times(json.loads(usage_text), window) if usage_text is not None else None
    flush_text = read_inside(box, box / "data" / "Telemetry" / "cli-flush.json")
    flush = scrub_times(json.loads(flush_text), window) if flush_text else flush_text
    log_text = read_inside(box, box / "helpers.log")
    helpers = log_text.splitlines() if log_text else []
    route = route_from(install.route_of(process.pid))
    observed = Observed(stdout, stderr, process.returncode, fake.transcript() if fake else [], records, queued, served, usage,
                        file_changes(before, after), helpers, flush, route, timed_out, fake.complete if fake else True)
    return apply_normalizers(observed, case, places), labels


def apply_normalizers(observed: Observed, case: Case, places: dict) -> Observed:
    rules = [(re.compile(expand(pattern, {k: re.escape(v) for k, v in places.items()}).encode()), replacement.encode())
             for pattern, replacement in case.normalize]
    if not rules:
        return observed

    def scrub(blob: bytes) -> bytes:
        for pattern, replacement in rules:
            blob = pattern.sub(replacement, blob)
        return blob

    observed.stdout = scrub(observed.stdout)
    observed.stderr = scrub(observed.stderr)
    observed.files = {rel: (change[:3] + (scrub(change[3]),) if change[:2] == ("written", "file") else change) for rel, change in observed.files.items()}
    return observed


def text_of(value) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", "backslashreplace")
    if isinstance(value, dict) and all(isinstance(change, tuple) for change in value.values()):
        lines = []
        for rel, change in value.items():
            if change[:2] == ("written", "file"):
                body = change[3]
                shown = body.decode("utf-8", "backslashreplace") if len(body) < 64 * 1024 else f"<{len(body)} bytes sha256 {hashlib.sha256(body).hexdigest()}>"
                lines.append(f"{rel}: file mode {oct(change[2])}\n{shown}")
            else:
                lines.append(f"{rel}: {change}")
        return "\n".join(lines)
    return json.dumps(value, indent=1, sort_keys=True, ensure_ascii=False, default=str)


FIELDS = ("status", "stdout", "stderr", "requests", "telemetry", "queued", "usage", "flush", "files", "helpers", "timed_out")


def read_only(connection: list) -> bool:
    return bool(connection) and all(request.get("method") in READ_ONLY_METHODS for request in connection)


def fallback_requests(new: list, python: list) -> list:
    extra = len(new) - len(python)
    if extra > 0 and exact(new[extra:]) == exact(python) and all(read_only(connection) for connection in new[:extra]):
        return python
    return new


def exact(value):
    if isinstance(value, bytes):
        return ("bytes", value)
    if isinstance(value, dict) and all(isinstance(change, tuple) for change in value.values()):
        return json.dumps({rel: [part.decode("latin-1") if isinstance(part, bytes) else part for part in change] for rel, change in value.items()}, sort_keys=True)
    return json.dumps(value, sort_keys=True, default=repr)


def compare(new: Observed, python: Observed, fallback: bool = False, label: str = "new") -> list[tuple[str, str]]:
    mismatches = []
    for name in FIELDS:
        left, right = getattr(python, name), getattr(new, name)
        if name == "requests" and fallback:
            right = fallback_requests(right, left)
        if exact(left) == exact(right):
            continue
        diff = "\n".join(difflib.unified_diff(text_of(left).splitlines(), text_of(right).splitlines(), "python", label, lineterm=""))
        mismatches.append((name, diff or f"python {left!r}\n{label:<6} {right!r}"))
    return mismatches


@dataclass
class Outcome:
    case: Case
    mismatches: list
    route: str
    python_labels: list
    problems: list

    @property
    def passed(self) -> bool:
        return not self.mismatches and not self.problems

    @property
    def native(self) -> bool:
        return self.passed and self.route != "python"

    def report(self) -> str:
        lines = [f"✗ {self.case.id} ({self.case.source}): ardia {' '.join(self.case.argv)}"]
        for problem in self.problems:
            lines.append(f"  {problem}")
        for name, diff in self.mismatches:
            lines.append(f"  {name} differs:")
            lines += ["    " + line for line in diff.splitlines()]
        return "\n".join(lines)


def check_case(install: Installation, case: Case, served: dict[str, str], keep: bool = False) -> Outcome:
    box = install.box()
    observed = {}
    labels = []
    for side in SIDES:
        observed[side], side_labels = run_side(install, side, case, box)
        if side == "python":
            labels = side_labels
        if keep:
            box.rename(box.with_name(f"{box.name}-{side}"))
        else:
            shutil.rmtree(box, True)
    problems = []
    new, python = observed["new"], observed["python"]
    named = command_of(case.argv, labels[-1] if labels else None)
    if named is not None and named != case.command:
        problems.append(f"this call is {named!r}, the case says {case.command!r}")
    if python.route != "python":
        problems.append("the Python side never started the bundled Python")
    expected = expected_route(install.entry, served, case, install.ts_installed)
    if new.route != expected:
        problems.append(f"expected {expected} to serve it, but {new.route} did")
    if new.served_by and new.served_by[-1] != new.route:
        problems.append(f"telemetry says {new.served_by[-1]} served it, but {new.route} did")
    if python.timed_out:
        problems.append(f"Python didn't finish in {TIMEOUT} s")
    for side, seen in ((install.entry, new), ("python", python)):
        if not seen.transcript_complete:
            problems.append(f"the {side} side left a control connection open past the drain deadline, so its transcript may be cut short")
    return Outcome(case, compare(new, python, case.fallback, install.entry), new.route, labels, problems)


def summarize(outcomes: list[Outcome], served: list[str] | dict[str, str]) -> dict:
    served = list(served)
    commands = {}
    for outcome in outcomes:
        row = commands.setdefault(outcome.case.command, {"cases": 0, "passed": 0, "native": 0, "failed": [], "served": outcome.case.command in served})
        row["cases"] += 1
        if outcome.passed:
            row["passed"] += 1
        else:
            row["failed"].append(outcome.case.id)
        if outcome.native:
            row["native"] += 1
    for name in served:
        commands.setdefault(name, {"cases": 0, "passed": 0, "native": 0, "failed": [], "served": True})
    proven = sorted(name for name, row in commands.items() if row["cases"] and row["passed"] == row["cases"] and row["native"])
    return {"served": served, "proven": proven, "unproven_but_served": sorted(set(served) - set(proven)), "commands": dict(sorted(commands.items()))}


def run_all(cases: list[Case], entry_program: Path, jobs: int = 6, keep: bool = False, progress=None, entry: str = "rust") -> tuple[list[Outcome], Installation]:
    from concurrent.futures import ThreadPoolExecutor

    install = Installation(entry_program, entry=entry)
    served = served_table()
    with ThreadPoolExecutor(max_workers=jobs) as pool:
        futures = [pool.submit(check_case, install, case, served, keep) for case in cases]
        outcomes = []
        for future in futures:
            outcome = future.result()
            outcomes.append(outcome)
            if progress:
                progress(outcome)
    stray = install.stray_routes()
    if stray:
        install.close()
        raise RuntimeError(f"route markers no case claimed, so a probe keyed one by something other than its session: {', '.join(stray)}")
    return outcomes, install


def wait_until(test, seconds: float, step: float = 0.05) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if test():
            return True
        time.sleep(step)
    return test()
