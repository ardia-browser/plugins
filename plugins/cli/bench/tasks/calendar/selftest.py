#!/usr/bin/env python3
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from benchclient import Session, base, get_json, http

APP = base(8791)
CORRECT = [
    {"title": "Pipeline review", "calendar": "board", "date": "2026-11-09", "start": "10:00", "end": "11:00"},
    {"title": "Design partner call", "calendar": "board", "date": "2026-11-10", "start": "14:00", "end": "15:00"},
    {"title": "Board prep", "calendar": "board", "date": "2026-11-11", "start": "09:00", "end": "10:30"},
    {"title": "Q3 deck review", "calendar": "board", "date": "2026-11-12", "start": "16:00", "end": "17:00"},
    {"title": "Investor update", "calendar": "board", "date": "2026-11-13", "start": "11:00", "end": "12:00"},
]
ANSWER_STRINGS = ("pipeline", "design partner", "board prep", "q3 deck", "investor", "2026-11-1", "10:30", "16:00")
failures = 0


def report(name, ok, extra=""):
    global failures
    failures += not ok
    print(f"{'PASS' if ok else 'FAIL'} {name}{' ' + extra if extra and not ok else ''}")


def run(name, events, want_pass):
    http("POST", f"{APP}/api/reset")
    sess = Session(APP)
    statuses = [sess.post("/api/events", event)[0] for event in events]
    _, result = get_json(f"{APP}/api/check")
    ok = all(s == 200 for s in statuses) and result["pass"] is want_pass and (result["completed_at_ms"] is not None) is want_pass
    report(name, ok, json.dumps(result["details"].get("extra")))


http("POST", f"{APP}/api/reset")
_, initial = get_json(f"{APP}/api/check")
text = json.dumps({k: v for k, v in initial.items() if not k.endswith("_ms")}).lower()
report("initial check fails and leaks nothing", initial["pass"] is False and initial["matched"] == 0
       and not any(a in text for a in ANSWER_STRINGS), text)

raw_status, _, _ = http("POST", f"{APP}/api/events", json.dumps(CORRECT[0]).encode(), {"Content-Type": "application/json"})
report("unsigned direct POST is rejected", raw_status == 403)

sess = Session(APP)
status, _ = sess.post("/api/events", {"title": "", "date": "2026-11-09", "start": "10:00", "end": "11:00"})
report("an event without a title is rejected", status == 400)

run("correct events pass", CORRECT, True)
_, after_pass = get_json(f"{APP}/api/check")
report("signed UI writes record method=ui", (after_pass.get("method") or {}).get("label") == "ui")
run("title case doesn't matter", [dict(e, title=e["title"].upper()) for e in CORRECT], True)
run("trap: one event missing", CORRECT[:-1], False)
run("trap: an extra event", CORRECT + [dict(CORRECT[0], title="Coffee")], False)
run("trap: a duplicate event", CORRECT + [CORRECT[0]], False)
run("trap: wrong calendar", [dict(CORRECT[0], calendar="personal")] + CORRECT[1:], False)
run("trap: PM read as AM", CORRECT[:1] + [dict(CORRECT[1], start="02:00", end="03:00")] + CORRECT[2:], False)
run("trap: half-hour end dropped", CORRECT[:2] + [dict(CORRECT[2], end="10:00")] + CORRECT[3:], False)

http("POST", f"{APP}/api/reset")
_, cleared = get_json(f"{APP}/api/check")
report("reset clears the events", cleared["details"]["total_events"] == 0)
run("second correct run passes again", CORRECT, True)
http("POST", f"{APP}/api/reset")
sys.exit(1 if failures else 0)
