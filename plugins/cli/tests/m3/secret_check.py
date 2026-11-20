"""Runs scenarios TS against TS with their scratch kept, then greps every file both sides left (CDP transcript, tap and
Chrome logs, the data folder, HOME, spawn configs) and every daemon reply for a fake secret. The requests a client sent
(`request` and `wire` in answers.jsonl) carry it by design and are the only part not searched.

  python -m tests.m3.secret_check [--secret S] [scenario ...]
"""
import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

DEFAULT_SECRET = "sk-d7-fake-secret-7f3a"
DEFAULT_SCENARIOS = ["secrets/credentials", "secrets/credentials_script"]
SCENARIOS = Path(__file__).resolve().parent / "scenarios"
REQUEST_FIELDS = ("request", "wire")


def without_requests(value):
    if isinstance(value, dict):
        return {key: without_requests(item) for key, item in value.items() if key not in REQUEST_FIELDS}
    if isinstance(value, list):
        return [without_requests(item) for item in value]
    return value


def skips_transcript(folder: Path) -> bool:
    name = folder.name.replace("__", "/", 1)
    path = SCENARIOS / f"{name}.json"
    return path.exists() and bool((json.loads(path.read_text()).get("secret_check") or {}).get("skip_transcript"))


def leaks(root: Path, secret: str) -> list[str]:
    found = []
    needle = secret.encode()
    skipped = {folder for folder in root.iterdir() if folder.is_dir() and skips_transcript(folder)}
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        data = path.read_bytes()
        if path.name == "transcript.jsonl" and any(folder in path.parents for folder in skipped):
            continue
        if path.name == "result.json":
            if secret in json.dumps(without_requests(json.loads(data)), ensure_ascii=False):
                found.append(f"{path.relative_to(root)} (replies or files)")
            continue
        if path.name == "answers.jsonl":
            for number, line in enumerate(data.decode("utf-8", "replace").splitlines(), 1):
                try:
                    answer = json.loads(line).get("answer")
                except ValueError:
                    answer = line
                if secret in json.dumps(answer, ensure_ascii=False):
                    found.append(f"{path.relative_to(root)}:{number} (reply)")
            continue
        if needle in data:
            found.append(str(path.relative_to(root)))
    return found


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("scenarios", nargs="*", default=DEFAULT_SCENARIOS)
    parser.add_argument("--secret", default=DEFAULT_SECRET)
    args = parser.parse_args(argv)
    scratch = Path(tempfile.mkdtemp(prefix="ardia-m3-secrets-"))
    run = subprocess.run([sys.executable, "-m", "tests.m3", "live", *args.scenarios, "--a", "ts", "--b", "ts", "--keep", "--scratch", str(scratch)],
                         capture_output=True, text=True)
    print(run.stdout.strip())
    replies = sum(1 for _ in scratch.rglob("answers.jsonl"))
    if run.returncode != 0 or replies == 0:
        print(run.stderr.strip()[-2000:])
        print(f"secret check: the scenarios didn't run (kept in {scratch})")
        return 1
    found = leaks(scratch, args.secret)
    if found:
        print(f"secret check: the fake secret leaked into {len(found)} place(s) (kept in {scratch}):")
        for place in found:
            print(f"  {place}")
        return 1
    files = sum(1 for path in scratch.rglob("*") if path.is_file())
    print(f"secret check: clean ({files} files and every reply searched)")
    subprocess.run(["rm", "-rf", str(scratch)], check=False)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
