#!/usr/bin/env python3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from benchclient import PORT_OFFSET, Report, Session, base, get_json, http, unsigned_post

VENDOR, PROCURE = base(8891), base(8892)
ANSWERS = ("8880", "8,880", "2026-10-14", "frankfurt", "eu-central-1", "business")
GOOD = {"vendor": "Vantage", "website": "", "tier": "Business", "cycle": "annual", "seats": "25",
        "annual_total": "$8,880", "soc2_date": "2026-10-14", "eu_residency": "yes",
        "eu_region": "Frankfurt (eu-central-1)", "justification": "Need SSO and audit logs."}
report = Report()


def check():
    return get_json(f"{PROCURE}/api/check")[1]


def reset():
    http("POST", f"{PROCURE}/api/reset")


def case(name, want_pass, event="click:1:50", **changes):
    reset()
    s = Session(PROCURE, "/new")
    status, out = s.post("/api/requests", dict(GOOD, **changes), event)
    r = check()
    ok = status == 200 and r["pass"] is want_pass and (r["completed_at_ms"] is not None) is want_pass
    report(name, ok, {"status": status, "items": r["details"]["items_ok"], "invariants": r["invariants"]})
    return r


reset()
fresh = check()
report("fresh state fails", fresh["pass"] is False and fresh["completed_at_ms"] is None and fresh["matched"] == 0, fresh)
report("fresh check leaks nothing", not report.leaks(fresh["details"], ANSWERS), report.leaks(fresh["details"], ANSWERS))
report("check reports method and invariants", isinstance(fresh.get("method"), dict) and isinstance(fresh.get("invariants"), dict))
for path in ("/", "/pricing", "/security", "/changelog", "/vendor.js", "/vendor.css"):
    report(f"vendor serves {path}", http("GET", f"{VENDOR}{path}")[0] == 200)
for path in ("/", "/new", "/requests", "/procure.js", "/realism.js"):
    report(f"procurement serves {path}", http("GET", f"{PROCURE}{path}")[0] == 200)
vendor_js = http("GET", f"{VENDOR}/vendor.js")[1].decode()
procure_html = http("GET", f"{PROCURE}/new")[1].decode()
report("vendor links to the procurement portal on this lane", f"127.0.0.1:{8892 + PORT_OFFSET}/" in vendor_js)
report("procurement links to the vendor site on this lane", f"127.0.0.1:{8891 + PORT_OFFSET}/" in procure_html)
if PORT_OFFSET:
    report("no base-port links leak through the offset", "127.0.0.1:8892/" not in vendor_js and "127.0.0.1:8891/" not in procure_html)
report("the vendor site has no check endpoint", http("GET", f"{VENDOR}/api/check")[0] == 404)

r = case("correct request passes", True)
report("correct request is recorded as ui writes", r["method"]["label"] == "ui", r["method"])
case("plain total and long date pass", True, annual_total="8880", soc2_date="October 14, 2026", eu_region="eu-central-1 Frankfurt")
case("monthly billing total fails", False, cycle="monthly", annual_total="10800")
case("annual total without volume pricing fails", False, annual_total="9600")
case("monthly cycle with the annual total fails", False, cycle="monthly")
case("team tier fails", False, tier="Team", annual_total="5460")
case("enterprise tier fails", False, tier="Enterprise")
case("wrong seat count fails", False, seats="20", annual_total="7200")
r = case("type I report date fails", False, soc2_date="2025-03-03")
case("audit period end date fails", False, soc2_date="2026-08-31")
case("Dublin region fails", False, eu_region="Dublin (eu-west-1)")
case("listing both regions fails", False, eu_region="Frankfurt (eu-central-1), formerly Dublin")
case("no EU residency fails", False, eu_residency="no", eu_region="")
r = case("total that contradicts the plan fails", False, annual_total="8800")
report("inconsistent total trips the invariant", r["invariants"]["total_matches_price_list"] is False)

reset()
s = Session(PROCURE, "/new")
status, out = s.post("/api/requests", dict(GOOD, tier=""))
report("missing tier is refused with a field error", status == 422 and "tier" in out["fields"])
status, out = s.post("/api/requests", dict(GOOD, eu_region=""))
report("yes without a region is refused", status == 422 and "eu_region" in out["fields"])
report("refused submissions record nothing", check()["details"]["requests_submitted"] == 0)
s.post("/api/requests", dict(GOOD, annual_total="9600"))
s.post("/api/requests", GOOD)
report("a corrected resubmission passes", check()["pass"] is True)

reset()
s = Session(PROCURE, "/new")
s.post("/api/requests", GOOD, "keydown:0:20")
report("scripted submit passes but is labelled ui_scripted", check()["pass"] and check()["method"]["label"] == "ui_scripted")

reset()
report("unsigned submissions are rejected", unsigned_post(f"{PROCURE}/api/requests", GOOD) == 403)
report("rejected submission records nothing", check()["details"]["requests_submitted"] == 0)
reset()
report("reset clears everything", check()["matched"] == 0)
report.finish()
