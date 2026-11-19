import json
import os
from pathlib import Path

from tests.m3.cases import PIECES, generator, many, noise, secret_list

ROLES = ["button", "link", "textbox", "checkbox", "radio", "option", "menuitem", "treeitem", "tab", "switch", "heading", "StaticText", "generic",
         "GenericContainer", "group", "div", "presentation", "RootWebArea", "WebArea", "none", "InlineTextBox", "LineBreak", "ListMarker", "Date",
         "DateTime", "InputTime", "ColorWell", "DisclosureTriangle", "Iframe", "dialog", "region", "article", "cell", "img", "list", "listitem",
         "combobox", "listbox", "Ignored", "paragraph", "rowheader"]
NAMES = ["", " ", "Save", "Save", "Next", "Item", "  padded  ", "two\nlines", 'quote "x"', "back\\slash", "token=abc&x=1", "s3cr3t", "😀 emoji",
         "\ud800 lone", "ß", "x" * 120, "y" * 250, "word " * 30, "\u3000wide\u3000", "Delete", "a"]
PROPS = [("checked", [True, False, "mixed", "true", "false", 1, 0]), ("expanded", [True, False, "false", 0, "", [], {}]), ("selected", [True, False]),
         ("pressed", [True, False, "false", 0, "true", None, "mixed"]), ("disabled", [True, False, 1, ""]), ("required", [True, False]),
         ("level", [1, 2, 3, 6, "2", 2.5, None]), ("inputType", ["email", "", None]), ("focusable", [True])]
SPIKE_AX = Path(os.environ.get("ARDIA_M3_AX", "/Users/barreloflube/ardia-scratch/ts-port/m3-spikes/data/ax.raw.json"))


def ax_value(rng, kind, pool):
    value = rng.choice(pool)
    return {"type": kind, "value": value} if rng.random() < 0.95 else rng.choice([{}, None, {"type": kind}])


def ax_tree(rng, size: int, backends: int = 60) -> list:
    nodes = []
    for index in range(size):
        node = {"nodeId": str(index), "role": ax_value(rng, "role", ROLES)}
        if rng.random() < 0.9:
            node["name"] = ax_value(rng, "computedString", NAMES + [noise(rng, PIECES, 6)])
        if rng.random() < 0.3:
            node["value"] = ax_value(rng, "string", ["", "v", "Save", "line\nbreak", 5, 0.5, True, "x" * 230])
        if rng.random() < 0.85:
            node["backendDOMNodeId"] = rng.randint(1, backends)
        if rng.random() < 0.08:
            node["ignored"] = True
        if rng.random() < 0.6:
            node["properties"] = [{"name": name, "value": {"type": "x", "value": rng.choice(values)}} for name, values in rng.sample(PROPS, rng.randint(1, 3))]
        nodes.append(node)
    for index in range(1, size):
        parent = rng.randint(max(0, index - 6), index - 1) if rng.random() < 0.8 else rng.randint(0, index - 1)
        nodes[index]["parentId"] = str(parent) if rng.random() < 0.97 else "missing"
        nodes[parent].setdefault("childIds", []).append(str(index))
    for node in nodes:
        if "childIds" in node and rng.random() < 0.05:
            node["childIds"].append("dangling")
    rng.shuffle(nodes) if rng.random() < 0.2 else None
    return nodes


def option_sets(rng):
    fixed = [[False, False, None, False], [True, False, None, False], [False, True, None, False], [False, False, 2, False], [True, False, 1, True],
             [False, False, None, True]]
    return fixed + [[rng.random() < 0.5, rng.random() < 0.5, rng.choice([None, 0, 1, 3]), rng.random() < 0.5]]


def hints_for(rng, backends: int) -> dict:
    return {str(rng.randint(1, backends)): rng.sample(["click", "pointer", "onclick", "tabindex"], rng.randint(1, 2)) for _ in range(rng.randint(0, 5))}


def urls_for(rng, backends: int) -> dict:
    return {str(rng.randint(1, backends)): rng.choice(["https://a.example/x", "/rel", "javascript:void(0)"]) for _ in range(rng.randint(0, 6))}


def runs_tree(rng) -> list:
    nodes = [{"nodeId": "0", "role": {"value": "RootWebArea"}, "backendDOMNodeId": 1000}]
    count = rng.randint(5, 40)
    role = rng.choice(["option", "button", "link", "checkbox", "menuitem", "tab"])
    for index in range(1, count + 1):
        props = [{"name": "disabled", "value": {"value": rng.random() < 0.6}}]
        if rng.random() < 0.2:
            props.append({"name": "selected", "value": {"value": True}})
        nodes.append({"nodeId": str(index), "parentId": "0", "role": {"value": role if rng.random() < 0.9 else "button"},
                      "name": {"value": rng.choice(["Same", f"Item {index}", "", f"Row {index % 3}"])}, "backendDOMNodeId": index, "properties": props})
        nodes[0].setdefault("childIds", []).append(str(index))
    return nodes


@generator("snapshot.take")
def gen_snapshot(rng, count, corpus):
    def make():
        secrets = secret_list(rng) if rng.random() < 0.3 else []
        tree = runs_tree(rng) if rng.random() < 0.25 else ax_tree(rng, rng.randint(1, 80))
        scope = rng.choice([None, None, None, rng.randint(1, 60)])
        return [json.dumps(tree), scope, hints_for(rng, 60), urls_for(rng, 60), option_sets(rng), secrets]
    out = many(rng, count, [], make)
    if SPIKE_AX.exists() and count >= 1000:
        nodes = json.loads(SPIKE_AX.read_text())["result"]["nodes"]
        text = {"file": str(SPIKE_AX)}
        backends = [node["backendDOMNodeId"] for node in nodes if "backendDOMNodeId" in node]
        out.append([text, None, {}, {}, [[False, False, None, False], [True, False, None, True], [False, True, 4, False]], ["s3cr3t-token-value-0123456789abcdef"]])
        for backend in rng.sample(backends, 5):
            out.append([text, backend, {}, {}, [[False, False, None, False], [True, False, None, False]], []])
    return out


def view_args(rng, tree, loader):
    return [json.dumps(tree), loader, rng.choice(["https://a.example/p?q=1", "https://a.example/other", "about:blank", "https://user:pw@h.example:8080/x"]),
            rng.choice(["Title", "Other", "", "😀"]), hints_for(rng, 60)]


def mutate(rng, tree):
    out = json.loads(json.dumps(tree))
    for node in out:
        roll = rng.random()
        if roll < 0.1 and "name" in node and isinstance(node["name"], dict):
            node["name"]["value"] = rng.choice(NAMES)
        elif roll < 0.15 and "backendDOMNodeId" in node:
            node["backendDOMNodeId"] = rng.randint(1, 90)
        elif roll < 0.2:
            node["properties"] = [{"name": "disabled", "value": {"value": rng.random() < 0.5}}, {"name": "checked", "value": {"value": rng.choice([True, False, "mixed"])}}]
        elif roll < 0.23:
            node["value"] = {"value": rng.choice(["", "typed", "x"])}
    return out


WRITES = [{"method": "POST", "url": "https://a.example/api", "statuses": [200]}, {"method": "PUT", "url": "/x", "statuses": [301, 200]},
          {"method": "DELETE", "url": "/y", "failed": "net::ERR_FAILED"}, {"method": "POST", "url": "/z"}, {"method": "PATCH", "url": "/w", "statuses": []}]


@generator("changes.report")
def gen_report(rng, count, corpus):
    def make():
        tree = runs_tree(rng) if rng.random() < 0.3 else ax_tree(rng, rng.randint(1, 60), 90)
        after_tree = mutate(rng, tree) if rng.random() < 0.8 else ax_tree(rng, rng.randint(1, 60), 90)
        before = None if rng.random() < 0.15 else view_args(rng, tree, "L1")
        after = view_args(rng, after_tree, "L1" if rng.random() < 0.75 else "L2")
        extra = {}
        if rng.random() < 0.3:
            extra["back"] = [f"e{rng.randint(1, 90)}" for _ in range(rng.randint(1, 8))]
        if rng.random() < 0.3:
            extra["text"] = {"lines": [noise(rng, PIECES + ["word", "Save", " [@e5]"], 12) for _ in range(rng.randint(0, 6))], "more": rng.random() < 0.5,
                             "where": rng.choice([None, "", "#main", "div > p", "it's"]), "refs": [f"e{rng.randint(1, 90)}" for _ in range(3)]}
        if rng.random() < 0.1:
            extra["notes"] = "notes here"
        if rng.random() < 0.1:
            extra["unsettled"] = True
        if rng.random() < 0.1:
            extra["error"] = "boom"
        writes = [rng.choice(WRITES) for _ in range(rng.choice([0, 0, 1, 3, 25]))]
        return [before, after, writes, extra, rng.random() < 0.8, secret_list(rng) if rng.random() < 0.2 else []]
    return many(rng, count, [], make)


CHANGE_URLS = ["https://a.example/p?q=1&token=abc", "http://[::1]:8080/x", "http://[::1]:99999/", "http://h:abc/", "ws://h/sock?x", "wss://h/",
               "ftp://x", "", "about:blank", "javascript:alert(1)", "https://h/path/abcdefghijklmnopqrstuvwxyz0123/x", "https://h/a:b", "https://h/%3A",
               "https://h/#frag", "https://h/#a=b", "https://h/?code=1&state=x&ok=2&Session=3", "https://H.EXAMPLE/p", "http://[fe80::1%25EN0]/",
               "http://u:p@h/", "https://h/" + "x" * 250, "https://h/?ſession=1", "https://h/?\u212aey=1", "https://h/?a&&b=", "data:text/plain,hi",
               "https://h:0/", "https://h:/", "http://[::1/", "https://h/?%74oken=1", "https://h/١٢٣٤٥٦٧٨٩٠١٢٣٤٥٦٧٨٩٠abc"]


@generator("changes.clean_url")
def gen_clean(rng, count, corpus):
    return many(rng, count, [], lambda: [rng.choice(CHANGE_URLS) if rng.random() < 0.6 else noise(rng, PIECES + ["http://", "?", "=", "&", "[::1]"], 10),
                                         rng.choice([[], ["abc"]])])


@generator("changes.masked_url")
def gen_masked(rng, count, corpus):
    return gen_clean(rng, count, corpus)


@generator("changes.refs_text")
def gen_refs(rng, count, corpus):
    def make():
        start = rng.randint(1, 50)
        refs = [f"e{start + index}" for index in range(rng.randint(0, 40))]
        if rng.random() < 0.3 and refs:
            refs[rng.randrange(len(refs))] = rng.choice(["ex", "e", "e07", "f3"])
        return [refs]
    return many(rng, count, [], make)


@generator("changes.within")
def gen_within(rng, count, corpus):
    return many(rng, count, [], lambda: [[noise(rng, PIECES, 10) for _ in range(rng.randint(0, 10))], rng.randint(0, 60)])


@generator("changes.run_label")
def gen_run_label(rng, count, corpus):
    return many(rng, count, [[None, []], ["", []]], lambda: [rng.choice(NAMES + [noise(rng)]), rng.choice([[], ["Save"]])])
