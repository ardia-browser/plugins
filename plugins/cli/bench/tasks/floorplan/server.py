#!/usr/bin/env python3
import json
import re
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from benchhttp import Handler, now_ms, serve_forever
from realism import Guard

FLOORPLAN_PORT = 8931
HERE = Path(__file__).resolve().parent
SLOTS = (
    {"id": "09:00-11:00", "utilization": 78},
    {"id": "11:00-13:00", "utilization": 92},
    {"id": "13:00-15:00", "utilization": 34},
    {"id": "15:00-17:00", "utilization": 65},
)
VALID_SLOTS = frozenset(s["id"] for s in SLOTS)
DESKS = {
    "C1": {"zone": "collaborative", "window": True, "power": True, "rect": (29, 80, 74, 88)},
    "C2": {"zone": "collaborative", "window": True, "power": False, "rect": (117, 80, 74, 88)},
    "C3": {"zone": "collaborative", "window": True, "power": True, "rect": (205, 80, 74, 88)},
    "C4": {"zone": "collaborative", "window": True, "power": False, "rect": (293, 80, 74, 88)},
    "C5": {"zone": "collaborative", "window": False, "power": True, "rect": (70, 244, 110, 88)},
    "C6": {"zone": "collaborative", "window": False, "power": False, "rect": (216, 244, 110, 88)},
    "Q1": {"zone": "quiet", "window": True, "power": True, "rect": (393, 80, 74, 88)},
    "Q2": {"zone": "quiet", "window": True, "power": False, "rect": (481, 80, 74, 88)},
    "Q3": {"zone": "quiet", "window": True, "power": True, "rect": (569, 80, 74, 88)},
    "Q4": {"zone": "quiet", "window": True, "power": True, "rect": (657, 80, 74, 88)},
    "Q5": {"zone": "quiet", "window": False, "power": True, "rect": (434, 244, 110, 88)},
    "Q6": {"zone": "quiet", "window": False, "power": False, "rect": (580, 244, 110, 88)},
}
OCCUPIED = {
    "09:00-11:00": frozenset(("C2", "C3", "C4", "C6", "Q1", "Q3", "Q4", "Q5", "Q6")),
    "11:00-13:00": frozenset(("C1", "C2", "C3", "C5", "C6", "Q1", "Q2", "Q3", "Q4", "Q5", "Q6")),
    "13:00-15:00": frozenset(("C3", "C6", "Q1", "Q3")),
    "15:00-17:00": frozenset(("C1", "C3", "C4", "C6", "Q1", "Q3", "Q4", "Q5")),
}
LOCK = threading.Lock()
STATE = {}
GUARD = Guard("floorplan")


def reset():
    with LOCK:
        STATE.update(reservations=[], writes=0, passing_since=None, reset_at_ms=now_ms())
    GUARD.reset()


def clean(value, limit=200):
    return re.sub(r"\s+", " ", str(value if value is not None else "")).strip()[:limit]


def parse_coord(raw):
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return None
    if raw != raw:
        return None
    return float(raw)


def in_desk_rect(desk_id, x, y):
    spec = DESKS.get(desk_id)
    if not spec or x is None or y is None:
        return False
    rx, ry, rw, rh = spec["rect"]
    return rx <= x <= rx + rw and ry <= y <= ry + rh


def items_for(res):
    keys = ("slot", "desk", "name", "canvas_coords")
    if not res:
        return dict.fromkeys(keys, False)
    return {
        "slot": res["slot"] == "13:00-15:00",
        "desk": res["desk"] == "Q4",
        "name": res["name"].lower() == "jordan lee",
        "canvas_coords": in_desk_rect("Q4", res["click_x"], res["click_y"]),
    }


def grade_locked():
    res = STATE["reservations"][-1] if STATE["reservations"] else None
    items = items_for(res)
    matched = sum(items.values())
    coords_valid = res is None or in_desk_rect(res["desk"], res["click_x"], res["click_y"])
    invariants = {"coords_inside_desk": coords_valid}
    latest = None
    if res:
        latest = {
            "id": res["id"],
            "slot": res["slot"],
            "desk": res["desk"],
            "name": res["name"],
            "notes": res["notes"],
            "click_x": res["click_x"],
            "click_y": res["click_y"],
        }
    return {
        "pass": matched == len(items) and all(invariants.values()),
        "matched": matched,
        "total": len(items),
        "invariants": invariants,
        "details": {
            "items_ok": items,
            "reservations_submitted": len(STATE["reservations"]),
            "latest_reservation": latest,
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


def validate_reservation(body, existing):
    slot = clean(body.get("slot"), 40)
    desk = clean(body.get("desk"), 16).upper()
    name = clean(body.get("name"), 120)
    notes = clean(body.get("notes"), 500)
    click_x = parse_coord(body.get("click_x"))
    click_y = parse_coord(body.get("click_y"))
    errors = {}
    if slot not in VALID_SLOTS:
        errors["slot"] = "Select a valid time slot"
    if desk not in DESKS:
        errors["desk"] = "Select a valid desk on the floorplan"
    if not name or len(name) < 2:
        errors["name"] = "Enter the guest name"
    if not errors.get("slot") and not errors.get("desk"):
        if desk in OCCUPIED[slot]:
            errors["desk"] = f"Desk {desk} is occupied during {slot}"
        elif any(r["slot"] == slot and r["desk"] == desk for r in existing):
            errors["desk"] = f"Desk {desk} is already reserved during {slot}"
        elif not in_desk_rect(desk, click_x, click_y):
            errors["desk"] = "Canvas click coordinates must fall inside the selected desk"
    parsed = {
        "slot": slot,
        "desk": desk,
        "name": name,
        "notes": notes,
        "click_x": click_x,
        "click_y": click_y,
    }
    return parsed, errors


class FloorplanHandler(Handler):
    def do_GET(self):
        path = self.path_only
        if path == "/api/check":
            return self.send(200, check())
        if path == "/api/reservations":
            with LOCK:
                return self.send(200, list(STATE["reservations"]))
        if path in ("/", "/book"):
            return GUARD.render_page(self, (HERE / "fixture/index.html").read_text())
        return self.static()

    def do_POST(self):
        path = self.path_only
        if path == "/api/reset":
            reset()
            return self.send(200, {"ok": True})
        if path != "/api/reserve":
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
        with LOCK:
            parsed, errors = validate_reservation(body, STATE["reservations"])
            if errors:
                return self.send(422, {"error": "Could not complete reservation", "fields": errors})
            now = now_ms()
            res = dict(parsed, id=f"ATR-2026-{201 + len(STATE['reservations']):04d}", reserved_at_ms=now)
            STATE["reservations"].append(res)
            STATE["writes"] += 1
            passing = grade_locked()["pass"]
            STATE["passing_since"] = (STATE["passing_since"] or now) if passing else None
        return self.send(200, {"ok": True, "reservation": res})


reset()

if __name__ == "__main__":
    serve_forever(
        [(FLOORPLAN_PORT, FloorplanHandler, HERE / "fixture")],
        f"Atrium Desk Booking on http://127.0.0.1:{FLOORPLAN_PORT}/ "
        f"(reset POST /api/reset, check GET /api/check)",
    )
