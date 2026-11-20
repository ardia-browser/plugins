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
    "oopif-auto-attach": {
        "row": 13,
        "always": True,
        "commands": "every page session the TS daemon attaches",
        "python": "nothing: Python never sees out-of-process iframes",
        "ts": 'Target.setAutoAttach {"autoAttach": true, "waitForDebuggerOnStart": false, "flatten": true, "filter": iframes only} on the page '
              "session after Page.setLifecycleEventsEnabled, and on each iframe session it attaches; replay answers it with an empty result",
        "why": "reads and snapshots reach out-of-process iframes in their own sessions (ardia#2812 rows 13, 21)",
    },
    "temp-tab-marker": {
        "row": None,
        "always": True,
        "decision": "D2 round 3 (plugins#20): temporary tabs open at about:blank#ardia-temp-<nonce> so a later sweep finds lost ones",
        "commands": "read <url>... (temporary reader tabs)",
        "python": 'Target.createTarget {"url": "about:blank", "background": true} for a reader tab',
        "ts": 'Target.createTarget {"url": "about:blank#ardia-temp-<nonce>", "background": true}',
        "why": "a temporary tab lost at shutdown is closed by the next sweep only if it is marked (docs/cli.md accepted differences)",
    },
    "shadow-pierce": {
        "row": 12,
        "always": True,
        "commands": "a selector that matches nothing in the document (get, is, snapshot -s, read -s, get count)",
        "python": "nothing: the command fails with not_found",
        "ts": 'DOM.getDocument {"depth": -1, "pierce": true}, then each open or closed shadow root resolved into the isolated world and searched; '
              "replay answers it with an empty document",
        "why": "selectors reach elements inside closed shadow roots (ardia#2812 row 12)",
    },
}
TEMP_MARKER = "about:blank#ardia-temp-"

UNANSWERING_FAULTS = ("drop", "stop")
PAGE_SESSION_ENABLES = ("Runtime.enable", "Debugger.enable", "Console.enable")
BUSY_PROBE = "1"
WORLD_HANDLE = "globalThis"


def daemon_of(impl: str) -> str:
    return impl.rsplit(":", 1)[-1]


def busy_probe(message: dict) -> bool:
    return message.get("method") == "Runtime.evaluate" and (message.get("params") or {}).get("expression") == BUSY_PROBE


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
        if "oopif-auto-attach" in self.names and method == "Target.setAutoAttach":
            return None
        if "shadow-pierce" in self.names and method == "DOM.getDocument" and params.get("pierce") is True:
            return None
        if "temp-tab-marker" in self.names and method == "Target.createTarget" and str(params.get("url", "")).startswith(TEMP_MARKER):
            message = {**message, "params": {**params, "url": "about:blank"}}
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
