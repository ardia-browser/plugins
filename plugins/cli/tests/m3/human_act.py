import argparse
import asyncio
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

from tests.m3 import divergences, infra
from tests.m3.human_core import Run, Tier

ROWS = (1, 2, 4, 5, 6, 20, 21)


def center(selector: str) -> str:
    return (f"(() => {{ const r = document.querySelector({json.dumps(selector)}).getBoundingClientRect(); "
            "return [r.left + r.width / 2, r.top + r.height / 2]; })()")


async def raw(tier: Tier, method: str, params: dict | None = None):
    return await tier.browser.send(method, params or {}, tier.session)


async def world(tier: Tier):
    tree = await raw(tier, "Page.getFrameTree")
    created = await raw(tier, "Page.createIsolatedWorld", {"frameId": tree["frameTree"]["frame"]["id"], "worldName": "ardia-human-tier"})
    tier.context = created["executionContextId"]


async def row(run: Run, number: int, scratch: Path) -> dict:
    session = f"act{number}"
    page = next(path.name for path in run.pages.glob(f"row{number:02d}-*.html"))
    steps = []
    notes = []

    def browse(*argv, expect: int = 0):
        step = run.browse(session, *argv)
        step["expect"] = expect
        steps.append(step)
        return step

    tier = Tier(run.chrome_port)
    await tier.open()
    read = None
    try:
        browse("open", f"{run.base}/{page}", "--no-changes")
        await tier.attach(page)
        if number == 1:
            fallback = browse("click", "--touch", "#touch", "--no-changes")
            if "touch isn't emulated" not in fallback["out"]:
                fallback["exit"] = fallback["exit"] or 99
            notes.append("touch emulation turned on by the tier, standing in for `set device` (D7)")
            await raw(tier, "Emulation.setTouchEmulationEnabled", {"enabled": True, "maxTouchPoints": 1})
            browse("open", f"{run.base}/{page}", "--no-changes")
            await world(tier)
            browse("click", "#target", "--no-changes")
            browse("press", "a", "--no-changes")
            browse("scroll", "-s", "#scroller", "down", "120", "--no-changes")
            browse("click", "--touch", "#touch", "--no-changes")
        elif number == 2:
            browse("press", "#field", "k", "--no-changes")
            browse("wait", "5300")
            browse("click", "#target", "--no-changes")
        elif number == 4:
            box = await tier.iso("(() => { const b = document.getElementById('pad').getBoundingClientRect(); return [b.left, b.top, b.width, b.height]; })()")
            left, top, width, height = box
            browse("mouse", "move", str(left + 10), str(top + 20), "--no-changes")
            browse("mouse", "move", str(left + width - 20), str(top + height - 30), "--humanize", "--no-changes")
            browse("mouse", "move", str(left + 30), str(top + height - 10), "--humanize", "--no-changes")
            browse("hover", "#hover", "--humanize", "--no-changes")
        elif number == 5:
            read = {"hasFocusBeforeInput": await tier.iso("document.hasFocus()")}
            browse("click", "#a", "--no-changes")
            browse("click", "#b", "--no-changes")
            notes.append("IME composition sent by the tier (the CLI has no IME command)")
            await raw(tier, "Input.imeSetComposition", {"text": "に", "selectionStart": 1, "selectionEnd": 1})
            await raw(tier, "Input.imeSetComposition", {"text": "にほ", "selectionStart": 2, "selectionEnd": 2})
            browse("keyboard", "inserttext", "日本", "--no-changes")
            browse("press", "Backspace", "--no-changes")
            browse("keyboard", "inserttext", "x", "--no-changes")
            read["visibility"] = await tier.iso("document.visibilityState")
        elif number == 6:
            for name, body in (("row06-a.txt", "row06 file a contents"), ("row06-b.txt", "row06 file b")):
                (scratch / name).write_text(body)
            browse("drag", "#src", "#dst", "--no-changes")
            notes.append("files dropped by the tier (Python has no `drag --files`)")
            zone = await tier.iso(center("#files"))
            data = {"items": [], "files": [str(scratch / "row06-a.txt"), str(scratch / "row06-b.txt")], "dragOperationsMask": 1}
            for kind in ("dragEnter", "dragOver", "drop"):
                await raw(tier, "Input.dispatchDragEvent", {"type": kind, "x": zone[0], "y": zone[1], "data": data, "modifiers": 0})
            browse("drag", '#sort li[data-id="1"]', '#sort li[data-id="5"]', "--before", "--no-changes")
            read = {"headless": True, "reference": None, "flags": []}
        elif number == 20:
            browse("click", "#plain", "--no-changes")
            browse("keyboard", "type", "hello world", "--no-changes")
            browse("press", "Meta+z", "--no-changes")
            browse("click", "#model", "--no-changes")
            browse("keyboard", "type", "hello world", "--no-changes")
            browse("press", "Alt+Shift+ArrowLeft", "--no-changes")
            browse("keyboard", "inserttext", "ardia", "--no-changes")
            after_replace = await tier.iso("document.getElementById('model').textContent")
            browse("press", "Meta+z", "--no-changes")
            read = {"afterReplace": after_replace}
        elif number == 21:
            browse("click", "input", "--no-changes")
            browse("keyboard", "type", "ardia-user", "--no-changes")
            browse("click", "button[type=button]", "--no-changes")
            browse("click", "#submit", "--no-changes")
        verdict = await tier.finish(read)
    finally:
        await tier.close()
    failed = [step for step in steps if step["exit"] != step["expect"]]
    return {"row": number, "pass": bool(verdict.get("pass")) and not failed, "verdict": verdict.get("pass"), "failed_steps": failed,
            "notes": notes, "measured": verdict.get("measured")}


def main() -> int:
    parser = argparse.ArgumentParser(description="ardia#2812 rows 1, 2, 4, 5, 6, 20 and 21 driven through `ardia browse`'s act commands against "
                                                 "headless Chrome for Testing, with the daemon's transcript checked for rows 1, 8 and 20")
    parser.add_argument("--pages", type=Path, required=True)
    parser.add_argument("--impl", default="ts")
    parser.add_argument("--rows", default=",".join(map(str, ROWS)))
    parser.add_argument("--port", type=int, default=int(os.environ.get("ARDIA_M3_HUMAN_PORT", "9512")))
    parser.add_argument("--keep", type=Path)
    parser.add_argument("--chrome", default=os.environ.get("ARDIA_M3_HUMAN_CHROME") or None,
                        help="a full Chrome for Testing binary run with --headless=new; chrome-headless-shell is old-mode headless")
    args = parser.parse_args()
    root = args.keep or Path(tempfile.mkdtemp(prefix="ardia-m3-human-act-"))
    if root.exists():
        shutil.rmtree(root)
    run = Run(root, args.impl, args.pages.resolve(), args.port, args.chrome or infra.chrome_binary())
    results = []
    try:
        run.start()
        files = root / "files"
        files.mkdir()
        for number in [int(part) for part in args.rows.split(",")]:
            results.append(asyncio.run(row(run, number, files)))
    finally:
        run.stop()
    checks = divergences.checks(root / "transcript.jsonl") if divergences.daemon_of(args.impl) == "ts" else []
    for result in results:
        mark = "PASS" if result["pass"] else "FAIL"
        print(f"{mark} row {result['row']}" + (f" ({'; '.join(result['notes'])})" if result["notes"] else ""))
        if not result["pass"]:
            print("   ", json.dumps({"failed_steps": result["failed_steps"], "measured": result["measured"]}, ensure_ascii=False)[:2500])
    print(f"transcript checks: {'clean' if not checks else checks}")
    if not args.keep:
        shutil.rmtree(root, ignore_errors=True)
    return 0 if all(result["pass"] for result in results) and not checks else 1


if __name__ == "__main__":
    sys.exit(main())
