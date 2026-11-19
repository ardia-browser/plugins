import json

from ardia_cli import command_metrics, redact
from ardia_cli.browse import changes, snapshot

SNAPSHOT_FLAGS = ("names_clipped", "snapshot_repeat_labels", "snapshot_disabled_folded", "change_run_choices")


def register(oracle, secrets_set):
    def dump(nodes):
        return [{"role": node.role, "name": node.name, "value": node.value, "props": node.props, "backend": node.backend, "ref": node.ref,
                 "hints": node.hints, "url": node.url, "children": dump(node.children)} for node in nodes]

    def flagged(run):
        metrics = command_metrics.Metrics("snapshot", False, False)
        token = command_metrics.current.set(metrics)
        try:
            out = run()
        finally:
            command_metrics.current.reset(token)
        return out, [name for name in SNAPSHOT_FLAGS if metrics.values.get(name) is True]

    def ax_of(source):
        if isinstance(source, dict):
            with open(source["file"]) as handle:
                return json.load(handle)["result"]["nodes"]
        return json.loads(source)

    def nodes_of(ax_text, scope, hints, urls):
        nodes = snapshot.build_tree(ax_of(ax_text), scope)
        for node in snapshot.walk(nodes):
            key = str(node.backend)
            if key in hints and node.role not in snapshot.INTERACTIVE:
                node.hints = hints[key]
            if node.role == "link" and key in urls:
                node.url = urls[key]
        for node in snapshot.walk(nodes):
            if node.role in snapshot.REF_ROLES or node.hints:
                if node.role == "heading" and not node.name or node.backend is None:
                    continue
                node.ref = f"e{node.backend}"
        return nodes

    @oracle("snapshot.take")
    def snapshot_take(ax_text, scope, hints, urls, options, secrets):
        secrets_set(secrets)
        nodes = nodes_of(ax_text, scope, hints, urls)
        renders = [flagged(lambda: snapshot.render(nodes, *option)) for option in options]
        contexts = [[node.ref, [list(pair) for pair in context]] for node, context in snapshot.walk_in_context(nodes) if node.ref]
        return {"tree": dump(nodes), "renders": renders, "entries": changes.entries_of(nodes), "contexts": contexts}

    def view_of(ax_text, loader, url, title, hints):
        nodes = nodes_of(ax_text, None, hints, {})
        return nodes, changes.View("t", loader, url, title, changes.entries_of(nodes), changes.containers_of(nodes))

    @oracle("changes.report")
    def changes_report(before, after, writes, extra, before_known, secrets):
        secrets_set(secrets)
        old = view_of(*before)[1] if before is not None else None
        nodes, now = view_of(*after)
        report = changes.diff(old, now, writes)
        report["back"] = [row["ref"] for row in report["added"] if row["ref"] in extra.get("back", [])]
        for name in ("text", "notes", "unsettled", "error"):
            if name in extra:
                report[name] = extra[name]
        text, flags = flagged(lambda: changes.render(report, before_known))
        fresh = changes.fresh_rows(report)
        lines = (report.get("text") or {}).get("lines") or []
        return {"text": text, "flags": flags, "data": changes.as_data(report), "fresh": [row["ref"] for row in fresh],
                "anchors": [[node.role, node.ref, node.backend] for node in changes.opened_anchors(report, nodes, old)],
                "adds_text": changes.adds_text(lines, fresh), "moved": changes.moved(report)}

    @oracle("changes.clean_url")
    def clean_url(url, secrets):
        secrets_set(secrets)
        return changes.clean_url(url)

    @oracle("changes.masked_url")
    def masked_url(url, secrets):
        secrets_set(secrets)
        return changes.masked_url(url)

    oracle("changes.refs_text")(changes.refs_text)
    oracle("changes.within")(changes.within)
    oracle("changes.run_label")(lambda text, secrets: (secrets_set(secrets), changes.run_label(text))[1])
    return redact
