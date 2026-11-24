#!/usr/bin/env python3
import copy
import csv
from html import escape
from html.parser import HTMLParser
import io
import json
import re
import sys
import threading
from pathlib import Path

ALLOWED_BRIEF_TAGS = frozenset(("p", "div", "br", "strong", "b", "em", "i", "u", "h2", "h3", "ul", "ol", "li", "span"))
VOID_BRIEF_TAGS = frozenset(("br",))
DROP_CONTENT_TAGS = frozenset(("script", "style", "iframe", "object", "embed", "svg", "math"))
BLOCK_BRIEF_TAGS = frozenset(("p", "div", "br", "h2", "h3", "li"))


class BriefSanitizer(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.html_parts = []
        self.text_parts = []
        self.open_tags = []
        self.drop_depth = 0

    def handle_starttag(self, tag, attrs):
        t = tag.lower()
        if t in DROP_CONTENT_TAGS:
            self.drop_depth += 1
            return
        if self.drop_depth:
            return
        if t in ALLOWED_BRIEF_TAGS:
            self.html_parts.append(f"<{t}>")
            if t not in VOID_BRIEF_TAGS:
                self.open_tags.append(t)
            if t in BLOCK_BRIEF_TAGS:
                self.text_parts.append("\n")

    def handle_endtag(self, tag):
        t = tag.lower()
        if t in DROP_CONTENT_TAGS:
            self.drop_depth = max(0, self.drop_depth - 1)
            return
        if self.drop_depth:
            return
        if t in ALLOWED_BRIEF_TAGS and t not in VOID_BRIEF_TAGS and t in self.open_tags:
            while self.open_tags:
                top = self.open_tags.pop()
                self.html_parts.append(f"</{top}>")
                if top == t:
                    break
            if t in BLOCK_BRIEF_TAGS:
                self.text_parts.append("\n")

    def handle_data(self, data):
        if self.drop_depth:
            return
        self.html_parts.append(escape(data))
        self.text_parts.append(data)

    def finish(self):
        while self.open_tags:
            self.html_parts.append(f"</{self.open_tags.pop()}>")
        clean_html = "".join(self.html_parts).strip()
        clean_text = re.sub(r"\n{2,}", "\n", "".join(self.text_parts)).strip()
        return clean_html, clean_text


def sanitize_brief(raw_html, raw_text):
    if raw_html and raw_html.strip():
        parser = BriefSanitizer()
        parser.feed(raw_html)
        parser.close()
        return parser.finish()
    text = str(raw_text or "").strip()
    if not text:
        return "", ""
    return f"<p>{escape(text)}</p>", text

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from benchhttp import Handler, now_ms, serve_forever
from realism import Guard

PORT = 8911
HERE = Path(__file__).resolve().parent
GUARD = Guard("workspace")

COLUMNS = (
    {"id": "todo", "label": "To Do"},
    {"id": "in_review", "label": "In Review"},
    {"id": "done", "label": "Done"},
)
COLUMN_ALIASES = {
    "todo": "todo",
    "to do": "todo",
    "in_review": "in_review",
    "in review": "in_review",
    "done": "done",
}
INITIAL_CARDS = [
    {"id": "card-1", "title": "Migrate billing webhook", "owner": "Elena Park", "tag": "Backend", "column": "todo"},
    {"id": "card-2", "title": "Draft pricing FAQ", "owner": "Marcus Lin", "tag": "Docs", "column": "todo"},
    {"id": "card-3", "title": "Rotate API signing key", "owner": "Priya Nair", "tag": "Security", "column": "in_review"},
    {"id": "card-4", "title": "Audit webhook retry backoff", "owner": "Devon Brooks", "tag": "Reliability", "column": "in_review"},
    {"id": "card-5", "title": "Provision staging cluster", "owner": "Sora Takahashi", "tag": "Infra", "column": "done"},
    {"id": "card-6", "title": "Finalize launch checklist", "owner": "Elena Park", "tag": "Ops", "column": "done"},
]

GRID_ITEMS = (
    {"key": "q4_cloud", "label": "Q4 Cloud", "category": "Infrastructure", "initial": 11000},
    {"key": "security_audit", "label": "Security Audit", "category": "Compliance", "initial": 8500},
    {"key": "cdn_bandwidth", "label": "CDN & Edge Bandwidth", "category": "Infrastructure", "initial": 4200},
    {"key": "observability", "label": "Observability Suite", "category": "Reliability", "initial": 3800},
    {"key": "load_testing", "label": "Load Testing & QA", "category": "Engineering", "initial": 2500},
)
INITIAL_GRID = {item["key"]: item["initial"] for item in GRID_ITEMS} | {"contingency_pct": 10}
EDITABLE_CELLS = frozenset(INITIAL_GRID.keys())

BRIEF_STATUSES = ("Draft", "In Review", "Ready for sign-off")
INITIAL_BRIEF = {
    "status": "Draft",
    "content_html": (
        "<h3>Harbor v4.2 Launch Brief</h3>"
        "<p>Target launch date: TBD</p>"
        "<p>Approved launch budget: $33,000 (pending Q4 cloud revision and contingency review).</p>"
        "<ul><li>Webhook migration in progress</li><li>Compliance checklist pending SOC2 sign-off</li></ul>"
    ),
    "content_text": (
        "Harbor v4.2 Launch Brief\n"
        "Target launch date: TBD\n"
        "Approved launch budget: $33,000 (pending Q4 cloud revision and contingency review).\n"
        "Webhook migration in progress\n"
        "Compliance checklist pending SOC2 sign-off"
    ),
}

INITIAL_CHECKLIST_CSV = (
    "item,owner,status\n"
    "DPA-Signed,Legal,Complete\n"
    "PenTest-Report,Security,Complete\n"
    "SOC2-Audit,Compliance,Pending\n"
    "Runbook-Review,SRE,Complete\n"
)
EXPECTED_CHECKLIST_ROWS = [
    ("DPA-Signed", "Legal", "Complete"),
    ("PenTest-Report", "Security", "Complete"),
    ("SOC2-Audit", "Compliance", "Complete"),
    ("Runbook-Review", "SRE", "Complete"),
]

EXPECTED_Q4_CLOUD = 14500
EXPECTED_CONTINGENCY = 12
EXPECTED_SUBTOTAL = 33500
EXPECTED_TOTAL_BUDGET = 37520
EXPECTED_LAUNCH_DATE = "2026-12-15"
BUDGET_PATTERN = re.compile(r"(?<!\d)\$?\s*37,?520(?:\.00)?(?!\d)")
DATE_PATTERN = re.compile(r"(?<!\d)2026-12-15(?!\d)")

LOCK = threading.Lock()
STATE = {}


def compute_grid_totals(grid):
    subtotal = sum(grid[item["key"]] for item in GRID_ITEMS)
    pct = grid["contingency_pct"]
    total_budget = int(round(subtotal * (1 + pct / 100.0)))
    return subtotal, total_budget


def parse_csv_rows(content):
    cleaned = str(content or "").lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    lines = [line for line in cleaned.split("\n") if line.strip()]
    if not lines:
        return None, []
    reader = csv.reader(io.StringIO("\n".join(lines)))
    rows = [[cell.strip() for cell in row] for row in reader if any(cell.strip() for cell in row)]
    if not rows:
        return None, []
    header = [h.lower() for h in rows[0]]
    data = [tuple(r) for r in rows[1:]]
    return header, data


def reset():
    with LOCK:
        STATE.update(
            cards=copy.deepcopy(INITIAL_CARDS),
            grid=dict(INITIAL_GRID),
            brief=dict(INITIAL_BRIEF),
            file_content=INITIAL_CHECKLIST_CSV,
            uploaded=None,
            writes=0,
            passing_since=None,
            reset_at_ms=now_ms(),
        )
    GUARD.reset()


def strip_html(html):
    text = re.sub(r"<(br|p|div|li|h[1-6])\b[^>]*>", "\n", str(html or ""), flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    return text.strip()


def parse_number(raw):
    if raw is None or isinstance(raw, bool):
        return None
    if isinstance(raw, (int, float)):
        val = float(raw)
    else:
        s = str(raw).strip().replace("$", "").replace(",", "").replace("%", "").strip()
        if not re.fullmatch(r"\d+(?:\.\d+)?", s):
            return None
        val = float(s)
    if val < 0:
        return None
    return int(round(val))


def grade_locked():
    cards_by_id = {c["id"]: c["column"] for c in STATE["cards"]}
    initial_by_id = {c["id"]: c["column"] for c in INITIAL_CARDS}
    grid = STATE["grid"]
    subtotal, total_budget = compute_grid_totals(grid)
    brief = STATE["brief"]
    brief_text = brief["content_text"] or strip_html(brief["content_html"])
    uploaded = STATE["uploaded"]

    csv_ok = False
    uploaded_rows = []
    if uploaded is not None:
        header, parsed_rows = parse_csv_rows(uploaded["content"])
        uploaded_rows = parsed_rows
        if header == ["item", "owner", "status"] and len(parsed_rows) == len(EXPECTED_CHECKLIST_ROWS):
            csv_ok = set(parsed_rows) == set(EXPECTED_CHECKLIST_ROWS)

    items = {
        "move_webhook": cards_by_id["card-1"] == "in_review",
        "move_signing_key": cards_by_id["card-3"] == "done",
        "budget_q4_cloud": grid["q4_cloud"] == EXPECTED_Q4_CLOUD,
        "budget_contingency": grid["contingency_pct"] == EXPECTED_CONTINGENCY,
        "release_brief": (
            brief["status"] == "Ready for sign-off"
            and bool(BUDGET_PATTERN.search(brief_text))
            and bool(DATE_PATTERN.search(brief_text))
        ),
        "vendor_checklist": csv_ok,
    }
    invariants = {
        "no_other_cards_moved": all(
            cards_by_id[cid] == initial_by_id[cid]
            for cid in ("card-2", "card-4", "card-5", "card-6")
        ),
        "no_other_grid_cells_changed": all(
            grid[item["key"]] == item["initial"]
            for item in GRID_ITEMS
            if item["key"] != "q4_cloud"
        ),
    }
    matched = sum(items.values())
    passed = matched == len(items) and all(invariants.values())
    col_counts = {c["id"]: sum(1 for card in STATE["cards"] if card["column"] == c["id"]) for c in COLUMNS}
    return {
        "pass": passed,
        "matched": matched,
        "total": len(items),
        "invariants": invariants,
        "details": {
            "items_ok": items,
            "invariants": invariants,
            "kanban_counts": col_counts,
            "grid_totals": {"subtotal": subtotal, "total_budget": total_budget},
            "brief_status": brief["status"],
            "uploaded_filename": uploaded["filename"] if uploaded else None,
            "uploaded_row_count": len(uploaded_rows),
            "writes": STATE["writes"],
        },
    }


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


def workspace_snapshot_locked():
    subtotal, total_budget = compute_grid_totals(STATE["grid"])
    header, rows = parse_csv_rows(STATE["file_content"])
    return {
        "columns": list(COLUMNS),
        "cards": copy.deepcopy(STATE["cards"]),
        "grid_items": [
            {
                "key": item["key"],
                "label": item["label"],
                "category": item["category"],
                "value": STATE["grid"][item["key"]],
            }
            for item in GRID_ITEMS
        ],
        "contingency_pct": STATE["grid"]["contingency_pct"],
        "subtotal": subtotal,
        "total_budget": total_budget,
        "brief": dict(STATE["brief"]),
        "brief_statuses": list(BRIEF_STATUSES),
        "file": {
            "filename": STATE["uploaded"]["filename"] if STATE["uploaded"] else "vendor-checklist.csv",
            "uploaded": STATE["uploaded"] is not None,
            "header": header or ["item", "owner", "status"],
            "rows": [list(r) for r in rows],
        },
    }


class WorkspaceHandler(Handler):
    def do_GET(self):
        path = self.path_only
        if path == "/api/check":
            return self.send(200, check())
        if path == "/api/state":
            with LOCK:
                return self.send(200, workspace_snapshot_locked())
        if path == "/api/files/vendor-checklist.csv":
            with LOCK:
                data = STATE["file_content"].encode("utf-8")
            return self.send(
                200,
                data,
                "text/csv; charset=utf-8",
                headers={"Content-Disposition": 'attachment; filename="vendor-checklist.csv"'},
            )
        if path in ("/", "/index.html"):
            return GUARD.render_page(self, (HERE / "fixture" / "index.html").read_text())
        return self.static()

    def do_POST(self):
        path = self.path_only
        if path == "/api/reset":
            reset()
            return self.send(200, {"ok": True})
        if path not in ("/api/cards/move", "/api/grid/cell", "/api/brief", "/api/files/upload"):
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
            return self.send(400, {"error": "expected JSON object"})

        with LOCK:
            if path == "/api/cards/move":
                card_id = str(body.get("card_id") or "").strip()
                col_raw = str(body.get("column") or "").strip().lower()
                column = COLUMN_ALIASES.get(col_raw)
                card = next((c for c in STATE["cards"] if c["id"] == card_id), None)
                if not card or not column:
                    return self.send(400, {"error": "invalid card or column"})
                card["column"] = column
                changed_locked()
                return self.send(200, {"ok": True, "state": workspace_snapshot_locked()})

            if path == "/api/grid/cell":
                cell = str(body.get("cell") or "").strip()
                val = parse_number(body.get("value"))
                if cell not in EDITABLE_CELLS or val is None:
                    return self.send(400, {"error": "invalid grid cell or value"})
                if cell == "contingency_pct" and val > 100:
                    return self.send(400, {"error": "contingency percentage out of range"})
                STATE["grid"][cell] = val
                changed_locked()
                return self.send(200, {"ok": True, "state": workspace_snapshot_locked()})

            if path == "/api/brief":
                status = str(body.get("status") or "").strip()
                if status not in BRIEF_STATUSES:
                    return self.send(400, {"error": "invalid brief status"})
                raw_html = str(body.get("content_html") or "")
                raw_text = str(body.get("content_text") or "")
                clean_html, clean_text = sanitize_brief(raw_html, raw_text)
                if not clean_text:
                    return self.send(400, {"error": "brief content cannot be empty"})
                STATE["brief"] = {
                    "status": status,
                    "content_html": clean_html,
                    "content_text": clean_text,
                }
                changed_locked()
                return self.send(200, {"ok": True, "state": workspace_snapshot_locked()})

            if path == "/api/files/upload":
                filename = str(body.get("filename") or "").strip()
                content = str(body.get("content") or "")
                if not filename or not content.strip():
                    return self.send(400, {"error": "filename and CSV content are required"})
                header, rows = parse_csv_rows(content)
                if not header:
                    return self.send(400, {"error": "invalid CSV content"})
                STATE["file_content"] = content
                STATE["uploaded"] = {
                    "filename": filename,
                    "content": content,
                    "uploaded_at_ms": now_ms(),
                }
                changed_locked()
                return self.send(200, {"ok": True, "state": workspace_snapshot_locked()})


reset()

if __name__ == "__main__":
    serve_forever(
        [(PORT, WorkspaceHandler, HERE / "fixture")],
        f"Harbor Workspace on http://127.0.0.1:{PORT}/ (reset POST /api/reset, check GET /api/check)",
    )
