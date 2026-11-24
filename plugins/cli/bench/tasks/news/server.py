#!/usr/bin/env python3
import json
import re
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from benchhttp import Handler, now_ms, serve_forever
from realism import Guard

PORT = 8871
HERE = Path(__file__).resolve().parent
REVIEW = "arclight-x2-review"
RETEST = "arclight-x2-battery-retest"
SPA_ROUTES = re.compile(r"^/(|articles/[a-z0-9-]+|reading-list|notes|section/[a-z-]+)/?$")

ARTICLES = [
    {
        "slug": REVIEW, "section": "Reviews", "title": "Arclight X2 review: the quiet overachiever",
        "dek": "Arclight's second-generation 14-inch laptop finally fixes the hinge, the speakers and the fan noise.",
        "author": "Maya Lindqvist", "date": "2026-11-03", "read_min": 11, "hero": "laptop",
        "body": [
            "The original Arclight X1 was a laptop you wanted to like. It was thin, it was fast, and it whined like a "
            "kettle under any real load. The X2 keeps the same 14.2-inch footprint but swaps nearly everything inside.",
            "Arclight sells the X2 in three configurations. The base model starts at $1,299 with 16 GB of memory and a "
            "512 GB drive, and the company claims up to 18 hours of battery life for every configuration.",
            "We spent two weeks with the X2 as our daily machine: writing, video calls, a few too many browser tabs and "
            "the occasional photo export. The tabs below have our benchmark numbers and the exact configuration we "
            "tested.",
        ],
        "tabs": [
            {"id": "overview", "label": "Overview", "blocks": [
                {"kind": "p", "text": "The new hinge opens with one finger and holds the 120 Hz OLED panel without a "
                                      "wobble. The keyboard has 1.3 mm of travel and a quieter switch than the X1."},
                {"kind": "p", "text": "Arclight's marketing leans hard on its battery claim of up to 18 hours. Our own "
                                      "test is in Benchmarks, and as usual it's lower."},
                {"kind": "verdict", "text": "Score 8.6 / 10. Buy it if you want a quiet 14-inch laptop with a great "
                                            "screen; skip the base model's 16 GB if you edit photos."},
            ]},
            {"id": "benchmarks", "label": "Benchmarks", "blocks": [
                {"kind": "p", "text": "All runs on the configuration in Specs, plugged in unless noted, Balanced power "
                                      "mode."},
                {"kind": "table", "head": ["Test", "Arclight X2", "Arclight X1 (2025)"], "rows": [
                    ["Signal battery test (video loop)", "13 h 47 min", "11 h 05 min"],
                    ["Arclight's claimed battery life", "up to 18 h", "up to 15 h"],
                    ["Geekbench 7 multi-core", "15,412", "11,980"],
                    ["4K export, 10 min project", "3 min 52 s", "6 min 10 s"],
                    ["Fan noise under load", "31 dBA", "44 dBA"],
                ]},
            ]},
            {"id": "specs", "label": "Specs", "blocks": [
                {"kind": "p", "text": "Arclight loaned us its mid-tier model. Prices are US list prices at the time "
                                      "of review."},
                {"kind": "table", "head": ["", "As reviewed", "Base model"], "rows": [
                    ["Processor", "Core Ultra 7 268V", "Core Ultra 5 236V"],
                    ["Memory", "32 GB LPDDR5X", "16 GB LPDDR5X"],
                    ["Storage", "1 TB NVMe", "512 GB NVMe"],
                    ["Display", "14.2-inch OLED, 2880 x 1800, 120 Hz", "14.2-inch IPS, 2560 x 1600, 60 Hz"],
                    ["Weight", "1.21 kg", "1.18 kg"],
                    ["Price", "$1,849", "$1,299"],
                ]},
            ]},
        ],
        "related": [RETEST],
    },
    {
        "slug": RETEST, "section": "Reviews", "title": "We retested the Arclight X2's battery after its big firmware update",
        "dek": "Arclight promised better standby and smarter refresh rates. We ran the whole battery suite again.",
        "author": "Maya Lindqvist", "date": "2026-11-05", "read_min": 6, "hero": "battery",
        "body": [
            "Two days after our review went up, Arclight pushed a firmware update that it says cuts idle power draw by "
            "a fifth. Readers asked whether that changes our verdict, so we put the same review unit back on the bench.",
            "In the same video loop, the X2 now lasts 15 h 12 min. That's a real gain, but our original review score "
            "stays as it is: we grade the laptop people could buy on launch day.",
            "Standby drain is the bigger story. Closed overnight, the X2 lost 2% instead of 7%, which finally puts it in "
            "line with the best ARM laptops.",
            "Our methodology and the exact firmware build are in the notes below.",
        ],
        "accordion": [
            {"id": "method-battery", "group": "Methodology", "question": "How we test battery life",
             "answer": "We loop a 1080p video at 200 nits with Wi-Fi on and keyboard backlight off, starting from a full "
                       "charge, until the laptop shuts down. Each result is the median of three runs."},
            {"id": "method-firmware", "group": "Methodology", "question": "Firmware and build tested",
             "answer": "Every run in this retest used firmware 1.3.2 (build 4471). The original review ran on the "
                       "launch firmware, 1.1.0."},
            {"id": "faq-beta", "group": "FAQ", "question": "Did you test the 1.4 public beta?",
             "answer": "Not yet. Arclight's 1.4 beta arrived after our runs were finished, and we don't score beta "
                       "software."},
            {"id": "faq-score", "group": "FAQ", "question": "Does the review's score change?",
             "answer": "No. The original score reflects the laptop as it shipped. We'll note updates in the review."},
            {"id": "faq-other", "group": "FAQ", "question": "Will other laptops get the same update?",
             "answer": "Arclight says the X1 won't. Its older display controller can't drop to the new 1 Hz refresh."},
        ],
        "related": [REVIEW],
    },
    {
        "slug": "arclight-x1-review", "section": "Reviews", "title": "Arclight X1 review: fast, thin and very loud",
        "dek": "A gorgeous chassis let down by a fan that never stops talking.", "author": "Maya Lindqvist",
        "date": "2025-10-14", "read_min": 9, "hero": "laptop",
        "body": ["The Arclight X1 we tested cost $1,599 with 16 GB of memory and a 1 TB drive.",
                 "In our video loop it lasted 11 h 05 min, well short of Arclight's 15-hour claim.",
                 "Verdict: 7.1 / 10. Wait for the next one."],
        "related": [],
    },
    {
        "slug": "meshline-duo-router-review", "section": "Reviews", "title": "Meshline Duo review: Wi-Fi 7 for normal homes",
        "dek": "Two nodes, one app, and no subscription nags.", "author": "Ravi Menon", "date": "2026-11-04",
        "read_min": 7, "hero": "router",
        "body": ["The Meshline Duo costs $349 for two nodes and covered our 2,400 sq ft test house without dead zones.",
                 "Setup took eleven minutes, most of it waiting for a firmware update."],
        "related": [],
    },
    {
        "slug": "quiet-keyboards-2026", "section": "Guides", "title": "The best quiet mechanical keyboards for open offices",
        "dek": "Seven boards your desk neighbours won't hate.", "author": "Jonah Weiss", "date": "2026-11-02",
        "read_min": 12, "hero": "keyboard",
        "body": ["Linear switches with silicone dampers are the sweet spot. Our top pick is the Halvard 75 at $129."],
        "related": [],
    },
    {
        "slug": "e-ink-monitors-usable", "section": "Features", "title": "E-ink monitors are finally usable for real work",
        "dek": "25 Hz refresh, warm front lights, and a price that no longer makes you laugh.", "author": "Ines Duarte",
        "date": "2026-11-01", "read_min": 8, "hero": "monitor",
        "body": ["We wrote this whole piece on a 25-inch e-ink monitor. Our eyes thank us; our cursor does not."],
        "related": [],
    },
    {
        "slug": "how-we-test-laptops", "section": "Features", "title": "How Signal tests laptops",
        "dek": "The benchmarks, the battery loop and the rules we don't break.", "author": "Signal staff",
        "date": "2024-03-18", "read_min": 5, "hero": "lab",
        "body": ["This page describes our 2024 suite. Battery runs used a web-browsing loop at 150 nits.",
                 "Reviews published after September 2025 use the video loop described in each review's methodology."],
        "related": [],
    },
    {
        "slug": "chip-shortage-that-wasnt", "section": "Features", "title": "Inside the memory shortage that wasn't",
        "dek": "Why laptop prices jumped this spring even though the factories were full.", "author": "Ravi Menon",
        "date": "2026-10-29", "read_min": 14, "hero": "chip",
        "body": ["Contract prices for LPDDR5X rose 30% in a quarter while utilisation stayed above 90%."],
        "related": [],
    },
]
BY_SLUG = {a["slug"]: a for a in ARTICLES}
NOTE_FIELDS = ("title", "source", "battery_hours", "battery_minutes", "price", "firmware", "summary")
LOCK = threading.Lock()
STATE = {}
GUARD = Guard("news")


def reset():
    with LOCK:
        STATE.update(consent=None, newsletter="pending", newsletter_email=None, bookmarks=[], notes=[],
                     writes=0, passing_since=None, reset_at_ms=now_ms())
    GUARD.reset()


def summary(a):
    return {k: a[k] for k in ("slug", "section", "title", "dek", "author", "date", "read_min", "hero")}


def article_view(a):
    out = dict(summary(a), body=a["body"], related=[summary(BY_SLUG[s]) for s in a["related"]])
    out["tabs"] = [{"id": t["id"], "label": t["label"]} for t in a.get("tabs", [])]
    out["accordion"] = [{"id": q["id"], "group": q["group"], "question": q["question"]} for q in a.get("accordion", [])]
    return out


def as_int(raw):
    text = str(raw if raw is not None else "").strip()
    return int(text) if re.fullmatch(r"\d{1,4}", text) else None


def as_price(raw):
    text = re.sub(r"[\s$,]|usd", "", str(raw or "").lower())
    m = re.fullmatch(r"(\d+)(\.(\d{1,2}))?", text)
    if not m or (m.group(3) and int(m.group(3))):
        return None
    return int(m.group(1))


def as_version(raw):
    m = re.search(r"(?<![\d.])(\d+\.\d+(?:\.\d+)?)(?![.\d])", str(raw or ""))
    return m.group(1) if m else None


def note_checks(note):
    if not note:
        return {"source": False, "battery": False, "price": False, "firmware": False}
    hours, minutes = as_int(note["battery_hours"]), as_int(note["battery_minutes"])
    battery = hours * 60 + minutes if hours is not None and minutes is not None and minutes < 60 else None
    return {"source": note["source"] == REVIEW, "battery": battery == 827,
            "price": as_price(note["price"]) == 1849, "firmware": as_version(note["firmware"]) == "1.3.2"}


def grade_locked():
    note = STATE["notes"][-1] if STATE["notes"] else None
    fields = note_checks(note)
    items = {"bookmark": STATE["bookmarks"] == [REVIEW], **fields}
    invariants = {"no_newsletter_signup": STATE["newsletter"] != "subscribed"}
    matched = sum(items.values())
    return {"pass": matched == len(items) and all(invariants.values()), "matched": matched, "total": len(items),
            "invariants": invariants,
            "details": {"items_ok": items, "reading_list": list(STATE["bookmarks"]), "notes_submitted": len(STATE["notes"]),
                        "latest_note": {k: note[k] for k in NOTE_FIELDS} if note else None,
                        "cookie_consent": STATE["consent"], "newsletter": STATE["newsletter"],
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


def clean(value, limit=400):
    return re.sub(r"\s+", " ", str(value if value is not None else "")).strip()[:limit]


class NewsHandler(Handler):
    def do_GET(self):
        path = self.path_only
        if path == "/api/check":
            return self.send(200, check())
        if path == "/api/session":
            with LOCK:
                return self.send(200, {"consent": STATE["consent"], "newsletter": STATE["newsletter"],
                                       "bookmarks": list(STATE["bookmarks"]),
                                       "reader": {"name": "Sam Rivera", "email": "sam.rivera@fastmail.test"}})
        if path == "/api/articles":
            return self.send(200, [summary(a) for a in ARTICLES])
        if path == "/api/notes":
            with LOCK:
                return self.send(200, list(reversed(STATE["notes"])))
        m = re.fullmatch(r"/api/articles/([a-z0-9-]+)(?:/(tabs|accordion)/([a-z0-9-]+))?", path)
        if m:
            a = BY_SLUG.get(m.group(1))
            if not a:
                return self.send(404, {"error": "no such article"})
            if not m.group(2):
                return self.send(200, article_view(a))
            pool = a.get("tabs" if m.group(2) == "tabs" else "accordion", [])
            part = next((x for x in pool if x["id"] == m.group(3)), None)
            if not part:
                return self.send(404, {"error": "not found"})
            return self.send(200, {"blocks": part["blocks"]} if m.group(2) == "tabs" else {"answer": part["answer"]})
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
        if not isinstance(body, dict):
            return self.send(400, {"error": "expected a JSON object"})
        with LOCK:
            if path == "/api/consent":
                if body.get("choice") not in ("accepted", "rejected", "custom"):
                    return self.send(400, {"error": "unknown choice"})
                STATE["consent"] = body["choice"]
            elif path == "/api/newsletter":
                if body.get("action") == "dismiss":
                    STATE["newsletter"] = "dismissed"
                elif body.get("action") == "subscribe":
                    email = clean(body.get("email"), 200)
                    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
                        return self.send(400, {"error": "Enter a valid email address"})
                    STATE["newsletter"], STATE["newsletter_email"] = "subscribed", email
                else:
                    return self.send(400, {"error": "unknown action"})
            elif path == "/api/bookmarks":
                slug = body.get("slug")
                if slug not in BY_SLUG:
                    return self.send(404, {"error": "no such article"})
                if body.get("saved") and slug not in STATE["bookmarks"]:
                    STATE["bookmarks"].append(slug)
                elif not body.get("saved") and slug in STATE["bookmarks"]:
                    STATE["bookmarks"].remove(slug)
            elif path == "/api/notes":
                note = {k: clean(body.get(k), 2000 if k == "summary" else 200) for k in NOTE_FIELDS}
                if not note["title"]:
                    return self.send(400, {"error": "Give the note a title"})
                if note["source"] not in BY_SLUG:
                    return self.send(400, {"error": "Pick the source article"})
                note.update(id=f"N-{len(STATE['notes']) + 101}", submitted_at_ms=now_ms())
                STATE["notes"].append(note)
            else:
                return self.send(404, {"error": "not found"})
            changed_locked()
            return self.send(200, {"ok": True, "bookmarks": list(STATE["bookmarks"]),
                                   "note": STATE["notes"][-1] if path == "/api/notes" else None})


reset()

if __name__ == "__main__":
    serve_forever([(PORT, NewsHandler, HERE / "fixture")],
                  f"Signal Daily on http://127.0.0.1:{PORT}/ (reset POST /api/reset, check GET /api/check)")
