import json
import sys

from tests.m3 import normalize

DIVERGENCES = {
    "busy-probe-isolated": {
        "row": 8,
        "commands": "any command on a tab whose page stopped answering in the last 120 s (the busy probe before it)",
        "python": 'Runtime.evaluate {"expression": "1", "returnByValue": true} on the page session, in the page\'s main world',
        "ts": 'Runtime.evaluate {"expression": "1", "contextId": <the ardia-browse world>, "returnByValue": true}, with '
              "Page.createIsolatedWorld first when that world isn't known for the current document",
        "why": "a main-world evaluation is visible to the page (ardia#2812 row 8); the isolated world shares the document but not its JS",
    },
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

UNANSWERING_FAULTS = ("drop", "stop")
PAGE_SESSION_ENABLES = ("Runtime.enable", "Debugger.enable", "Console.enable")
BUSY_PROBE = "1"


def daemon_of(impl: str) -> str:
    return impl.rsplit(":", 1)[-1]


def busy_probe(message: dict) -> bool:
    return message.get("method") == "Runtime.evaluate" and (message.get("params") or {}).get("expression") == BUSY_PROBE


MAC_SHORTCUT_KEYS = ("a", "c", "x", "v", "z")
META = 4


def rewrite(form: str, names: list[str]) -> str:
    if "busy-probe-isolated" not in names and "editing-commands" not in names:
        return form
    message = json.loads(form)
    if "editing-commands" in names and message.get("method") == "Input.dispatchKeyEvent" and "commands" in (message.get("params") or {}):
        params = dict(message["params"])
        params.pop("commands")
        message["params"] = params
        return normalize.canonical(message)
    if "busy-probe-isolated" in names and busy_probe(message):
        params = dict(message.get("params") or {})
        params.pop("contextId", None)
        message["params"] = params
        return normalize.canonical(message)
    return form


def apply(shaped: dict, names: list[str] | None) -> dict:
    if not names:
        return shaped
    unknown = [name for name in names if name not in DIVERGENCES]
    if unknown:
        raise ValueError(f"unknown divergence(s): {unknown}")
    for part in ("requests", "request_sets"):
        for step, sessions in shaped.get(part, {}).items():
            for session, value in sessions.items():
                if part == "requests":
                    sessions[session] = [sorted(form for form in (rewrite(item, names) for item in group) if form) for group in value]
                    sessions[session] = [group for group in sessions[session] if group]
                else:
                    sessions[session] = sorted({form for form in (rewrite(item, names) for item in value) if form})
    return shaped


def checks(transcript_path) -> list[str]:
    found = []
    touch_emulated = False
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
        if busy_probe(message) and "contextId" not in (message.get("params") or {}):
            found.append("row 8: the busy probe ran in the page's main world")
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
