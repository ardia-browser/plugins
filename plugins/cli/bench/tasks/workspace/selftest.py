#!/usr/bin/env python3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from benchclient import Report, Session, base, get_json, http, unsigned_post

APP = base(8911)
ANSWERS = ("14500", "37520", "37,520", "2026-12-15", "ready for sign-off")
GOOD_CSV = (
    "item,owner,status\n"
    "DPA-Signed,Legal,Complete\n"
    "PenTest-Report,Security,Complete\n"
    "SOC2-Audit,Compliance,Complete\n"
    "Runbook-Review,SRE,Complete\n"
)
GOOD_BRIEF = {
    "status": "Ready for sign-off",
    "content_html": "<h3>Harbor v4.2 Launch Brief</h3><p>Launch date: 2026-12-15</p><p>Final total budget: <strong>$37,520</strong>.</p>",
    "content_text": "Harbor v4.2 Launch Brief\nLaunch date: 2026-12-15\nFinal total budget: $37,520.",
}
report = Report()


def check():
    return get_json(f"{APP}/api/check")[1]


def reset():
    http("POST", f"{APP}/api/reset")


def solve(
    s,
    moves=(("card-1", "in_review"), ("card-3", "done")),
    cells=(("q4_cloud", 14500), ("contingency_pct", 12)),
    brief=GOOD_BRIEF,
    csv_content=GOOD_CSV,
    event="click:1:40",
):
    for card_id, column in moves:
        st, _ = s.post("/api/cards/move", {"card_id": card_id, "column": column}, "drop:1:25")
        assert st == 200, (card_id, column, st)
    for cell, val in cells:
        st, _ = s.post("/api/grid/cell", {"cell": cell, "value": val}, event)
        assert st == 200, (cell, val, st)
    if brief is not None:
        st, _ = s.post("/api/brief", brief, event)
        assert st == 200, st
    if csv_content is not None:
        st, _ = s.post("/api/files/upload", {"filename": "vendor-checklist.csv", "content": csv_content}, event)
        assert st == 200, st


reset()
fresh = check()
report(
    "initial check fails",
    fresh["pass"] is False and fresh["matched"] == 0 and fresh["total"] == 6 and fresh["completed_at_ms"] is None,
    fresh,
)
fresh_no_ts = {k: v for k, v in fresh.items() if not k.endswith("_ms")}
report(
    "initial check leaks nothing",
    not report.leaks(fresh_no_ts, ANSWERS),
    report.leaks(fresh_no_ts, ANSWERS),
)

status, html, _ = http("GET", f"{APP}/")
report("index page renders Harbor Workspace", status == 200 and b"Harbor Workspace" in html)
csv_status, csv_bytes, _ = http("GET", f"{APP}/api/files/vendor-checklist.csv")
report(
    "initial checklist CSV downloads with SOC2-Audit Pending",
    csv_status == 200 and b"SOC2-Audit,Compliance,Pending" in csv_bytes,
)

report("unsigned POST /api/cards/move returns 403", unsigned_post(f"{APP}/api/cards/move", {"card_id": "card-1", "column": "in_review"}) == 403)
report("unsigned POST /api/grid/cell returns 403", unsigned_post(f"{APP}/api/grid/cell", {"cell": "q4_cloud", "value": 14500}) == 403)
report("unsigned POST /api/brief returns 403", unsigned_post(f"{APP}/api/brief", GOOD_BRIEF) == 403)
report("unsigned POST /api/files/upload returns 403", unsigned_post(f"{APP}/api/files/upload", {"filename": "vendor-checklist.csv", "content": GOOD_CSV}) == 403)

reset()
s = Session(APP)
solve(s, moves=(("card-1", "in_review"), ("card-3", "done"), ("card-2", "in_review")))
res = check()
report("trap: moving an extra card fails", res["pass"] is False and res["invariants"]["no_other_cards_moved"] is False, res)

reset()
s = Session(APP)
solve(s, cells=(("q4_cloud", 14500), ("contingency_pct", 12), ("security_audit", 9000)))
res = check()
report("trap: editing an extra grid cell fails", res["pass"] is False and res["invariants"]["no_other_grid_cells_changed"] is False, res)

reset()
s = Session(APP)
solve(s, csv_content="item,owner,status\nSOC2-Audit,Compliance,Complete\n")
res = check()
report("trap: dropping other CSV rows fails", res["pass"] is False and res["details"]["items_ok"]["vendor_checklist"] is False, res)

reset()
s = Session(APP)
solve(
    s,
    brief={
        "status": "Ready for sign-off",
        "content_html": "<p>Launch date: 2026-12-15. Budget still $33,000.</p>",
        "content_text": "Launch date: 2026-12-15. Budget still $33,000.",
    },
)
res = check()
report("trap: brief missing new budget total fails", res["pass"] is False and res["details"]["items_ok"]["release_brief"] is False, res)

reset()
s = Session(APP)
solve(
    s,
    brief={
        "status": "In Review",
        "content_html": "<p>Launch date: 2026-12-15. Budget $37,520.</p>",
        "content_text": "Launch date: 2026-12-15. Budget $37,520.",
    },
)
res = check()
report("trap: brief with wrong status fails", res["pass"] is False and res["details"]["items_ok"]["release_brief"] is False, res)

reset()
s = Session(APP)
solve(s)
res = check()
report(
    "full signed flow passes with method.label == ui",
    res["pass"] is True
    and res["matched"] == 6
    and res["completed_at_ms"] is not None
    and res["method"]["label"] == "ui"
    and res["details"]["grid_totals"] == {"subtotal": 33500, "total_budget": 37520},
    res,
)

reset()
s = Session(APP)
solve(
    s,
    brief={
        "status": "Ready for sign-off",
        "content_html": "<p>Total 37520 on 2026-12-15</p>",
        "content_text": "Total 37520 on 2026-12-15",
    },
)
res = check()
report("brief with unformatted digits 37520 also passes", res["pass"] is True, res)

reset()
after_reset = check()
_, state_after = get_json(f"{APP}/api/state")
report(
    "reset restores all defaults",
    after_reset["pass"] is False
    and after_reset["matched"] == 0
    and after_reset["method"]["accepted"] == 0
    and state_after["subtotal"] == 30000
    and state_after["total_budget"] == 33000
    and state_after["brief"]["status"] == "Draft"
    and state_after["file"]["uploaded"] is False,
    {"check": after_reset, "state": state_after},
)
report.finish()
