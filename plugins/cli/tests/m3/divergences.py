import json
import sys

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
}

EDITING_COMMANDS = {
    "editing-commands": {
        "row": 20,
        "commands": "press, keydown and fill's select-all: a shortcut with Control, Meta or Alt",
        "python": 'Input.dispatchKeyEvent with "commands" for Control or Meta with a, z, y and Shift+z, on every platform',
        "ts": 'Input.dispatchKeyEvent with "commands" for every macOS editing shortcut (Meta with a, c, x, v, z, Shift+z; Meta and Alt '
              "with the arrows, Backspace and Delete), and none on Linux and Windows",
        "why": "on macOS a native contenteditable ignores Meta+z, Meta+c and the rest without the editing command (ardia#2812 row 20); "
               "Control+a is not select-all there",
    },
}
DIVERGENCES.update(EDITING_COMMANDS)

UNANSWERING_FAULTS = ("drop", "stop")
MAC_SHORTCUT_KEYS = ("a", "c", "x", "v", "z")
META = 4
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


def rewriter(names: list[str]):
    unknown = [name for name in names if name not in DIVERGENCES]
    if unknown:
        raise ValueError(f"unknown divergence(s): {unknown}")

    binding: set = set()

    def rewrite(message: dict) -> dict | None:
        params = message.get("params") or {}
        method = message.get("method")
        session = message.get("sessionId") or ""
        if "world-handle" in names:
            if method == "Runtime.evaluate" and params.get("expression") == WORLD_HANDLE and params.get("returnByValue") is False:
                binding.add(session)
                return None
            if session in binding:
                binding.discard(session)
                if method == "Page.getFrameTree":
                    return None
            if method == "Runtime.callFunctionOn":
                kept = {key: value for key, value in params.items() if key not in ("executionContextId", "objectId")}
                message = {**message, "params": kept}
        if "editing-commands" in names and method == "Input.dispatchKeyEvent" and "commands" in params:
            message = {**message, "params": {key: value for key, value in params.items() if key != "commands"}}
        if "busy-probe-isolated" in names and busy_probe(message):
            message = {**message, "params": {key: value for key, value in params.items() if key != "contextId"}}
        return message

    return rewrite


def checks(transcript_path) -> list[str]:
    found = []
    worlds = set()
    touch_emulated = False
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
        params = message.get("params") or {}
        if (sys.platform == "darwin" and message.get("method") == "Input.dispatchKeyEvent" and params.get("type") in ("keyDown", "rawKeyDown")
                and (params.get("modifiers") or 0) & META and str(params.get("key", "")).lower() in MAC_SHORTCUT_KEYS and not params.get("commands")):
            found.append(f"row 20: Meta+{params.get('key')} sent without its editing command")
        if message.get("method") == "Input.dispatchTouchEvent" and not touch_emulated:
            found.append("row 1: a touch event was sent without touch emulation")
        if message.get("method") == "Emulation.setTouchEmulationEnabled":
            touch_emulated = bool(params.get("enabled"))
        if message.get("method") == "Runtime.callFunctionOn" and "navigator.maxTouchPoints" in str(params.get("functionDeclaration", "")):
            touch_emulated = True
    return sorted(set(found))
