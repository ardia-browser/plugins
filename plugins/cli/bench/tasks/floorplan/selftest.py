#!/usr/bin/env python3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from benchclient import Report, Session, base, get_json, http, unsigned_post

APP = base(8931)
ANSWERS = ("13:00-15:00", "q4", "jordan lee", "657")
DESK_CENTERS = {
    "C1": (66.0, 124.0),
    "Q1": (430.0, 124.0),
    "Q2": (518.0, 124.0),
    "Q4": (694.0, 124.0),
    "Q5": (489.0, 288.0),
}
GOOD = {
    "slot": "13:00-15:00",
    "desk": "Q4",
    "name": "Jordan Lee",
    "notes": "Quiet window seat with power",
    "click_x": DESK_CENTERS["Q4"][0],
    "click_y": DESK_CENTERS["Q4"][1],
}
report = Report()


def check():
    return get_json(f"{APP}/api/check")[1]


def reset():
    http("POST", f"{APP}/api/reset")


def reserve_case(label, want_status, want_pass=False, event="click:1:50", **changes):
    reset()
    s = Session(APP, "/")
    body = dict(GOOD, **changes)
    status, out = s.post("/api/reserve", body, event)
    r = check()
    ok = status == want_status and (want_status != 200 or (r["pass"] is want_pass and (r["completed_at_ms"] is not None) is want_pass))
    report(label, ok, {"status": status, "out": out, "check": r})
    return status, out, r


reset()
fresh = check()
report("fresh state fails", fresh["pass"] is False and fresh["completed_at_ms"] is None and fresh["matched"] == 0, fresh)
report("fresh check leaks nothing", not report.leaks(fresh, ANSWERS), report.leaks(fresh, ANSWERS))
report("check reports method and invariants", isinstance(fresh.get("method"), dict) and isinstance(fresh.get("invariants"), dict))

for path in ("/", "/floorplan.css", "/floorplan.js", "/realism.js"):
    report(f"floorplan serves {path}", http("GET", f"{APP}{path}")[0] == 200)

reset()
report("unsigned POST rejected with 403", unsigned_post(f"{APP}/api/reserve", GOOD) == 403)
report("unsigned POST records nothing", check()["details"]["reservations_submitted"] == 0)

reserve_case("out-of-bounds canvas coords rejected", 422, click_x=10.0, click_y=10.0)
reserve_case("coords inside wrong desk rejected", 422, click_x=DESK_CENTERS["Q2"][0], click_y=DESK_CENTERS["Q2"][1])
reserve_case("default slot 09:00-11:00 Q4 is occupied", 422, slot="09:00-11:00")
reserve_case("default slot 09:00-11:00 Q2 trap fails", 200, False, slot="09:00-11:00", desk="Q2", click_x=DESK_CENTERS["Q2"][0], click_y=DESK_CENTERS["Q2"][1])
reserve_case("no-power Q2 trap in 13:00-15:00 fails", 200, False, desk="Q2", click_x=DESK_CENTERS["Q2"][0], click_y=DESK_CENTERS["Q2"][1])
reserve_case("interior Q5 trap in 13:00-15:00 fails", 200, False, desk="Q5", click_x=DESK_CENTERS["Q5"][0], click_y=DESK_CENTERS["Q5"][1])
reserve_case("collaborative C1 trap in 13:00-15:00 fails", 200, False, desk="C1", click_x=DESK_CENTERS["C1"][0], click_y=DESK_CENTERS["C1"][1])
reserve_case("occupied Q1 in 13:00-15:00 rejected", 422, desk="Q1", click_x=DESK_CENTERS["Q1"][0], click_y=DESK_CENTERS["Q1"][1])
reserve_case("wrong guest name fails", 200, False, name="Sam Rivera")

_, _, r_scripted = reserve_case("scripted submit passes as ui_scripted", 200, True, event="click:0:30")
report("scripted method label is ui_scripted", r_scripted["method"]["label"] == "ui_scripted", r_scripted["method"])

_, _, r_ok = reserve_case("exact Q4 reservation with valid coords passes", 200, True)
report("exact reservation records ui method", r_ok["method"]["label"] == "ui", r_ok["method"])

reset()
after_reset = check()
report(
    "reset clears state and guard",
    after_reset["pass"] is False
    and after_reset["matched"] == 0
    and after_reset["details"]["reservations_submitted"] == 0
    and after_reset["method"]["accepted"] == 0
    and after_reset["method"]["label"] == "none",
    after_reset,
)
report.finish()
