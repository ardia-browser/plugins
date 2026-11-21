"""Runs ardia scripts install, uninstall and list end to end on Python and on the TypeScript entry, with a real esbuild,
in the same throwaway folders one side after the other, and diffs stdout, stderr, exit status and every file under
<data dir>/Scripts. A thread stands in for Ardia: it reads Scripts/generation and writes the status.json Ardia would.

  python -m tests.m2_scripts.live --esbuild DIR [--scenario NAME]...

DIR holds the esbuild binary: Python finds it on PATH, the TypeScript side as installed, at <root>/libexec/esbuild,
behind the Rust router (rust/target/release/ardia, ts/dist/ardia-ts and the addon beside it).
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from tests.parity import harness

CLI = Path(__file__).resolve().parents[2]
CONTROL = {"port": 9222, "browser": "/devtools/browser/abc-123", "token": "0123456789abcdef0123", "generation": 4}
TIMES = re.compile(rb'"(installed_at|updated_at)": [0-9.e+-]+')
MAIN = """// ==UserScript==
// @name        Hide Sidebar
// @namespace   ardia
// @version     1.2.0
// @description hides it
// @match       https://example.com/*
// @match       *://*.example.org/docs/*
// @exclude-match https://example.com/admin/*
// @include     https://exact.net/page
// @exclude     *logout*
// @run-at      document-idle
// @inject-into content
// @noframes
// @grant       GM_setValue
// @require     https://cdn.example/lib.js
// ==/UserScript==
import { hide } from "./lib/hide";
hide(document.querySelector("aside"));
"""
LIB = "export function hide(node: Element | null): void {\n  if (node) (node as HTMLElement).style.display = \"none\";\n}\n"
SECOND = "// ==UserScript==\n// @name second\n// @match https://second.example/*\n// ==/UserScript==\nconst x = { a: 1, a: 2 };\nconsole.log(x);\n"
BROKEN = "// ==UserScript==\n// @name broken\n// @match https://b.example/*\n// ==/UserScript==\nconst = ;\n"
ESCAPE = "// ==UserScript==\n// @name escape\n// @match https://e.example/*\n// ==/UserScript==\nimport \"../outside.js\";\n"
NOWHERE = "// ==UserScript==\n// @name nowhere\n// ==/UserScript==\nconsole.log(1);\n"


def scenarios() -> dict:
    return {
        "install-update-uninstall": [
            ["scripts", "install", "work/hide.user.ts"],
            ["scripts", "list"],
            ["scripts", "install", "work/second.user.js"],
            ["scripts", "list", "--json"],
            ["scripts", "install", "work/hide.user.ts"],
            ["scripts", "uninstall", "Hide Sidebar"],
            ["scripts", "list"],
            ["scripts", "uninstall", "second"],
            ["scripts", "list", "--json"],
        ],
        "build-errors": [
            ["scripts", "install", "work/broken.user.ts"],
            ["scripts", "install", "work/escape.user.ts"],
            ["scripts", "install", "work/nowhere.user.ts"],
            ["scripts", "list"],
        ],
        "quiet-ardia": [["scripts", "install", "work/second.user.js"], ["scripts", "list"]],
    }


def write_tree(box: Path) -> None:
    for folder in ("home", "cli-home", "tmp", "data/Chromium", "cwd/work/lib"):
        (box / folder).mkdir(parents=True, exist_ok=True)
    files = {"cwd/work/hide.user.ts": MAIN, "cwd/work/lib/hide.ts": LIB, "cwd/work/second.user.js": SECOND, "cwd/work/broken.user.ts": BROKEN,
             "cwd/work/escape.user.ts": ESCAPE, "cwd/outside.js": "console.log(2);\n", "cwd/work/nowhere.user.ts": NOWHERE}
    for rel, text in files.items():
        (box / rel).write_text(text)
    control = box / "data" / "Chromium" / "ArdiaControl.json"
    control.write_text(json.dumps({**CONTROL, "pid": os.getpid()}))
    control.chmod(0o600)


class FakeArdia(threading.Thread):
    def __init__(self, scripts: Path):
        super().__init__(daemon=True)
        self.scripts = scripts
        self.stopped = threading.Event()

    def run(self):
        reported = 0
        while not self.stopped.wait(0.02):
            try:
                generation = int((self.scripts / "generation").read_text().strip())
            except (OSError, ValueError):
                continue
            if generation > reported:
                reported = generation
                removed = not (self.scripts / "extension").exists()
                profile = {"removed": True} if removed else {"ok": True}
                status = self.scripts / ".status.tmp"
                status.write_text(json.dumps({"generation": generation, "profiles": {"Default": profile, "Work": {"disabled": True}}}))
                status.rename(self.scripts / "status.json")


def snapshot(scripts: Path) -> dict:
    found = {}
    if not scripts.exists():
        return found
    for path in sorted(scripts.rglob("*")):
        rel = str(path.relative_to(scripts))
        mode = oct(path.lstat().st_mode)
        found[rel] = (mode, TIMES.sub(rb'"\1": <time>', path.read_bytes()) if path.is_file() and not path.is_symlink() else None)
    return found


def install_ts(scratch: Path, esbuild: Path) -> Path:
    root = scratch / "cli"
    libexec = root / "libexec"
    (root / "bin").mkdir(parents=True)
    libexec.mkdir()
    shutil.copy2(harness.binary(), root / "bin" / "ardia")
    program = harness.ts_binary()
    shutil.copy2(program, libexec / "ardia-ts.bin")
    shutil.copy2(harness.ts_libc(program), libexec / harness.TS_LIBC)
    harness.sign_for_tests(libexec)
    (libexec / "ardia-ts").write_text('#!/bin/sh\nexec "$(dirname "$0")/ardia-ts.bin" "$@"\n')
    (libexec / "ardia-ts").chmod(0o755)
    shutil.copy2(esbuild / "esbuild", libexec / "esbuild")
    (root / "served.txt").write_text((CLI / "served.txt").read_text())
    return root / "bin" / "ardia"


def run_side(command: list, box: Path, esbuild: Path, steps: list, fake: bool) -> list:
    shutil.rmtree(box, ignore_errors=True)
    write_tree(box)
    env = {"PATH": f"{esbuild}:/usr/bin:/bin", "HOME": str(box / "home"), "ARDIA_CLI_HOME": str(box / "cli-home"), "ARDIA_DATA_DIR": str(box / "data"),
           "TMPDIR": str(box / "tmp"), "DO_NOT_TRACK": "1", "LANG": "en_US.UTF-8", "PYTHONPATH": str(CLI), "PYTHONDONTWRITEBYTECODE": "1"}
    ardia = FakeArdia(box / "data" / "Scripts") if fake else None
    if ardia:
        ardia.start()
    seen = []
    try:
        for argv in steps:
            done = subprocess.run(command + argv, cwd=box / "cwd", env=env, capture_output=True, timeout=120)
            stdout = re.sub(rb"ardia-script-[A-Za-z0-9_]+", b"ardia-script-X", done.stdout)
            stderr = re.sub(rb"ardia-script-[A-Za-z0-9_]+", b"ardia-script-X", done.stderr)
            seen.append({"argv": argv, "status": done.returncode, "stdout": TIMES.sub(rb'"\1": <time>', stdout), "stderr": stderr,
                         "files": snapshot(box / "data" / "Scripts")})
    finally:
        if ardia:
            ardia.stopped.set()
            ardia.join()
    return seen


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="python -m tests.m2_scripts.live", description=__doc__.split("\n\n", 1)[1],
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--esbuild", type=Path, required=True)
    parser.add_argument("--scenario", action="append", default=[])
    args = parser.parse_args(argv)
    chosen = {name: steps for name, steps in scenarios().items() if not args.scenario or name in args.scenario}
    scratch = Path(tempfile.mkdtemp(prefix="ardia-live-"))
    failures = 0
    try:
        ts = install_ts(scratch, args.esbuild)
        for name, steps in chosen.items():
            box = scratch / "box"
            fake = name != "quiet-ardia"
            python = run_side([sys.executable, "-m", "ardia_cli"], box, args.esbuild, steps, fake)
            typescript = run_side([str(ts)], box, args.esbuild, steps, fake)
            for left, right in zip(python, typescript):
                for key in ("status", "stdout", "stderr", "files"):
                    if left[key] != right[key]:
                        failures += 1
                        print(f"{name}: {' '.join(left['argv'])}: {key} differs\n  python: {str(left[key])[:1500]}\n  ts:     {str(right[key])[:1500]}")
            print(f"{name}: {len(steps)} steps, {'agree' if not failures else 'differ'}", flush=True)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
