import asyncio
import json
import sys
import urllib.request
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from ardia_cli import guard
from ardia_cli.browse import connection

DIRECT = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def tap(port: int, path: str, body: dict) -> None:
    request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(body).encode(), method="POST",
                                     headers={"content-type": "application/json"})
    with DIRECT.open(request, timeout=10) as response:
        response.read()


def lookup(saved: dict, reference: str):
    name, _, path = reference[1:].partition(".")
    value = saved.get(name)
    for part in path.split(".") if path else []:
        value = value.get(part) if isinstance(value, dict) else None
    return value


def resolved(value, saved: dict, index: int | None = None):
    if isinstance(value, str) and value.startswith("@"):
        return lookup(saved, value)
    if isinstance(value, str) and index is not None:
        return value.replace("{i}", str(index))
    if isinstance(value, dict):
        return {key: resolved(item, saved, index) for key, item in value.items()}
    if isinstance(value, list):
        return [resolved(item, saved, index) for item in value]
    return value


def shaped(result, keep):
    if keep == "keys":
        return sorted(result) if isinstance(result, dict) else None
    if isinstance(keep, dict) and "len" in keep:
        value = result
        for part in keep["len"].split("."):
            value = value.get(part) if isinstance(value, dict) else None
        return {"len": len(value) if isinstance(value, str) else None}
    return result


def failed(error: BaseException) -> dict:
    kind = "CancelledError" if isinstance(error, asyncio.CancelledError) else type(error).__name__
    return {"error": {"type": kind, "message": str(error), "code": getattr(error, "code", None)}}


class Driver:
    def __init__(self, url: str, tap_port: int):
        self.url = url
        self.tap_port = tap_port
        self.browser = None
        self.saved: dict = {}
        self.events: dict[str, int] = {}

    def on_event(self, method, params, session):
        self.events[method] = self.events.get(method, 0) + 1

    async def open(self, url: str | None = None):
        url = (url or self.url).replace("{tap}", str(self.tap_port))
        endpoint = SimpleNamespace(ws=url, instance=None, explicit=True, source=f"--port {self.tap_port}")
        self.browser = connection.Browser(endpoint, self.on_event)
        try:
            await self.browser.open()
            return {"ok": True}
        except Exception as error:
            return failed(error)

    async def send(self, op: dict, index: int | None = None):
        params = resolved(op.get("params"), self.saved, index)
        session = resolved(op.get("session"), self.saved)
        try:
            result = await self.browser.send(op["method"], params, session, timeout=op.get("timeout", 30), mutation=op.get("mutation", False))
        except (Exception, asyncio.CancelledError) as error:
            return failed(error)
        if op.get("save"):
            self.saved[op["save"]] = result
        return {"ok": shaped(result, op.get("keep", "full"))}

    async def run(self, op: dict):
        kind = op["op"]
        if kind == "open":
            return await self.open(op.get("url"))
        if kind == "send":
            return await self.send(op)
        if kind == "gather":
            return {"all": list(await asyncio.gather(*(self.send(one) for one in op["sends"])))}
        if kind == "pipeline":
            results = await asyncio.gather(*(self.send(op["send"], index) for index in range(op["count"])))
            return {"all": results} if op.get("keep_all") else {"count": len(results), "ok": sum(1 for one in results if "ok" in one),
                                                                   "distinct": len({json.dumps(one, sort_keys=True) for one in results})}
        if kind == "cancel":
            task = asyncio.ensure_future(self.send_raw(op["send"]))
            await asyncio.sleep(op.get("after", 0.2))
            task.cancel()
            try:
                return {"ok": await task}
            except (Exception, asyncio.CancelledError) as error:
                return failed(error)
        if kind == "fault":
            tap(self.tap_port, "/tap/fault", op["fault"])
            return {"ok": True}
        if kind == "sleep":
            await asyncio.sleep(op["seconds"])
            return {"ok": True}
        if kind == "close":
            await self.browser.close()
            return {"alive": self.browser.alive}
        if kind == "alive":
            return {"alive": self.browser.alive}
        if kind == "wait_lost":
            deadline = asyncio.get_running_loop().time() + op.get("seconds", 5)
            while self.browser.alive and asyncio.get_running_loop().time() < deadline:
                await asyncio.sleep(0.02)
            return {"alive": self.browser.alive}
        if kind == "events":
            return {"seen": sorted(name for name in op["names"] if self.events.get(name))}
        if kind == "guard":
            try:
                guard.check_message(op["message"])
                return {"ok": True}
            except guard.ForbiddenCommand as error:
                return failed(error)
        raise ValueError(f"unknown op {kind}")

    async def send_raw(self, op: dict):
        params = resolved(op.get("params"), self.saved)
        session = resolved(op.get("session"), self.saved)
        return shaped(await self.browser.send(op["method"], params, session, timeout=op.get("timeout", 30)), op.get("keep", "full"))

    async def script(self, ops: list[dict]):
        out = []
        for index, op in enumerate(ops):
            tap(self.tap_port, "/tap/mark", {"step": index})
            out.append(await self.run(op))
        if self.browser is not None and self.browser.alive:
            tap(self.tap_port, "/tap/mark", {"step": "teardown"})
            await self.browser.close()
        return out


def main() -> int:
    url, script, tap_port = sys.argv[1], Path(sys.argv[2]), int(sys.argv[3])
    ops = json.loads(script.read_text())["ops"]
    results = asyncio.run(asyncio.wait_for(Driver(url, tap_port).script(ops), 600))
    sys.stdout.write(json.dumps(results) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
