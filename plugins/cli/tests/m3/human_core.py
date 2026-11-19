import argparse
import asyncio
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from ardia_cli.browse.connection import Browser
from ardia_cli.endpoint import Endpoint
from tests import browse_driver
from tests.m3 import divergences, infra

CHROME_FLAGS = ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update",
                "--disable-sync", "--mute-audio", "--hide-scrollbars", "--window-size=1200,900"]
ROWS = (7, 8, 9, 10, 11, 12, 13)
ROW13_ROLES = ("child", "grandchild", "sandboxed")
WORLD = "ardia-human-tier"


class Tier:
    def __init__(self, chrome_port: int):
        self.chrome_port = chrome_port
        self.browser = None
        self.session = None
        self.context = None

    async def open(self):
        version = json.loads(infra.DIRECT.open(f"http://127.0.0.1:{self.chrome_port}/json/version", timeout=10).read())
        self.browser = Browser(Endpoint(version["webSocketDebuggerUrl"], "--port", True), lambda *_: None)
        await self.browser.open()

    async def attach(self, page: str):
        infos = (await self.browser.send("Target.getTargets"))["targetInfos"]
        target = next(info["targetId"] for info in infos if info.get("type") == "page" and page in info.get("url", ""))
        self.session = (await self.browser.send("Target.attachToTarget", {"targetId": target, "flatten": True}))["sessionId"]
        tree = await self.browser.send("Page.getFrameTree", None, self.session)
        world = await self.browser.send("Page.createIsolatedWorld", {"frameId": tree["frameTree"]["frame"]["id"], "worldName": WORLD}, self.session)
        self.context = world["executionContextId"]

    async def iso(self, expression: str):
        result = await self.browser.send("Runtime.evaluate", {"expression": expression, "contextId": self.context, "returnByValue": True,
                                                              "awaitPromise": True}, self.session)
        return (result.get("result") or {}).get("value")

    async def click_pierced(self, host: str, selector: str):
        root = (await self.browser.send("DOM.getDocument", {"depth": -1, "pierce": True}, self.session))["root"]
        roots = []

        def walk(node):
            for shadow in node.get("shadowRoots") or []:
                roots.append(shadow["nodeId"])
                walk(shadow)
            for child in node.get("children") or []:
                walk(child)

        walk(root)
        node = 0
        for shadow in roots:
            node = (await self.browser.send("DOM.querySelector", {"nodeId": shadow, "selector": selector}, self.session)).get("nodeId") or 0
            if node:
                break
        quad = (await self.browser.send("DOM.getContentQuads", {"nodeId": node}, self.session))["quads"][0]
        x, y = sum(quad[0::2]) / 4, sum(quad[1::2]) / 4
        for kind in ("mouseMoved", "mousePressed", "mouseReleased"):
            params = {"type": kind, "x": x, "y": y}
            if kind != "mouseMoved":
                params.update({"button": "left", "clickCount": 1})
            await self.browser.send("Input.dispatchMouseEvent", params, self.session)

    async def phase(self, name: str):
        await self.iso(f"document.documentElement.dataset.phase = {json.dumps(name)}")

    async def click(self, selector: str):
        box = await self.iso(f"(() => {{ const r = document.querySelector({json.dumps(selector)}).getBoundingClientRect(); "
                             "return [r.left + r.width / 2, r.top + r.height / 2]; })()")
        for kind in ("mouseMoved", "mousePressed", "mouseReleased"):
            params = {"type": kind, "x": box[0], "y": box[1]}
            if kind != "mouseMoved":
                params.update({"button": "left", "clickCount": 1})
            await self.browser.send("Input.dispatchMouseEvent", params, self.session)

    async def finish(self, read: dict | None = None) -> dict:
        if read is not None:
            await self.iso(f"document.documentElement.dataset.read = {json.dumps(json.dumps(read))}")
        await self.iso("document.documentElement.setAttribute('data-finish', '1')")
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            raw = await self.iso("document.documentElement.dataset.humanResult || null")
            if raw:
                return json.loads(raw)
            await asyncio.sleep(0.1)
        return {"pass": False, "measured": {"error": "no verdict in 15 s"}}

    async def close(self):
        if self.session:
            try:
                await self.browser.send("Target.detachFromTarget", {"sessionId": self.session})
            except Exception:
                pass
        if self.browser:
            await self.browser.close()


class Run:
    def __init__(self, root: Path, impl: str, pages: Path, port: int, chrome: str):
        self.chrome = chrome
        self.root = root
        self.impl = impl
        self.pages = pages
        self.chrome_port = port
        self.tap_port = port + 1
        self.processes = []
        self.base = None

    def start(self):
        (self.root / "data").mkdir(parents=True)
        (self.root / "home").mkdir()
        server = subprocess.Popen([infra.bun(), str(self.pages / "server.ts")], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
        self.processes.append(server)
        line = server.stdout.readline().decode()
        self.base = re.search(r"http://127\.0\.0\.1:\d+/", line).group().rstrip("/")
        log = open(self.root / "chrome.log", "wb")
        chrome = subprocess.Popen([self.chrome, *CHROME_FLAGS, f"--remote-debugging-port={self.chrome_port}",
                                   f"--user-data-dir={self.root / 'profile'}", "about:blank"], stdout=log, stderr=log, start_new_session=True)
        log.close()
        self.processes.append(chrome)
        infra.wait_for(lambda: infra.answers(f"http://127.0.0.1:{self.chrome_port}/json/version"), 30, "Chromium")
        tap = subprocess.Popen([infra.bun(), str(infra.TAP), "--listen", str(self.tap_port), "--out", str(self.root / "transcript.jsonl"),
                                "--scratch", str(self.root), "--upstream", str(self.chrome_port), "--chrome-pid", str(chrome.pid)],
                               stdout=subprocess.PIPE, stderr=open(self.root / "tap.log", "wb"), start_new_session=True)
        self.processes.append(tap)
        tap.stdout.readline()

    def browse(self, session: str, *argv: str) -> dict:
        env = browse_driver.isolated_env(self.root / "home", {"ARDIA_BROWSE_DAEMON": browse_driver.daemon_of(self.impl), "ARDIA_M3_SEED": "7",
                                                             "ARDIA_M3_ANSWERS": str(self.root / "answers.jsonl")})
        done = subprocess.run([*browse_driver.client_argv(self.impl, seeded=True), "browse", "--port", str(self.tap_port), "--data-dir",
                               str(self.root / "data"), "--session", session, *argv], capture_output=True, text=True, env=env,
                              cwd=self.root / "home", timeout=150)
        return {"argv": list(argv), "exit": done.returncode, "out": done.stdout.strip()[:300], "err": done.stderr.strip()[:300], "full": done.stdout}

    def stop(self):
        try:
            self.browse("harness", "close", "--all")
        except Exception:
            pass
        for process in reversed(self.processes):
            infra.stop(process)


async def row(run: Run, number: int) -> dict:
    session = f"row{number}"
    page = next(path.name for path in run.pages.glob(f"row{number:02d}-*.html"))
    steps = []
    notes = []

    def browse(*argv):
        step = run.browse(session, *argv)
        steps.append(step)
        return step

    tier = Tier(run.chrome_port)
    await tier.open()
    try:
        browse("open", f"{run.base}/{page}", "--no-changes")
        await tier.attach(page)
        read = None
        if number == 7:
            browse("wait", "200")
            browse("get", "title")
        elif number == 8:
            browse("wait", "500")
            browse("get", "title")
            browse("wait", "--text", "Act on me")
            await tier.click("#target")
            notes.append("click by the tier (D5 owns click)")
            browse("wait", "1500")
        elif number == 9:
            browse("get", "title")
            browse("wait", "--text", "Click me")
            await tier.click("#target")
            notes.append("click by the tier (D5 owns click)")
            browse("wait", "100")
        elif number == 10:
            await tier.phase("attached-idle")
            browse("wait", "1200")
            await tier.phase("actions")
            for _ in range(5):
                browse("get", "title")
                browse("wait", "--text", "Click me")
            await tier.phase("after")
            browse("wait", "1000")
            notes.append("no screenshot phase (D6) and no typing (D5)")
        elif number == 11:
            browse("wait", "2000")
            await tier.phase("attached")
            browse("wait", "1500")
            browse("get", "title")
            await tier.phase("acted")
            browse("wait", "800")
            read = {"headless": True, "reference": None, "flags": CHROME_FLAGS}
        elif number == 12:
            got = browse("get", "text", "#text")
            shot = browse("snapshot")
            read = {"text": got["out"]}
            notes.append("text read by `get text #text` through the closed shadow roots; the snapshot shows it too"
                         if got["out"] and got["out"] in shot["out"] else "the snapshot did not show the secret")
            if not (got["out"] and got["out"] in shot["out"]):
                read = {"text": None}
            await tier.click_pierced("#host", "#deep")
            notes.append("click by the tier through DOM.getDocument pierce (D5 owns click)")
        elif number == 13:
            browse("wait", "1500")
            text = browse("read")["full"]
            shot = browse("snapshot")["full"]
            read = {}
            for role in ROW13_ROLES:
                found = re.search(rf"secret-{role}-[a-z0-9]+", text)
                in_snapshot = re.search(rf"secret-{role}-[a-z0-9]+", shot)
                read[role] = found.group() if found and in_snapshot and found.group() == in_snapshot.group() else None
            notes.append("each frame's secret read by `read` and `snapshot` in its own session; clicks are D5's, so the page's clickOk "
                         "stays false and this row passes on readOk")
        verdict = await tier.finish(read)
    finally:
        await tier.close()
    failed = [step for step in steps if step["exit"] != 0]
    passed = bool(verdict.get("pass"))
    if number == 13:
        passed = bool(((verdict.get("measured") or {}).get("checks") or {}).get("readOk"))
    return {"row": number, "pass": passed and not failed, "verdict": verdict.get("pass"), "failed_steps": failed,
            "notes": notes, "measured": verdict.get("measured")}


def main() -> int:
    parser = argparse.ArgumentParser(description="ardia#2812 rows 7 to 11 driven through `ardia browse` against headless Chrome, with the "
                                                 "daemon's transcript checked for Runtime/Debugger/Console.enable on page sessions")
    parser.add_argument("--pages", type=Path, required=True)
    parser.add_argument("--impl", default="ts")
    parser.add_argument("--rows", default=",".join(map(str, ROWS)))
    parser.add_argument("--port", type=int, default=int(os.environ.get("ARDIA_M3_HUMAN_PORT", "9790")))
    parser.add_argument("--keep", type=Path)
    parser.add_argument("--chrome", default=os.environ.get("ARDIA_M3_HUMAN_CHROME") or None,
                        help="a full Chrome for Testing binary run with --headless=new; chrome-headless-shell is old-mode headless and sets navigator.webdriver")
    args = parser.parse_args()
    root = args.keep or Path(tempfile.mkdtemp(prefix="ardia-m3-human-"))
    if root.exists():
        shutil.rmtree(root)
    run = Run(root, args.impl, args.pages.resolve(), args.port, args.chrome or infra.chrome_binary())
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
            print("   ", json.dumps({"failed_steps": result["failed_steps"], "measured": result["measured"]})[:1500])
    print(f"transcript checks: {'clean' if not checks else checks}")
    if not args.keep:
        shutil.rmtree(root, ignore_errors=True)
    return 0 if all(result["pass"] for result in results) and not checks else 1


if __name__ == "__main__":
    sys.exit(main())
