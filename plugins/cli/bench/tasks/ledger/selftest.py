#!/usr/bin/env python3
import csv
import io
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from benchclient import Report, Session, base, get_json, http, unsigned_post

APP = base(8901)
EXPECTED = {
    "count": 31,
    "total_usd": "$259,247.95",
    "top_invoice": "INV-260217",
    "top_vendor": "Helios Compute",
}
ANSWERS = ("31", "259247", "259,247", "inv-260217", "helios compute")
report = Report()


def check():
    return get_json(f"{APP}/api/check")[1]


def reset():
    http("POST", f"{APP}/api/reset")


def submit(payload, event="click:1:40"):
    reset()
    s = Session(APP)
    st, body = s.post("/api/reconcile", payload, event)
    return st, body, check()


reset()
fresh = check()
report(
    "initial check fails",
    fresh["pass"] is False and fresh["matched"] == 0 and fresh["total"] == 4 and fresh["completed_at_ms"] is None,
    fresh,
)
fresh_no_ts = {k: v for k, v in fresh.items() if not k.endswith("_ms")}
report(
    "initial check leaks nothing",
    not report.leaks(fresh_no_ts, ANSWERS),
    report.leaks(fresh_no_ts, ANSWERS),
)

status, html, _ = http("GET", f"{APP}/")
report("index page renders Meridian Ledger", status == 200 and b"Meridian Ledger" in html)
status_js, _, _ = http("GET", f"{APP}/realism.js")
report("realism.js is served", status_js == 200)

report("unsigned POST returns 403", unsigned_post(f"{APP}/api/reconcile", EXPECTED) == 403)
report("unsigned POST does not alter state", check()["details"]["submitted"] is None)

all_rows = []
offset = 0
pages = 0
while True:
    st, page = get_json(f"{APP}/api/rows?offset={offset}&limit=25")
    assert st == 200
    all_rows.extend(page["rows"])
    pages += 1
    if not page["has_more"]:
        break
    offset = page["next_offset"]

top_index = next((i for i, r in enumerate(all_rows) if r["id"] == EXPECTED["top_invoice"]), -1)
report(
    "paginated /api/rows yields 240 rows with top invoice past row 200",
    len(all_rows) == 240 and pages == 10 and top_index >= 200,
    {"count": len(all_rows), "pages": pages, "top_index": top_index},
)

csv_status, csv_raw, csv_headers = http("GET", f"{APP}/api/export.csv")
csv_rows = list(csv.DictReader(io.StringIO(csv_raw.decode("utf-8"))))
report(
    "/api/export.csv has 240 data rows and required columns",
    csv_status == 200
    and len(csv_rows) == 240
    and list(csv_rows[0].keys()) == ["id", "date", "quarter", "vendor", "category", "status", "amount_cents", "duplicate_of"],
    {"status": csv_status, "len": len(csv_rows)},
)

first25 = [
    r for r in all_rows[:25]
    if r["quarter"] == "Q3 2026" and r["category"] == "Infrastructure" and r["status"] == "Approved" and not r["duplicate_of"]
]
first25_total = sum(r["amount_cents"] for r in first25) / 100
first25_top = max(first25, key=lambda r: r["amount_cents"])["id"]
st, _, res = submit({
    "count": len(first25),
    "total_usd": f"{first25_total:.2f}",
    "top_invoice": first25_top,
    "top_vendor": "Strata Networks",
})
report("trap: first-25-only totals fail", st == 200 and res["pass"] is False, res)

with_void = [
    r for r in all_rows
    if r["quarter"] == "Q3 2026" and r["category"] == "Infrastructure" and r["status"] in ("Approved", "VOID") and not r["duplicate_of"]
]
st, _, res = submit({
    "count": len(with_void),
    "total_usd": f"{sum(r['amount_cents'] for r in with_void) / 100:.2f}",
    "top_invoice": max(with_void, key=lambda r: r["amount_cents"])["id"],
    "top_vendor": EXPECTED["top_vendor"],
})
report("trap: including VOID rows fails", st == 200 and res["pass"] is False, res)

with_dup = [
    r for r in all_rows
    if r["quarter"] == "Q3 2026" and r["category"] == "Infrastructure" and r["status"] == "Approved"
]
st, _, res = submit({
    "count": len(with_dup),
    "total_usd": f"{sum(r['amount_cents'] for r in with_dup) / 100:.2f}",
    "top_invoice": EXPECTED["top_invoice"],
    "top_vendor": EXPECTED["top_vendor"],
})
report("trap: including duplicate rows fails", st == 200 and res["pass"] is False, res)

all_quarters = [
    r for r in all_rows
    if r["category"] == "Infrastructure" and r["status"] == "Approved" and not r["duplicate_of"]
]
st, _, res = submit({
    "count": len(all_quarters),
    "total_usd": f"{sum(r['amount_cents'] for r in all_quarters) / 100:.2f}",
    "top_invoice": max(all_quarters, key=lambda r: r["amount_cents"])["id"],
    "top_vendor": EXPECTED["top_vendor"],
})
report("trap: wrong quarter (all quarters) fails", st == 200 and res["pass"] is False, res)

st, _, res = submit(EXPECTED)
report(
    "exact signed submission passes with method.label == ui",
    st == 200
    and res["pass"] is True
    and res["matched"] == 4
    and res["completed_at_ms"] is not None
    and res["method"]["label"] == "ui",
    res,
)

st, _, res = submit({
    "count": "31",
    "total_usd": "259247.95",
    "top_invoice": "inv-260217",
    "top_vendor": "helios compute",
})
report("normalized plain numeric USD and lowercase strings pass", st == 200 and res["pass"] is True, res)

reset()
s = Session(APP)
bad_st, _ = s.post("/api/reconcile", {"count": "not-a-number", "total_usd": "100", "top_invoice": "INV-1", "top_vendor": "X"})
report("invalid payload returns 400", bad_st == 400)

reset()
after_reset = check()
report(
    "reset clears state",
    after_reset["pass"] is False
    and after_reset["matched"] == 0
    and after_reset["details"]["submitted"] is None
    and after_reset["method"]["accepted"] == 0,
    after_reset,
)
report.finish()
