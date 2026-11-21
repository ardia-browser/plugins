"""Compares the caller the TypeScript entry works out with the one the Rust router put in its marker.

    python3 tests/caller_diff.py <router root> <caller probe>

<router root> holds the Rust router from ts/entry as bin/ardia, served.txt with `tabs ts`, and libexec/ardia-ts, a
script that appends its first argument to $CALLER_CAPTURE. <caller probe> is ts/tests/caller-probe.ts compiled with
bun build --compile, with ardia-libc.so beside it. Each scenario starts one launcher (a shell, a script, an interpreter,
a program inside a scratch .app bundle) that runs the router and then the probe, so both walk the same ancestry.
"""

import json
import os
import plistlib
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def bundle(root: Path, name: str, plist: dict | None, binary: bool, inner: str | None = None) -> Path:
    contents = root / name / "Contents"
    if inner:
        contents = contents / "Frameworks" / inner / "Contents"
    macos = contents / "MacOS"
    macos.mkdir(parents=True)
    program = macos / "launcher"
    shutil.copyfile("/bin/bash", program)
    program.chmod(0o755)
    subprocess.run(["codesign", "--force", "--sign", "-", str(program)], check=True, capture_output=True)
    if plist is not None:
        target = (root / name / "Contents") if inner else contents
        with open(target / "Info.plist", "wb") as handle:
            plistlib.dump(plist, handle, fmt=plistlib.FMT_BINARY if binary else plistlib.FMT_XML)
    return program


ORPHAN = "import subprocess, sys; print(subprocess.Popen(sys.argv[2:], stdout=open(sys.argv[1], 'w'), stderr=subprocess.STDOUT, start_new_session=True).pid)"


def run_orphaned(argv: list, env: dict, out: Path) -> str:
    started = subprocess.run([sys.executable, "-I", "-c", ORPHAN, str(out), *argv], env=env, capture_output=True, text=True, check=True, timeout=30)
    pid = int(started.stdout)
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.05)
    else:
        os.kill(pid, 9)
        raise TimeoutError(argv)
    return out.read_text()


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] in ("-h", "--help"):
        print(__doc__)
        return 0 if len(sys.argv) > 1 and sys.argv[1] in ("-h", "--help") else 64
    router, probe = Path(sys.argv[1]), Path(sys.argv[2])
    scratch = Path(tempfile.mkdtemp(prefix="caller-diff-"))
    capture = scratch / "capture.txt"
    both = f'"{router}/bin/ardia" tabs; "{probe}"; :'
    script = scratch / "run.sh"
    script.write_text(f"#!/bin/bash\n{both}\n")
    script.chmod(0o755)
    agent_dir = scratch / "agents"
    agent_dir.mkdir()
    (agent_dir / "codex.js").write_text(f'require("child_process").execFileSync("/bin/bash", ["-c", {json.dumps(both)}], {{stdio: "inherit"}});\n')
    (agent_dir / "aider.py").write_text(f"import subprocess\nsubprocess.run(['/bin/bash', '-c', {both!r}])\n")
    apps = scratch / "apps"
    xml_app = bundle(apps, "Fake Term.app", {"CFBundleDisplayName": "Fake​  Term & Co™", "CFBundleName": "Ignored"}, False)
    bin_app = bundle(apps, "Binary.app", {"CFBundleDisplayName": "", "CFBundleName": "Binéry \U0001f600 Name"}, True)
    bare_app = bundle(apps, "No Plist Folder.app", None, False)
    helper = bundle(apps, "Outer Host.app", {"CFBundleName": "Outer Host"}, False, inner="Helper.app")
    long_app = bundle(apps, "L" * 60 + ".app", {"CFBundleName": "x" * 80}, False)
    real = [Path("/System/Applications/Utilities/Terminal.app"), Path("/Applications/Safari.app"), *sorted(Path("/Applications").glob("*.app"))[:6]]
    copied = {}
    for app in real:
        info = app / "Contents" / "Info.plist"
        if info.is_file() and app.name not in copied:
            program = bundle(apps / "real", app.name, None, False)
            shutil.copyfile(info, program.parent.parent / "Info.plist")
            copied[app.name] = program
    node = shutil.which("node") or shutil.which("bun")
    scenarios = {
        "this agent's shell": ["/bin/bash", "-c", both],
        "zsh -c": ["/bin/zsh", "-c", both],
        "sh -c": ["/bin/sh", "-c", both],
        "a bash script": [str(script)],
        "argv0 claude": ["/bin/bash", "-c", f"exec -a claude /bin/bash -c {json.dumps(both)}"],
        "argv0 -zsh": ["/bin/bash", "-c", f"exec -a -zsh /bin/zsh -c {json.dumps(both)}"],
        "python3 aider.py": [sys.executable, str(agent_dir / "aider.py")],
        "node codex.js": [node, str(agent_dir / "codex.js")] if node else None,
        "XML plist bundle": [str(xml_app), "-c", both],
        "binary plist bundle": [str(bin_app), "-c", both],
        "bundle with no Info.plist": [str(bare_app), "-c", both],
        "nested helper bundle": [str(helper), "-c", both],
        "long names": [str(long_app), "-c", both],
        **{f"Info.plist of {name}": [str(program), "-c", both] for name, program in copied.items()},
    }
    env = {"PATH": "/usr/bin:/bin", "HOME": str(scratch), "CALLER_CAPTURE": str(capture), "ARDIA_TELEMETRY": "off", "ARDIA_DATA_DIR": str(scratch / "data")}
    failures = 0
    try:
        for label, argv in scenarios.items():
            if argv is None:
                print(f"SKIP {label}: no node or bun")
                continue
            capture.write_text("")
            if label == "this agent's shell":
                stdout = subprocess.run(argv, env=env, capture_output=True, text=True, timeout=60).stdout
            else:
                stdout = run_orphaned(argv, env, scratch / "out.txt")
            markers = [line for line in capture.read_text().splitlines() if line.startswith("--ardia-routed=")]
            rust = json.loads(bytes.fromhex(markers[-1].rsplit(":", 1)[1])) if markers else None
            lines = [line for line in stdout.splitlines() if line.startswith("{")]
            ts = json.loads(lines[-1]) if lines else None
            same = rust is not None and rust == ts
            failures += not same
            print(f"{'SAME' if same else 'DIFF'} {label}: rust={rust} ts={ts}" + ("" if same else f" output={stdout[-300:]!r}"))
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    print(f"{len([a for a in scenarios.values() if a]) - failures} same, {failures} different")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
