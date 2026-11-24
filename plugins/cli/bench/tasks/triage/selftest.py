#!/usr/bin/env python3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from benchclient import Report, Session, base, get_json, http, unsigned_post

APP = base(8881)
ANSWERS = ("regression", "marco-lin", "476", "482")
report = Report()


def check():
    return get_json(f"{APP}/api/check")[1]


def reset():
    http("POST", f"{APP}/api/reset")


def solve(s, labels=("bug", "export", "regression"), assignees=("marco-lin",), comment="Triage: regression from #476, Marco owns the fix.",
          dup=(491, 482), event="click:1:50"):
    out = []
    if labels is not None:
        out.append(s.post("/api/issues/482/labels", {"labels": list(labels)}, event))
    if assignees is not None:
        out.append(s.post("/api/issues/482/assignees", {"assignees": list(assignees)}, event))
    if comment:
        out.append(s.post("/api/issues/482/comments", {"body": comment}, event))
    if dup:
        out.append(s.post(f"/api/issues/{dup[0]}/close", {"reason": "duplicate", "duplicate_of": dup[1]}, event))
    return out


def case(name, want_pass, extra=None, **kw):
    reset()
    s = Session(APP, "/issues")
    solve(s, **kw)
    if extra:
        extra(s)
    r = check()
    ok = r["pass"] is want_pass and (r["completed_at_ms"] is not None) is want_pass
    report(name, ok, {k: r[k] for k in ("matched", "total", "invariants")} | {"items": r["details"]["items_ok"]})
    return r


reset()
fresh = check()
report("fresh state fails", fresh["pass"] is False and fresh["completed_at_ms"] is None and fresh["matched"] == 0, fresh)
report("fresh check leaks nothing", not report.leaks(fresh["details"], ANSWERS), report.leaks(fresh["details"], ANSWERS))
report("check reports method and invariants", isinstance(fresh.get("method"), dict) and isinstance(fresh.get("invariants"), dict))
root = http("GET", f"{APP}/")
report("root lands on the issue list", root[0] == 200 and b"Forge" in root[1])
report("spa routes serve the shell", all(http("GET", f"{APP}{p}")[0] == 200 for p in ("/issues", "/issues/482", "/pulls/476", "/milestones")))
page1 = get_json(f"{APP}/api/issues")[1]
report("the bug is not on the first page by default", 482 not in [i["number"] for i in page1["issues"]] and page1["total"] > 15)
v24 = get_json(f"{APP}/api/issues?milestone=v2.4")[1]
report("v2.4 needs load more for the bug", 482 not in [i["number"] for i in v24["issues"]] and v24["total"] > v24["per_page"])
v24p2 = get_json(f"{APP}/api/issues?milestone=v2.4&page=2")[1]
report("load more reaches the bug", 482 in [i["number"] for i in v24p2["issues"]])
pr = get_json(f"{APP}/api/pulls/476")[1]
report("the PR discussion names the owner", "marco-lin" in str(pr["discussion"]) and pr["author"] == "dana-okafor")
report("issue detail links the PR", [p["number"] for p in get_json(f"{APP}/api/issues/482")[1]["linked_prs"]] == [476])

r = case("correct triage passes", True)
report("correct triage is recorded as ui writes", r["method"]["label"] == "ui", r["method"])
case("comment citing PR 476 in words passes", True, comment="Regression introduced before PR 476; assigning Marco.")
case("adding the duplicate label while closing passes", True,
     extra=lambda s: s.post("/api/issues/491/labels", {"labels": ["bug", "needs-triage", "duplicate"]}))
case("PR author as assignee fails", False, assignees=("dana-okafor",))
case("both people assigned fails", False, assignees=("marco-lin", "dana-okafor"))
case("comment citing the older PR fails", False, comment="Regression from #463.")
case("comment citing the issue number fails", False, comment="See #482 for details.")
case("missing comment fails", False, comment=None)
case("missing regression label fails", False, labels=("bug", "export"))
case("dropping an existing label fails", False, labels=("bug", "regression"))
case("closing the wrong issue as duplicate fails", False, dup=(503, 482))
case("duplicate pointing at the wrong canonical fails", False, dup=(491, 455))
case("closing the canonical bug fails", False, dup=(482, 491))
case("labelling another issue fails", False, extra=lambda s: s.post("/api/issues/503/labels", {"labels": ["bug", "export", "regression"]}))
case("commenting on another issue fails", False, extra=lambda s: s.post("/api/issues/488/comments", {"body": "related to #476?"}))
case("closing the duplicate as completed fails", False, dup=None,
     extra=lambda s: s.post("/api/issues/491/close", {"reason": "completed"}))
case("closing the target as well fails", False, extra=lambda s: s.post("/api/issues/482/close", {"reason": "completed"}))

reset()
s = Session(APP, "/issues")
solve(s, assignees=("dana-okafor",))
s.post("/api/issues/482/assignees", {"assignees": ["marco-lin"]})
report("fixing a wrong assignee passes", check()["pass"] is True)

reset()
s = Session(APP, "/issues")
solve(s, event="click:0:30")
report("scripted clicks pass but are labelled ui_scripted", check()["pass"] and check()["method"]["label"] == "ui_scripted")

reset()
report("unsigned writes are rejected", unsigned_post(f"{APP}/api/issues/482/labels", {"labels": ["bug", "export", "regression"]}) == 403)
report("rejected write changes nothing", check()["details"]["target_now"]["labels"] == ["bug", "export"])
s = Session(APP, "/issues")
report("unknown label is refused", s.post("/api/issues/482/labels", {"labels": ["bug", "nope"]})[0] == 400)
report("self-duplicate is refused", s.post("/api/issues/491/close", {"reason": "duplicate", "duplicate_of": 491})[0] == 400)
reset()
report("reset clears everything", check()["matched"] == 0)
report.finish()
