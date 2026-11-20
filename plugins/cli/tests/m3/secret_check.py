"""Checks that a password given to `set credentials`/`set auth` or passed through a script never enters output.

  python -m tests.m3.secret_check

For each password (`a`, `"`, `-x`, `--foo` and a long unique one) it writes two scenarios under scenarios/secrets/,
runs them TS against TS with the scratch kept, and checks:
- every `--json` reply's `out` parses as JSON, and no reply was masked (`***`): nothing is substring-redacted;
- no reply's stderr contains a dash-prefixed password (it must never be parsed as a flag and echoed);
- for the long password, every file both sides left (tap and Chrome logs, data folder, HOME, spawn configs, result
  and answer files) and every reply: the password appears nowhere.
Not searched: the requests the client sent (`request` and `wire`), which carry the argv by design, and the CDP
transcript of the script scenarios. The tap records what the user's script sends to its worker in the temporary tab,
and a script that contains the password carries it there by design: a test artifact, not product output. D3's tap
still redacts CDP credential fields (continueWithAuth, Authorization/Cookie headers, cookie values) everywhere, and
frames coming back in are the page under test.
"""
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

LONG = "sk-d7-fake-secret-7f3a-" + "q" * 40
PASSWORDS = ["a", '"', "-x", "--foo", LONG]
SCENARIOS = Path(__file__).resolve().parent / "scenarios"
GENERATED = "gen-"
REQUEST_FIELDS = ("request", "wire")


def plain_steps(password: str) -> list[dict]:
    steps = [["set", "credentials", "alice", password], ["--json", "set", "credentials", "alice", password], ["set", "auth", "alice", password],
             ["set", "credentials", password], ["--json", "set", "credentials", password], ["set", "credentials", password, password]]
    return ([{"argv": ["open", "{fixture}/auth.html", "--no-changes"], "session": "cred"}] + [{"argv": argv, "session": "cred"} for argv in steps]
            + [{"argv": ["auth", "login", "nobody"], "session": "cred"}, {"argv": ["close"], "session": "cred"}])


def script_steps(password: str) -> list[dict]:
    literal = json.dumps(password)
    return [{"argv": ["open", "{fixture}/auth.html", "--no-changes"], "session": "cred"},
            {"argv": ["script"], "session": "cred", "stdin": f"await browse('set', 'credentials', 'alice', {literal});"},
            {"argv": ["--json", "script"], "session": "cred", "stdin": f"log('before');\nawait browse('set', 'credentials', 'alice', {literal});"},
            {"argv": ["script", "--timeout", "2s"], "session": "cred", "stdin": f"await browse('set', 'credentials', {literal}, {literal});\nawait sleep(5000);"},
            {"argv": ["close"], "session": "cred"}]


def without_requests(value):
    if isinstance(value, dict):
        return {key: without_requests(item) for key, item in value.items() if key not in REQUEST_FIELDS}
    if isinstance(value, list):
        return [without_requests(item) for item in value]
    return value


def replies(side: Path) -> list[tuple[dict, dict]]:
    found = []
    path = side / "answers.jsonl"
    if not path.exists():
        return found
    for line in path.read_text().splitlines():
        entry = json.loads(line)
        found.append((entry.get("request") or {}, entry.get("answer") or {}))
    return found


def check(scratch: Path, name: str, password: str, script: bool) -> list[str]:
    problems = []
    folder = scratch / name.replace("/", "__", 1)
    sides = [side for side in folder.iterdir() if side.is_dir()] if folder.exists() else []
    if not sides:
        return [f"{name}: nothing ran"]
    for side in sides:
        for request, answer in replies(side):
            options = request.get("options") or {}
            if options.get("json") and answer.get("out"):
                try:
                    json.loads(answer["out"])
                except ValueError:
                    problems.append(f"{name}/{side.name}: a --json reply isn't JSON: {answer['out'][:120]!r}")
            if "***" in json.dumps(answer, ensure_ascii=False):
                problems.append(f"{name}/{side.name}: a reply was masked")
            if password.startswith("-") and password in str(answer.get("err") or ""):
                problems.append(f"{name}/{side.name}: stderr repeats the dash-prefixed password")
        if password != LONG:
            continue
        for path in sorted(side.rglob("*")):
            if not path.is_file() or path.is_symlink():
                continue
            if script and path.name == "transcript.jsonl":
                continue
            data = path.read_bytes()
            if path.name in ("answers.jsonl", "result.json"):
                text = json.dumps([without_requests(json.loads(line)) for line in data.decode().splitlines()] if path.name == "answers.jsonl"
                                  else without_requests(json.loads(data)), ensure_ascii=False)
                if password in text:
                    problems.append(f"{name}/{side.name}: {path.name} carries the password outside the requests")
            elif password.encode() in data:
                problems.append(f"{name}/{side.name}: {path.relative_to(side)} carries the password")
    return problems


def main() -> int:
    written = []
    scratch = Path(tempfile.mkdtemp(prefix="ardia-m3-secrets-"))
    try:
        names = []
        for index, password in enumerate(PASSWORDS):
            for kind, steps in (("plain", plain_steps(password)), ("script", script_steps(password))):
                name = f"secrets/{GENERATED}{kind}-{index}"
                path = SCENARIOS / f"{name}.json"
                path.parent.mkdir(exist_ok=True)
                path.write_text(json.dumps({"live_only": "generated by tests/m3/secret_check.py", "steps": steps}, indent=1, ensure_ascii=False) + "\n")
                written.append(path)
                names.append((name, password, kind == "script"))
        run = subprocess.run([sys.executable, "-m", "tests.m3", "live", *[name for name, _, _ in names], "--a", "ts", "--b", "ts", "--keep", "--scratch",
                              str(scratch)], capture_output=True, text=True)
        print("\n".join(line for line in run.stdout.splitlines() if "passed" in line or line.startswith("FAIL")))
        problems = [problem for name, password, script in names for problem in check(scratch, name, password, script)]
        if problems:
            print(f"secret check: {len(problems)} problem(s) (kept in {scratch}):")
            for problem in problems:
                print(f"  {problem}")
            return 1
        files = sum(1 for path in scratch.rglob("*") if path.is_file())
        print(f"secret check: clean ({len(names)} scenarios, {len(PASSWORDS)} passwords, {files} files and every reply searched)")
        shutil.rmtree(scratch, ignore_errors=True)
        return 0
    finally:
        for path in written:
            path.unlink(missing_ok=True)


if __name__ == "__main__":
    sys.exit(main())
