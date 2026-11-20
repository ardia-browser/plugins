import json

from tests.m3 import normalize

DIVERGENCES = {
    "world-handle": {
        "row": 8,
        "always": True,
        "commands": "every isolated-world page call",
        "python": 'Runtime.callFunctionOn {"executionContextId": <world>, ...}',
        "ts": 'Runtime.evaluate {"expression": "globalThis", "contextId": <world>, "returnByValue": false} once per world, then '
              'Page.getFrameTree on the same session to bind the handle to the loader it reports, then '
              'Runtime.callFunctionOn {"objectId": <that handle>, ...}',
        "why": "a numeric context id can be reused across renderer processes; the handle's object id is refused by the renderer once "
               "its document is gone, so a call never runs in a document it wasn't meant for",
    },
    "busy-probe-isolated": {
        "row": 8,
        "commands": "any command on a tab whose page stopped answering in the last 120 s (the busy probe before it)",
        "python": 'Runtime.evaluate {"expression": "1", "returnByValue": true} on the page session, in the page\'s main world',
        "ts": 'Runtime.evaluate {"expression": "1", "contextId": <the ardia-browse world>, "returnByValue": true}, with '
              "Page.createIsolatedWorld first when that world isn't known for the current document",
        "why": "a main-world evaluation is visible to the page (ardia#2812 row 8); the isolated world shares the document but not its JS",
    },
    "eval-isolated": {
        "row": 9,
        "commands": "eval (without --main-world)",
        "python": 'Runtime.evaluate {"expression": <script>, "returnByValue": true, "awaitPromise": true, "userGesture": false} on the '
                  "page session, in the page's main world",
        "ts": 'Runtime.callFunctionOn {"functionDeclaration": "function (source) { return (0, eval)(source); }", "objectId": '
              '<the ardia-browse world>, "arguments": [{"value": <script>}], "returnByValue": true, "awaitPromise": true, "userGesture": false}',
        "why": "a main-world evaluation leaves globals and stack frames the page can see (ardia#2812 rows 8 and 9); the isolated world "
               "shares the document but not its JavaScript. `eval --main-world` keeps the old way for code that needs the page's globals",
    },
    "script-isolated": {
        "row": 9,
        "commands": "script (its controller in the temporary tab)",
        "python": 'Runtime.evaluate {"expression": <CONTROLLER>, "returnByValue": false, "awaitPromise": true} in the controller tab\'s '
                  "main world",
        "ts": "Page.createIsolatedWorld and the library in the controller tab, then Runtime.callFunctionOn "
              '{"functionDeclaration": "function () { return (<CONTROLLER>); }", "objectId": <the ardia-browse world>, "arguments": [], '
              '"returnByValue": false, "awaitPromise": true}; the worker and every later controller call are the same. In this scenario '
              "Page.createIsolatedWorld and the library evaluation aren't compared on either side (core/* compares them)",
        "why": "the controller's global and its worker live in the isolated world, so nothing the script machinery defines is visible "
               "to a page (ardia#2812 row 9)",
    },
}

ISOLATED_EVAL = "function (source) { return (0, eval)(source); }"
SCRIPT_CONTROLLER_HEAD = "\n(() => {\n  if (globalThis.__ardiaScript) return globalThis.__ardiaScript;"

UNANSWERING_FAULTS = ("drop", "stop")
PAGE_SESSION_ENABLES = ("Runtime.enable", "Debugger.enable", "Console.enable")
BUSY_PROBE = "1"
WORLD_HANDLE = "globalThis"


def daemon_of(impl: str) -> str:
    return impl.rsplit(":", 1)[-1]


def busy_probe(message: dict) -> bool:
    return message.get("method") == "Runtime.evaluate" and (message.get("params") or {}).get("expression") == BUSY_PROBE


def main_world_eval(message: dict) -> bool:
    params = message.get("params") or {}
    return (message.get("method") == "Runtime.evaluate" and "contextId" not in params and params.get("userGesture") is False
            and params.get("returnByValue") is True and params.get("awaitPromise") is True)


def library() -> str:
    from ardia_cli.browse.js import LIBRARY

    return LIBRARY


def names_for(scenario: dict, fault=None) -> list[str]:
    names = [name for name, entry in DIVERGENCES.items() if entry.get("always")]
    for name in scenario.get("divergences") or []:
        if name not in DIVERGENCES:
            raise ValueError(f"unknown divergence: {name}")
        if name not in names:
            names.append(name)
    if fault is not None and fault.kind in UNANSWERING_FAULTS and "busy-probe-isolated" not in names:
        names.append("busy-probe-isolated")
    return names


class Rewriter:
    def __init__(self, names: list[str]):
        unknown = [name for name in names if name not in DIVERGENCES]
        if unknown:
            raise ValueError(f"unknown divergence(s): {unknown}")
        self.names = names
        self.binding: set = set()
        self.handle_requests: set = set()
        self.handles: set = set()

    def reply(self, key, message: dict):
        if key in self.handle_requests:
            self.handle_requests.discard(key)
            handle = ((message.get("result") or {}).get("result") or {}).get("objectId")
            if isinstance(handle, str):
                self.handles.add(handle)

    def __call__(self, message: dict, key=None) -> dict | None:
        params = message.get("params") or {}
        method = message.get("method")
        session = message.get("sessionId") or ""
        if "world-handle" in self.names:
            if method == "Runtime.evaluate" and params.get("expression") == WORLD_HANDLE and params.get("returnByValue") is False:
                self.binding.add(session)
                self.handle_requests.add(key)
                return None
            if session in self.binding:
                self.binding.discard(session)
                if method == "Page.getFrameTree":
                    return None
            if method == "Runtime.callFunctionOn":
                kept = {name: value for name, value in params.items()
                        if name != "executionContextId" and not (name == "objectId" and value in self.handles)}
                message = {**message, "params": kept}
        if "eval-isolated" in self.names and main_world_eval(message):
            message = {**message, "method": "Runtime.callFunctionOn", "params": {
                "functionDeclaration": ISOLATED_EVAL, "arguments": [{"value": params.get("expression")}], "returnByValue": True,
                "awaitPromise": True, "userGesture": False}}
        if "script-isolated" in self.names:
            if method == "Page.createIsolatedWorld" or (method == "Runtime.evaluate" and params.get("expression") == library()):
                return None
            if method == "Runtime.evaluate" and str(params.get("expression") or "").startswith(SCRIPT_CONTROLLER_HEAD):
                message = {**message, "method": "Runtime.callFunctionOn", "params": {
                    "functionDeclaration": f"function () {{ return ({params['expression']}); }}", "arguments": [], "returnByValue": False,
                    "awaitPromise": True}}
        if "busy-probe-isolated" in self.names and busy_probe(message):
            message = {**message, "params": {name: value for name, value in params.items() if name != "contextId"}}
        return message


def rewriter(names: list[str]) -> Rewriter:
    return Rewriter(names)


def checks(transcript_path) -> list[str]:
    found = []
    worlds = set()
    binding = set()
    for entry in normalize.load(transcript_path):
        if entry.get("k") != "out":
            continue
        try:
            message = json.loads(entry["m"])
        except (ValueError, KeyError):
            continue
        if not message.get("sessionId"):
            continue
        if message.get("method") in PAGE_SESSION_ENABLES:
            found.append(f"row 8: {message['method']} sent on a page session")
        if message.get("method") == "Page.createIsolatedWorld":
            worlds.add(message["sessionId"])
        params = message.get("params") or {}
        if message["sessionId"] in binding:
            binding.discard(message["sessionId"])
            if message.get("method") != "Page.getFrameTree":
                found.append("a world handle was used before its loader was checked by Page.getFrameTree")
        if message.get("method") == "Runtime.evaluate" and params.get("expression") == WORLD_HANDLE and params.get("returnByValue") is False:
            binding.add(message["sessionId"])
        if busy_probe(message) and "contextId" not in (message.get("params") or {}) and message["sessionId"] in worlds:
            found.append("row 8: the busy probe ran in the page's main world though the page had an isolated world")
        if message.get("method") == "Runtime.callFunctionOn" and "executionContextId" in (message.get("params") or {}):
            found.append("a page call named a numeric execution context instead of its world handle")
    return sorted(set(found))
