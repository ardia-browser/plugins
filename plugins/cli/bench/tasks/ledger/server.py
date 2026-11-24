#!/usr/bin/env python3
import csv
import io
import json
import random
import re
import sys
import threading
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from benchhttp import Handler, now_ms, serve_forever
from realism import Guard

PORT = 8901
HERE = Path(__file__).resolve().parent
GUARD = Guard("ledger")
TARGET_QUARTER = "Q3 2026"
TARGET_CATEGORY = "Infrastructure"
CATEGORIES = ("Infrastructure", "Software", "Travel", "Recruiting", "Facilities")
VENDORS = {
    "Infrastructure": (
        "Nimbus Cloud",
        "Helios Compute",
        "Strata Networks",
        "Redwood Storage",
        "Vektor CDN",
        "Ironclad Baremetal",
    ),
    "Software": (
        "Linearity Labs",
        "Figma Works",
        "Datapulse Telemetry",
        "Sentryline",
        "Notionary",
    ),
    "Travel": (
        "Pacific Air",
        "Harbor Hotels",
        "RailLink Express",
        "Metro Transit",
    ),
    "Recruiting": (
        "Beacon Talent",
        "Northstar Search",
        "Kestrel Staffing",
    ),
    "Facilities": (
        "Civic Workspaces",
        "Verdant Office Co",
        "Apex Security",
    ),
}
QUARTER_MONTHS = {
    "Q2 2026": (4, 5, 6),
    "Q3 2026": (7, 8, 9),
    "Q4 2026": (10, 11, 12),
}
MONTH_DAYS = {4: 30, 5: 31, 6: 30, 7: 31, 8: 31, 9: 30, 10: 31, 11: 30, 12: 31}
CENTS_ENDINGS = (0, 25, 50, 75, 10, 35, 60, 85)


def generate_rows():
    rng = random.Random(20260701)
    rows = []
    for idx in range(240):
        inv_id = f"INV-26{idx + 1:04d}"
        quarter = rng.choices(("Q2 2026", "Q3 2026", "Q4 2026"), weights=(26, 46, 28))[0]
        month = rng.choice(QUARTER_MONTHS[quarter])
        day = rng.randint(1, MONTH_DAYS[month])
        date_str = f"2026-{month:02d}-{day:02d}"
        category = rng.choices(CATEGORIES, weights=(32, 24, 16, 14, 14))[0]
        vendor = rng.choice(VENDORS[category])
        status = rng.choices(("Approved", "Pending", "VOID"), weights=(72, 18, 10))[0]
        dollars = rng.randint(420, 11800)
        cents = rng.choice(CENTS_ENDINGS)
        amount_cents = dollars * 100 + cents
        rows.append({
            "id": inv_id,
            "date": date_str,
            "quarter": quarter,
            "vendor": vendor,
            "category": category,
            "status": status,
            "amount_cents": amount_cents,
            "duplicate_of": "",
        })

    pinned = {
        3: ("2026-07-08", "Q3 2026", "Nimbus Cloud", "Infrastructure", "Approved", 642050, ""),
        10: ("2026-07-14", "Q3 2026", "Ironclad Baremetal", "Infrastructure", "VOID", 3490000, ""),
        14: ("2026-06-19", "Q2 2026", "Helios Compute", "Infrastructure", "Approved", 3125000, ""),
        18: ("2026-07-08", "Q3 2026", "Nimbus Cloud", "Infrastructure", "Approved", 642050, "INV-260004"),
        22: ("2026-07-21", "Q3 2026", "Strata Networks", "Infrastructure", "Approved", 815025, ""),
        47: ("2026-08-03", "Q3 2026", "Strata Networks", "Infrastructure", "Pending", 2980000, ""),
        73: ("2026-08-11", "Q3 2026", "Nimbus Cloud", "Infrastructure", "Approved", 934000, ""),
        88: ("2026-08-11", "Q3 2026", "Nimbus Cloud", "Infrastructure", "Approved", 934000, "INV-260074"),
        112: ("2026-08-24", "Q3 2026", "Helios Compute", "Infrastructure", "Approved", 1274075, ""),
        139: ("2026-08-24", "Q3 2026", "Helios Compute", "Infrastructure", "Approved", 1274075, "INV-260113"),
        154: ("2026-09-02", "Q3 2026", "Helios Compute", "Infrastructure", "Approved", 1125050, ""),
        175: ("2026-10-12", "Q4 2026", "Redwood Storage", "Infrastructure", "Approved", 3310000, ""),
        198: ("2026-09-15", "Q3 2026", "Nimbus Cloud", "Infrastructure", "VOID", 2640000, ""),
        204: ("2026-09-18", "Q3 2026", "Redwood Storage", "Infrastructure", "Approved", 1048000, ""),
        216: ("2026-09-22", "Q3 2026", "Helios Compute", "Infrastructure", "Approved", 2845075, ""),
        221: ("2026-09-24", "Q3 2026", "Helios Compute", "Infrastructure", "Approved", 1420050, ""),
        229: ("2026-09-28", "Q3 2026", "Strata Networks", "Infrastructure", "Approved", 1189000, "INV-260023"),
        234: ("2026-09-29", "Q3 2026", "Vektor CDN", "Infrastructure", "Approved", 765025, ""),
    }
    for idx, (date_str, quarter, vendor, category, status, amount_cents, dup) in pinned.items():
        rows[idx].update(
            date=date_str,
            quarter=quarter,
            vendor=vendor,
            category=category,
            status=status,
            amount_cents=amount_cents,
            duplicate_of=dup,
        )
    return rows


def is_qualifying(row):
    return (
        row["quarter"] == TARGET_QUARTER
        and row["category"] == TARGET_CATEGORY
        and row["status"] == "Approved"
        and not row["duplicate_of"]
    )


ROWS = generate_rows()
QUALIFYING_ROWS = [r for r in ROWS if is_qualifying(r)]
EXPECTED_COUNT = len(QUALIFYING_ROWS)
EXPECTED_TOTAL_CENTS = sum(r["amount_cents"] for r in QUALIFYING_ROWS)
EXPECTED_TOP_ROW = max(QUALIFYING_ROWS, key=lambda r: r["amount_cents"])
EXPECTED_TOP_INVOICE = EXPECTED_TOP_ROW["id"]
VENDOR_TOTALS = {}
for row in QUALIFYING_ROWS:
    VENDOR_TOTALS[row["vendor"]] = VENDOR_TOTALS.get(row["vendor"], 0) + row["amount_cents"]
EXPECTED_TOP_VENDOR = max(VENDOR_TOTALS.items(), key=lambda kv: kv[1])[0]

LOCK = threading.Lock()
STATE = {}


def reset():
    with LOCK:
        STATE.update(submission=None, writes=0, passing_since=None, reset_at_ms=now_ms())
    GUARD.reset()


def parse_usd_to_cents(raw):
    if raw is None or isinstance(raw, bool):
        return None
    if isinstance(raw, (int, float)):
        s = f"{raw:.6f}"
    else:
        s = str(raw).strip()
        s = re.sub(r"^(usd)\s*", "", s, flags=re.I)
        s = s.replace("$", "").replace(",", "").strip()
    if not re.fullmatch(r"\d+(?:\.\d+)?", s):
        return None
    try:
        dec = Decimal(s)
    except InvalidOperation:
        return None
    return int((dec * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def parse_count(raw):
    if raw is None or isinstance(raw, bool):
        return None
    if isinstance(raw, int):
        return raw
    s = str(raw).strip().replace(",", "")
    if not re.fullmatch(r"\d+", s):
        return None
    return int(s)


def normalize_text(raw):
    return re.sub(r"\s+", " ", str(raw or "").strip()).lower()


def grade_locked():
    sub = STATE["submission"]
    if not sub:
        items = {"count": False, "total_usd": False, "top_invoice": False, "top_vendor": False}
    else:
        items = {
            "count": sub["count"] == EXPECTED_COUNT,
            "total_usd": sub["total_cents"] == EXPECTED_TOTAL_CENTS,
            "top_invoice": normalize_text(sub["top_invoice"]) == EXPECTED_TOP_INVOICE.lower(),
            "top_vendor": normalize_text(sub["top_vendor"]) == EXPECTED_TOP_VENDOR.lower(),
        }
    matched = sum(items.values())
    passed = matched == len(items)
    return {
        "pass": passed,
        "matched": matched,
        "total": len(items),
        "details": {
            "submitted": dict(sub) if sub else None,
            "items_ok": items,
            "writes": STATE["writes"],
        },
    }


def check():
    with LOCK:
        g = grade_locked()
        g["completed_at_ms"] = STATE["passing_since"] if g["pass"] else None
        g["reset_at_ms"] = STATE["reset_at_ms"]
    g["method"] = GUARD.summary()
    return g


def filter_rows(params):
    quarter = params.get("quarter", "").strip()
    category = params.get("category", "").strip()
    status = params.get("status", "").strip()
    q = params.get("q", "").strip().lower()
    out = []
    for r in ROWS:
        if quarter and r["quarter"] != quarter:
            continue
        if category and r["category"] != category:
            continue
        if status and r["status"] != status:
            continue
        if q and q not in f"{r['id']} {r['vendor']} {r['category']} {r['quarter']} {r['status']} {r['duplicate_of']}".lower():
            continue
        out.append(r)
    return out


def build_csv():
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(["id", "date", "quarter", "vendor", "category", "status", "amount_cents", "duplicate_of"])
    for r in ROWS:
        writer.writerow([
            r["id"],
            r["date"],
            r["quarter"],
            r["vendor"],
            r["category"],
            r["status"],
            r["amount_cents"],
            r["duplicate_of"],
        ])
    return buf.getvalue().encode("utf-8")


CSV_BYTES = build_csv()


class LedgerHandler(Handler):
    def do_GET(self):
        path = self.path_only
        if path == "/api/check":
            return self.send(200, check())
        if path == "/api/rows":
            params = self.query
            try:
                offset = max(0, int(params.get("offset", "0")))
            except ValueError:
                offset = 0
            try:
                limit = max(1, min(50, int(params.get("limit", "25"))))
            except ValueError:
                limit = 25
            filtered = filter_rows(params)
            chunk = filtered[offset:offset + limit]
            next_offset = offset + len(chunk) if offset + len(chunk) < len(filtered) else None
            return self.send(200, {
                "rows": chunk,
                "offset": offset,
                "limit": limit,
                "total": len(filtered),
                "has_more": next_offset is not None,
                "next_offset": next_offset,
            })
        if path == "/api/export.csv":
            return self.send(
                200,
                CSV_BYTES,
                "text/csv; charset=utf-8",
                headers={"Content-Disposition": 'attachment; filename="meridian-ledger-2026.csv"'},
            )
        if path in ("/", "/index.html"):
            return GUARD.render_page(self, (HERE / "fixture" / "index.html").read_text())
        return self.static()

    def do_POST(self):
        path = self.path_only
        if path == "/api/reset":
            reset()
            return self.send(200, {"ok": True})
        if path == "/api/reconcile":
            raw = self.body_bytes()
            record = GUARD.verify_write(self, raw)
            if record["kind"] == "rejected":
                return GUARD.reject(self, record)
            try:
                body = json.loads(raw or b"{}")
            except ValueError:
                body = None
            if not isinstance(body, dict):
                return self.send(400, {"error": "expected JSON object"})
            count = parse_count(body.get("count"))
            total_cents = parse_usd_to_cents(body.get("total_usd"))
            top_invoice = str(body.get("top_invoice") or "").strip()
            top_vendor = str(body.get("top_vendor") or "").strip()
            if count is None or total_cents is None or not top_invoice or not top_vendor:
                return self.send(400, {"error": "all reconciliation fields are required and must be valid"})
            with LOCK:
                STATE["submission"] = {
                    "count": count,
                    "total_usd": str(body.get("total_usd")).strip(),
                    "total_cents": total_cents,
                    "top_invoice": top_invoice,
                    "top_vendor": top_vendor,
                    "saved_at_ms": now_ms(),
                }
                STATE["writes"] += 1
                STATE["passing_since"] = (STATE["passing_since"] or now_ms()) if grade_locked()["pass"] else None
            return self.send(200, {"ok": True, "saved": True})
        return self.send(404, {"error": "not found"})


reset()

if __name__ == "__main__":
    serve_forever(
        [(PORT, LedgerHandler, HERE / "fixture")],
        f"Meridian Ledger on http://127.0.0.1:{PORT}/ (reset POST /api/reset, check GET /api/check)",
    )
