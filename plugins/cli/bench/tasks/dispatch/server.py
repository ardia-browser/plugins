#!/usr/bin/env python3
import html
import json
import re
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from benchhttp import Handler, now_ms, serve_forever
from realism import Guard

WIKI_PORT = 8951
CATALOG_PORT = 8952
OPS_PORT = 8953
HERE = Path(__file__).resolve().parent
GUARD = Guard("dispatch")

ESC_CODE_RE = re.compile(r"^ESC-\d+-[A-Z]{2}$")

EXPECTED = {
    "service": "svc-pay-01",
    "region": "eu-west-3",
    "mode": "active-passive",
    "responder": "Tomas Lind",
    "escalation_code": "ESC-47-EU",
}

SERVICES = [
    {"id": "svc-pay-01", "name": "Payments Core", "tier": "Tier 0", "mode": "active-passive", "owner": "Payments Core"},
    {"id": "svc-pay-legacy", "name": "Payments Legacy Gateway", "tier": "Tier 2", "mode": "active-active", "owner": "Payments Core"},
    {"id": "svc-auth-02", "name": "Auth Platform", "tier": "Tier 0", "mode": "active-active", "owner": "Auth Platform"},
    {"id": "svc-ledger-01", "name": "Ledger Core", "tier": "Tier 1", "mode": "read-only", "owner": "Ledger & Clearing"},
]

REGIONS = [
    {"id": "us-east-1", "residency": "US", "p95_ms": 19, "status": "Available"},
    {"id": "eu-central-1", "residency": "EU (GDPR)", "p95_ms": 52, "status": "Available"},
    {"id": "eu-west-1", "residency": "EU (GDPR)", "p95_ms": 41, "status": "Degraded"},
    {"id": "eu-west-3", "residency": "EU (GDPR)", "p95_ms": 38, "status": "Available"},
    {"id": "ap-northeast-1", "residency": "APAC", "p95_ms": 140, "status": "Available"},
    {"id": "uk-south-1", "residency": "UK (non-EU)", "p95_ms": 31, "status": "Available"},
]

RESPONDERS = [
    {"id": "resp-tomas", "name": "Tomas Lind", "team": "Payments Core", "role": "Staff SRE"},
    {"id": "resp-maya", "name": "Maya Patel", "team": "Payments Core", "role": "Senior SRE"},
    {"id": "resp-devon", "name": "Devon Brooks", "team": "Payments Core", "role": "Principal Engineer"},
    {"id": "resp-priya", "name": "Priya Nair", "team": "Auth Platform", "role": "Staff Engineer"},
    {"id": "resp-alex", "name": "Alex Morgan", "team": "Edge Routing", "role": "Senior SRE"},
]

RESPONDER_BY_ID = {r["id"]: r for r in RESPONDERS}
SERVICE_IDS = {s["id"] for s in SERVICES}
REGION_IDS = {r["id"] for r in REGIONS}
MODES = {"active-passive", "active-active", "read-only"}

LOCK = threading.Lock()
STATE = {}


def reset_state():
    with LOCK:
        STATE.clear()
        STATE.update(
            dispatched=None,
            rate_limit_hit=False,
            rate_limit_hits=0,
            rate_limit_retries=0,
            reverts=0,
            submissions=0,
            reset_at_ms=now_ms(),
        )
    GUARD.reset()


def check():
    with LOCK:
        d = dict(STATE["dispatched"]) if STATE["dispatched"] else None
        retries = STATE["rate_limit_retries"]
        hits = STATE["rate_limit_hits"]
        reverts = STATE["reverts"]
        submissions = STATE["submissions"]
        reset_at = STATE["reset_at_ms"]
    total = 7
    if not d:
        return {
            "pass": False,
            "matched": 0,
            "total": total,
            "completed_at_ms": None,
            "reset_at_ms": reset_at,
            "method": GUARD.summary(),
            "details": {
                "submissions": submissions,
                "rate_limit_hits": hits,
                "rate_limit_retries": retries,
                "reverts": reverts,
                "dispatched": None,
                "wrong": ["no_failover_dispatched"],
            },
        }
    results = {
        "service": d["service"] == EXPECTED["service"],
        "region": d["region"] == EXPECTED["region"],
        "mode": d["mode"] == EXPECTED["mode"],
        "responder": d["responder"].casefold() == EXPECTED["responder"].casefold(),
        "escalation_code": d["escalation_code"] == EXPECTED["escalation_code"],
        "owner_confirmed": d["owner_confirmed"] is True,
        "rate_limit_retries": retries >= 1,
    }
    passed = all(results.values())
    return {
        "pass": passed,
        "matched": sum(results.values()),
        "total": total,
        "completed_at_ms": d["saved_at_ms"] if passed else None,
        "reset_at_ms": reset_at,
        "method": GUARD.summary(),
        "details": {
            "submissions": submissions,
            "rate_limit_hits": hits,
            "rate_limit_retries": retries,
            "reverts": reverts,
            "dispatched": {k: d[k] for k in ("service", "region", "mode", "responder", "escalation_code", "owner_confirmed")},
            "wrong": sorted(k for k, ok in results.items() if not ok),
        },
    }


def wiki_page(title, active, body_html):
    links = [
        ("/runbook/payments-outage", "Runbook", "runbook"),
        ("/postmortems/pm-47", "Postmortem #47", "pm47"),
        ("/rotations", "Rotations", "rotations"),
        ("/pto", "PTO Schedule", "pto"),
        ("/compliance/gdpr", "GDPR Policy", "gdpr"),
    ]
    nav = "".join(
        f'<a href="{href}" class="nav-link{" active" if key == active else ""}">{label}</a>'
        for href, label, key in links
    )
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{html.escape(title)} — Northwind Incident Wiki</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <header class="topbar">
    <div class="topbar-inner">
      <div class="brand">Northwind Incident Wiki</div>
      <nav class="nav">{nav}</nav>
      <div class="ext-links">
        <a href="http://127.0.0.1:{CATALOG_PORT}/">Service Catalog</a>
        <a href="http://127.0.0.1:{OPS_PORT}/">Live Ops Console</a>
      </div>
    </div>
  </header>
  <main class="container">
    {body_html}
  </main>
</body>
</html>"""


def catalog_page(title, active, body_html):
    links = [
        ("/", "All Services", "home"),
        ("/services/payments-core", "Payments Core", "payments"),
        ("/regions", "Regions", "regions"),
    ]
    nav = "".join(
        f'<a href="{href}" class="nav-link{" active" if key == active else ""}">{label}</a>'
        for href, label, key in links
    )
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{html.escape(title)} — Northwind Service Catalog</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <header class="topbar">
    <div class="topbar-inner">
      <div class="brand">Northwind Service Catalog</div>
      <nav class="nav">{nav}</nav>
      <div class="ext-links">
        <a href="http://127.0.0.1:{WIKI_PORT}/">Incident Wiki</a>
        <a href="http://127.0.0.1:{OPS_PORT}/">Live Ops Console</a>
      </div>
    </div>
  </header>
  <main class="container">
    {body_html}
  </main>
</body>
</html>"""


WIKI_PAGES = {
    "/": lambda: wiki_page(
        "Payments Core Outage Runbook",
        "runbook",
        """<article class="doc">
          <div class="doc-meta">Runbook · Last updated 2025-04-12 · Payments Engineering</div>
          <h1>Payments Core Outage Failover Runbook</h1>
          <p>Use this procedure when EU payment gateways report elevated 5xx rates or regional control-plane disruption.</p>
          <h2>Standard Failover Steps (Legacy Procedure)</h2>
          <ol>
            <li>Open the <a href="http://127.0.0.1:8953/">Live Ops Console</a> and select <strong>Payments Core</strong>.</li>
            <li>Fail over traffic to <code>us-east-1</code> for lowest global latency.</li>
            <li>Page primary on-call <strong>Devon Brooks</strong>.</li>
            <li>Enter escalation code <code>ESC-12-US</code> and dispatch.</li>
          </ol>
          <footer class="doc-footer">
            See related: <a href="/postmortems/pm-47">Postmortem #47 (EU Failover Policy)</a>
          </footer>
        </article>""",
    ),
    "/postmortems/pm-47": lambda: wiki_page(
        "Postmortem #47 — EU Failover Policy",
        "pm47",
        f"""<article class="doc">
          <div class="doc-meta">Postmortem #47 · Effective 2026-09-15 · Supersedes Payments Core Outage Runbook</div>
          <h1>Postmortem #47: Mandatory EU Payment Failover Policy</h1>
          <div class="callout warning">
            <strong>Policy update:</strong> This postmortem supersedes the 2025 Payments Core Outage Runbook. Do not follow the legacy US failover target, primary-paging step, or <code>ESC-12-US</code> code.
          </div>
          <h2>Mandatory Failover Rules</h2>
          <ol>
            <li><strong>Target Region:</strong> EU payment failover MUST target a region with <strong>p95 latency under 45 ms</strong>, <strong>GDPR EU residency</strong>, and status <strong>Available</strong>. Verify current latency and status in the <a href="http://127.0.0.1:{CATALOG_PORT}/regions">Service Catalog Regions table</a>, and confirm the required failover mode on the <a href="http://127.0.0.1:{CATALOG_PORT}/services/payments-core">Payments Core service entry</a>.</li>
            <li><strong>On-Call Escalation:</strong> Page the <strong>highest-priority available backup on-call</strong> (NOT the primary on-call) for <strong>Payments Core</strong> so the primary remains focused on mitigation. Check <a href="/rotations">On-Call Rotations</a> and cross-check <a href="/pto">PTO Schedule</a> for today (<code>2026-11-06</code>).</li>
            <li><strong>Escalation Code:</strong> Format is <code>ESC-47-&lt;suffix&gt;</code>, where <code>&lt;suffix&gt;</code> is the GDPR residency suffix defined on <a href="/compliance/gdpr">GDPR Compliance Policy</a>.</li>
            <li><strong>Confirmation:</strong> Dispatch in the <a href="http://127.0.0.1:{OPS_PORT}/">Live Ops Console</a> with <strong>Incident owner confirmed</strong> checked.</li>
          </ol>
        </article>""",
    ),
    "/rotations": lambda: wiki_page(
        "On-Call Rotations",
        "rotations",
        """<article class="doc">
          <div class="doc-meta">Operations · Q4 2026 Rotation Roster</div>
          <h1>On-Call Rotations</h1>
          <p>Backup escalation order proceeds from Secondary (Backup #1) to Tertiary (Backup #2). Always verify availability on the <a href="/pto">PTO Schedule</a> before paging.</p>
          <table class="data-table">
            <thead>
              <tr><th>Team</th><th>Primary</th><th>Secondary (Backup #1)</th><th>Tertiary (Backup #2)</th></tr>
            </thead>
            <tbody>
              <tr><td><strong>Payments Core</strong></td><td>Devon Brooks</td><td>Maya Patel</td><td>Tomas Lind</td></tr>
              <tr><td>Auth Platform</td><td>Priya Nair</td><td>Alex Morgan</td><td>Samir Rao</td></tr>
              <tr><td>Ledger &amp; Clearing</td><td>Hannah Osei</td><td>Devon Brooks</td><td>Elena Vance</td></tr>
              <tr><td>Edge Routing</td><td>Alex Morgan</td><td>Tomas Lind</td><td>Priya Nair</td></tr>
            </tbody>
          </table>
        </article>""",
    ),
    "/pto": lambda: wiki_page(
        "PTO Schedule",
        "pto",
        """<article class="doc">
          <div class="doc-meta">People Ops · Current Date: 2026-11-06</div>
          <h1>PTO &amp; Out-of-Office Schedule</h1>
          <p>Active date reference: <strong>2026-11-06</strong>. Engineers marked Out of Office during today's date must be skipped in backup escalation order.</p>
          <table class="data-table">
            <thead>
              <tr><th>Engineer</th><th>Team</th><th>Dates</th><th>Status on 2026-11-06</th></tr>
            </thead>
            <tbody>
              <tr><td><strong>Maya Patel</strong></td><td>Payments Core</td><td>2026-11-05 to 2026-11-12</td><td><span class="pill pill-red">Out of Office</span></td></tr>
              <tr><td>Priya Nair</td><td>Auth Platform</td><td>2026-11-18 to 2026-11-22</td><td><span class="pill pill-gray">Upcoming</span></td></tr>
              <tr><td>Devon Brooks</td><td>Payments Core</td><td>2026-11-25 to 2026-11-29</td><td><span class="pill pill-gray">Upcoming</span></td></tr>
              <tr><td>Tomas Lind</td><td>Payments Core</td><td>2026-10-12 to 2026-10-16</td><td><span class="pill pill-green">Available</span></td></tr>
              <tr><td>Alex Morgan</td><td>Edge Routing</td><td>2026-12-01 to 2026-12-05</td><td><span class="pill pill-gray">Upcoming</span></td></tr>
            </tbody>
          </table>
        </article>""",
    ),
    "/compliance/gdpr": lambda: wiki_page(
        "GDPR Compliance Policy",
        "gdpr",
        """<article class="doc">
          <div class="doc-meta">Legal &amp; Compliance · Data Residency Standard</div>
          <h1>GDPR EU Data Residency &amp; Escalation Suffixes</h1>
          <p>EU cardholder and settlement workloads must remain strictly within approved GDPR EU residency regions during failover events.</p>
          <h2>Approved GDPR EU Residency Regions</h2>
          <ul>
            <li><code>eu-central-1</code> — Frankfurt (EU GDPR)</li>
            <li><code>eu-west-3</code> — Paris (EU GDPR)</li>
          </ul>
          <p>Note: <code>uk-south-1</code> is UK (non-EU) and does not satisfy GDPR EU residency. Always verify live regional health and latency in the Service Catalog.</p>
          <h2>Failover Escalation Suffixes</h2>
          <table class="data-table">
            <thead>
              <tr><th>Jurisdiction</th><th>Escalation Suffix</th><th>Applies To</th></tr>
            </thead>
            <tbody>
              <tr><td><strong>GDPR EU Residency</strong></td><td><code>EU</code></td><td>EU payment failovers under Postmortem #47</td></tr>
              <tr><td>North America</td><td><code>US</code></td><td>US-only domestic incidents</td></tr>
              <tr><td>United Kingdom</td><td><code>UK</code></td><td>UK FCA workloads</td></tr>
              <tr><td>Asia-Pacific</td><td><code>AP</code></td><td>APAC settlement regions</td></tr>
            </tbody>
          </table>
        </article>""",
    ),
}
WIKI_PAGES["/runbook/payments-outage"] = WIKI_PAGES["/"]


def render_catalog_home():
    rows = "".join(
        f'<tr><td><a href="/services/payments-core">{s["name"]}</a></td><td><code>{s["id"]}</code></td><td>{s["tier"]}</td><td><code>{s["mode"]}</code></td></tr>'
        if s["id"] == "svc-pay-01"
        else f'<tr><td>{s["name"]}</td><td><code>{s["id"]}</code></td><td>{s["tier"]}</td><td><code>{s["mode"]}</code></td></tr>'
        for s in SERVICES
    )
    return catalog_page(
        "Services",
        "home",
        f"""<article class="doc">
          <h1>Production Service Directory</h1>
          <p>Select a service to inspect its failover topology and compliance tier, or check <a href="/regions">Regions</a> for live health and latency.</p>
          <table class="data-table">
            <thead>
              <tr><th>Service</th><th>Service ID</th><th>Tier</th><th>Required Failover Mode</th></tr>
            </thead>
            <tbody>{rows}</tbody>
          </table>
        </article>""",
    )


def render_payments_core():
    return catalog_page(
        "Payments Core",
        "payments",
        f"""<article class="doc">
          <div class="doc-meta">Tier 0 · Payments Core Engineering</div>
          <h1>Payments Core (<code>svc-pay-01</code>)</h1>
          <dl class="spec-grid">
            <dt>Service ID</dt><dd><code>svc-pay-01</code></dd>
            <dt>Required Failover Mode</dt><dd><code>active-passive</code></dd>
            <dt>Residency Policy</dt><dd>GDPR EU residency required for EU failovers (see <a href="http://127.0.0.1:{WIKI_PORT}/postmortems/pm-47">Postmortem #47</a>)</dd>
            <dt>Regions Status</dt><dd><a href="/regions">Inspect live region latency &amp; availability</a></dd>
          </dl>
          <div class="callout info">
            <strong>Do not confuse with legacy gateway:</strong> <code>svc-pay-legacy</code> (Payments Legacy Gateway) uses <code>active-active</code> for deprecated batch webhooks and is not the live Payments Core service.
          </div>
        </article>""",
    )


def render_regions():
    rows = "".join(
        f'<tr><td><code>{r["id"]}</code></td><td>{r["residency"]}</td><td>{r["p95_ms"]} ms</td>'
        f'<td><span class="pill {"pill-green" if r["status"] == "Available" else "pill-amber"}">{r["status"]}</span></td></tr>'
        for r in REGIONS
    )
    return catalog_page(
        "Regions",
        "regions",
        f"""<article class="doc">
          <div class="doc-meta">Live Telemetry · Updated 2026-11-06</div>
          <h1>Failover Regions</h1>
          <p>Current p95 latency, residency classification, and operational availability across Northwind regions.</p>
          <table class="data-table">
            <thead>
              <tr><th>Region</th><th>Residency</th><th>p95 Latency</th><th>Status</th></tr>
            </thead>
            <tbody>{rows}</tbody>
          </table>
        </article>""",
    )


class WikiHandler(Handler):
    def do_GET(self):
        path = self.path_only
        if path in WIKI_PAGES:
            return self.html(200, WIKI_PAGES[path]())
        return self.static()


class CatalogHandler(Handler):
    def do_GET(self):
        path = self.path_only
        if path == "/":
            return self.html(200, render_catalog_home())
        if path == "/services/payments-core":
            return self.html(200, render_payments_core())
        if path == "/regions":
            return self.html(200, render_regions())
        return self.static()


class OpsHandler(Handler):
    def do_GET(self):
        path = self.path_only
        if path == "/api/check":
            return self.send(200, check())
        if path == "/api/responders":
            q = self.query.get("q", "").strip().lower()
            hits = [
                r for r in RESPONDERS
                if not q or q in f"{r['name']} {r['team']} {r['role']} {r['id']}".lower()
            ]
            return self.send(200, {"responders": hits})
        if path in ("/", "/index.html"):
            return GUARD.render_page(self, (HERE / "fixture" / "ops" / "index.html").read_text())
        return self.static()

    def do_POST(self):
        path = self.path_only
        if path == "/api/reset":
            reset_state()
            return self.send(200, {"ok": True})
        if path != "/api/failover":
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
            return self.send(400, {"error": "Invalid JSON body"})
        service = str(body.get("service") or "").strip()
        region = str(body.get("region") or "").strip()
        mode = str(body.get("mode") or "").strip()
        responder_id = str(body.get("responder_id") or "").strip()
        responder_raw = str(body.get("responder") or "").strip()
        responder_obj = RESPONDER_BY_ID.get(responder_id)
        if not responder_obj and responder_raw:
            responder_obj = next((r for r in RESPONDERS if r["name"].lower() == responder_raw.lower()), None)
        responder = responder_obj["name"] if responder_obj else ""
        responder_id = responder_obj["id"] if responder_obj else ""
        escalation_code = str(body.get("escalation_code") or "").strip()
        owner_confirmed = body.get("owner_confirmed") is True

        with LOCK:
            STATE["submissions"] += 1
            if not STATE["rate_limit_hit"]:
                STATE["rate_limit_hit"] = True
                STATE["rate_limit_hits"] += 1
                return self.send(
                    429,
                    {
                        "error": "rate_limited",
                        "message": "Ops API rate limited (429). Wait a moment and retry.",
                    },
                )
            STATE["rate_limit_retries"] += 1
            if not owner_confirmed or not ESC_CODE_RE.fullmatch(escalation_code):
                STATE["reverts"] += 1
                return self.send(
                    200,
                    {
                        "accepted": False,
                        "reverted": True,
                        "reason": "Requires incident owner confirmation and valid escalation code",
                    },
                )
            if service not in SERVICE_IDS or region not in REGION_IDS or mode not in MODES or not responder:
                return self.send(400, {"error": "Missing or invalid failover parameter"})
            saved = {
                "service": service,
                "region": region,
                "mode": mode,
                "responder": responder,
                "responder_id": responder_id,
                "escalation_code": escalation_code,
                "owner_confirmed": owner_confirmed,
                "saved_at_ms": now_ms(),
            }
            STATE["dispatched"] = saved
        return self.send(200, {"accepted": True, "status": "Dispatched", "dispatch": saved})


reset_state()

if __name__ == "__main__":
    fixture = HERE / "fixture"
    serve_forever(
        [
            (WIKI_PORT, WikiHandler, fixture / "wiki"),
            (CATALOG_PORT, CatalogHandler, fixture / "catalog"),
            (OPS_PORT, OpsHandler, fixture / "ops"),
        ],
        f"dispatch wiki http://127.0.0.1:{WIKI_PORT}/ catalog http://127.0.0.1:{CATALOG_PORT}/ ops http://127.0.0.1:{OPS_PORT}/",
    )
