import json

from tests.m3.cases import PIECES, generator, many

HOSTS = ["example.com", "www.example.com", "shop.example.co.uk", "a.b.github.io", "localhost", "127.0.0.1", "[::1]", "api.example.com",
         "x.vercel.app", "EXAMPLE.com.", "bücher.de", "a_b.example", "-bad.example", "x" * 70 + ".com", "example.com:8080", ""]
SCHEMES = ["https://", "http://", "", "ftp://", "HTTPS://"]
PATHS = ["/", "/search", "/items/42", "/a b/c", "/caf%C3%A9", "/q/{{term}}", "/x/ünï", "", "/api/v1/list.json"]
QUERIES = ["", "?q=shoes", "?q=red+shoes&page=2", "?utm_source=x&id=7", "?token=abc", "?q=%E2%9C%93", "?a=&b=1", "?q={{term}}"]
WORDS = ["shoes", "red shoes", "42", "a", "ab", "café", "x/y", "a&b", "100%", "", "token", "secret pass", "✓", "\U0001f600"]
JSON_TEXTS = ['{}', '{"a": 1}', '{"a": 1, "a": 2}', '[1, 2]', '{"x": NaN}', '{"x": 1e400}', '{"a": [1,]}', '{"a": 1,}', '  ', '', '{bad',
              '{"k": "\\ud800"}', '{"n": 123456789012345678901234567890}', '{"f": 1.5e3, "s": "x"}', '"str"', 'null', '{"a": {"b": {"c": []}}}',
              '﻿{}', '{"a"  :  1 } x', '{"\\u00e9": "\\n"}', '{"t": true, "f": false, "n": null}', '[' * 70 + ']' * 70, '{"a": 01}',
              '{"a": -0}', '{"a": 1.}', '{"a": "\x01"}', '{"a": "\\x"}', '{"a": "\\u12"}']


def url(rng):
    return rng.choice(SCHEMES) + rng.choice(HOSTS) + rng.choice(PATHS) + rng.choice(QUERIES) + rng.choice(["", "#frag"])


def word(rng):
    return rng.choice(WORDS + ["".join(rng.choice(PIECES) for _ in range(rng.randint(1, 4)))])


@generator("d7.cdp_params")
def gen_cdp_params(rng, count, corpus):
    def make():
        raw = rng.choice(JSON_TEXTS + [None, "-"])
        pairs = [rng.choice(["a=1", "b:=2", "c:=[1,2]", "d:={\"x\": 1}", "e:=[1,]", "url", "=x", ":=1", "f=" + word(rng), "g:=NaN", "h:=", "-p x=1"])
                 for _ in range(rng.randint(0, 3))]
        return [raw, pairs, rng.choice(JSON_TEXTS + [None])]
    return many(rng, count, [[None, [], None], ["{}", [], None], ["-", [], '{"expression": "1"}'], ["-", [], "x" * 1100000]], make)


def body(rng):
    return rng.choice([
        {"items": [{"id": 1, "name": "a", "price": 1.5}, {"id": 2, "name": "b", "price": 2}], "total": 2},
        {"results": [{"title": "t", "url": "u", "tags": ["x"]}], "next": None},
        [{"a": 1}, {"a": 2}],
        {"data": {"list": [{"k": "v"}]}, "secret pass": 1},
        {"x": 1},
        {"rows": []},
    ])


def request(rng, step_url, kind=None):
    value = body(rng)
    kind = kind or rng.choice(["json", "json", "document"])
    if kind == "document":
        text = f'<html><script id="{rng.choice(["data", "__NEXT_DATA__", "bad id!"])}" type="application/json">{json.dumps(value)}</script></html>'
    else:
        text = json.dumps(value)
    base = rng.choice([step_url.split("?")[0], "https://api.example.com/v1/search", "https://other.org/x", "http://example.com:81/z"])
    return {"method": "POST" if rng.random() < 0.08 else "GET", "url": base + rng.choice(["", "?q=shoes", "?q=red+shoes", "?term=shoes&page=2", "?token=abc"]),
            "type": "Fetch" if kind == "json" else "Document", "status": rng.choice([200, 200, 304, 404]), "mime": "application/json" if kind == "json" else "text/html",
            "headers": rng.choice([{}, {"accept": "application/json"}, {"accept": "xé"}]), "strippedAuth": rng.random() < 0.2, "kind": kind,
            "bytes": len(text), "text": None if rng.random() < 0.1 else text, "evicted": rng.random() < 0.1}


def steps(rng):
    out = []
    start = rng.choice(["https://www.example.com/search?q=shoes", "https://example.com/", "http://localhost:3000/app?id=7",
                        "https://shop.example.co.uk/items?utm_source=x&q=red+shoes"] + (["about:blank"] if rng.random() < 0.1 else []))
    for seq in range(1, rng.randint(1, 4) + 1):
        name = "open" if seq == 1 else rng.choice(["click", "fill", "type", "press", "wait", "find"])
        typed = None
        command = [name, start] if name == "open" else [name, rng.choice(["#q", "@e3", "input[name=q]"]), rng.choice(WORDS)]
        if name in ("fill", "type") and rng.random() < 0.8:
            typed = {"value": command[-1], "secret": rng.random() < 0.2, "field": rng.choice(["q", "searchTerm", "", "Password"])}
        step = {"seq": seq, "command": command, "before": start, "replay": command if rng.random() < 0.7 else None,
                "requests": [request(rng, start) for _ in range(rng.randint(0, 3))], "origins": rng.choice([[], ["https://api.example.com"], ["https://evil.org"]]),
                "unkept": rng.choice([[], ["POST"]]), "url": start if name == "open" else rng.choice([start, start + "&page=2", ""]), "ok": rng.random() < 0.9}
        for index, item in enumerate(step["requests"], 1):
            item["id"] = f"s{seq}r{index}"
        if typed:
            step["typed"] = typed
        out.append(step)
    return out


@generator("d7.build_flow")
def gen_build(rng, count, corpus):
    def make():
        return [rng.choice(["search", "items", "search", "a-b_c", "bad name!"] if rng.random() < 0.1 else ["search", "items", "a-b_c"]), steps(rng),
                rng.choice([{}, {}, {"term": "shoes"}, {"q": "red shoes"}] + ([{"Bad": "x"}] if rng.random() < 0.1 else [])),
                rng.choice([None, None, "s1r1", "s9r9"]), rng.choice([None, "  find   shoes \n", "d" * 200]), rng.choice([[], ["secret pass"], ["shoes"]])]
    return many(rng, count, [], make)


def valid_flow():
    return {"version": 1, "name": "search", "description": None, "site": "example.com", "origin": "https://www.example.com",
            "startUrl": "https://www.example.com/search?q={{q}}", "hosts": ["https://www.example.com"], "createdAt": "2026-01-01T00:00:00Z",
            "createdBy": {"tool": "ardia browse", "version": "1"}, "params": [{"name": "q", "example": "shoes", "source": "query"}],
            "output": "s1r1", "verified": True,
            "steps": [{"seq": 1, "command": ["open", "https://www.example.com/search?q={{q}}"], "url": "https://www.example.com/search?q={{q}}", "ok": True,
                       "requests": [{"id": "s1r1", "method": "GET", "url": "https://www.example.com/api?q={{q}}", "headers": {"accept": "application/json"},
                                     "kind": "json", "expect": {"status": 200, "mime": "application/json", "signature": {"items": [{"id": "number"}]},
                                                                "bytes": 10, "list": "items", "itemFields": ["id"]}}]}]}


MUTATIONS = [
    lambda f: f.update(version=2), lambda f: f.update(extra=1), lambda f: f.pop("hosts"), lambda f: f.update(startUrl="ftp://x/"),
    lambda f: f.update(site="other.com"), lambda f: f.update(origin="https://example.com"), lambda f: f.update(hosts=["https://evil.org", "https://www.example.com"]),
    lambda f: f.update(description="x" * 130), lambda f: f.update(description="a\nb"), lambda f: f["params"].append({"name": "Bad"}),
    lambda f: f["params"][0].update(example="a b c d e f g h i j k l m n o p q r s t u v w x y z " * 3), lambda f: f.update(steps={}),
    lambda f: f["steps"][0].update(extra=1), lambda f: f["steps"][0].update(command=[]), lambda f: f["steps"][0]["requests"][0].update(body="x"),
    lambda f: f["steps"][0]["requests"][0].update(method="POST"), lambda f: f["steps"][0]["requests"][0].update(url="https://evil.org/x"),
    lambda f: f["steps"][0]["requests"][0].update(headers={"cookie": "x"}), lambda f: f["steps"][0]["requests"][0]["expect"].update(itemFields=["a b"]),
    lambda f: f.update(output="s9"), lambda f: f.update(version="1"), lambda f: f.update(hosts="x"), lambda f: None,
    lambda f: f.update(startUrl="https://www.example.com/search?token=abc"), lambda f: f.update(name="other"),
]


@generator("d7.validate")
def gen_validate(rng, count, corpus):
    def make():
        flow = valid_flow()
        for _ in range(rng.choice([0, 0, 1, 1, 2])):
            try:
                rng.choice(MUTATIONS)(flow)
            except (KeyError, TypeError, AttributeError, IndexError):
                pass
        return [flow, rng.choice([None, None, "example.com", "other.com"]), rng.choice([None, None, "search", "x"])]
    return many(rng, count, [[valid_flow(), None, None], [[], None, None], ["x", None, None]], make)


@generator("d7.signature")
def gen_signature(rng, count, corpus):
    def value(depth=0):
        kind = rng.random()
        if depth > 8 or kind < 0.3:
            return rng.choice([1, 1.5, "s", True, None, -0.0, 10 ** 20])
        if kind < 0.6:
            return [value(depth + 1) for _ in range(rng.randint(0, 3))]
        return {rng.choice(["a", "b", "c d", "_x", "1x", "k" * 40, "secret pass", "é"]): value(depth + 1) for _ in range(rng.randint(0, 4))}
    return many(rng, count, [[{f"k{i}": i for i in range(100)}]], lambda: [value()])


@generator("d7.drift")
def gen_drift(rng, count, corpus):
    sigs = [{"items": [{"id": "number"}]}, {"a": "string", "*": "any"}, ["object"], "array", "object", "null", "number", {"x": {"y": "boolean"}}]
    values = [{"items": [{"id": 1}]}, {"items": []}, {"items": [{"id": "1"}]}, {"a": "x"}, {"a": 1}, [], [{"z": 1}], {}, None, 1, "s", True, {"x": {"y": True}}, {"x": {}}]
    return many(rng, count, [], lambda: [rng.choice(sigs), rng.choice(values)])


@generator("d7.template_url")
def gen_template(rng, count, corpus):
    return many(rng, count, [], lambda: [url(rng), [[rng.choice(["q", "p1", "term"]), word(rng)] for _ in range(rng.randint(0, 3))]])


@generator("d7.fill_url")
def gen_fill(rng, count, corpus):
    return many(rng, count, [], lambda: [url(rng) + rng.choice(["", "/{{q}}", "?x={{q}}&y={{term}}", "/{{zz}}"]), {rng.choice(["q", "term"]): word(rng)}])


@generator("d7.masked_part")
def gen_masked(rng, count, corpus):
    return many(rng, count, [], lambda: [rng.choice([url(rng), word(rng), "example.com/x", "localhost:3000/", "secret pass", "abc"]),
                                         rng.choice([{}, {"secret": True, "value": "abc"}, {"value": "x"}]), rng.choice([[], ["secret pass"], ["abc"]]),
                                         rng.choice([[], [["q", "shoes"]]])])


@generator("d7.flow_site")
def gen_flow_site(rng, count, corpus):
    return many(rng, count, [], lambda: [url(rng)])


@generator("d7.slug")
def gen_slug(rng, count, corpus):
    return many(rng, count, [["searchTerm"], ["Q"], [""], ["x" * 30], ["2fa"], ["a--b"], ["été"]], lambda: [word(rng) + rng.choice(["", "Name", "_id", " X"])])


@generator("d7.base_domain")
def gen_base(rng, count, corpus):
    return many(rng, count, [], lambda: [rng.choice(HOSTS + ["a.b.c.d.example.co.jp", "foo.s3.amazonaws.com", "x.y.z", "1.2.3.4", "[2001:db8::1]", "com", ""])])


@generator("d7.embedded_json")
def gen_embedded(rng, count, corpus):
    blocks = ['<script type="application/json" id="d">{"a": [1, 2]}</script>', '<script>window.__DATA__ = {"x": 1};</script>',
              "<script>var s = [1,2]</script>", '<script type="text/plain">{"no": 1}</script>', '<SCRIPT TYPE=module>{"m": 1}</SCRIPT >',
              '<script id=\'q\'>self.state = {"n": NaN}</script>', "<script>const a.b['c'] = {\"deep\": {\"x\": []}}</script>", "<script>{bad json}</script>",
              '<script type="application/ld+json">[{"@type": "Thing"}]</script>', "<script>x = 1</script>"]
    return many(rng, count, [], lambda: ["<html>" + "".join(rng.choice(blocks) for _ in range(rng.randint(0, 4))) + "</html>"])


@generator("d7.kept_headers")
def gen_headers(rng, count, corpus):
    names = ["Accept", "accept", "Authorization", "Cookie", "X-CSRF-Token", "x-api-key", "X-Session-Id", "Content-Type", "X-Auth-User", "Signature"]
    return many(rng, count, [], lambda: [{rng.choice(names): rng.choice(["application/json", "x" * 1100, "é"]) for _ in range(rng.randint(0, 4))}])


@generator("d7.find_arguments")
def gen_find(rng, count, corpus):
    def make():
        args = [rng.choice(["role", "text", "label=Email", "nth", "role=button", "testid"])] + [rng.choice(["button", "click", "Submit", "fill", "x", "2"])
                                                                                             for _ in range(rng.randint(0, 4))]
        return [args, rng.choice([None, "Name"])]
    return many(rng, count, [], make)


@generator("d7.notes_site")
def gen_notes_site(rng, count, corpus):
    return many(rng, count, [["https://example.com:443/x"], ["http://h:80"], ["example.com:0"], ["[::1]:8080"], ["https://[::1"]], lambda: [url(rng)])


@generator("d7.page_site")
def gen_page_site(rng, count, corpus):
    return many(rng, count, [[None], [""]], lambda: [url(rng)])


@generator("d7.notes_args")
def gen_notes_args(rng, count, corpus):
    def make():
        return [[rng.choice(["get", "set", "append", "list", "rm", "example.com", "localhost", "hello world", "--json", "--x", "-", "a.b", "x"])
                 for _ in range(rng.randint(0, 4))]]
    return many(rng, count, [], make)


@generator("d7.worker_source")
def gen_worker(rng, count, corpus):
    return many(rng, count, [], lambda: [rng.choice(["return 1", "log('x')\nreturn state", "", "a\nb\nc", "\U0001f600"]), rng.choice(["{}", '{"a": 1}', "null"])])


@generator("d7.split_command_line")
def gen_split(rng, count, corpus):
    return many(rng, count, [], lambda: [rng.choice([["get title"], ["get", "title"], ["click '#a b'"], ["nosuch x"], ["auth login x"], ["open 'unclosed"], [" "],
                                                      ["key Enter"], ["title"], ["wait 1000"], ["eval \"1 + 1\""], []])])


@generator("d7.tail")
def gen_tail(rng, count, corpus):
    return many(rng, count, [], lambda: [[word(rng) * rng.randint(1, 400) for _ in range(rng.randint(0, 20))], rng.choice([3000, 10, 0])])


@generator("d7.page_world_hint")
def gen_hint(rng, count, corpus):
    texts = ["ReferenceError: foo is not defined", "ReferenceError: document is not defined", "window is not defined", "TypeError: x", "ReferenceError: é is not defined"]
    return many(rng, count, [], lambda: [rng.choice(texts), rng.choice([None, [], ["eval", "x"], ["click", "#a"]])])


@generator("d7.state_summary")
def gen_summary(rng, count, corpus):
    return many(rng, count, [], lambda: [json.dumps(rng.choice([{}, {"a": [1, 2], "b": {"c": 1}, "d": 1}, {f"k{i}": i for i in range(10)}, [1], "x", 3,
                                                                  {"2": 1, "b": 2}]))])


@generator("d7.kept_preview")
def gen_preview(rng, count, corpus):
    return many(rng, count, [], lambda: [rng.choice([None, "", " {} ", "{}", '{"a": 1}', "x" * 1600, "\U0001f600" * 1501, 5])])


@generator("d7.render_json")
def gen_render(rng, count, corpus):
    return many(rng, count, [], lambda: [rng.choice([None, 1, 1.5, "s", [], [{"a": 1}, [1]], {"rows": [{"a": 1}], "n": 2}, {"a": "é"}, [1, 2], {"x": []}])])


@generator("d7.parse_timeout")
def gen_timeout(rng, count, corpus):
    return many(rng, count, [], lambda: [rng.choice([None, "30s", "2m", "1500", "0", "11m", "600s", " 5s ", "1.5m", "x", "١٢s", "1e3", "-1", "600000", "600001"])])


@generator("d7.quote_selectors")
def gen_quote(rng, count, corpus):
    cases = ["document.querySelector('a[href=/x y/]')", 'document.querySelectorAll("[aria-label=Two words]")', "el.closest('[data-x=a.b]')",
             "el.matches('[id=plain]')", "document.querySelector('a[href*=\"/p/\"]')", "x.querySelector('[a=b c i]')", "no selectors here",
             "document.querySelector('[x=é ü]')", "querySelector('[a= -x ]')"]
    return many(rng, count, [], lambda: [" ; ".join(rng.choice(cases) for _ in range(rng.randint(1, 3)))])


@generator("d7.command_line")
def gen_command_line(rng, count, corpus):
    return many(rng, count, [], lambda: [["find-generic-password"] + [rng.choice(["-a", "name", 'q"uote', "back\\slash", "tab\tx", "é", "\x7f", "-w"])
                                                                      for _ in range(rng.randint(0, 5))]])


@generator("d7.origin_of")
def gen_origin(rng, count, corpus):
    return many(rng, count, [["http://localhost:8080/x"], ["http://[::1]/"], ["https://h:99999/"]], lambda: [url(rng)])


@generator("d7.parse_params")
def gen_parse_params(rng, count, corpus):
    return many(rng, count, [[None]], lambda: [[rng.choice(["a=1", "b=", "=x", "c", " d =e", "f=g=h"]) for _ in range(rng.randint(0, 3))]])


def full_control() -> bool:
    try:
        import ardia_cli.call_cli  # noqa: F401
    except ImportError:
        return False
    return True


FULL_CONTROL_ONLY = ("d7.cdp_params", "d7.parse_timeout")
if not full_control():
    from tests.m3.cases import GENERATORS

    for name in FULL_CONTROL_ONLY:
        GENERATORS.pop(name, None)
