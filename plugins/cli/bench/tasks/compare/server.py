#!/usr/bin/env python3
import datetime
import json
import re
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from benchhttp import Handler, now_ms, serve_forever
from realism import Guard

VENDOR_PORT, PROCURE_PORT = 8891, 8892
HERE = Path(__file__).resolve().parent
VENDOR_PAGES = {"/": "index.html", "/pricing": "pricing.html", "/security": "security.html", "/changelog": "changelog.html"}
FIELDS = ("vendor", "website", "tier", "cycle", "seats", "annual_total", "soc2_date", "eu_residency", "eu_region",
          "justification")
TIERS = ("Starter", "Team", "Business", "Enterprise")
SEAT_PRICES = {"Starter": {"monthly": (12, 11), "annual": (10, 9)}, "Team": {"monthly": (24, 21), "annual": (20, 17)},
               "Business": {"monthly": (39, 34), "annual": (32, 28)}}
VOLUME_FROM_SEAT = 11
LOCK = threading.Lock()
STATE = {}
GUARD = Guard("procure")


def reset():
    with LOCK:
        STATE.update(requests=[], writes=0, passing_since=None, reset_at_ms=now_ms())
    GUARD.reset()


def money(raw):
    text = re.sub(r"[\s$,]|usd|/yr|per year|a year", "", str(raw or "").lower())
    m = re.fullmatch(r"(\d+)(\.(\d{1,2}))?", text)
    if not m or (m.group(3) and int(m.group(3))):
        return None
    return int(m.group(1))


def as_date(raw):
    text = str(raw or "").strip()
    for fmt in ("%Y-%m-%d", "%b %d, %Y", "%B %d, %Y", "%m/%d/%Y", "%d %B %Y", "%d %b %Y"):
        try:
            return datetime.datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def list_price(tier, cycle, seats):
    prices = SEAT_PRICES.get(tier, {}).get(cycle)
    if not prices or not seats.isdigit():
        return None
    first, rest = prices
    n = int(seats)
    return (min(n, VOLUME_FROM_SEAT - 1) * first + max(n - VOLUME_FROM_SEAT + 1, 0) * rest) * 12


def items_for(req):
    if not req:
        return dict.fromkeys(("vendor", "tier", "cycle", "seats", "annual_total", "soc2_date", "eu_residency", "eu_region"), False)
    region = req["eu_region"].lower()
    return {
        "vendor": re.sub(r"[^a-z]", "", req["vendor"].lower()) in ("vantage", "vantageinc", "vantagehq"),
        "tier": req["tier"] == "Business",
        "cycle": req["cycle"] == "annual",
        "seats": req["seats"].strip() == "25",
        "annual_total": money(req["annual_total"]) == 8880,
        "soc2_date": as_date(req["soc2_date"]) == "2026-10-14",
        "eu_residency": req["eu_residency"] == "yes",
        "eu_region": ("frankfurt" in region or "eu-central-1" in region) and "dublin" not in region and "eu-west-1" not in region,
    }


def grade_locked():
    req = STATE["requests"][-1] if STATE["requests"] else None
    items = items_for(req)
    matched = sum(items.values())
    invariants = {"total_matches_price_list": req is None or
                  money(req["annual_total"]) == list_price(req["tier"], req["cycle"], req["seats"])}
    return {"pass": matched == len(items) and all(invariants.values()), "matched": matched, "total": len(items),
            "invariants": invariants,
            "details": {"items_ok": items, "requests_submitted": len(STATE["requests"]),
                        "latest_request": {k: req[k] for k in FIELDS} if req else None,
                        "failed_invariants": [k for k, v in invariants.items() if not v], "writes": STATE["writes"]}}


def check():
    with LOCK:
        g = grade_locked()
        g["completed_at_ms"] = STATE["passing_since"] if g["pass"] else None
        g["reset_at_ms"] = STATE["reset_at_ms"]
    g["method"] = GUARD.summary()
    return g


def clean(value, limit=300):
    return re.sub(r"\s+", " ", str(value if value is not None else "")).strip()[:limit]


def validate(body):
    req = {k: clean(body.get(k), 2000 if k == "justification" else 300) for k in FIELDS}
    req["eu_residency"] = req["eu_residency"].lower()
    req["cycle"] = req["cycle"].lower()
    errors = {}
    if not req["vendor"]:
        errors["vendor"] = "Vendor is required"
    if req["tier"] not in TIERS:
        errors["tier"] = "Choose a plan tier"
    if req["cycle"] not in ("monthly", "annual"):
        errors["cycle"] = "Choose a billing cycle"
    if not re.fullmatch(r"\d{1,5}", req["seats"]) or int(req["seats"]) < 1:
        errors["seats"] = "Seats must be a whole number"
    if money(req["annual_total"]) is None:
        errors["annual_total"] = "Enter the annual total in USD"
    if not as_date(req["soc2_date"]):
        errors["soc2_date"] = "Enter a date"
    if req["eu_residency"] not in ("yes", "no"):
        errors["eu_residency"] = "Answer yes or no"
    if req["eu_residency"] == "yes" and not req["eu_region"]:
        errors["eu_region"] = "Name the EU region"
    if req["eu_residency"] == "no":
        req["eu_region"] = ""
    return req, errors


class VendorHandler(Handler):
    def do_GET(self):
        page = VENDOR_PAGES.get(self.path_only.rstrip("/") or "/")
        return self.static(page) if page else self.static()


class ProcureHandler(Handler):
    def do_GET(self):
        path = self.path_only
        if path == "/api/check":
            return self.send(200, check())
        if path == "/api/requests":
            with LOCK:
                return self.send(200, list(reversed(STATE["requests"])))
        if path in ("/", "/requests", "/new"):
            return GUARD.render_page(self, (HERE / "fixture/procure/index.html").read_text())
        return self.static()

    def do_POST(self):
        path = self.path_only
        if path == "/api/reset":
            reset()
            return self.send(200, {"ok": True})
        if path != "/api/requests":
            return self.send(404, {"error": "not found"})
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
        req, errors = validate(body)
        if errors:
            return self.send(422, {"error": "Fix the highlighted fields", "fields": errors})
        with LOCK:
            req.update(id=f"PR-2026-{412 + len(STATE['requests']):04d}", requester="Sam Rivera",
                       submitted_at_ms=now_ms(), status="Pending finance review")
            STATE["requests"].append(req)
            STATE["writes"] += 1
            passing = grade_locked()["pass"]
            STATE["passing_since"] = (STATE["passing_since"] or req["submitted_at_ms"]) if passing else None
        return self.send(200, {"ok": True, "request": req})


reset()

if __name__ == "__main__":
    serve_forever([(VENDOR_PORT, VendorHandler, HERE / "fixture/vendor"), (PROCURE_PORT, ProcureHandler, HERE / "fixture/procure")],
                  f"Vantage on http://127.0.0.1:{VENDOR_PORT}/ and Northwind Procurement on http://127.0.0.1:{PROCURE_PORT}/ "
                  f"(reset POST /api/reset, check GET /api/check on {PROCURE_PORT})")
