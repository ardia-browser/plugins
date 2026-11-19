import json

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
    "oopif-auto-attach": {
        "row": 13,
        "commands": "every page session the TS daemon attaches (always applied)",
        "python": "nothing: Python never sees out-of-process iframes",
        "ts": 'Target.setAutoAttach {"autoAttach": true, "waitForDebuggerOnStart": false, "flatten": true, "filter": iframes only} on the page '
              "session after Page.setLifecycleEventsEnabled, and on each iframe session it attaches; replay answers it with an empty result",
        "why": "reads and snapshots reach out-of-process iframes in their own sessions (ardia#2812 rows 13, 21)",
    },
    "temp-tab-marker": {
        "row": None,
        "commands": "read <url>... (temporary reader tabs), always applied",
        "python": 'Target.createTarget {"url": "about:blank", "background": true} for a reader tab',
        "ts": 'Target.createTarget {"url": "about:blank#ardia-temp-<nonce>", "background": true}, D2\'s marked temporary tabs that a later sweep can find',
        "why": "D2 review: a temporary tab lost at shutdown is closed by the next sweep only if it is marked (docs/cli.md accepted differences)",
    },
    "shadow-pierce": {
        "row": 12,
        "commands": "a selector that matches nothing in the document (get, is, snapshot -s, read -s, get count), always applied",
        "python": "nothing: the command fails with not_found",
        "ts": 'DOM.getDocument {"depth": -1, "pierce": true}, then each open or closed shadow root resolved into the isolated world and searched',
        "why": "selectors reach elements inside closed shadow roots (ardia#2812 row 12)",
    },
}
ALWAYS = ("oopif-auto-attach", "temp-tab-marker", "shadow-pierce")
TEMP_MARKER = "about:blank#ardia-temp-"
AUTO_ATTACH = "Target.setAutoAttach"

UNANSWERING_FAULTS = ("drop", "stop")
PAGE_SESSION_ENABLES = ("Runtime.enable", "Debugger.enable", "Console.enable")
BUSY_PROBE = "1"


def daemon_of(impl: str) -> str:
    return impl.rsplit(":", 1)[-1]


def busy_probe(message: dict) -> bool:
    return message.get("method") == "Runtime.evaluate" and (message.get("params") or {}).get("expression") == BUSY_PROBE


def rewrite(form: str, names: list[str]) -> str:
    parsed = json.loads(form)
    if "oopif-auto-attach" in names and parsed.get("method") == AUTO_ATTACH:
        return ""
    if "shadow-pierce" in names and parsed.get("method") == "DOM.getDocument" and (parsed.get("params") or {}).get("pierce") is True:
        return ""
    if "temp-tab-marker" in names and parsed.get("method") == "Target.createTarget" and str((parsed.get("params") or {}).get("url", "")).startswith(TEMP_MARKER):
        parsed["params"] = {**parsed["params"], "url": "about:blank"}
        return normalize.canonical(parsed)
    if "busy-probe-isolated" not in names:
        return form
    message = json.loads(form)
    if busy_probe(message):
        params = dict(message.get("params") or {})
        params.pop("contextId", None)
        message["params"] = params
        return normalize.canonical(message)
    return form


def apply(shaped: dict, names: list[str] | None) -> dict:
    names = list(names or []) + [name for name in ALWAYS if name not in (names or [])]
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
    return sorted(set(found))
