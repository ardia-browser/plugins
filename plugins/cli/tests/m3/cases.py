import ast
import math
import struct
from pathlib import Path

PIECES = ["a", "Z", "0", "9", "5", "-", "_", ".", " ", "\t", "\n", "\r\n", "\x00", "\x1c", "\x1f", "\x7f", "\x85", "\xa0", " ", "　",
          "﻿", "é", "ß", "ẞ", "İ", "ı", "Σ", "ς", "ﬁ", "ŉ", "٣", "３", "𝟘", "߀", "²", "½", "😀", "\ud800", "\udc00", "\ud83d", "\ude00",
          "￿", "%", "+", "=", "&", "?", "#", "/", "@", ":", "[", "]", "{", "}", "<", ">", '"', "'", "\\", "*", "K", "K", "ǅ"]
GENERATORS: dict = {}
_corpus: list[str] = []


def generator(name: str):
    def register(function):
        GENERATORS[name] = function
        return function

    return register


def recorded_strings(tests: Path) -> list[str]:
    if _corpus:
        return _corpus
    seen: set[str] = set()
    for path in sorted(tests.glob("test_*.py")):
        try:
            tree = ast.parse(path.read_text())
        except (SyntaxError, UnicodeDecodeError):
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str) and 0 < len(node.value) <= 300:
                seen.add(node.value)
    _corpus.extend(sorted(seen))
    return _corpus


def noise(rng, pieces=PIECES, most=12) -> str:
    return "".join(rng.choice(pieces) for _ in range(rng.randint(0, most)))


def pick(rng, corpus: list[str], fresh, share: float = 0.3) -> str:
    return rng.choice(corpus) if corpus and rng.random() < share else fresh()


def many(rng, count: int, fixed: list, make) -> list:
    out = [list(case) for case in fixed]
    while len(out) < count:
        out.append(make())
    return out


def any_float(rng) -> float:
    kind = rng.random()
    if kind < 0.2:
        return struct.unpack("<d", struct.pack("<Q", rng.getrandbits(64)))[0]
    if kind < 0.4:
        return rng.choice([0.0, -0.0, 0.5, 1.5, 2.5, -2.5, 0.125, 1e16, 1e-5, 123456.5, 9.999995, 0.0001, 1e22, 5e-324, 1.7976931348623157e308,
                           math.inf, -math.inf, math.nan])
    if kind < 0.7:
        return round(rng.uniform(-1e6, 1e6), rng.randint(0, 6))
    return rng.uniform(-10, 10) * 10 ** rng.randint(-20, 20)


NUMBERISH = ["0", "1", "5", "25", "007", ".", "5.", ".5", "1.5", "ms", "s", "m", " ", "　", "\x1c", "٣", "３", "𝟘", "²", "_", "e", "E", "+", "-",
             "inf", "nan", "Infinity", "x", "1_000"]


@generator("limits.seconds_of")
def gen_seconds(rng, count, corpus):
    fixed = [[None], [""], ["5"], ["5ms"], ["1.5s"], ["2m"], [" 7 "], ["٣s"], ["1.s"], ["s"], ["5mms"], ["1e3"], ["𝟘𝟘5m"]]
    return many(rng, count, fixed, lambda: [pick(rng, corpus, lambda: noise(rng, NUMBERISH, 5), 0.1)])


def argv_gen(rng, corpus):
    tokens = ["--timeout", "--timeout=5s", "--timeout=", "--", "5", "1.5", "30s", "click", "@e1", "--x", "٣", "2m", "--timeout=٣m", "1e3", "0"]
    return [rng.choice(tokens) if rng.random() < 0.8 else pick(rng, corpus, lambda: noise(rng, NUMBERISH, 4)) for _ in range(rng.randint(0, 6))]


@generator("limits.given_timeout")
def gen_given(rng, count, corpus):
    return many(rng, count, [[[]], [["--timeout", "5s"]], [["--", "--timeout", "5"]]], lambda: [argv_gen(rng, corpus)])


NAMES = ["wait", "script", "batch", "read", "record", "click", "snapshot", "", "eval"]


@generator("limits.command_limit")
def gen_limit(rng, count, corpus):
    return many(rng, count, [], lambda: [rng.choice(NAMES), argv_gen(rng, corpus), rng.choice([25.0, 0.0, 0.001, 600.5, rng.uniform(0, 1000)])])


@generator("limits.queue_wait")
def gen_queue(rng, count, corpus):
    return many(rng, count, [], lambda: [rng.choice(NAMES), argv_gen(rng, corpus), rng.choice([30.0, 0.0, 400.0]), rng.random() < 0.5])


REASONS = ["to that target", "on that target", "to that URL", "on a tab the ardia command didn't open", "with that option",
           "on a tab that isn't off-screen", "elsewhere", "", "constructor", "__proto__", "toString"]


def maybe(rng, value):
    return value if rng.random() < 0.6 else None


@generator("errors.make")
def gen_errors(rng, count, corpus):
    def make():
        kind = rng.choice(["Gated", "GatedDuring", "StaleRef", "CdpError", "CdpTimeout", "PageBusy", "NotFocusable", "OutcomeUnknown",
                           "ConnectionLost", "Usage", "Unreachable"])
        text = lambda: pick(rng, corpus, lambda: noise(rng))
        if kind in ("Gated", "GatedDuring"):
            args = ["Page." + noise(rng, ["a", "B", "x"], 4), maybe(rng, text()), maybe(rng, text()), maybe(rng, rng.choice(REASONS))]
            if kind == "GatedDuring":
                args += [maybe(rng, text()), maybe(rng, text())]
        elif kind == "StaleRef":
            args = [text(), rng.choice(["it is now @e5", "the page changed", text()])]
        elif kind in ("CdpTimeout", "PageBusy"):
            args = [text(), any_float(rng)] + ([text()] if kind == "PageBusy" else [])
        elif kind in ("CdpError", "OutcomeUnknown"):
            args = [text(), text()]
        elif kind == "ConnectionLost":
            args = [] if rng.random() < 0.5 else [text()]
        else:
            args = [text()]
        return [kind, args]
    return many(rng, count, [], make)


@generator("errors.refusal_reason")
def gen_refusal(rng, count, corpus):
    def make():
        method = rng.choice(["Page.navigate", "Target.createTarget", "X", ""])
        reason = rng.choice(REASONS + [noise(rng)])
        text = rng.choice([f"{method} {reason} isn't allowed for the ardia command", f"{method}  {reason}　 isn't allowed for the ardia command x",
                           noise(rng), f"{method} {method} {reason}", f"{reason}isn't allowed for the ardia command{method}"])
        return [text, method]
    return many(rng, count, [], make)


def secret_list(rng) -> list[str]:
    from urllib.parse import quote
    alphabet = ["a", "b", "Z", "9", "-", "_", " ", "/", "+", "=", "é", "😀", "%", "token", "&"]
    held: list[str] = []
    lengths: set[int] = set()
    for _ in range(rng.randint(0, 3)):
        secret = "".join(rng.choice(alphabet) for _ in range(rng.randint(1, 10)))
        forms = {secret, quote(secret, safe="")}
        sizes = {len(form) for form in forms}
        if sizes & lengths or len(sizes) < len(forms):
            continue
        lengths |= sizes
        held.append(secret)
    return held


def redact_text(rng, secrets: list[str], corpus) -> str:
    parts = []
    for _ in range(rng.randint(0, 8)):
        roll = rng.random()
        if secrets and roll < 0.3:
            secret = rng.choice(secrets)
            parts.append(secret[: rng.randint(1, len(secret))])
        elif roll < 0.5:
            parts.append(rng.choice(["token=", "?token=abc&x=1", "token=", "token=\x1c", "token=a\\b", "Token=", "token=token=x"]))
        else:
            parts.append(pick(rng, corpus, lambda: noise(rng, PIECES, 4), 0.1))
    return "".join(parts)


@generator("redact.redact")
def gen_redact(rng, count, corpus):
    def make():
        secrets = secret_list(rng)
        return [secrets, redact_text(rng, secrets, corpus)]
    return many(rng, count, [], make)


@generator("redact.unsafe_tail")
def gen_tail(rng, count, corpus):
    return gen_redact(rng, count, corpus)


@generator("redact.stream")
def gen_stream(rng, count, corpus):
    def make():
        secrets = secret_list(rng)
        text = redact_text(rng, secrets, corpus)
        chunks, at = [], 0
        while at < len(text):
            step = rng.randint(1, 5)
            chunks.append(text[at:at + step])
            at += step
        return [secrets, chunks]
    return many(rng, count, [], make)


METRIC_KEYS = ["total_ms", "cdp_calls", "humanize", "read_data", "cell_edits", "change_text_chars", "flow_saved", "flow_items", "nope", "snapshot_nodes",
               "unsettled", "waited_for_enabled", "settle_ms"]


def metric_value(rng):
    return rng.choice([True, False, 0, 1, -5, 7, 3_600_001, 10**12, 100_000_001, 0.5, 1.5, 2.5, -0.5, -0.0, math.nan, math.inf, -math.inf, "5", None,
                       [1], any_float(rng)])


@generator("metrics.clean")
def gen_clean(rng, count, corpus):
    return many(rng, count, [[{}], [[]]], lambda: [{rng.choice(METRIC_KEYS): metric_value(rng) for _ in range(rng.randint(0, 6))}])


@generator("metrics.rendered")
def gen_rendered(rng, count, corpus):
    def make():
        data = rng.choice([None, [], "x", {}, {"snapshot": rng.choice(["", "a", "a\nb\n", "😀\ud800", 5])},
                           {"changes": rng.choice([{}, {"network": []}, {"network": [1, 2], "unsettled": rng.choice([0, 1, "", "x", None])}, [],
                                                   {"network": "x"}])}])
        out = rng.choice(["", "x\n[output capped at 5", " not shown. Narrow it instead: ", "\n[truncated ", noise(rng)])
        return [rng.choice(["snapshot", "click", "read"]), data, rng.choice([None, [], [1, 2], "ab", {}]), rng.choice([False, None, "", "x"]), out]
    return many(rng, count, [], make)


KEYS = ["id", "name", "user", "1", "0", "²", "٣", "a.b", "", "items", "data", "ß", "SS", "Σ"]


def json_value(rng, depth=0):
    roll = rng.random()
    if depth > 3 or roll < 0.35:
        return rng.choice([None, True, False, 0, 7, -3, 10**30, 1.5, -0.0, "x", "Ab", "straße", "STRASSE", "😀", "\ud800", "", "ﬁle", "Σς", "٣"])
    if roll < 0.6:
        return [json_value(rng, depth + 1) for _ in range(rng.randint(0, 4))]
    return {rng.choice(KEYS): json_value(rng, depth + 1) for _ in range(rng.randint(0, 4))}


def item_list(rng):
    return [{rng.choice(KEYS): json_value(rng, 2) for _ in range(rng.randint(0, 4))} if rng.random() < 0.9 else json_value(rng, 3)
            for _ in range(rng.randint(0, 6))]


def body(rng):
    roll = rng.random()
    if roll < 0.3:
        return item_list(rng)
    if roll < 0.8:
        return {rng.choice(KEYS): rng.choice([item_list(rng), {rng.choice(KEYS): item_list(rng)}, json_value(rng, 2)]) for _ in range(rng.randint(0, 4))}
    return json_value(rng)


def field_names(rng):
    return rng.choice([None, "", "id", "id,name", " id , ,name.x", "user.name,0", ",", "²", noise(rng, ["a", ",", " ", ".", "ß"], 6)])


def where_list(rng):
    return rng.choice([None, [], ["id=1"], ["name=straSSe"], ["x"], ["=y"], [" = y"], ["user.name= AB "], [noise(rng, ["a", "=", " ", "ß", "ﬁ"], 6)]])


def limit_value(rng):
    return rng.choice([None, 0, 2, -1, "3", " 4 ", "-2", "x", "1_0", "٣", "2.0", "99999999999999999999", 10**25])


@generator("shape.parse")
def gen_shape_parse(rng, count, corpus):
    return many(rng, count, [], lambda: [field_names(rng), where_list(rng), limit_value(rng)])


@generator("shape.apply")
def gen_shape_apply(rng, count, corpus):
    return many(rng, count, [], lambda: [body(rng), field_names(rng), where_list(rng), limit_value(rng), rng.random() < 0.3,
                                         rng.choice([None, "", "items", "data.items", "0", "a.b"])])


@generator("shape.lookup")
def gen_lookup(rng, count, corpus):
    paths = ["id", "0", "1.id", "²", "٣", "01", "9" * 30, "a.b", "", ".", "items.0.name", "-1", " 1"]
    return many(rng, count, [], lambda: [body(rng), rng.choice(paths) if rng.random() < 0.7 else ".".join(rng.choice(KEYS) for _ in range(rng.randint(1, 3)))])


@generator("shape.main_list")
def gen_main(rng, count, corpus):
    return many(rng, count, [], lambda: [body(rng)])


@generator("shape.item_fields")
def gen_item_fields(rng, count, corpus):
    return many(rng, count, [], lambda: [item_list(rng) * rng.choice([1, 1, 20])])


HOSTS = ["example.com", "EXAMPLE.com", "a-b.c", "-a.com", "a..b", "localhost", "10.0.0.1", "0x7f.1", "1.2.3", "[::1]", "[::1]:8080", "[fe80::1%25en0]",
         "[::ffff:1.2.3.4]", "[1:2:3:4:5:6:7:8]", "[1::2::3]", "[::1", "::1]", "[v1.x]", "[1.2.3.4]", "user@host.com", "host:", "host:0", "host:65536",
         "host:443", "xn--bcher-kva.ch", "bücher.ch", "a" * 64 + ".com", "ex_ample.com", "host:80x", "[::1]x", "℀.com", "[12345::]", "[::1.2.3.04]"]
SEGMENTS = ["", "users", "{{id}}", "{{Id}}", "12", "-3.5", "1234567890123456", "user_{{n}}", "..", "a@b", "tokens", "apiKey", "sessionId", "%7B%7Bid%7D%7D",
            "%E2%82%AC", "%ZZ", "%", "x" * 25, "a.b", "٣", "AccessToken", "pass_word", "my-secret", "%C3", "😀"]
QUERY = ["q=1", "token=abc", "token=", "a[b]=c", "x=%7B%7Bp%7D%7D", "k", "=v", "page=2&sort=asc", "sig=12", "&&", "a=b=c", "u%20s=1", "x=@y", "big=" + "z" * 30,
         "authToken=xyz", "a+b=c+d", "id=-1.5"]


def url(rng, corpus):
    if rng.random() < 0.1:
        return pick(rng, corpus, lambda: noise(rng), 0.6)
    scheme = rng.choice(["https", "http", "HTTP", "ftp", "javascript", "", "h"])
    path = "/".join(rng.choice(SEGMENTS) for _ in range(rng.randint(0, 4)))
    query = "&".join(rng.choice(QUERY) for _ in range(rng.randint(0, 3)))
    text = f"{scheme}://{rng.choice(HOSTS)}" + (f"/{path}" if path or rng.random() < 0.5 else "") + (f"?{query}" if query else "")
    text += rng.choice(["", "", "#frag", "#a b", "?"])
    if rng.random() < 0.15:
        at = rng.randint(0, len(text))
        text = text[:at] + rng.choice(PIECES) + text[at:]
    return text


def secrets_for(rng):
    return rng.choice([[], ["abc"], ["12"], ["xyz", "secret value"], ["😀"], ["z" * 30]])


@generator("flowurl.parse")
def gen_parse(rng, count, corpus):
    return many(rng, count, [[5], [None]], lambda: [url(rng, corpus)])


@generator("flowurl.checked")
def gen_checked(rng, count, corpus):
    return many(rng, count, [], lambda: [url(rng, corpus), secrets_for(rng)])


@generator("flowurl.credential_key")
def gen_cred(rng, count, corpus):
    words = ["token", "Token", "apiKey", "api_key", "API-KEY", "sessionIds", "x", "keys", "pass", "a.b", "my token", "auth%5F", "csrf+x", "ACCESS_TOKEN",
             "userName", "pwds", "SIG", "credential", "Key"]
    return many(rng, count, [], lambda: [rng.choice(words) if rng.random() < 0.6 else noise(rng, words + PIECES, 4)])


@generator("flowurl.literal_ok")
def gen_literal(rng, count, corpus):
    return many(rng, count, [], lambda: [rng.choice(SEGMENTS + QUERY) if rng.random() < 0.6 else noise(rng), rng.random() < 0.5])


@generator("flowurl.encodings")
def gen_encodings(rng, count, corpus):
    return many(rng, count, [], lambda: [noise(rng, PIECES, 8)])


@generator("flowurl.carries")
def gen_carries(rng, count, corpus):
    def make():
        secret = noise(rng, ["a", "B", "1", " ", "é", "/", "\ud800"], 5)
        text = rng.choice([None, "", noise(rng)]) if rng.random() < 0.4 else noise(rng) + secret.upper() + noise(rng)
        return [text, secret]
    return many(rng, count, [], make)


@generator("flowurl.query_pairs")
def gen_pairs(rng, count, corpus):
    return many(rng, count, [], lambda: ["&".join(rng.choice(QUERY + [noise(rng)]) for _ in range(rng.randint(0, 4)))])


@generator("flowurl.host_label")
def gen_host(rng, count, corpus):
    return many(rng, count, [], lambda: [url(rng, corpus)])


@generator("flowurl.mask")
def gen_mask(rng, count, corpus):
    return many(rng, count, [], lambda: [url(rng, corpus), secrets_for(rng)])


FIELD_VALUES = {
    "date": ["2026-11-09", "2026-2-29", "2024-02-29", "0000-01-01", "10000-01-01", "٢٠٢٦-١١-٠٩", " 2026-11-09 ", "2026-13-01", "2026-11-31", "202-1-1"],
    "time": ["14:30", "2:30 PM", "2:30pm", "12 am", "12 a.m.", "13 pm", "0 am", "14:30:15", "14:30:15.5", "14:30:15.1234", "24:00", "9", "9pm", "１４:３０",
             "14:60", "14:30:60", "14 :30", "14:30 \x1c pm"],
    "datetime-local": ["2026-11-09T14:30", "2026-11-09 14:30", "2026-11-09t2pm", "2026-11-09", "2026-11-09T"],
    "month": ["2026-11", "2026-0", "2026-13", "202611", "٢٠٢٦-٣"],
    "week": ["2026-W46", "2026W46", "2026-w1", "2026-W54", "2026-W0"],
    "color": ["#3b82f6", "3B82F6", "#abc", "#ABCD", "#ggg", "abc"],
    "range": ["50", " 1e3 ", "inf", "nan", "1_0", "x", "-0", "٣", "1__0"],
}


@generator("fields.normalize")
def gen_fields(rng, count, corpus):
    def make():
        kind = rng.choice(list(FIELD_VALUES) + ["text"])
        values = FIELD_VALUES.get(kind, ["x"])
        value = rng.choice(values)
        if rng.random() < 0.4:
            at = rng.randint(0, len(value))
            value = value[:at] + rng.choice(PIECES + ["1", "2", ":", "T", " "]) + value[at:]
        return [kind, rng.choice(["", "   "]) if rng.random() < 0.03 else value]
    return many(rng, count, [], make)


PCT = ["%41", "%4", "%", "%%", "%e2%82%ac", "%E2%82", "%ff", "%C0%80", "%ED%A0%80", "%EF%BB%BF", "%F0%9F%98%80", "%F4%90%80%80", "%F0%80", "%zz", "+"]


@generator("urllib.unquote")
def gen_unquote(rng, count, corpus):
    return many(rng, count, [], lambda: ["".join(rng.choice(PCT + PIECES) for _ in range(rng.randint(0, 8)))])


@generator("urllib.unquote_plus")
def gen_unquote_plus(rng, count, corpus):
    return gen_unquote(rng, count, corpus)


@generator("urllib.quote")
def gen_quote(rng, count, corpus):
    return many(rng, count, [], lambda: [noise(rng), rng.choice(["/", "", "[]<>", "{}<>", "é", "%"])])


@generator("urllib.quote_plus")
def gen_quote_plus(rng, count, corpus):
    return gen_quote(rng, count, corpus)


@generator("urllib.urlsplit")
def gen_split(rng, count, corpus):
    extra = [" \x00http://a", "http://[::1", "http://a]b", "http://[v1.x]/", "http://[vz.x]", "http://u@[::1]:80/p", "http://x[::1]", "http://[::1]x",
             "//host/p?q#f", "a:b", "1a:b", "http://℀/", "http://℀.com", "ht\ttp://a\nb", "mailto:x@y", "http://[1.2.3.4]/", "HTTP://A/"]
    return many(rng, count, [[value] for value in extra], lambda: [url(rng, corpus)])


@generator("ipaddress.kind")
def gen_ip(rng, count, corpus):
    samples = ["1.2.3.4", "01.2.3.4", "256.1.1.1", "1.2.3", "::", "::1", "1::", "1:2:3:4:5:6:7:8", "1:2:3:4:5:6:7:8:9", "1::2::3", ":1::", "1:::2",
               "::ffff:1.2.3.4", "1:2:3:4:5:6:1.2.3.4", "1:2:3:4:5:6:7:1.2.3.4", "fe80::1%en0", "fe80::1%", "fe80::1%a%b", "12345::", "g::", "::1/64",
               "1:2:3:4:5:6:7::", "::2:3:4:5:6:7:8", "::1:2:3:4:5:6:7:8", "١.2.3.4", "0:0:0:0:0:0:0:0", ""]
    def make():
        text = rng.choice(samples)
        if rng.random() < 0.4:
            at = rng.randint(0, len(text))
            text = text[:at] + rng.choice([":", ".", "1", "f", "::", "%", "g"]) + text[at:]
        return [text]
    return many(rng, count, [], make)


@generator("py.repr")
def gen_repr(rng, count, corpus):
    return many(rng, count, [["'"], ['"'], ["'\""], ["\x7f\x80\x9f\xa0\xad"], ["\U000e0001\U0010ffff"]], lambda: [pick(rng, corpus, lambda: noise(rng))])


@generator("py.int")
def gen_int(rng, count, corpus):
    return many(rng, count, [["9" * 4301], ["9" * 4300]], lambda: [noise(rng, NUMBERISH, 5)])


@generator("py.float")
def gen_float(rng, count, corpus):
    return many(rng, count, [["1e999"], ["-1e-999"], ["1_0.5_5e1_0"], ["infinity"], ["-iNf"], ["+nan"]], lambda: [noise(rng, NUMBERISH, 6)])


@generator("py.casefold")
def gen_casefold(rng, count, corpus):
    sweep = [["".join(chr(code) for code in range(start, start + 64) if not 0xD800 <= code < 0xE000)] for start in range(0x80, 0x20000, 64)]
    return many(rng, count + len(sweep), sweep, lambda: [pick(rng, corpus, lambda: noise(rng) + chr(rng.randint(0x80, 0x1FFFF)))])


@generator("py.format_g")
def gen_g(rng, count, corpus):
    return many(rng, count, [], lambda: [any_float(rng), rng.choice([0, 1, 2, 3, 6, 6, 6, 10, 17])])


@generator("py.round")
def gen_round(rng, count, corpus):
    return many(rng, count, [], lambda: [any_float(rng)])


@generator("py.round_to")
def gen_round_to(rng, count, corpus):
    return many(rng, count, [], lambda: [any_float(rng), rng.choice([0, 1, 2, 3, 3, 6])])


@generator("py.len")
def gen_len(rng, count, corpus):
    return many(rng, count, [], lambda: [noise(rng, PIECES, 20)])
