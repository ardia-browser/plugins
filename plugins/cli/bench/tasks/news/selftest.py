#!/usr/bin/env python3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from benchclient import Report, Session, base, get_json, http, unsigned_post

APP = base(8871)
ANSWERS = ("13 h 47", "827", "1849", "1,849", "1.3.2", "arclight-x2-review")
GOOD = {"title": "Arclight X2 facts", "source": "arclight-x2-review", "battery_hours": "13", "battery_minutes": "47",
        "price": "$1,849", "firmware": "1.3.2 (build 4471)", "summary": "Retest got longer battery."}
report = Report()


def check():
    return get_json(f"{APP}/api/check")[1]


def reset():
    http("POST", f"{APP}/api/reset")


def solve(s, note=None, bookmarks=("arclight-x2-review",), consent="rejected", newsletter=("dismiss",), event="click:1:50"):
    s.post("/api/consent", {"choice": consent}, event)
    s.post("/api/newsletter", dict(zip(("action", "email"), newsletter)), event)
    for slug in bookmarks:
        s.post("/api/bookmarks", {"slug": slug, "saved": True}, event)
    return s.post("/api/notes", note or GOOD, event)


def case(name, want_pass, **kw):
    reset()
    s = Session(APP, "/articles/arclight-x2-review")
    solve(s, **kw)
    r = check()
    ok = r["pass"] is want_pass and (r["completed_at_ms"] is not None) is want_pass
    report(name, ok, {k: r[k] for k in ("matched", "total", "invariants")} | {"items": r["details"]["items_ok"]})
    return r


reset()
fresh = check()
report("fresh state fails", fresh["pass"] is False and fresh["matched"] == 0 and fresh["completed_at_ms"] is None, fresh)
report("fresh check leaks nothing", not report.leaks(fresh["details"], ANSWERS), report.leaks(fresh["details"], ANSWERS))
report("check reports method and invariants", isinstance(fresh.get("method"), dict) and isinstance(fresh.get("invariants"), dict))
status, html, _ = http("GET", f"{APP}/")
report("front page serves", status == 200 and b"Signal" in html)
report("spa routes serve the shell", all(http("GET", f"{APP}{p}")[0] == 200 for p in ("/articles/arclight-x2-review", "/notes", "/reading-list")))
status, article = get_json(f"{APP}/api/articles/arclight-x2-review")
report("article payload hides tab contents", status == 200 and "13 h 47" not in str(article) and "1,849" not in str(article))
status, retest = get_json(f"{APP}/api/articles/arclight-x2-battery-retest")
report("follow-up payload hides accordion answers", status == 200 and "1.3.2" not in str(retest))
report("benchmarks tab holds the battery figure", "13 h 47 min" in str(get_json(f"{APP}/api/articles/arclight-x2-review/tabs/benchmarks")[1]))
report("firmware sits in the methodology accordion", "1.3.2" in str(get_json(f"{APP}/api/articles/arclight-x2-battery-retest/accordion/method-firmware")[1]))
report("realism.js is served", http("GET", f"{APP}/realism.js")[0] == 200)

r = case("correct solution passes", True)
report("correct solution is recorded as ui writes", r["method"]["label"] == "ui", r["method"])
case("other price formats pass", True, note=dict(GOOD, price="1849.00", firmware="v1.3.2"))
case("manufacturer battery claim fails", False, note=dict(GOOD, battery_hours="18", battery_minutes="0"))
case("retest battery result fails", False, note=dict(GOOD, battery_hours="15", battery_minutes="12"))
case("older X1 battery fails", False, note=dict(GOOD, battery_hours="11", battery_minutes="5"))
case("base model price fails", False, note=dict(GOOD, price="1299"))
case("X1 price fails", False, note=dict(GOOD, price="$1,599"))
case("beta firmware fails", False, note=dict(GOOD, firmware="1.4"))
case("launch firmware fails", False, note=dict(GOOD, firmware="1.1.0"))
case("follow-up as source fails", False, note=dict(GOOD, source="arclight-x2-battery-retest"))
case("bookmarking the follow-up too fails", False, bookmarks=("arclight-x2-review", "arclight-x2-battery-retest"))
case("bookmarking only the follow-up fails", False, bookmarks=("arclight-x2-battery-retest",))
case("no bookmark fails", False, bookmarks=())
r = case("newsletter signup fails", False, newsletter=("subscribe", "sam@example.com"))
report("newsletter signup trips the invariant", r["invariants"]["no_newsletter_signup"] is False)

reset()
s = Session(APP)
solve(s, note=dict(GOOD, price="1299"))
s.post("/api/notes", GOOD)
report("a corrected resubmission passes", check()["pass"] is True)

reset()
s = Session(APP)
solve(s, event="click:0:40")
report("scripted clicks pass but are labelled ui_scripted", check()["pass"] and check()["method"]["label"] == "ui_scripted")

reset()
report("unsigned writes are rejected", unsigned_post(f"{APP}/api/bookmarks", {"slug": "arclight-x2-review", "saved": True}) == 403)
report("rejected write changes nothing", check()["details"]["reading_list"] == [])
reset()
report("reset clears everything", check()["matched"] == 0)
report.finish()
