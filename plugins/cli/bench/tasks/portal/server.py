#!/usr/bin/env python3
import json
import re
import secrets
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from benchhttp import Handler, now_ms, serve_forever
from realism import Guard

PORTAL_PORT, PAY_PORT = 8921, 8922
HERE = Path(__file__).resolve().parent
PLANS = {
    "starter": {"name": "Starter", "annual": 19, "monthly": 24},
    "growth": {"name": "Growth", "annual": 35, "monthly": 42},
    "scale": {"name": "Scale", "annual": 48, "monthly": 58},
}
LOCK = threading.Lock()
STATE = {}
GUARD_PORTAL = Guard("portal")
GUARD_PAY = Guard("portal_pay")


def reset():
    with LOCK:
        STATE.update(tokens={}, upgrades=[], writes=0, auth_writes=0, passing_since=None, reset_at_ms=now_ms())
    GUARD_PORTAL.reset()
    GUARD_PAY.reset()


def clean(value, limit=200):
    return re.sub(r"\s+", " ", str(value if value is not None else "")).strip()[:limit]


def parse_seats(raw):
    if isinstance(raw, bool):
        return None
    if isinstance(raw, int):
        return raw if 1 <= raw <= 500 else None
    text = str(raw if raw is not None else "").strip()
    if not re.fullmatch(r"\d{1,3}", text):
        return None
    n = int(text)
    return n if 1 <= n <= 500 else None


def parse_amount(raw):
    if isinstance(raw, bool):
        return None
    if isinstance(raw, (int, float)):
        return int(raw) if raw == int(raw) and raw > 0 else None
    text = str(raw if raw is not None else "").strip()
    if not re.fullmatch(r"\d{1,8}", text):
        return None
    n = int(text)
    return n if n > 0 else None


def compute_amount(plan, seats, cycle):
    spec = PLANS.get(plan)
    if not spec or cycle not in ("annual", "monthly") or seats is None:
        return None
    return spec[cycle] * seats * (12 if cycle == "annual" else 1)


def luhn_ok(digits):
    total = 0
    for i, ch in enumerate(reversed(digits)):
        d = int(ch)
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def combined_method():
    p = GUARD_PORTAL.summary()
    y = GUARD_PAY.summary()
    counts = {k: p[k] + y[k] for k in ("ui", "ui_scripted", "no_event", "rejected")}
    accepted = p["accepted"] + y["accepted"]
    reasons = {}
    for src in (p["rejected_reasons"], y["rejected_reasons"]):
        for k, v in src.items():
            reasons[k] = reasons.get(k, 0) + v
    events = {}
    for src in (p["trigger_events"], y["trigger_events"]):
        for k, v in src.items():
            events[k] = events.get(k, 0) + v
    if accepted == 0:
        label = "none"
    elif p["accepted"] > 0 and y["accepted"] > 0 and p["label"] == "ui" and y["label"] == "ui":
        label = "ui"
    elif counts["no_event"] == accepted:
        label = "no_event"
    elif counts["ui_scripted"] == accepted:
        label = "ui_scripted"
    else:
        label = "mixed"
    return {
        "label": label,
        "accepted": accepted,
        **counts,
        "rejected_reasons": reasons,
        "trigger_events": events,
        "origins": {"portal": p, "pay": y},
    }


def items_for(upg, tokens):
    keys = ("plan", "cycle", "seats", "amount", "po", "payment_authorized", "cardholder", "card", "zip")
    if not upg:
        return dict.fromkeys(keys, False)
    tok = tokens.get(upg["payment_token"])
    tok_ok = bool(
        tok
        and tok["plan"] == upg["plan"]
        and tok["cycle"] == upg["cycle"]
        and tok["seats"] == upg["seats"]
        and tok["amount"] == upg["amount"]
        and tok["amount"] == 8640
    )
    return {
        "plan": upg["plan"] == "scale",
        "cycle": upg["cycle"] == "annual",
        "seats": upg["seats"] == 15,
        "amount": upg["amount"] == 8640,
        "po": upg["po"].upper() == "PO-2026-8841",
        "payment_authorized": tok_ok,
        "cardholder": bool(tok) and tok["cardholder"].lower() == "jordan lee",
        "card": bool(tok) and tok["card_digits"] == "4242424242424242" and tok["expiry"] == "09/28" and tok["cvc"] == "842",
        "zip": bool(tok) and tok["zip"] == "94104",
    }


def grade_locked():
    upg = STATE["upgrades"][-1] if STATE["upgrades"] else None
    items = items_for(upg, STATE["tokens"])
    matched = sum(items.values())
    tok = STATE["tokens"].get(upg["payment_token"]) if upg else None
    token_consistent = upg is None or bool(
        tok
        and tok["plan"] == upg["plan"]
        and tok["cycle"] == upg["cycle"]
        and tok["seats"] == upg["seats"]
        and tok["amount"] == upg["amount"]
    )
    invariants = {"token_matches_upgrade": token_consistent}
    latest = None
    if upg:
        latest = {
            "id": upg["id"],
            "plan": upg["plan"],
            "cycle": upg["cycle"],
            "seats": upg["seats"],
            "amount": upg["amount"],
            "po": upg["po"],
            "cardholder": tok["cardholder"] if tok else "",
            "card_last4": tok["card_last4"] if tok else "",
            "zip": tok["zip"] if tok else "",
        }
    return {
        "pass": matched == len(items) and all(invariants.values()),
        "matched": matched,
        "total": len(items),
        "invariants": invariants,
        "details": {
            "items_ok": items,
            "upgrades_submitted": len(STATE["upgrades"]),
            "authorizations_issued": len(STATE["tokens"]),
            "latest_upgrade": latest,
            "writes": STATE["writes"],
            "auth_writes": STATE["auth_writes"],
        },
    }


def check():
    with LOCK:
        g = grade_locked()
        g["completed_at_ms"] = STATE["passing_since"] if g["pass"] else None
        g["reset_at_ms"] = STATE["reset_at_ms"]
    g["method"] = combined_method()
    return g


def validate_auth(body):
    plan = clean(body.get("plan"), 40).lower()
    cycle = clean(body.get("cycle"), 40).lower()
    seats = parse_seats(body.get("seats"))
    amount = parse_amount(body.get("amount"))
    cardholder = clean(body.get("cardholder"), 120)
    card_raw = clean(body.get("card_number"), 40)
    digits = re.sub(r"[\s-]+", "", card_raw)
    expiry = clean(body.get("expiry"), 16)
    cvc = clean(body.get("cvc"), 10)
    zip_code = clean(body.get("zip"), 16)
    errors = {}
    expected = compute_amount(plan, seats, cycle)
    if plan not in PLANS:
        errors["plan"] = "Invalid plan"
    if cycle not in ("annual", "monthly"):
        errors["cycle"] = "Invalid billing cycle"
    if seats is None:
        errors["seats"] = "Invalid seat count"
    if expected is None or amount != expected:
        errors["amount"] = "Charge amount does not match selected plan"
    if len(cardholder) < 2:
        errors["cardholder"] = "Enter the cardholder name"
    if not re.fullmatch(r"\d{16}", digits) or not luhn_ok(digits):
        errors["card_number"] = "Enter a valid 16-digit card number"
    m_exp = re.fullmatch(r"(0[1-9]|1[0-2])/(\d{2})", expiry)
    if not m_exp:
        errors["expiry"] = "Use MM/YY format"
    if not re.fullmatch(r"\d{3,4}", cvc):
        errors["cvc"] = "Enter a 3 or 4 digit CVC"
    if not re.fullmatch(r"\d{5}(-\d{4})?", zip_code):
        errors["zip"] = "Enter a 5-digit ZIP code"
    parsed = {
        "plan": plan,
        "cycle": cycle,
        "seats": seats,
        "amount": amount,
        "cardholder": cardholder,
        "card_digits": digits,
        "card_last4": digits[-4:] if len(digits) >= 4 else "",
        "expiry": expiry,
        "cvc": cvc,
        "zip": zip_code,
    }
    return parsed, errors


def validate_upgrade(body, tokens):
    plan = clean(body.get("plan"), 40).lower()
    cycle = clean(body.get("cycle"), 40).lower()
    seats = parse_seats(body.get("seats"))
    po = clean(body.get("po"), 80)
    amount = parse_amount(body.get("amount"))
    payment_token = clean(body.get("payment_token"), 120)
    errors = {}
    expected = compute_amount(plan, seats, cycle)
    if plan not in PLANS:
        errors["plan"] = "Choose a valid plan"
    if cycle not in ("annual", "monthly"):
        errors["cycle"] = "Choose monthly or annual billing"
    if seats is None:
        errors["seats"] = "Enter between 1 and 500 seats"
    if not po:
        errors["po"] = "Enter a purchase order number"
    if expected is None or amount != expected:
        errors["amount"] = "Total does not match selected plan and seats"
    tok = tokens.get(payment_token) if payment_token else None
    if not tok:
        errors["payment_token"] = "Authorize payment before finalizing upgrade"
    elif tok.get("consumed"):
        errors["payment_token"] = "Payment authorization has already been used"
    elif (tok["plan"], tok["cycle"], tok["seats"], tok["amount"]) != (plan, cycle, seats, amount):
        errors["payment_token"] = "Payment authorization does not match the current order"
    parsed = {
        "plan": plan,
        "cycle": cycle,
        "seats": seats,
        "po": po,
        "amount": amount,
        "payment_token": payment_token,
    }
    return parsed, errors


class PortalHandler(Handler):
    def do_GET(self):
        path = self.path_only
        if path == "/api/check":
            return self.send(200, check())
        if path == "/api/upgrades":
            with LOCK:
                return self.send(200, list(reversed(STATE["upgrades"])))
        if path in ("/", "/billing", "/upgrade"):
            return GUARD_PORTAL.render_page(self, (HERE / "fixture/portal/index.html").read_text())
        return self.static()

    def do_POST(self):
        path = self.path_only
        if path == "/api/reset":
            reset()
            return self.send(200, {"ok": True})
        if path != "/api/upgrade":
            return self.send(404, {"error": "not found"})
        raw = self.body_bytes()
        record = GUARD_PORTAL.verify_write(self, raw)
        if record["kind"] == "rejected":
            return GUARD_PORTAL.reject(self, record)
        try:
            body = json.loads(raw or b"{}")
        except ValueError:
            body = None
        if not isinstance(body, dict):
            return self.send(400, {"error": "expected a JSON object"})
        with LOCK:
            parsed, errors = validate_upgrade(body, STATE["tokens"])
            if errors:
                return self.send(422, {"error": "Could not finalize upgrade", "fields": errors})
            STATE["tokens"][parsed["payment_token"]]["consumed"] = True
            now = now_ms()
            upg = dict(parsed, id=f"UPG-2026-{101 + len(STATE['upgrades']):04d}", submitted_at_ms=now, status="Active")
            STATE["upgrades"].append(upg)
            STATE["writes"] += 1
            passing = grade_locked()["pass"]
            STATE["passing_since"] = (STATE["passing_since"] or now) if passing else None
        return self.send(200, {"ok": True, "upgrade": upg})


class PayHandler(Handler):
    def do_GET(self):
        path = self.path_only
        if path in ("/embed/pay", "/embed/pay/"):
            return GUARD_PAY.render_page(self, (HERE / "fixture/pay/embed.html").read_text())
        return self.static()

    def do_POST(self):
        path = self.path_only
        if path != "/api/authorize":
            return self.send(404, {"error": "not found"})
        raw = self.body_bytes()
        record = GUARD_PAY.verify_write(self, raw)
        if record["kind"] == "rejected":
            return GUARD_PAY.reject(self, record)
        try:
            body = json.loads(raw or b"{}")
        except ValueError:
            body = None
        if not isinstance(body, dict):
            return self.send(400, {"error": "expected a JSON object"})
        parsed, errors = validate_auth(body)
        if errors:
            return self.send(422, {"error": "Fix the highlighted payment fields", "fields": errors})
        token = f"cp_tok_{secrets.token_hex(12)}"
        with LOCK:
            entry = dict(parsed, token=token, issued_at_ms=now_ms())
            STATE["tokens"][token] = entry
            STATE["auth_writes"] += 1
        return self.send(200, {
            "ok": True,
            "token": token,
            "amount": parsed["amount"],
            "plan": parsed["plan"],
            "seats": parsed["seats"],
            "cycle": parsed["cycle"],
            "card_last4": parsed["card_last4"],
        })


reset()

if __name__ == "__main__":
    serve_forever(
        [(PORTAL_PORT, PortalHandler, HERE / "fixture/portal"), (PAY_PORT, PayHandler, HERE / "fixture/pay")],
        f"Verve Cloud Billing Portal on http://127.0.0.1:{PORTAL_PORT}/ and ClearPay Checkout on http://127.0.0.1:{PAY_PORT}/ "
        f"(reset POST /api/reset, check GET /api/check on {PORTAL_PORT})",
    )
