import copy
import datetime
import importlib.util
import json
import os
from pathlib import Path

BENCH_DIR = Path(__file__).resolve().parent.parent
REGISTRY = Path(os.environ.get("BENCH_REGISTRY", BENCH_DIR / "tasks.json"))
HOME = Path(os.environ.get("BENCH_HOME", Path.home() / "ardia-scratch/bench-proper"))
STATE_DIR = HOME / "state"


def load_task_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, BENCH_DIR / "tasks" / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


benchhttp = load_task_module("bench_task_http", "benchhttp.py")
livedates = load_task_module("bench_task_livedates", "livedates.py")


def load():
    return json.loads(REGISTRY.read_text())["tasks"]


def task_day(task):
    value = task.get("today")
    if not value:
        return None
    return livedates.today() if value == "live" else datetime.date.fromisoformat(value)


def resolved(task):
    out = {k: v for k, v in task.items() if k != "business_days"}
    day = task_day(task)
    if day is None:
        return out
    for key, count in task.get("business_days", {}).items():
        out["prompt"] = out["prompt"].replace("{" + key + "}", livedates.long_day(livedates.add_business_days(day, count)))
    out["today"] = day.isoformat()
    return out


def dated_prompt(task):
    out = resolved(task)
    if not out.get("today"):
        return out["prompt"]
    return f"{out['prompt']}\n\nToday is {livedates.long_date(task_day(out))}."


def write_resolved(path):
    raw = json.loads(REGISTRY.read_text())
    raw["tasks"] = [dict(resolved(t), prompt=dated_prompt(t)) for t in raw["tasks"]]
    Path(path).write_text(json.dumps(raw, indent=2) + "\n")
    return Path(path)


def task(task_id, port_offset=0):
    for t in load():
        if t["id"] == task_id:
            return at_offset({**t, "prompt": dated_prompt(t)}, port_offset)
    raise SystemExit(f"no task {task_id!r} in {REGISTRY}; known: {', '.join(t['id'] for t in load())}")


def at_offset(task, port_offset):
    out = copy.deepcopy(task)
    out["port_offset"] = port_offset
    if not port_offset:
        return out
    base_ports = task["server"]["ports"]

    def move(value):
        return benchhttp.rewrite_ports(value, base_ports, port_offset)

    out["server"]["ports"] = [p + port_offset for p in base_ports]
    out["start_url"] = move(task["start_url"])
    out["extra_urls"] = [move(u) for u in task.get("extra_urls", [])]
    out["prompt"] = move(task["prompt"])
    for key in ("reset", "check"):
        out[key]["url"] = move(task[key]["url"])
    return out


def task_ids(selection):
    ids = [t["id"] for t in load()]
    if selection in (None, "all", ["all"]):
        return ids
    if isinstance(selection, str):
        selection = [selection]
    missing = [s for s in selection if s not in ids]
    if missing:
        raise SystemExit(f"tasks not in {REGISTRY}: {', '.join(missing)}; known: {', '.join(ids)}")
    return list(selection)
