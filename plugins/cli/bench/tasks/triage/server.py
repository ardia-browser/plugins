#!/usr/bin/env python3
import copy
import datetime
import json
import re
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from benchhttp import Handler, now_ms, serve_forever
from realism import Guard

PORT = 8881
HERE = Path(__file__).resolve().parent
ME = "sam-rivera"
TARGET, DUPLICATE, PR = 482, 491, 476
OWNER = "marco-lin"
PER_PAGE = 10
SPA_ROUTES = re.compile(r"^/(|issues|issues/\d+|pulls/\d+|milestones)/?$")
REPO = {"owner": "northwind", "name": "ledger", "description": "Invoicing and payments for small teams"}
PEOPLE = [
    {"login": "dana-okafor", "name": "Dana Okafor"}, {"login": "marco-lin", "name": "Marco Lin"},
    {"login": "priya-shah", "name": "Priya Shah"}, {"login": "tom-becker", "name": "Tom Becker"},
    {"login": "lena-voss", "name": "Lena Voss"}, {"login": "ji-woo-park", "name": "Ji-woo Park"},
    {"login": ME, "name": "Sam Rivera"},
]
LOGINS = {p["login"] for p in PEOPLE}
LABELS = [
    {"name": "bug", "color": "d73a4a", "description": "Something isn't working"},
    {"name": "regression", "color": "b60205", "description": "Worked in a previous release"},
    {"name": "enhancement", "color": "a2eeef", "description": "New feature or request"},
    {"name": "export", "color": "5319e7", "description": "CSV, XLSX and PDF exports"},
    {"name": "api", "color": "0e8a16", "description": "Public REST API"},
    {"name": "ui", "color": "fbca04", "description": "Layout and visual polish"},
    {"name": "perf", "color": "f9d0c4", "description": "Performance"},
    {"name": "docs", "color": "0075ca", "description": "Documentation"},
    {"name": "duplicate", "color": "cfd3d7", "description": "This issue or pull request already exists"},
    {"name": "needs-triage", "color": "ededed", "description": "Waiting for a maintainer"},
    {"name": "good first issue", "color": "7057ff", "description": "Good for newcomers"},
]
LABEL_NAMES = [l["name"] for l in LABELS]
MILESTONES = [
    {"title": "v2.3", "state": "closed", "due": "2026-10-09", "description": "Reporting and CSV streaming"},
    {"title": "v2.4", "state": "open", "due": "2026-11-20", "description": "Exports, webhooks and polish"},
    {"title": "v2.5", "state": "open", "due": "2026-12-18", "description": "Bulk actions and tax"},
]


def comment(author, at, body):
    return {"kind": "comment", "author": author, "at": at, "body": body}


SEED = [
    (510, "Dark mode: chart tooltips are unreadable", "open", ["bug", "ui"], "v2.5", [], "priya-shah", "2026-11-05T16:20", "Tooltip text is #222 on #1b1b1b in dark mode.", [], []),
    (509, "Keyboard shortcut to duplicate an invoice", "open", ["enhancement"], "v2.5", [], "lena-voss", "2026-11-05T11:02", "Cmd+D on an invoice should duplicate it, like in Sheets.", [], []),
    (508, "Docs: webhook retry policy is out of date", "open", ["docs"], "v2.4", ["tom-becker"], "tom-becker", "2026-11-04T18:45", "We retry 8 times now, not 5. The backoff table needs updating.", [], []),
    (507, "Bulk-archive customers from the list view", "open", ["enhancement"], "v2.5", [], "ji-woo-park", "2026-11-04T09:30", "Select many, archive once.", [], []),
    (506, "Recurring invoices skip February 29", "open", ["bug"], "v2.4", ["priya-shah"], "lena-voss", "2026-11-03T21:10", "A monthly invoice anchored on the 29th never fires in February of a leap year.", [comment("priya-shah", "2026-11-04T08:00", "I'll take this one.")], []),
    (505, "API: /v2/payments returns 500 for refunds over $10k", "open", ["bug", "api"], "v2.4", [], "dana-okafor", "2026-11-03T15:44", "Amounts above 1,000,000 cents overflow the refund validator.", [], []),
    (504, "Settings page layout breaks at 1280px", "open", ["bug", "ui"], "v2.5", [], "ji-woo-park", "2026-11-03T12:12", "The sidebar overlaps the form between 1240 and 1300 px.", [], []),
    (503, "XLSX export loses accents in column headers", "open", ["bug", "export"], "v2.5", [], "lena-voss", "2026-11-03T10:05", "Header \"Société\" becomes \"Soci?t?\" in the XLSX export. Data rows are fine.", [], []),
    (502, "Support multiple tax rates per line item", "open", ["enhancement"], "v2.5", [], "tom-becker", "2026-11-02T17:31", "Canada needs GST and PST on the same line.", [], []),
    (501, "Onboarding checklist doesn't remember dismissed steps", "open", ["bug", "ui"], "v2.4", [], "priya-shah", "2026-11-02T13:50", "Dismiss \"Connect Stripe\", reload, it comes back.", [], []),
    (500, "Swiss QR-bill on invoice PDFs", "open", ["enhancement"], "v2.5", [], "lena-voss", "2026-11-01T09:12", "Required for Swiss customers from 2027.", [], []),
    (499, "Better empty state for the Reports tab", "open", ["enhancement", "ui", "good first issue"], "v2.5", [], "ji-woo-park", "2026-10-31T16:40", "Right now it's a blank chart with no hint.", [], []),
    (498, "Webhook signatures fail when the secret has a trailing space", "open", ["bug", "api"], "v2.4", ["tom-becker"], "tom-becker", "2026-10-31T11:25", "We trim on save but not on verify.", [], []),
    (497, "Docs: explain the export column order", "open", ["docs", "export"], "v2.4", [], "lena-voss", "2026-10-30T14:00", "Customers keep asking why Email comes after Notes.", [], []),
    (495, "Search doesn't match customer email domains", "open", ["enhancement"], "v2.4", [], "priya-shah", "2026-10-30T10:48", "Searching \"acme.com\" should find everyone at Acme.", [], []),
    (494, "Currency rounding is off by one yen on JPY invoices", "open", ["bug"], "v2.4", ["dana-okafor"], "ji-woo-park", "2026-10-29T19:02", "JPY has no minor unit but we round to 2 decimals before converting.", [], []),
    (DUPLICATE, "Exported CSV is missing customers like José and Zoë", "open", ["bug", "needs-triage"], "v2.4", [], "ji-woo-park", "2026-11-03T08:41",
     "Our accountant noticed the customer CSV has fewer rows than the app. Everyone missing has an accent in their name (José Alvarez, Zoë Martin, Łukasz Nowak).", [], []),
    (488, "CSV export is slow for workspaces with 50k customers", "open", ["perf", "export"], "v2.4", ["marco-lin"], "dana-okafor", "2026-10-27T15:30", "Takes 90 s and sometimes times out at the proxy.", [], []),
    (485, "Invoice PDF renders accented names as boxes", "open", ["bug", "ui"], "v2.4", ["priya-shah"], "lena-voss", "2026-10-26T12:18", "The PDF font has no glyphs for ł, ő and similar.", [comment("priya-shah", "2026-10-27T09:00", "Swapping the font in #481.")], [481]),
    (TARGET, "CSV export drops rows when customer names contain accents", "open", ["bug", "export"], "v2.4", [], "lena-voss", "2026-10-25T10:14",
     "Since 2.3.1, exporting Customers to CSV silently skips rows whose name has non-ASCII characters. No error is shown.\n\nSteps: create a customer named \"Zoë Martin\", export Customers as CSV, search the file.\n\n@dana-okafor touched the exporter last, I think.",
     [comment("priya-shah", "2026-10-26T09:12", "Reproduced on staging: 412 customers in the app, 398 rows in the CSV. All 14 missing rows have accents."),
      comment("tom-becker", "2026-10-28T17:40", "Smells like the streaming change in 2.3.1. There's a PR in flight, see the Development panel.")], [PR]),
    (480, "Date picker starts weeks on Sunday for en-GB", "open", ["bug", "ui"], "v2.4", [], "priya-shah", "2026-10-24T09:55", "Should follow the locale's first day of week.", [], []),
    (478, "Customer import fails on CSV files with a BOM", "open", ["bug"], "v2.5", [], "dana-okafor", "2026-10-23T14:05", "Excel on Windows adds a BOM and the first header becomes \"\\ufeffName\".", [], []),
    (473, "CSV export repeats the header row", "closed", ["bug", "export"], "v2.3", ["dana-okafor"], "lena-voss", "2026-10-01T10:00", "Every 1,000 rows the header shows up again.", [], []),
    (470, "Reports chart legend overlaps the axis", "closed", ["bug", "ui"], "v2.3", ["priya-shah"], "ji-woo-park", "2026-09-28T13:00", "Fixed by moving the legend above the chart.", [], []),
    (455, "CSV export drops rows with emoji in notes", "closed", ["bug", "export"], "v2.3", ["dana-okafor"], "tom-becker", "2026-09-15T11:30", "Rows whose Notes field has emoji are missing from the CSV.", [comment("dana-okafor", "2026-09-20T10:00", "Fixed in #463.")], [463]),
]
PULLS = {
    PR: {"number": PR, "title": "Stream CSV export through a generator and encode as UTF-8", "state": "open", "draft": False,
         "author": "dana-okafor", "created": "2026-10-29T16:02", "base": "main", "head": "dana/csv-utf8-stream",
         "linked_issues": [TARGET], "additions": 184, "deletions": 61,
         "files": ["app/exports/csv_writer.py", "app/exports/customers.py", "tests/exports/test_csv_unicode.py"],
         "body": "Fixes the dropped rows by writing through an explicit UTF-8 encoder instead of the ASCII fallback the streaming writer picked up in #463.",
         "discussion": [
             comment("dana-okafor", "2026-10-30T09:20", "Adding a regression test with Zoë, José and Łukasz before this is ready."),
             comment("tom-becker", "2026-11-01T14:05", "Confirmed the ASCII fallback came in with #463 in 2.3.1, so this is a regression."),
             comment("dana-okafor", "2026-11-02T18:30", "Heads-up: I'm on leave from Nov 4. @marco-lin is taking this PR over and owns the fix from here; he'll land it for v2.4."),
             comment("marco-lin", "2026-11-03T10:12", "Yep, I've got it. Assign anything related to this to me."),
         ]},
    481: {"number": 481, "title": "Embed Noto Sans in invoice PDFs", "state": "open", "draft": True, "author": "priya-shah",
          "created": "2026-10-27T11:00", "base": "main", "head": "priya/pdf-font", "linked_issues": [485], "additions": 22,
          "deletions": 4, "files": ["app/pdf/fonts.py"], "body": "Swaps Helvetica for Noto Sans so accented names render.",
          "discussion": [comment("priya-shah", "2026-10-27T11:05", "Draft until legal okays the font licence.")]},
    463: {"number": 463, "title": "Stream CSV exports instead of buffering", "state": "merged", "draft": False,
          "author": "dana-okafor", "created": "2026-09-16T10:00", "base": "main", "head": "dana/csv-stream",
          "linked_issues": [455], "additions": 240, "deletions": 190, "files": ["app/exports/csv_writer.py"],
          "body": "Streams rows so large exports don't run out of memory.", "discussion": []},
}
TRACKED = ("state", "labels", "assignees", "milestone", "title", "close_reason", "duplicate_of", "comment_count")
PR_CITE = re.compile(rf"(#|\bpr\s*#?\s*|\bpull request\s*#?\s*|pull/){PR}(?!\d)", re.I)
LOCK = threading.Lock()
STATE = {}
GUARD = Guard("forge")


def initial_issues():
    out = {}
    for n, title, state, labels, milestone, assignees, author, created, body, comments, prs in SEED:
        out[n] = {"number": n, "title": title, "state": state, "labels": [l for l in LABEL_NAMES if l in labels],
                  "milestone": milestone, "assignees": list(assignees), "author": author, "created": created,
                  "body": body, "timeline": copy.deepcopy(comments), "linked_prs": list(prs),
                  "close_reason": "completed" if state == "closed" else None, "duplicate_of": None}
    return out


def reset():
    with LOCK:
        STATE.update(issues=initial_issues(), writes=0, passing_since=None, reset_at_ms=now_ms())
    GUARD.reset()


def tracked(issue):
    return {"state": issue["state"], "labels": sorted(issue["labels"]), "assignees": sorted(issue["assignees"]),
            "milestone": issue["milestone"], "title": issue["title"], "close_reason": issue["close_reason"],
            "duplicate_of": issue["duplicate_of"],
            "comment_count": sum(1 for e in issue["timeline"] if e["kind"] == "comment")}


def my_comments(issue):
    return [e["body"] for e in issue["timeline"] if e["kind"] == "comment" and e.get("new")]


def grade_locked():
    issues, initial = STATE["issues"], initial_issues()
    target, dup = issues[TARGET], issues[DUPLICATE]
    items = {
        "target_labels": sorted(target["labels"]) == sorted(initial[TARGET]["labels"] + ["regression"]),
        "target_assignee": target["assignees"] == [OWNER],
        "target_comment": any(PR_CITE.search(b) for b in my_comments(target)),
        "duplicate_closed": dup["state"] == "closed" and dup["close_reason"] == "duplicate" and dup["duplicate_of"] == TARGET,
    }
    others = []
    for n, issue in issues.items():
        now, before = tracked(issue), tracked(initial[n])
        if n == TARGET:
            diff = {f: now[f] for f in ("milestone", "title") if now[f] != before[f]}
        elif n == DUPLICATE:
            diff = {f: now[f] for f in ("milestone", "title", "assignees") if now[f] != before[f]}
        else:
            diff = {f: now[f] for f in TRACKED if now[f] != before[f]}
        if diff:
            others.append({"issue": n, "changed": diff})
    invariants = {"target_still_open": target["state"] == "open", "nothing_else_changed": not others}
    matched = sum(items.values())
    return {"pass": matched == len(items) and all(invariants.values()), "matched": matched, "total": len(items),
            "invariants": invariants,
            "details": {"items_ok": items,
                        "target_now": {k: target[k] for k in ("labels", "assignees", "state")} | {"new_comments": my_comments(target)},
                        "duplicate_now": {k: dup[k] for k in ("state", "close_reason", "duplicate_of", "labels")},
                        "unexpected_changes": others,
                        "failed_invariants": [k for k, v in invariants.items() if not v], "writes": STATE["writes"]}}


def changed_locked():
    STATE["writes"] += 1
    at = now_ms()
    STATE["passing_since"] = (STATE["passing_since"] or at) if grade_locked()["pass"] else None


def check():
    with LOCK:
        g = grade_locked()
        g["completed_at_ms"] = STATE["passing_since"] if g["pass"] else None
        g["reset_at_ms"] = STATE["reset_at_ms"]
    g["method"] = GUARD.summary()
    return g


def stamp():
    return datetime.datetime.now().strftime("%Y-%m-%dT%H:%M")


def summary(issue):
    return {k: issue[k] for k in ("number", "title", "state", "labels", "milestone", "assignees", "author", "created",
                                  "close_reason", "duplicate_of")} | {
        "comments": sum(1 for e in issue["timeline"] if e["kind"] == "comment"), "linked_prs": issue["linked_prs"]}


def search(params):
    state = params.get("state", "open")
    milestone, label, assignee = params.get("milestone", ""), params.get("label", ""), params.get("assignee", "")
    q = params.get("q", "").strip().lower()
    sort = params.get("sort", "newest")
    rows = [i for i in STATE["issues"].values()
            if (state == "all" or i["state"] == state) and (not milestone or i["milestone"] == milestone)
            and (not label or label in i["labels"]) and (not assignee or assignee in i["assignees"]
                                                         or (assignee == "none" and not i["assignees"]))
            and (not q or q in f"#{i['number']} {i['title']} {i['body']}".lower())]
    key = {"newest": lambda i: -i["number"], "oldest": lambda i: i["number"],
           "comments": lambda i: -sum(1 for e in i["timeline"] if e["kind"] == "comment")}.get(sort, lambda i: -i["number"])
    rows.sort(key=key)
    try:
        page = max(1, int(params.get("page", "1")))
    except ValueError:
        page = 1
    counts = {"open": sum(1 for i in STATE["issues"].values() if i["state"] == "open"),
              "closed": sum(1 for i in STATE["issues"].values() if i["state"] == "closed")}
    return {"total": len(rows), "page": page, "per_page": PER_PAGE, "counts": counts,
            "issues": [summary(i) for i in rows[(page - 1) * PER_PAGE: page * PER_PAGE]]}


def event(issue, kind, **fields):
    issue["timeline"].append({"kind": kind, "author": ME, "at": stamp(), **fields})


def mutate_locked(n, action, body):
    issue = STATE["issues"].get(n)
    if not issue:
        return 404, {"error": "No such issue"}
    if action == "labels":
        labels = body.get("labels")
        if not isinstance(labels, list) or any(l not in LABEL_NAMES for l in labels):
            return 400, {"error": "Unknown label"}
        added = [l for l in labels if l not in issue["labels"]]
        removed = [l for l in issue["labels"] if l not in labels]
        if not added and not removed:
            return 200, {"issue": detail(issue)}
        issue["labels"] = [l for l in LABEL_NAMES if l in labels]
        event(issue, "labeled", added=added, removed=removed)
    elif action == "assignees":
        people = body.get("assignees")
        if not isinstance(people, list) or any(p not in LOGINS for p in people) or len(people) > 3:
            return 400, {"error": "Unknown assignee"}
        added = [p for p in people if p not in issue["assignees"]]
        removed = [p for p in issue["assignees"] if p not in people]
        if not added and not removed:
            return 200, {"issue": detail(issue)}
        issue["assignees"] = list(dict.fromkeys(people))
        event(issue, "assigned", added=added, removed=removed)
    elif action == "comments":
        text = str(body.get("body") or "").strip()
        if not text:
            return 400, {"error": "Comment can't be empty"}
        issue["timeline"].append({"kind": "comment", "author": ME, "at": stamp(), "body": text[:5000], "new": True})
    elif action == "close":
        reason = body.get("reason")
        if reason not in ("completed", "not_planned", "duplicate"):
            return 400, {"error": "Unknown close reason"}
        dup_of = None
        if reason == "duplicate":
            try:
                dup_of = int(str(body.get("duplicate_of", "")).lstrip("#"))
            except ValueError:
                return 400, {"error": "Pick the issue this duplicates"}
            if dup_of == n or dup_of not in STATE["issues"]:
                return 400, {"error": "Pick the issue this duplicates"}
        issue.update(state="closed", close_reason=reason, duplicate_of=dup_of)
        event(issue, "closed", reason=reason, duplicate_of=dup_of)
    elif action == "reopen":
        issue.update(state="open", close_reason=None, duplicate_of=None)
        event(issue, "reopened")
    else:
        return 404, {"error": "not found"}
    return 200, {"issue": detail(issue)}


def detail(issue):
    out = copy.deepcopy(issue)
    for e in out["timeline"]:
        e.pop("new", None)
    out["linked_prs"] = [{k: PULLS[p][k] for k in ("number", "title", "state", "draft", "author")} for p in issue["linked_prs"]]
    return out


class ForgeHandler(Handler):
    def do_GET(self):
        path = self.path_only
        if path == "/api/check":
            return self.send(200, check())
        if path == "/api/meta":
            return self.send(200, {"repo": REPO, "people": PEOPLE, "labels": LABELS, "milestones": MILESTONES,
                                   "viewer": ME})
        with LOCK:
            if path == "/api/issues":
                return self.send(200, search(self.query))
            if path == "/api/milestones":
                return self.send(200, [dict(m, open=sum(1 for i in STATE["issues"].values() if i["milestone"] == m["title"] and i["state"] == "open"),
                                            closed=sum(1 for i in STATE["issues"].values() if i["milestone"] == m["title"] and i["state"] == "closed"))
                                       for m in MILESTONES])
            m = re.fullmatch(r"/api/issues/(\d+)", path)
            if m:
                issue = STATE["issues"].get(int(m.group(1)))
                return self.send(200, detail(issue)) if issue else self.send(404, {"error": "No such issue"})
        m = re.fullmatch(r"/api/pulls/(\d+)", path)
        if m:
            pr = PULLS.get(int(m.group(1)))
            return self.send(200, pr) if pr else self.send(404, {"error": "No such pull request"})
        if path == "/":
            return self.redirect(f"http://127.0.0.1:{PORT}/issues")
        if SPA_ROUTES.match(path):
            return GUARD.render_page(self, (HERE / "fixture" / "index.html").read_text())
        return self.static()

    def do_POST(self):
        path = self.path_only
        if path == "/api/reset":
            reset()
            return self.send(200, {"ok": True})
        raw = self.body_bytes()
        record = GUARD.verify_write(self, raw)
        if record["kind"] == "rejected":
            return GUARD.reject(self, record)
        try:
            body = json.loads(raw or b"{}")
        except ValueError:
            body = None
        m = re.fullmatch(r"/api/issues/(\d+)/(labels|assignees|comments|close|reopen)", path)
        if not m or not isinstance(body, dict):
            return self.send(404 if not m else 400, {"error": "not found" if not m else "expected a JSON object"})
        with LOCK:
            status, out = mutate_locked(int(m.group(1)), m.group(2), body)
            if status == 200:
                changed_locked()
        return self.send(status, out)


reset()

if __name__ == "__main__":
    serve_forever([(PORT, ForgeHandler, HERE / "fixture")],
                  f"Forge on http://127.0.0.1:{PORT}/issues (reset POST /api/reset, check GET /api/check)")
