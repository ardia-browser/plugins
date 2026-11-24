import datetime
import statistics
from pathlib import Path

import registry
from procs import read_json, read_jsonl


def median(values):
    values = [v for v in values if isinstance(v, (int, float)) and not isinstance(v, bool)]
    return round(statistics.median(values), 3) if values else None


def tokens_total(rec):
    t = rec.get("tokens")
    return t.get("total") if isinstance(t, dict) else None


def counts(values):
    out = {}
    for v in values:
        out[v] = out.get(v, 0) + 1
    return out


def method_labels(runs):
    labels = [r["method"].get("label") for r in runs if isinstance(r.get("method"), dict)]
    return counts(str(label) for label in labels) if labels else None


def rejected_writes(runs):
    found = [r["method"].get("rejected") for r in runs if isinstance(r.get("method"), dict)]
    found = [n for n in found if isinstance(n, int) and not isinstance(n, bool)]
    return sum(found) if found else None


def invariant_failures(runs):
    checked = [r["invariants"] for r in runs if isinstance(r.get("invariants"), dict)]
    if not checked:
        return None
    return counts(name for inv in checked for name, ok in inv.items() if ok is False)


def cell(runs):
    passed = [r for r in runs if r.get("pass")]
    valid = [r for r in runs if not r.get("harness_error")]
    return {
        "runs": len(valid),
        "passes": len(passed),
        "pass_rate": round(len(passed) / len(valid), 3) if valid else None,
        "median_time_s": median(r.get("wall_s") for r in valid),
        "median_time_s_passing": median(r.get("wall_s") for r in passed),
        "median_time_to_correct_s": median(r.get("time_to_correct_s") for r in passed),
        "median_tokens": median(tokens_total(r) for r in valid),
        "median_commands": median(r.get("commands") for r in valid),
        "harness_errors": len(runs) - len(valid),
        "frontmost_during_run": [r.get("frontmost_during_run") for r in valid if "frontmost_during_run" in r] or None,
        "screenshot_timeouts": [r.get("screenshot_timeouts") for r in valid if "screenshot_timeouts" in r] or None,
        "method_labels": method_labels(valid),
        "rejected_writes": rejected_writes(valid),
        "invariant_failures": invariant_failures(valid),
        "run_ids": [r["run_id"] for r in runs],
    }


def brief(runs):
    passed = [r for r in runs if r.get("pass")]
    return {"runs": len(runs), "pass_rate": round(len(passed) / len(runs), 3) if runs else None,
            "median_time_s": median(r.get("wall_s") for r in runs),
            "median_time_to_correct_s": median(r.get("time_to_correct_s") for r in passed),
            "median_tokens": median(tokens_total(r) for r in runs),
            "median_lanes_active": median(r.get("lanes_active") or 1 for r in runs)}


def serial_vs_parallel(runs):
    valid = [r for r in runs if not r.get("harness_error")]
    serial = [r for r in valid if (r.get("lanes_active") or 1) <= 1]
    parallel = [r for r in valid if (r.get("lanes_active") or 1) > 1]
    return {"serial": brief(serial), "parallel": brief(parallel)} if serial and parallel else None


def parallel_block(results_dirs, runs):
    samples = [s for d in results_dirs for s in read_jsonl(Path(d) / "memory.jsonl")]
    sessions = {}
    for s in samples:
        sessions.setdefault(s.get("session"), []).append(s)
    busy = [s["active"] for s in samples if s.get("active")]
    lanes = [r.get("lanes_active") for r in runs if r.get("lanes_active")]
    return {
        "peak_memory_used_pct": max((s["used_pct"] for s in samples), default=None),
        "median_memory_used_pct": median(s["used_pct"] for s in samples),
        "avg_lanes": round(sum(busy) / len(busy), 2) if busy else None,
        "max_lanes": max(busy, default=None),
        "avg_lanes_active_at_start": round(sum(lanes) / len(lanes), 2) if lanes else None,
        "total_wall_s": round(sum(max(x["t"] for x in v) - min(x["t"] for x in v) for v in sessions.values()), 1)
        if sessions else None,
        "sessions": len(sessions),
        "samples": len(samples),
    }


def as_dirs(results_dirs):
    if isinstance(results_dirs, (str, Path)):
        results_dirs = [results_dirs]
    return [Path(d).expanduser() for d in results_dirs]


def better_run(a, b):
    if bool(a.get("harness_error")) != bool(b.get("harness_error")):
        return b if a.get("harness_error") else a
    return max(a, b, key=lambda r: r.get("run_ended_epoch") or 0)


def merged_runs(dirs):
    runs = {}
    for d in dirs:
        for path in sorted((d / "runs").glob("*.json")):
            r = read_json(path)
            if r and r.get("run_id") and r.get("task") and r.get("contender"):
                runs[r["run_id"]] = better_run(runs[r["run_id"]], r) if r["run_id"] in runs else r
    return sorted(runs.values(), key=lambda r: r["run_id"])


def planned_tasks(plan, known):
    selection = plan.get("tasks", "all")
    if selection in ("all", ["all"], None):
        return list(known)
    return [selection] if isinstance(selection, str) else list(selection)


def build(results_dirs):
    dirs = as_dirs(results_dirs)
    plans = [p for p in (read_json(d / "plan.json", {}) for d in dirs) if p]
    runs = merged_runs(dirs)
    task_meta = {t["id"]: t for t in registry.load()}
    plan_contenders = []
    for c in (c for p in plans for c in p.get("contenders") or []):
        if all(c["id"] != x["id"] for x in plan_contenders):
            plan_contenders.append(c)
    contender_ids = list(dict.fromkeys([c["id"] for c in plan_contenders] + sorted({r["contender"] for r in runs})))
    task_ids = list(dict.fromkeys([t for p in plans for t in planned_tasks(p, task_meta)] +
                                  [t for t in task_meta if any(r["task"] == t for r in runs)] +
                                  sorted({r["task"] for r in runs})))
    task_ids = [t for t in task_ids if t in task_meta or any(r["task"] == t for r in runs)]
    known_contenders = {c["id"] for c in plan_contenders}
    plan_contenders += [{"id": c} for c in contender_ids if c not in known_contenders]
    by = {}
    for r in runs:
        by.setdefault((r["task"], r["contender"]), []).append(r)
    cells = [dict(task=t, contender=c, **cell(by[(t, c)]), serial_vs_parallel=serial_vs_parallel(by[(t, c)]))
             for t in task_ids for c in contender_ids if (t, c) in by]
    overall = []
    for c in contender_ids:
        mine = [r for r in runs if r["contender"] == c]
        if not mine:
            continue
        per_task = [x for x in cells if x["contender"] == c]
        overall.append(dict(contender=c, tasks=len(per_task),
                            tasks_all_passed=sum(1 for x in per_task if x["runs"] and x["passes"] == x["runs"]),
                            hosts=sorted({r["host"] for r in mine if r.get("host")}),
                            **{k: v for k, v in cell(mine).items() if k != "run_ids"}))
    plan = plans[0] if len(plans) == 1 else {"name": " + ".join(dict.fromkeys(str(p.get("name")) for p in plans)) or None,
                                             "repeats": max((p.get("repeats") or 0 for p in plans), default=None)}
    return {
        "schema": 1,
        "generated_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        "plan": plan.get("name"),
        "repeats": plan.get("repeats"),
        "tasks": [{"id": t, "title": task_meta.get(t, {}).get("title", t),
                   "deadline_s": task_meta.get(t, {}).get("deadline_s")} for t in task_ids],
        "sources": [str(d) for d in dirs],
        "contenders": [{"id": c.get("id"), "label": c.get("label", c.get("id")), "side": c.get("kind"),
                        "agent": c.get("agent"), "model": c.get("model"), "effort": c.get("effort"),
                        "browser": c.get("browser")} for c in plan_contenders],
        "cells": cells,
        "overall": overall,
        "parallel": parallel_block(dirs, runs),
        "metrics": {
            "pass_rate": "passing runs / runs (harness errors excluded)",
            "median_time_s": "median wall time of the agent, all runs",
            "median_time_to_correct_s": "median seconds from agent start to the checker's completed_at_ms, passing runs",
            "median_tokens": "median total tokens (input incl. cached + output)",
            "method_labels": "runs per write method the checker saw (ui, ui_scripted, no_event, public_api, mixed, none); null when no run's check reports it",
            "rejected_writes": "writes the task server rejected (bad session, CSRF, nonce or signature), summed over runs",
            "invariant_failures": "runs per invariant that came back false; {} when every reported invariant held",
            "median_commands": "median shell commands (Ardia side), browse MCP calls plus shell commands (OpenCode side), or agent steps (Aside)",
        },
    }
