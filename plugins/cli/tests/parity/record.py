"""Usage: python -m tests.parity.record [--rust BIN] [--jobs N] [test module ...]

Seeds parity cases from the Python black-box tests. It runs the tests (all of tests/, or the named modules) with the
ardia entry points wrapped, and records each in-process call of the command: its argv, stdin, the environment it
saw, the files in its data dir, CLI home and HOME when those are throwaway dirs, and every control-socket exchange
(also when a test stubs control.call). Each recording is replayed twice on the Python ardia in the parity sandbox;
one that gives the same result twice, for a command safe to run outside the test's mocks, is written to
tests/parity/cases/seeded/<command>.jsonl with the label Python's own telemetry gives it. The rest are listed with
the reason they were dropped. Re-running it rewrites the seeded tables.
"""
import argparse
import base64
import contextlib
import functools
import hashlib
import io
import json
import os
import re
import socket
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from parity import harness

SEEDED = harness.CASES / "seeded"
MAX_FILE = 1024 * 1024
MAX_TREE = 4 * 1024 * 1024
INLINE_BLOB = 512
UNSAFE = ("browse", "notes", "computer", "hooks install", "hooks uninstall", "hooks run", "events", "on", "feedback", "star",
          "config edit", "theme edit", "scripts test")
KEPT_ENV = re.compile(r"^(ARDIA_[A-Z_]+|AGENT_BROWSER_[A-Z_]+|DO_NOT_TRACK|COLUMNS|LINES|NO_COLOR|TERM|XDG_[A-Z_]+|LANG|LC_[A-Z]+)$")
SANDBOXED_ENV = ("ARDIA_DATA_DIR", "ARDIA_CLI_HOME", "ARDIA_TELEMETRY_URL", "HOME", "TMPDIR")
REAL_HOME = Path(os.path.expanduser("~")).resolve()
REPO = harness.CLI.parents[1].resolve()
SCRATCH_ROOTS = [Path(tempfile.gettempdir()).resolve(), Path("/tmp").resolve(), Path("/private/var/folders").resolve(), REAL_HOME / "ardia-scratch"]


class Skip(Exception):
    pass


def throwaway(path: Path) -> bool:
    try:
        resolved = path.resolve()
    except OSError:
        return False
    if resolved.is_relative_to(REPO) or REPO.is_relative_to(resolved):
        return False
    return any(resolved != root and resolved.is_relative_to(root) for root in SCRATCH_ROOTS)


def snapshot(root: Path) -> dict:
    files, total = {}, 0
    if not root.is_dir():
        return files
    for path in sorted(root.rglob("*")):
        rel = path.relative_to(root)
        if path.is_symlink():
            files[str(rel)] = {"link": os.readlink(path)}
        elif path.is_dir():
            if not any(path.iterdir()):
                files[str(rel)] = {"dir": True}
        elif path.is_file():
            if path.name in ("ArdiaControl.sock", "cli-flush.json", "cli-flush.lock"):
                continue
            body = path.read_bytes()
            total += len(body)
            if len(body) > MAX_FILE or total > MAX_TREE:
                raise Skip(f"{rel} makes the starting files too big to keep")
            mode = path.stat().st_mode & 0o777
            try:
                entry = {"text": body.decode()}
            except UnicodeDecodeError:
                entry = {"base64": base64.b64encode(body).decode()}
            if mode != 0o644:
                entry["mode"] = mode
            files[str(rel)] = entry
    return files


def flag_value(argv: list, name: str):
    for index, token in enumerate(argv):
        if token == name and index + 1 < len(argv):
            return argv[index + 1]
        if token.startswith(name + "="):
            return token.split("=", 1)[1]
    return None


OUTSIDE_PATH = re.compile(r"(?:/private)?/var/folders/[^/\"\s]+/[^/\"\s]+/T/|/tmp/|" + re.escape(str(REAL_HOME)) + "/")


def outside(text: str) -> str:
    return OUTSIDE_PATH.sub("{outside}/", text)


def label_of(argv: list) -> str:
    from ardia_cli import cli

    try:
        index = cli.take_shared(argv, 0, [])
    except cli.UsageError:
        return "none"
    if index < len(argv) and argv[index] in ("browse", "notes", "computer"):
        return argv[index]
    if index < len(argv) and argv[index] == "--version" and len(argv) == 1:
        return "--version"
    try:
        path, _, rest = cli.arrange(cli.build_parser(), argv)
    except cli.UsageError:
        return "none"
    return " ".join(cli.command_label(path, rest))


class Recorder:
    def __init__(self):
        self.depth = threading.local()
        self.records = []
        self.dropped = []
        self.exchanges = None
        self.blobs = {}
        self.baseline = dict(os.environ)
        self.stray_lines = 0

    def calling_test(self) -> str:
        frame = sys._getframe()
        while frame:
            name = frame.f_code.co_name
            if name.startswith("test_"):
                owner = frame.f_locals.get("self")
                module = Path(frame.f_code.co_filename).stem
                return f"{module}.{type(owner).__name__ if owner else ''}.{name}"
            frame = frame.f_back
        return "unknown"

    def wrap_entry(self, original):
        @functools.wraps(original)
        def entry(argv=None, *rest, **kwargs):
            if getattr(self.depth, "value", 0):
                return original(argv, *rest, **kwargs)
            self.depth.value = 1
            argv_list = list(sys.argv[1:] if argv is None else argv)
            try:
                start = self.begin(argv_list)
            except Skip as reason:
                self.dropped.append((self.calling_test(), argv_list, str(reason)))
                start = None
            except Exception as error:
                self.dropped.append((self.calling_test(), argv_list, f"recorder failed: {error!r}"))
                start = None
            streams = (sys.stdout, sys.stderr)
            marks = [len(stream.getvalue()) if isinstance(stream, io.StringIO) else None for stream in streams]
            status = None
            try:
                status = original(argv, *rest, **kwargs)
                return status
            except SystemExit as exit:
                status = exit.code
                raise
            finally:
                self.depth.value = 0
                if start is not None:
                    if None in marks:
                        self.dropped.append((start["test"], start["argv"], "the test didn't capture its output"))
                    else:
                        start["expect"] = {"status": status if isinstance(status, int) else (0 if status is None else 1),
                                           "stdout": streams[0].getvalue()[marks[0]:], "stderr": streams[1].getvalue()[marks[1]:]}
                        self.finish(start)
        return entry

    def begin(self, argv: list) -> dict:
        from ardia_cli import endpoint, usage

        label = label_of(argv)
        if label in UNSAFE or label.split(" ")[0] in UNSAFE:
            raise Skip(f"{label} isn't safe to replay outside the test's mocks")
        env = dict(os.environ)
        roots = {}
        data = endpoint.data_root(flag_value(argv, "--data-dir"))
        if throwaway(data):
            roots["data"] = data
        elif data.resolve() != Path(endpoint.installed_data_dir()).resolve() and data.exists():
            raise Skip(f"its data dir {data} isn't a throwaway dir")
        cli_home = usage.cli_home(env)
        if throwaway(cli_home):
            roots["cli_home"] = cli_home
        home = Path(env.get("HOME") or REAL_HOME)
        if throwaway(home) and home not in (data, cli_home):
            roots["home"] = home
        cwd = Path(os.getcwd())
        if throwaway(cwd) and cwd not in roots.values():
            roots["cwd"] = cwd
        files = {}
        sandbox_names = {"data": "data", "cli_home": "cli-home", "home": "home", "cwd": "cwd"}
        for name, root in roots.items():
            for rel, entry in snapshot(root).items():
                files[f"{sandbox_names[name]}/{rel}"] = entry
        stdin = None
        if isinstance(sys.stdin, (io.StringIO, io.BytesIO)):
            value = sys.stdin.getvalue()
            stdin = value.decode("utf-8", "replace") if isinstance(value, bytes) else value
        elif isinstance(sys.stdin, io.TextIOWrapper) and isinstance(getattr(sys.stdin, "buffer", None), io.BytesIO):
            stdin = sys.stdin.buffer.getvalue().decode("utf-8", "replace")
        self.exchanges = []
        self.stray_lines = 0
        return {"argv": argv, "env": env, "roots": roots, "files": files, "stdin": stdin, "test": self.calling_test(), "label": label}

    def finish(self, start: dict):
        exchanges, self.exchanges = self.exchanges, None
        if self.stray_lines:
            self.dropped.append((start["test"], start["argv"], "the test's server sent lines that aren't replies, which a replay can't reproduce"))
            return
        try:
            case, expect = self.build(start, exchanges or [])
        except Skip as reason:
            self.dropped.append((start["test"], start["argv"], str(reason)))
            return
        self.records.append((start["test"], start["label"], case, expect))

    def note(self, method, params, outcome):
        if self.exchanges is not None:
            self.exchanges.append((method, params, outcome))

    def build(self, start: dict, exchanges: list) -> dict:
        places = {str(root): "{" + name + "}" for name, root in start["roots"].items()}
        places.update({str(root.resolve()): "{" + name + "}" for name, root in start["roots"].items()})

        def place(value):
            if isinstance(value, str):
                for path in sorted(places, key=len, reverse=True):
                    value = value.replace(path, places[path])
                return value
            if isinstance(value, list):
                return [place(item) for item in value]
            if isinstance(value, dict):
                return {key: place(item) for key, item in value.items()}
            return value

        env = {}
        for key, value in start["env"].items():
            if KEPT_ENV.match(key) and key not in SANDBOXED_ENV and self.baseline.get(key) != value:
                value = place(value)
                if os.path.isabs(value) and not value.startswith("{"):
                    raise Skip(f"${key} points outside the test's throwaway dirs")
                env[key] = value
        argv = [token.replace(str(harness.CLI), "{cli}") for token in place(start["argv"])]
        for token in argv:
            for candidate in [token] + ([token.split("=", 1)[1]] if token.startswith("--") and "=" in token else []):
                if os.path.isabs(candidate) and not candidate.startswith("{"):
                    raise Skip(f"{candidate} is outside the test's throwaway dirs")
        files = {}
        for rel, entry in start["files"].items():
            if "text" in entry:
                entry = {**entry, "text": outside(place(entry["text"]).replace(str(harness.CLI), "{cli}"))}
            if "link" in entry:
                target = place(entry["link"])
                if os.path.isabs(target) and not target.startswith("{"):
                    target = "{outside}/link-target"
                entry = {"link": target}
            files[rel] = entry
        control = self.control_of(exchanges, place)
        case = {"argv": argv, "env": env, "files": files, "control": control}
        if start["stdin"]:
            case["stdin"] = place(start["stdin"])
        self.check_private(case)
        case["files"] = {rel: self.blob(entry) for rel, entry in files.items()}
        expect = {key: (outside(place(value)).replace(str(harness.CLI), "{cli}") if isinstance(value, str) else value)
                  for key, value in start["expect"].items()}
        return case, expect

    def check_private(self, case: dict) -> None:
        def leaves(value):
            if isinstance(value, dict):
                if "base64" in value:
                    yield base64.b64decode(value["base64"])
                for key, child in value.items():
                    yield str(key).encode("utf-8", "surrogatepass")
                    yield from leaves(child)
            elif isinstance(value, list):
                for child in value:
                    yield from leaves(child)
            elif isinstance(value, str):
                yield value.encode("utf-8", "surrogatepass")

        text = b"\n".join(leaves(case))
        user = os.environ.get("USER") or os.environ.get("LOGNAME") or ""
        markers = [str(REAL_HOME), socket.gethostname()]
        if len(user) >= 3:
            markers.append(f"/{user}/")
        markers += [value for key, value in self.baseline.items() if len(value) >= 16 and not key.endswith("PATH")]
        for marker in markers:
            if marker and len(marker) >= 4 and marker.encode("utf-8", "surrogatepass") in text:
                raise Skip("it would carry something from this machine (a local path, the host name or an inherited variable)")

    def blob(self, entry: dict):
        if "dir" in entry or "link" in entry:
            return entry
        body = {key: value for key, value in entry.items() if key in ("text", "base64")}
        size = len(next(iter(body.values())))
        if size <= INLINE_BLOB:
            return body["text"] if "text" in body and "mode" not in entry else {**body, **({"mode": entry["mode"]} if "mode" in entry else {})}
        digest = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()
        self.blobs[digest] = body
        return {"blob": digest, **({"mode": entry["mode"]} if "mode" in entry else {})}

    @staticmethod
    def control_of(exchanges: list, place):
        if not exchanges:
            return {}
        hello = None
        replies = {}
        unreachable_every_time = True
        for method, params, outcome in exchanges:
            kind, value = outcome
            if kind != "unreachable" or value[1]:
                unreachable_every_time = False
            if kind == "result":
                try:
                    json.dumps(value)
                except (TypeError, ValueError):
                    raise Skip(f"{method} returned something that isn't JSON") from None
                reply = {"result": place(value)}
            elif kind == "error":
                reply = {"error": {"code": value[0], "message": place(value[1])}}
            elif kind == "incompatible":
                reply = {"error": {"code": "unsupported_protocol", "message": place(value)}}
                method = "hello"
            else:
                reply = "close"
            if method == "hello":
                hello = reply
                continue
            replies.setdefault(method, []).append(reply)
        if unreachable_every_time:
            return None
        control = {"replies": {method: queue[0] if len(queue) == 1 else queue for method, queue in replies.items()}}
        if hello is not None:
            control["hello"] = hello
        return control


def install(recorder: Recorder):
    from ardia_cli import cli, control

    cli.main = recorder.wrap_entry(cli.main)
    cli.run = recorder.wrap_entry(cli.run)

    def outcome_of(call):
        try:
            value = call()
        except control.Incompatible as error:
            return ("incompatible", str(error)), error
        except control.Unreachable as error:
            return ("unreachable", (str(error), bool(getattr(error, "sent", False)))), error
        except control.MethodError as error:
            return ("error", (error.code, error.message)), error
        return ("result", value), None

    original_module_call = control.call
    target = {"call": original_module_call}

    def module_call(data_dir, method, params=None, timeout=control.CALL_TIMEOUT):
        current = target["call"]
        if current is original_module_call:
            return current(data_dir, method, params, timeout)
        outcome, error = outcome_of(lambda: current(data_dir, method, params, timeout))
        recorder.note(method, params, outcome)
        if error is not None:
            raise error
        return outcome[1]

    original_connection_call = control.Connection.call

    async def connection_call(self, method, params=None, timeout=control.CALL_TIMEOUT):
        try:
            value = await original_connection_call(self, method, params, timeout)
        except control.MethodError as error:
            if method == "hello" and error.code == "unsupported_protocol":
                recorder.note("hello", params, ("incompatible", error.message))
            else:
                recorder.note(method, params, ("error", (error.code, error.message)))
            raise
        except control.Unreachable as error:
            recorder.note(method, params, ("unreachable", (str(error), bool(getattr(error, "sent", False)))))
            raise
        recorder.note(method, params, ("result", value))
        return value

    original_connect = control.connect

    async def connect(path, *rest, **kwargs):
        try:
            return await original_connect(path, *rest, **kwargs)
        except control.Incompatible:
            raise
        except control.Unreachable as error:
            if recorder.exchanges is not None and not any(method == "hello" for method, _, _ in recorder.exchanges):
                recorder.note("connect", None, ("unreachable", (str(error), False)))
            raise

    original_init = control.Connection.__init__

    def counted_init(self, reader, writer):
        original_readuntil = reader.readuntil

        async def readuntil(separator=b"\n"):
            line = await original_readuntil(separator)
            if recorder.exchanges is not None:
                try:
                    message = json.loads(line)
                except ValueError:
                    message = None
                ident = message.get("id") if isinstance(message, dict) else None
                answers = isinstance(ident, int) and not isinstance(ident, bool) and ident in getattr(self, "_pending", {})
                if not answers:
                    recorder.stray_lines += 1
            return line

        reader.readuntil = readuntil
        original_init(self, reader, writer)

    control.Connection.__init__ = counted_init
    control.Connection.call = connection_call
    control.connect = connect
    plain_setattr = type(control).__setattr__

    class ControlModule(type(control)):
        def __setattr__(self, name, value):
            if name == "call":
                target["call"] = original_module_call if value is module_call else value
                return
            plain_setattr(self, name, value)

        def __delattr__(self, name):
            if name == "call":
                target["call"] = original_module_call
                return
            super().__delattr__(name)

    plain_setattr(control, "call", module_call)
    control.__class__ = ControlModule


def replay_twice(install_root, case: harness.Case):
    import shutil

    box = install_root.box()
    first, labels = harness.run_side(install_root, "python", case, box)
    shutil.rmtree(box, True)
    second, _ = harness.run_side(install_root, "python", case, box)
    shutil.rmtree(box, True)
    return first, second, labels, harness.places_of(box)


def reproduces(observed, expect: dict, places: dict) -> str | None:
    wanted = {"status": expect["status"], "stdout": harness.expand(expect["stdout"], places).encode(),
              "stderr": harness.expand(expect["stderr"], places).encode()}
    got = {"status": observed.status, "stdout": observed.stdout, "stderr": observed.stderr}
    differing = [name for name in ("status", "stdout", "stderr") if wanted[name] != got[name]]
    return ", ".join(differing) or None


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "x"


def main() -> int:
    parser = argparse.ArgumentParser(prog="python -m tests.parity.record", description=__doc__.split("\n\n", 1)[1], formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--rust", type=Path, default=None)
    parser.add_argument("--jobs", type=int, default=6)
    parser.add_argument("--unstable", type=Path, default=None, help="write the recordings Python doesn't repeat, with a diff, to this JSON file")
    parser.add_argument("modules", nargs="*", help="test modules (default: every tests/test_*.py but the parity tests)")
    args = parser.parse_args()
    rust = args.rust or harness.binary()
    if not rust:
        sys.stderr.write("no Rust ardia: build rust/ first or pass --rust\n")
        return 2
    os.chdir(harness.CLI)
    tests_dir = harness.CLI / "tests"
    sys.path.insert(0, str(tests_dir))
    recorder = Recorder()
    install(recorder)
    loader = unittest.TestLoader()
    names = args.modules or sorted(path.stem for path in tests_dir.glob("test_*.py") if path.stem not in ("test_rust_parity",))
    suite = unittest.TestSuite(loader.loadTestsFromName(name) for name in names)
    with contextlib.redirect_stderr(io.StringIO()) as noise:
        result = unittest.TextTestRunner(stream=noise, verbosity=0).run(suite)
    sys.stderr.write(f"ran {result.testsRun} tests ({len(result.failures)} failures, {len(result.errors)} errors under the recorder); "
                     f"{len(recorder.records)} recordings, {len(recorder.dropped)} dropped while recording\n")
    unique = {}
    for test, label, case, expect in recorder.records:
        key = hashlib.sha256(json.dumps(case, sort_keys=True).encode()).hexdigest()
        unique.setdefault(key, (test, label, case, expect))
    sys.stderr.write(f"{len(unique)} distinct recordings\n")
    from concurrent.futures import ThreadPoolExecutor

    root = harness.Installation(rust)
    kept, dropped = {}, list(recorder.dropped)
    unstable = []
    counters = {}

    harness.blob_store().update(recorder.blobs)
    served = set(harness.served_commands())

    def judge(item):
        import shutil

        key, (test, label, row, expect) = item
        try:
            case = harness.Case.from_dict({"id": "probe", "command": label, **row}, "seeded")
        except harness.UnsafeCase as error:
            return key, test, label, row, None, None, [], str(error)
        try:
            first, second, labels, places = replay_twice(root, case)
        except harness.UnsafeCase as error:
            return key, test, label, row, None, None, [], str(error)
        differing = reproduces(first, expect, places)
        if differing:
            return key, test, label, row, first, second, labels, f"replay doesn't reproduce the test's {differing}"
        command = harness.command_of(row["argv"], labels[-1] if labels else None) or label
        if command in served:
            box = root.box()
            rust_side, _ = harness.run_side(root, "rust", case, box)
            shutil.rmtree(box, True)
            if rust_side.route == "python":
                row = {**row, "fallback": True}
        return key, test, label, row, first, second, labels, None

    try:
        with ThreadPoolExecutor(max_workers=args.jobs) as pool:
            for key, test, label, row, first, second, labels, rejected in pool.map(judge, unique.items()):
                if rejected:
                    dropped.append((test, row["argv"], rejected))
                    continue
                command = harness.command_of(row["argv"], labels[-1] if labels else None) or label
                if first.timed_out:
                    dropped.append((test, row["argv"], "Python didn't finish"))
                    continue
                differences = harness.compare(first, second)
                if differences:
                    dropped.append((test, row["argv"], f"Python gives different {', '.join(name for name, _ in differences)} on two runs"))
                    unstable.append({"test": test, "command": command, "argv": row["argv"], "diff": differences[0][1][:1500]})
                    continue
                number = counters.get((test, command), 0) + 1
                counters[(test, command)] = number
                ident = f"seed--{slug(test.split('.', 1)[1] if '.' in test else test)}--{slug(command)}--{number}"
                kept.setdefault(command, []).append({"id": ident, "command": command, **row, "note": f"from {test}"})
    finally:
        root.close()
    if SEEDED.exists():
        for old in SEEDED.glob("*.jsonl"):
            old.unlink()
    SEEDED.mkdir(parents=True, exist_ok=True)
    for command, rows in sorted(kept.items()):
        rows.sort(key=lambda row: row["id"])
        with open(SEEDED / f"{slug(command)}.jsonl", "w") as out:
            for row in rows:
                out.write(json.dumps(harness.Case.from_dict(row, "seeded").to_dict(), sort_keys=False) + "\n")
    used = set(re.findall(r'"blob": "([0-9a-f]{64})"', "".join(path.read_text() for path in SEEDED.glob("*.jsonl"))))
    harness.BLOBS.write_text(json.dumps({digest: recorder.blobs[digest] for digest in sorted(used)}, indent=0, sort_keys=True) + "\n")
    if args.unstable:
        args.unstable.write_text(json.dumps(unstable, indent=1))
    reasons = {}
    for test, argv, reason in dropped:
        reasons.setdefault(re.sub(r"\S*/\S*", "<path>", reason), []).append(test)
    print(json.dumps({"kept": {command: len(rows) for command, rows in sorted(kept.items())}, "kept_total": sum(map(len, kept.values())),
                      "dropped_total": len(dropped), "dropped_by_reason": {reason: len(tests) for reason, tests in sorted(reasons.items(), key=lambda item: -len(item[1]))}}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
