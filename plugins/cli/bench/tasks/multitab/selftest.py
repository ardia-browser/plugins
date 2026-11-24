#!/usr/bin/env python3
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from benchclient import Session, base, get_json, http

SCHED = base(8853)
PAYMENTS = ["priya.raman@northwind.dev", "marcus.chen@northwind.dev", "sofia.alvarez@northwind.dev",
            "hana.kim@northwind.dev", "alex.morgan@northwind.dev", "omar.haddad@northwind.dev"]
LENA = "lena.vogt@kontor.io"
CORRECT = {"title": "Kontor integration kickoff", "date": "2026-11-11", "start": "14:00", "duration": 45,
           "attendees": PAYMENTS + [LENA], "room": "mission", "description": ""}
ANSWER_STRINGS = ("kontor", "2026-11-11", "14:00", "mission", "lena", "priya", "omar")
failures = 0


def report(name, ok, extra=""):
    global failures
    failures += not ok
    print(f"{'PASS' if ok else 'FAIL'} {name}{' ' + extra if extra and not ok else ''}")


def without(email):
    return [a for a in CORRECT["attendees"] if a != email]


def put(sess, path, body):
    data = json.dumps(body).encode()
    status, raw, _ = http("PUT", sess.origin + path, data, sess.signed("PUT", path, data))
    return status, json.loads(raw or b"null")


def run(name, overrides, want_pass):
    http("POST", f"{SCHED}/api/reset")
    sess = Session(SCHED)
    status, _ = sess.post("/api/meetings", dict(CORRECT, **overrides))
    _, result = get_json(f"{SCHED}/api/check")
    ok = status == 201 and result["pass"] is want_pass and (result["completed_at_ms"] is not None) is want_pass
    report(name, ok, json.dumps(result["details"].get("wrong")))


http("POST", f"{SCHED}/api/reset")
_, initial = get_json(f"{SCHED}/api/check")
text = json.dumps({k: v for k, v in initial.items() if not k.endswith("_ms")}).lower()
report("initial check fails and leaks nothing", initial["pass"] is False and initial["total"] == 6
       and not any(a in text for a in ANSWER_STRINGS), text)

raw_status, _, _ = http("POST", f"{SCHED}/api/meetings", json.dumps(CORRECT).encode(), {"Content-Type": "application/json"})
report("unsigned direct POST is rejected", raw_status == 403)

sess = Session(SCHED)
status, invalid = sess.post("/api/meetings", {"title": " ", "date": "", "start": "2pm", "duration": 40, "attendees": ["lena"]})
report("invalid meeting is rejected with field errors", status == 422 and set(invalid["errors"]) == {"title", "date", "start", "duration", "attendees"})

run("correct meeting passes", {}, True)
_, after_pass = get_json(f"{SCHED}/api/check")
report("signed UI writes record method=ui", (after_pass.get("method") or {}).get("label") == "ui")
run("lenient title case and spacing passes", {"title": "  kontor   Integration KICKOFF ", "attendees": [a.upper() for a in CORRECT["attendees"]] + ["jordan@northwind.dev"]}, True)
run("trap: on-leave member invited", {"attendees": CORRECT["attendees"] + ["devon.brooks@northwind.dev"]}, False)
run("trap: former member from the stale rotation email", {"attendees": CORRECT["attendees"] + ["ravi.iyer@northwind.dev"]}, False)
run("trap: similarly named Alexa Morgan instead of Alex Morgan",
    {"attendees": without("alex.morgan@northwind.dev") + ["alexa.morgan@northwind.dev"]}, False)
run("trap: internal Lena Okafor instead of Lena from Kontor", {"attendees": without(LENA) + ["lena.okafor@northwind.dev"]}, False)
run("trap: room with a screen but too small", {"room": "alcatraz"}, False)
run("trap: big enough room with a screen but booked", {"room": "embarcadero"}, False)
run("trap: room without a screen", {"room": "presidio"}, False)
run("wrong duration fails", {"duration": 60}, False)

http("POST", f"{SCHED}/api/reset")
sess = Session(SCHED)
_, made = sess.post("/api/meetings", dict(CORRECT, room="twin-peaks"))
put(sess, f"/api/meetings/{made['id']}", CORRECT)
_, edited = get_json(f"{SCHED}/api/check")
report("editing the meeting into shape passes", edited["pass"] is True and edited["details"]["edits"] == 1)

http("POST", f"{SCHED}/api/reset")
_, cleared = get_json(f"{SCHED}/api/check")
_, week = get_json(f"{SCHED}/api/meetings?from=2026-11-09&to=2026-11-15")
report("reset clears created meetings", cleared["details"]["meetings_now"] == 0 and cleared["details"]["created"] == 0
       and all(m["seeded"] for m in week))
run("second correct run passes again", {}, True)
http("POST", f"{SCHED}/api/reset")
sys.exit(1 if failures else 0)
