#!/usr/bin/env python3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from benchclient import PORT_OFFSET, Report, Session, base, get_json, http, unsigned_post

PORTAL, PAY = base(8921), base(8922)
ANSWERS = ("scale", "8640", "8,640", "po-2026-8841", "8841", "jordan lee", "4242", "09/28", "842", "94104")
GOOD_AUTH = {
    "cardholder": "Jordan Lee",
    "card_number": "4242 4242 4242 4242",
    "expiry": "09/28",
    "cvc": "842",
    "zip": "94104",
    "plan": "scale",
    "seats": 15,
    "cycle": "annual",
    "amount": 8640,
}
GOOD_UPGRADE = {
    "plan": "scale",
    "seats": 15,
    "cycle": "annual",
    "amount": 8640,
    "po": "PO-2026-8841",
}
report = Report()


def check():
    return get_json(f"{PORTAL}/api/check")[1]


def reset():
    http("POST", f"{PORTAL}/api/reset")


def full_flow(auth_changes=None, upg_changes=None, auth_event="click:1:40", upg_event="click:1:50"):
    reset()
    s_portal = Session(PORTAL, "/")
    s_pay = Session(PAY, "/embed/pay?amount=8640&plan=scale&seats=15&cycle=annual")
    auth_body = dict(GOOD_AUTH, **(auth_changes or {}))
    a_status, a_out = s_pay.post("/api/authorize", auth_body, auth_event)
    if a_status != 200:
        return a_status, a_out, None, None, check()
    upg_body = dict(GOOD_UPGRADE, **(upg_changes or {}), payment_token=a_out["token"])
    u_status, u_out = s_portal.post("/api/upgrade", upg_body, upg_event)
    return a_status, a_out, u_status, u_out, check()


reset()
fresh = check()
report("fresh state fails", fresh["pass"] is False and fresh["completed_at_ms"] is None and fresh["matched"] == 0, fresh)
report("fresh check leaks nothing", not report.leaks(fresh, ANSWERS), report.leaks(fresh, ANSWERS))
report("check reports method and invariants", isinstance(fresh.get("method"), dict) and isinstance(fresh.get("invariants"), dict))

for path in ("/", "/portal.css", "/portal.js", "/realism.js"):
    report(f"portal serves {path}", http("GET", f"{PORTAL}{path}")[0] == 200)
for path in ("/embed/pay?amount=120&plan=starter&seats=5&cycle=monthly", "/pay.css", "/pay.js", "/realism.js"):
    report(f"pay serves {path}", http("GET", f"{PAY}{path}")[0] == 200)

portal_html = http("GET", f"{PORTAL}/")[1].decode()
report("portal embeds pay iframe on this lane", f"127.0.0.1:{8922 + PORT_OFFSET}/embed/pay" in portal_html)
if PORT_OFFSET:
    report("no base-port iframe link leaks through offset", "127.0.0.1:8922/" not in portal_html)
report("pay origin has no check endpoint", http("GET", f"{PAY}/api/check")[0] == 404)

reset()
report("unsigned POST to 8921 rejected with 403", unsigned_post(f"{PORTAL}/api/upgrade", dict(GOOD_UPGRADE, payment_token="fake")) == 403)
report("unsigned POST to 8922 rejected with 403", unsigned_post(f"{PAY}/api/authorize", GOOD_AUTH) == 403)
c_after_unsigned = check()
report("unsigned attempts record no writes", c_after_unsigned["details"]["upgrades_submitted"] == 0 and c_after_unsigned["details"]["authorizations_issued"] == 0)

reset()
sp = Session(PORTAL, "/")
status_bad_tok, out_bad_tok = sp.post("/api/upgrade", dict(GOOD_UPGRADE, payment_token="cp_tok_forged"))
report("forged payment token rejected with 422", status_bad_tok == 422 and "payment_token" in out_bad_tok.get("fields", {}), out_bad_tok)

reset()
sp = Session(PORTAL, "/")
sy = Session(PAY, "/embed/pay?amount=870&plan=scale&seats=15&cycle=monthly")
st_a, out_a = sy.post("/api/authorize", dict(GOOD_AUTH, cycle="monthly", amount=870))
report("monthly auth issues token", st_a == 200 and "token" in out_a, out_a)
st_u, out_u = sp.post("/api/upgrade", dict(GOOD_UPGRADE, payment_token=out_a["token"]))
report("mismatched payment token rejected with 422", st_u == 422 and "payment_token" in out_u.get("fields", {}), out_u)

_, _, u_st, _, r = full_flow(
    auth_changes={"cycle": "monthly", "amount": 870},
    upg_changes={"cycle": "monthly", "amount": 870},
)
report("decoy monthly billing fails", u_st == 200 and r["pass"] is False and r["details"]["items_ok"]["cycle"] is False, r)

_, _, u_st, _, r = full_flow(
    auth_changes={"seats": 10, "amount": 5760},
    upg_changes={"seats": 10, "amount": 5760},
)
report("decoy wrong seats fails", u_st == 200 and r["pass"] is False and r["details"]["items_ok"]["seats"] is False, r)

_, _, u_st, _, r = full_flow(
    auth_changes={"plan": "growth", "amount": 6300},
    upg_changes={"plan": "growth", "amount": 6300},
)
report("decoy wrong plan fails", u_st == 200 and r["pass"] is False and r["details"]["items_ok"]["plan"] is False, r)

_, _, u_st, _, r = full_flow(upg_changes={"po": "PO-2026-0001"})
report("decoy wrong PO fails", u_st == 200 and r["pass"] is False and r["details"]["items_ok"]["po"] is False, r)

_, _, u_st, _, r = full_flow(auth_changes={"zip": "10001"})
report("decoy wrong ZIP fails", u_st == 200 and r["pass"] is False and r["details"]["items_ok"]["zip"] is False, r)

_, _, u_st, _, r = full_flow(auth_event="click:0:40", upg_event="click:1:50")
report("scripted pay + trusted portal is labelled mixed", u_st == 200 and r["pass"] is True and r["method"]["label"] == "mixed", r["method"])

a_st, _, u_st, _, r = full_flow()
report("full cross-origin flow passes", a_st == 200 and u_st == 200 and r["pass"] is True and r["completed_at_ms"] is not None, r)
report("full cross-origin flow records ui method across both origins", r["method"]["label"] == "ui" and r["method"]["origins"]["portal"]["label"] == "ui" and r["method"]["origins"]["pay"]["label"] == "ui", r["method"])

reset()
after_reset = check()
report(
    "reset clears both guards and state",
    after_reset["pass"] is False
    and after_reset["matched"] == 0
    and after_reset["details"]["upgrades_submitted"] == 0
    and after_reset["details"]["authorizations_issued"] == 0
    and after_reset["method"]["accepted"] == 0
    and after_reset["method"]["label"] == "none",
    after_reset,
)
report.finish()
