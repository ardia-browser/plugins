#!/usr/bin/env python3
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from benchclient import Report, Session, base, get_json, http, unsigned_post

WIKI = base(8951)
CATALOG = base(8952)
OPS = base(8953)

CORRECT = {
    "service": "svc-pay-01",
    "region": "eu-west-3",
    "mode": "active-passive",
    "responder": "Tomas Lind",
    "responder_id": "resp-tomas",
    "escalation_code": "ESC-47-EU",
    "owner_confirmed": True,
}

LEAK_STRINGS = (
    "svc-pay-01",
    "eu-west-3",
    "active-passive",
    "tomas lind",
    "esc-47-eu",
)

report = Report()


def submit_with_retry(overrides, want_pass):
    http("POST", f"{OPS}/api/reset")
    sess = Session(OPS)
    payload = dict(CORRECT, **overrides)
    st1, body1 = sess.post("/api/failover", payload)
    st2, body2 = sess.post("/api/failover", payload)
    _, chk = get_json(f"{OPS}/api/check")
    ok = (
        st1 == 429
        and body1.get("error") == "rate_limited"
        and st2 == 200
        and body2.get("accepted") is True
        and chk["pass"] is want_pass
        and (chk["completed_at_ms"] is not None) is want_pass
    )
    return ok, chk


http("POST", f"{OPS}/api/reset")
_, initial = get_json(f"{OPS}/api/check")
leaks = report.leaks({k: v for k, v in initial.items() if not k.endswith("_ms")}, LEAK_STRINGS)
report(
    "initial check fails and leaks nothing",
    initial["pass"] is False and initial["matched"] == 0 and initial["total"] == 7 and not leaks,
    leaks or initial,
)

for url, needle in [
    (f"{WIKI}/", "Postmortem #47"),
    (f"{WIKI}/runbook/payments-outage", "us-east-1"),
    (f"{WIKI}/postmortems/pm-47", f"{CATALOG}/regions"),
    (f"{WIKI}/rotations", "Tomas Lind"),
    (f"{WIKI}/pto", "2026-11-05 to 2026-11-12"),
    (f"{WIKI}/compliance/gdpr", "eu-west-3"),
    (f"{CATALOG}/", "svc-pay-01"),
    (f"{CATALOG}/services/payments-core", "active-passive"),
    (f"{CATALOG}/regions", "38 ms"),
    (f"{OPS}/", "Dispatch failover"),
    (f"{OPS}/realism.js", "export async function request"),
]:
    st, raw, _ = http("GET", url)
    text = raw.decode("utf-8", "replace")
    report(f"page loads: {url}", st == 200 and needle in text, (st, needle))

st_resp, resp_data = get_json(f"{OPS}/api/responders?q=tomas")
report(
    "responders autocomplete endpoint filters by query",
    st_resp == 200 and [r["name"] for r in resp_data.get("responders", [])] == ["Tomas Lind"],
    resp_data,
)

report("unsigned POST /api/failover returns 403", unsigned_post(f"{OPS}/api/failover", CORRECT) == 403)

sess = Session(OPS)
st_rl, body_rl = sess.post("/api/failover", CORRECT)
report("first signed POST returns 429 rate_limited", st_rl == 429 and body_rl.get("error") == "rate_limited", (st_rl, body_rl))

st_unconf, body_unconf = sess.post("/api/failover", dict(CORRECT, owner_confirmed=False))
_, chk_unconf = get_json(f"{OPS}/api/check")
report(
    "unconfirmed second POST reverts silently and fails check",
    st_unconf == 200 and body_unconf.get("accepted") is False and body_unconf.get("reverted") is True and chk_unconf["pass"] is False,
    (st_unconf, body_unconf, chk_unconf),
)

st_badcode, body_badcode = sess.post("/api/failover", dict(CORRECT, escalation_code="INVALID"))
_, chk_badcode = get_json(f"{OPS}/api/check")
report(
    "invalid escalation code reverts silently and fails check",
    st_badcode == 200 and body_badcode.get("accepted") is False and body_badcode.get("reverted") is True and chk_badcode["pass"] is False,
    (st_badcode, body_badcode),
)

st_ok, body_ok = sess.post("/api/failover", CORRECT)
_, chk_ok = get_json(f"{OPS}/api/check")
report(
    "confirmed retry with exact values passes check with method=ui",
    st_ok == 200
    and body_ok.get("accepted") is True
    and body_ok.get("status") == "Dispatched"
    and chk_ok["pass"] is True
    and chk_ok["matched"] == 7
    and chk_ok["total"] == 7
    and chk_ok["completed_at_ms"] is not None
    and chk_ok["method"]["label"] == "ui"
    and chk_ok["details"]["rate_limit_retries"] >= 1,
    (st_ok, body_ok, chk_ok),
)

for trap_name, overrides in [
    ("trap: outdated region us-east-1", {"region": "us-east-1"}),
    ("trap: high latency eu-central-1", {"region": "eu-central-1"}),
    ("trap: degraded eu-west-1", {"region": "eu-west-1"}),
    ("trap: non-EU uk-south-1", {"region": "uk-south-1"}),
    ("trap: responder on PTO Maya Patel", {"responder": "Maya Patel", "responder_id": "resp-maya"}),
    ("trap: primary responder Devon Brooks", {"responder": "Devon Brooks", "responder_id": "resp-devon"}),
    ("trap: legacy service svc-pay-legacy", {"service": "svc-pay-legacy"}),
    ("trap: wrong failover mode active-active", {"mode": "active-active"}),
    ("trap: legacy escalation code ESC-12-US", {"escalation_code": "ESC-12-US"}),
]:
    ok, chk = submit_with_retry(overrides, False)
    report(trap_name, ok, chk)

http("POST", f"{OPS}/api/reset")
_, cleared = get_json(f"{OPS}/api/check")
sess2 = Session(OPS)
st_after_reset, body_after_reset = sess2.post("/api/failover", CORRECT)
report(
    "reset clears state and re-arms 429 rate limit",
    cleared["pass"] is False
    and cleared["matched"] == 0
    and cleared["details"]["dispatched"] is None
    and cleared["details"]["rate_limit_retries"] == 0
    and st_after_reset == 429
    and body_after_reset.get("error") == "rate_limited",
    (cleared, st_after_reset, body_after_reset),
)

http("POST", f"{OPS}/api/reset")
report.finish()
