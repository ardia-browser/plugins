import argparse
import asyncio
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

from tests.m3 import divergences, human_core, infra

ROWS = (3, 9, 14)
FAKE_MEDIA = "--use-fake-device-for-media-stream"


async def row(run: human_core.Run, number: int) -> dict:
    session = f"d7row{number}"
    page = next(path.name for path in run.pages.glob(f"row{number:02d}-*.html"))
    steps = []
    notes = []

    def browse(*argv, stdin=None):
        step = run.browse(session, *argv) if stdin is None else run_with_stdin(run, session, stdin, *argv)
        steps.append(step)
        return step

    tier = human_core.Tier(run.chrome_port)
    await tier.open()
    try:
        browse("open", f"{run.base}/{page}", "--no-changes")
        await tier.attach(page)
        if number == 3:
            browse("clipboard", "write", "seeded by ardia")
            browse("clipboard", "read")
            await tier.click("#clip")
            notes.append("click by the tier (D5 owns click); only the clipboard item is D7's, the rest need engine or app work")
            browse("wait", "1500")
        elif number == 9:
            browse("get", "title")
            browse("eval", "var leakedByEval = 1; window.leakedToo = 2; document.title")
            browse("script", stdin="return await page.title();")
            browse("wait", "--text", "Click me")
            await tier.click("#target")
            notes.append("click by the tier (D5 owns click)")
            browse("wait", "100")
        elif number == 14:
            browse("set", "permission", "geolocation", "notifications", "camera")
            browse("set", "geo", "52.5", "13.4")
            for target in ("#geo", "#notify", "#camera"):
                await tier.click(target)
            notes.append("clicks by the tier (D5 owns click); select, date and colour pickers need app work")
            browse("wait", "2500")
        verdict = await tier.finish()
    finally:
        await tier.close()
    measured = verdict.get("measured") or {}
    failed = [step for step in steps if step["exit"] != 0]
    if number == 3:
        passed = bool((measured.get("items") or {}).get("clipboardWithGrant"))
    elif number == 14:
        checks = measured.get("checks") or {}
        passed = all(checks.get(name) for name in ("geolocation", "notifications", "camera"))
    else:
        passed = bool(verdict.get("pass"))
    return {"row": number, "pass": passed and not failed, "verdict": verdict.get("pass"), "failed_steps": failed, "notes": notes, "measured": measured}


def run_with_stdin(run: human_core.Run, session: str, stdin: str, *argv: str) -> dict:
    import subprocess

    from tests import browse_driver

    env = browse_driver.isolated_env(run.root / "home", {"ARDIA_BROWSE_DAEMON": browse_driver.daemon_of(run.impl), "ARDIA_M3_SEED": "7",
                                                        "ARDIA_M3_ANSWERS": str(run.root / "answers.jsonl")})
    done = subprocess.run([*browse_driver.client_argv(run.impl, seeded=True), "browse", "--port", str(run.tap_port), "--data-dir", str(run.root / "data"),
                           "--session", session, *argv], input=stdin, capture_output=True, text=True, env=env, cwd=run.root / "home", timeout=150)
    return {"argv": list(argv), "exit": done.returncode, "out": done.stdout.strip()[:300], "err": done.stderr.strip()[:300]}


def main() -> int:
    parser = argparse.ArgumentParser(description="ardia#2812 rows 3 (clipboard), 9 and 14 (granted permissions) through `ardia browse`, the D7 slice")
    parser.add_argument("--pages", type=Path, required=True)
    parser.add_argument("--impl", default="ts")
    parser.add_argument("--rows", default=",".join(map(str, ROWS)))
    parser.add_argument("--port", type=int, default=None, help="Chromium's port, the tap takes the next (default: ARDIA_M3_PORT_BASE + 16)")
    parser.add_argument("--keep", type=Path)
    parser.add_argument("--chrome", default=os.environ.get("ARDIA_M3_HUMAN_CHROME") or None)
    args = parser.parse_args()
    root = args.keep or Path(tempfile.mkdtemp(prefix="ardia-m3-human-d7-"))
    if root.exists():
        shutil.rmtree(root)
    port = args.port if args.port is not None else infra.port_base() + 16
    infra.check_block(port, port + 1)
    if FAKE_MEDIA not in human_core.CHROME_FLAGS:
        human_core.CHROME_FLAGS.append(FAKE_MEDIA)
    run = human_core.Run(root, args.impl, args.pages.resolve(), port, args.chrome or infra.chrome_binary())
    results = []
    try:
        run.start()
        for number in [int(part) for part in args.rows.split(",")]:
            results.append(asyncio.run(row(run, number)))
    finally:
        run.stop()
    checks = divergences.checks(root / "transcript.jsonl") if divergences.daemon_of(args.impl) == "ts" else []
    for result in results:
        mark = "PASS" if result["pass"] else "FAIL"
        print(f"{mark} row {result['row']}" + (f" ({'; '.join(result['notes'])})" if result["notes"] else ""))
        if not result["pass"]:
            print("   ", json.dumps({"failed_steps": result["failed_steps"], "measured": result["measured"]})[:2000])
    print(f"transcript checks: {'clean' if not checks else checks}")
    if not args.keep:
        shutil.rmtree(root, ignore_errors=True)
    return 0 if all(result["pass"] for result in results) and not checks else 1


if __name__ == "__main__":
    sys.exit(main())
