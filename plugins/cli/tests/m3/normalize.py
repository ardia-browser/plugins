import gzip
import hashlib
import json
import re
from pathlib import Path

STRING_IDS = {"targetId", "frameId", "parentFrameId", "loaderId", "sessionId", "openerId", "openerFrameId", "browserContextId", "objectId",
              "requestId", "interceptionId", "networkId", "scriptId", "identifier", "uniqueId", "executionContextUniqueId", "uniqueContextId",
              "workerId", "navigationId"}
INT_IDS = {"nodeId": "node", "parentNodeId": "node", "backendNodeId": "backend", "backendDOMNodeId": "backend", "executionContextId": "context",
           "contextId": "context"}
SOURCE_KEYS = ("expression", "functionDeclaration", "source")
READY_PROBE = "() => document.readyState"
KEY = re.compile(r"\b[0-9a-f]{24}\b")
TABS_FILE = re.compile(r"tabs-[0-9a-f]+")
READ_STAMP = re.compile(r"(?<=\[read )\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC(?=\])")

REDACTED = "<REDACTED>"
SECRET_HEADERS = {"authorization", "proxy-authorization", "cookie"}


def redact_headers(headers):
    if isinstance(headers, list):
        return [{**header, "value": REDACTED} if isinstance(header, dict) and isinstance(header.get("name"), str)
                and header["name"].lower() in SECRET_HEADERS else header for header in headers]
    if isinstance(headers, dict):
        return {name: REDACTED if name.lower() in SECRET_HEADERS else value for name, value in headers.items()}
    return headers


def redact_secrets(message: dict) -> dict:
    params = message.get("params")
    method = message.get("method")
    if not isinstance(params, dict):
        return message
    kept = dict(params)
    auth = kept.get("authChallengeResponse")
    if method in ("Fetch.continueWithAuth", "Network.continueInterceptedRequest") and isinstance(auth, dict):
        kept["authChallengeResponse"] = {name: REDACTED if name in ("username", "password") else value for name, value in auth.items()}
    if method in ("Network.setExtraHTTPHeaders", "Fetch.continueRequest", "Network.continueInterceptedRequest") and "headers" in kept:
        kept["headers"] = redact_headers(kept["headers"])
    if method == "Network.setCookie" and "value" in kept:
        kept["value"] = REDACTED
    if method in ("Network.setCookies", "Storage.setCookies") and isinstance(kept.get("cookies"), list):
        kept["cookies"] = [{**cookie, "value": REDACTED} if isinstance(cookie, dict) else cookie for cookie in kept["cookies"]]
    return {**message, "params": kept} if kept != params else message


RULES = {
    "browser-ids": "values of the CDP ID fields in STRING_IDS and INT_IDS become <kind#n>, numbered by first appearance in the step's own requests (browser events cross step marks by timing)",
    "after-fault": "in a fault run, the faulted step's requests before the fault are left out; only the cleanup after it is compared",
    "message-id": "the top-level `id` of a request is dropped; requests are matched by content",
    "concurrency": "requests on one CDP session sent while another was unanswered are one group, compared as a sorted multiset",
    "scratch": "the side's scratch root (data dir, HOME, TMPDIR) becomes <SCRATCH> in answers, files and requests",
    "ports": "the tap's, Chromium's and the fixture server's port become <TAP>, <CHROME> and <FIXTURE> in answers and requests (recordings made before the fixture port was stored used 9419)",
    "ids-in-answers": "browser string IDs (8+ chars) seen in the transcript become their placeholder inside answer text",
    "session-key": "24-hex session keys in file names and answers become <KEY:session>",
    "tabs-file": "the tab registry's file name hash becomes tabs-<HASH>",
    "file-times": "`pid`, `started`, `at` and any float over 1e9 (epoch seconds) inside the session folder's JSON files become <PID> and <TIME>",
    "read-stamp": "the wall-clock time in `read`'s `[read YYYY-MM-DD HH:MM:SS UTC]` line becomes <TIME>",
    "live-sets": "live mode compares each step's requests as a set of distinct forms; order, counts and concurrency are replay's job, because Chromium's load timing decides how often the daemon polls",
    "ready-probe": "live mode ignores the `() => document.readyState` probe, which the daemon sends only when the load event hasn't arrived yet",
    "replay-order": "replay checks order in the tap: a request matches the recording within `lookahead` concurrency groups (tests/m3/elastic.json), so tasks that interleave by timing don't fail",
    "replay-repeats": "replay lets the read-only probes listed in tests/m3/elastic.json repeat or be skipped, since their count follows the daemon's sleeps",
    "unstable-steps": "live mode compares only exit and stderr of the steps a scenario lists in `unstable_steps`, with the reason in the scenario",
    "metrics": "of an answer's `metrics` only the key set is compared, never values",
    "secrets": "credential-bearing request params (continueWithAuth's username and password, Authorization/Proxy-Authorization/Cookie header values, cookie values being set) become <REDACTED>; the tap writes them redacted too, and replay matches on the redacted form",
    "racy-steps": "every mode compares only the exit status of the steps a scenario lists in `racy_steps`, where Chromium decides which of two errors the same request gets (the reason is in the scenario)",
    "whole-floats": "a whole-number float in a request's params (91.0) is compared as the integer (91): Python's json writes 91.0 for a float, JavaScript has one number type, and Chromium reads both the same",
    "divergences": "designed TS differences from tests/m3/divergences.py (`world-handle` always, the rest when a scenario names them) rewrite only the request fields they name, on both sides, before IDs are numbered",
}


def load(path: Path) -> list[dict]:
    raw = path.read_bytes()
    if path.suffix == ".gz":
        raw = gzip.decompress(raw)
    return [json.loads(line) for line in raw.decode("utf-8").split("\n") if line]


def whole_numbers(value):
    if isinstance(value, dict):
        return {name: whole_numbers(item) for name, item in value.items()}
    if isinstance(value, list):
        return [whole_numbers(item) for item in value]
    if isinstance(value, float) and value.is_integer() and abs(value) < 2 ** 53:
        return int(value)
    return value


def canonical(value) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


class Ids:
    def __init__(self):
        self.strings: dict[str, str] = {}
        self.ints: dict[tuple[str, int], str] = {}

    def string(self, value: str) -> str:
        if value not in self.strings:
            self.strings[value] = f"<id#{len(self.strings) + 1}>"
        return self.strings[value]

    def integer(self, family: str, value: int) -> str:
        key = (family, value)
        if key not in self.ints:
            self.ints[key] = f"<{family}#{sum(1 for known in self.ints if known[0] == family) + 1}>"
        return self.ints[key]

    def walk(self, value, key: str | None = None):
        if isinstance(value, dict):
            return {name: self.walk(item, name) for name, item in value.items()}
        if isinstance(value, list):
            return [self.walk(item, key) for item in value]
        if key in STRING_IDS and isinstance(value, str) and value:
            return self.string(value)
        if key in INT_IDS and isinstance(value, int) and not isinstance(value, bool):
            return self.integer(INT_IDS[key], value)
        return value

    def in_text(self, text: str) -> str:
        for value in sorted((known for known in self.strings if len(known) >= 8), key=len, reverse=True):
            if value in text:
                text = text.replace(value, self.strings[value])
        return text


RECORDED_FIXTURE = 9419


class Subs:
    def __init__(self, subs: dict):
        self.root = subs.get("root") or ""
        self.tap = subs.get("tap")
        self.chrome = subs.get("chrome")
        self.fixture = subs.get("fixture", RECORDED_FIXTURE)

    def text(self, text: str) -> str:
        if self.root:
            text = text.replace(self.root, "<SCRATCH>")
        for port, name in ((self.tap, "<TAP>"), (self.chrome, "<CHROME>"), (self.fixture, "<FIXTURE>")):
            if port:
                text = re.sub(rf"(?<=127\.0\.0\.1:){port}\b|(?<=localhost:){port}\b|(?<=--port ){port}\b", name, text)
        return text


def transcript(entries: list[dict], subs: Subs, rewrite=None) -> tuple[dict, Ids]:
    ids = Ids()
    local = Ids()
    step: str = "setup"
    steps: dict[str, dict] = {}
    open_by_session: dict[tuple, set] = {}
    session_of: dict[tuple, tuple] = {}
    sources: dict[str, set] = {}
    dropped: set = set()
    for entry in entries:
        kind = entry.get("k")
        if kind == "mark":
            step = str(entry.get("step"))
            local = Ids()
            continue
        if kind == "fault":
            step = f"{step}/after-fault"
            continue
        if kind not in ("in", "out"):
            continue
        try:
            message = json.loads(entry["m"])
        except (ValueError, KeyError):
            continue
        conn = entry.get("c", 0)
        if kind == "in":
            if (conn, message.get("id")) in dropped:
                dropped.discard((conn, message.get("id")))
                if hasattr(rewrite, "reply"):
                    rewrite.reply((conn, message.get("id")), message)
                continue
            ids.walk(message)
            found = (conn, message.get("id"))
            if found in session_of:
                open_by_session.get(session_of.pop(found), set()).discard(message.get("id"))
            continue
        if "method" not in message or "id" not in message:
            continue
        message = redact_secrets(message)
        if rewrite is not None:
            rewritten = rewrite(message, (conn, message["id"])) if hasattr(rewrite, "reply") else rewrite(message)
            if rewritten is None:
                dropped.add((conn, message["id"]))
                continue
            message = rewritten
        session = (conn, message.get("sessionId") or "")
        ids.walk(message)
        normalized = local.walk({name: value for name, value in message.items() if name != "id"})
        form = subs.text(canonical(whole_numbers(normalized)))
        groups = steps.setdefault(step, {}).setdefault(f"{conn}:{local.walk(session[1], 'sessionId') if session[1] else 'browser'}", [])
        waiting = open_by_session.setdefault(session, set())
        if not waiting or not groups:
            groups.append([])
        groups[-1].append(form)
        waiting.add(message["id"])
        session_of[(conn, message["id"])] = session
        for name in SOURCE_KEYS:
            source = (message.get("params") or {}).get(name)
            if isinstance(source, str) and source != READY_PROBE:
                sources.setdefault(step, set()).add(hashlib.sha256(subs.text(source).encode()).hexdigest()[:16])
    shaped = {name: {session: [sorted(group) for group in groups] for session, groups in sessions.items()} for name, sessions in steps.items()}
    sets = {name: {session: sorted({form for group in groups for form in group if READY_PROBE not in form}) for session, groups in sessions.items()}
            for name, sessions in steps.items()}
    return {"requests": shaped, "request_sets": sets, "sources": {name: sorted(found) for name, found in sources.items()}}, ids


def answer(step: dict, subs: Subs, ids: Ids, keys: dict) -> dict:
    def clean(text: str) -> str:
        text = READ_STAMP.sub("<TIME>", ids.in_text(subs.text(text or "")))
        return KEY.sub(lambda found: keys.get(found.group(), "<KEY>"), text)

    shaped = {"exit": step.get("exit"), "out": clean(step.get("out", "")), "err": clean(step.get("err", ""))}
    fields = []
    for item in step.get("answers") or []:
        got = item.get("answer") or {}
        fields.append({"code": got.get("code"), "busy_elsewhere": got.get("busy_elsewhere"), "exit": got.get("exit"),
                       "metrics": sorted((got.get("metrics") or {}).keys()) if isinstance(got.get("metrics"), dict) else got.get("metrics") is not None})
    shaped["answers"] = fields
    return shaped


def session_keys(files: dict) -> dict:
    keys = {}
    for name, entry in files.items():
        found = KEY.fullmatch(name.removesuffix(".json"))
        if found and isinstance(entry.get("json"), dict):
            keys[found.group()] = f"<KEY:{entry['json'].get('session')}>"
    return keys


def file_value(value, key: str | None = None):
    if isinstance(value, dict):
        return {name: file_value(item, name) for name, item in value.items()}
    if isinstance(value, list):
        return [file_value(item, key) for item in value]
    if key == "pid":
        return "<PID>"
    if key in ("started", "at") or (isinstance(value, float) and value > 1e9):
        return "<TIME>"
    return value


def files(found: dict, subs: Subs, ids: Ids, keys: dict) -> dict:
    shaped = {}
    for name, entry in found.items():
        clean = TABS_FILE.sub("tabs-<HASH>", KEY.sub(lambda hit: keys.get(hit.group(), "<KEY>"), name))
        item = {"mode": entry["mode"], "kind": entry["kind"]}
        if "json" in entry:
            text = ids.in_text(subs.text(json.dumps(ids.walk(file_value(entry["json"])))))
            item["json"] = json.loads(KEY.sub(lambda hit: keys.get(hit.group(), "<KEY>"), text))
        shaped[clean] = item
    return dict(sorted(shaped.items()))


def run(result, unstable: list[int] | None = None, racy: list[int] | None = None, rewrite=None) -> dict:
    subs = Subs(result.subs)
    requests, ids = transcript(load(result.transcript), subs, rewrite)
    keys = session_keys(result.files)
    answers = [answer(step, subs, ids, keys) for step in result.steps]
    for index in unstable or []:
        if index < len(answers):
            answers[index] = {"exit": answers[index]["exit"], "err": answers[index]["err"], "out": "<unstable>", "answers": "<unstable>"}
    for index in racy or []:
        if index < len(answers):
            answers[index] = {"exit": answers[index]["exit"], "err": "<racy>", "out": "<racy>", "answers": "<racy>"}
    return {
        "answers": answers,
        "files": files(result.files, subs, ids, keys),
        **requests,
    }
