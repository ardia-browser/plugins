#!/usr/bin/env python3
import datetime
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlencode

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from benchclient import Session, base
from livedates import add_business_days, month_day, short_day, today

BASE = base(8821)
SECRETS = ["DK-2814", "DESKDAYS", "expedited", "548", "94104"]
OFFICE = {"ship_to": "new", "name": "Jordan Lee", "company": "Northwind Labs", "line1": "548 Market St", "line2": "Suite 1200",
          "city": "San Francisco", "state": "CA", "zip": "94104", "phone": "(415) 555-0198", "shipping": "expedited", "payment": "card-4417"}


def call(method, path, form=None):
    data = urlencode(form).encode() if form is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read().decode(), r.geturl()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(), path


def check():
    return json.loads(call("GET", "/api/check")[1])


def order(sku="DK-2814", qty=3, codes=("DESKDAYS",), address=None):
    sess = Session(BASE, "/c/docks-hubs?sort=featured&page=2")
    sess.post_form("/cart/add", {"sku": sku, "qty": str(qty)})
    for code in codes:
        sess.post_form("/cart/coupon", {"code": code})
    call("GET", "/checkout")
    return sess.post_form("/checkout", address or OFFICE)


failures = 0


def report(name, ok, extra=""):
    global failures
    failures += not ok
    print(f"{'PASS' if ok else 'FAIL'} {name}{' ' + extra if extra else ''}")


call("POST", "/api/reset")
c = check()
shown = json.dumps({k: v for k, v in c.items() if not k.endswith("_ms")})
report("initial check fails and leaks nothing", not c["pass"] and c["completed_at_ms"] is None and not any(s in shown for s in SECRETS))

report("unsigned form POSTs are rejected with 403",
       call("POST", "/cart/add", {"sku": "DK-2814", "qty": "1"})[0] == 403
       and call("POST", "/checkout", OFFICE)[0] == 403)

call("POST", "/api/reset")
sess = Session(BASE, "/")
page1 = call("GET", "/c/docks-hubs")[1]
page2 = call("GET", "/c/docks-hubs?sort=featured&page=2")[1]
report("answer is on page 2, not page 1", "DK-2814" not in page1 and "harbor-h12" in page2)
sess.post_form("/cart/add", {"sku": "DK-2814", "qty": "3"})
expired = sess.post_form("/cart/coupon", {"code": "TECH20"})[1]
other = sess.post_form("/cart/coupon", {"code": "SCREENS25"})[1]
report("expired and wrong-category codes are refused", "expired on" in expired and "apply to the items" in other)
status, body, _ = sess.post_form("/checkout", dict(OFFICE, zip="9410", phone="+1 415 555 0198", line1=""))
report("checkout shows inline errors", status == 422 and body.count('class="err"') == 3 and "error-summary" in body)

call("POST", "/api/reset")
sess = Session(BASE, "/")
sess.post_form("/cart/add", {"sku": "DK-2814", "qty": "3"})
checkout = call("GET", "/checkout")[1]
etas = dict(re.findall(r'value="(\w+)" data-cost="\d+"[^>]*>.*?<span class="muted">([^<]+)</span>', checkout))
deadline = short_day(add_business_days(today(), 3))
standard_first = short_day(add_business_days(today(), 5))
report("delivery dates follow today's date", etas.get("expedited") == f"Arrives by {deadline}"
       and etas.get("standard", "").startswith(f"Arrives {standard_first} – ")
       and etas.get("twoday") == f"Arrives by {short_day(add_business_days(today(), 2))}", json.dumps(etas))
deskdays_ends = today() + datetime.timedelta(days=9)
report("promo end dates follow today's date", f"Ends {month_day(deskdays_ends)}." in call("GET", "/deals")[1])

for name in ("correct", "correct again after reset"):
    call("POST", "/api/reset")
    status, body, url = order()
    c = check()
    report(name, status == 200 and "/orders/" in url and c["pass"] and c["completed_at_ms"]
           and c["matched"] == c["total"] and c["method"]["label"] == "ui",
           json.dumps({"wrong": c["details"]["wrong"], "method": c["method"]}))

traps = {
    "decoy 4K at 30 Hz": dict(sku="DK-3317"),
    "decoy 85 W to laptop": dict(sku="DK-3542"),
    "page-1 pricier qualifier": dict(sku="DK-4016"),
    "decoy coupon FALL10": dict(codes=("DESKDAYS", "FALL10")),
    "expired coupon only": dict(codes=("TECH20",)),
    "saved home address": dict(address=dict(OFFICE, ship_to="saved")),
    "cheapest shipping misses date": dict(address=dict(OFFICE, shipping="standard")),
    "wrong quantity": dict(qty=1),
}
for name, kwargs in traps.items():
    call("POST", "/api/reset")
    status, _, url = order(**kwargs)
    c = check()
    report(f"trap {name}", not c["pass"] and c["completed_at_ms"] is None, f"ordered={'/orders/' in url} wrong={c['details']['wrong']}")

call("POST", "/api/reset")
c = check()
cart = call("GET", "/cart")[1]
report("reset clears orders and cart", c["details"]["orders_placed"] == 0 and "Your cart is empty" in cart)
sys.exit(1 if failures else 0)
