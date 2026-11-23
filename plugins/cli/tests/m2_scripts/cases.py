import random
import stringprep
from unicodedata import ucd_3_2_0

SCHEMES = ["http", "https", "file", "ftp", "*", "ws", "HTTP", "chrome", "", "h*", "ht tp"]
ASCII_HOSTS = ["example.com", "a.b.c", "EXAMPLE.org", "localhost", "x", "*.example.com", "*", "*.", "*.*", "a*b", "-a-.b_", "a..b",
               "trailing.", "trailing..", ".lead", "xn--nxasmq6b", "xn--bcher-kva", "XN--BCHER-KVA", "xn--", "xn--a", "xn--zz-",
               "xn--abc-", "xn---", "xn--99999999999", "xn--a-ecp.ru", "a b", "a\tb", "a\nb", "abc\n", "a/b", "a@b", "a\\b", "a" * 64,
               "a" * 63, "%41", "a%", "[", "]", "a]", "[::1", "::1"]
IP_HOSTS = ["127.0.0.1", "127.1", "0x7f.1", "0x7F000001", "017700000001", "1.2.3.4.5", "256.1.1.1", "1.256", "08", "0x", "0", "00",
            "1.2.3.", "1..2", "4294967295", "4294967296", "0xffffffff", "0x1ffffffff", "1.0x100", "1.2.65536", "99999999999999999999",
            "1.2.3.09", "0x1g", "1e3", "[::1]", "[::]", "[1::]", "[::ffff:1.2.3.4]", "[::ffff:127.1]", "[2001:db8::1]", "[2001:DB8:0:0:0:0:0:1]",
            "[1:2:3:4:5:6:7:8]", "[1:2:3:4:5:6:7:8:9]", "[1::2::3]", "[:1:2:3:4:5:6:7]", "[1:2:3:4:5:6:7:]", "[12345::]", "[g::]",
            "[::1.2.3.4]", "[1:0:0:2:0:0:0:3]", "[0:0:1:0:0:1:0:0]", "[fe80::1%eth0]", "[::1]x", "[]", "[[::1]]", "[::1]:80", "[v1.a]",
            "[1.2.3.4]", "[0000:0000::]", "[0:0:0:0:0:0:0:0:0]", "[::0:0:0:0:0:0:0]", "[1:2:3:4:5:6:1.2.3.4]", "[1:2:3:4:5:6:7:1.2.3.4]"]
UNICODE_HOSTS = ["bücher.de", "BÜCHER.de", "例え.テスト", "пример.рф", "مثال.إختبار", "a١", "אב", "אaב", "א1",
                 "ﬀ.com", "Ⅻ.com", "①.com", "ｅｘａｍｐｌｅ。ｃｏｍ", "a．b", "a｡b", "a。", "straße.de", "ς.gr", "a‌b", "a‍b",
                 "­.com", "á.com", "ẹ́̂", "각", "각", "क़", "שׁ", "Ω",
                 "Å", "ẛ̣", "̈́", "é" * 70, "\U0001f600.com", "\ud800.com", "a\udfff", "ȡ", "ȷ", "Ⰰ",
                 "\U00020000", "͸x", "⿰", "￹", "\U000e0001", "̀a", "‎", "　", " ", "x̀́̂",
                 "ཱི", "ཱུ", "ཱྀ", "ᾀ", "ǅ", "ﬆ", "µ", "İ", "ŉ", "ǰ", "ΐ", "ẖ", "ῼ",
                 "㎒", "㏆", "\U0001d400", "Ⅰ", "Ⓐ", "ͺ", "ϓ", "xn--bücher", "é.xn--a"]
PATHS = ["/", "/*", "/a/*", "/a?b", "/a\\b", "/%41", "/%41%42", "/%7E", "/%2F", "/%25", "/%e2%82%ac", "/%E2%82%AC", "/%e2%82",
         "/%c3%a9", "/%c3", "/%c0%af", "/%ed%a0%80", "/%f4%90%80%80", "/%ef%bb%bf", "/%c2%a0", "/%e2%80%8b", "/%f0%9f%98%80",
         "/%f3%a0%80%81", "/%", "/%4", "/%zz", "/€", "/é?q=1", "/a*b?c", "/*?*", "/\\*", "/\\?", "/??", "/a#frag", "/ space",
         "/\ud800", "/%ff", "/%80", "/*.js", "/foo/*/bar", "/\x00", "/日本"]
PORTS = ["", ":80", ":8080", ":*", ":0", ":65535", ":65536", ":080", ":", ":abc", ":١", ":-1", ":" + "9" * 30, ":" + "1" * 4400]
URL_PARTS = ["http://", "https://", "HTTPS://", "file://", "ftp://", "ws://", "chrome://", "about:", "data:", "", "http:", "http:/", "//"]
URL_TAILS = ["", "/", "/a", "/a/b", "/a?b=c", "/a?b#c", "#frag", "?q", "/%41", "/%e2%82%ac", "/é", "/a\\b", "/*", "/x?y?z", "/\ud800"]
USERINFO = ["", "user@", "user:pw@", "@", "a@b@"]
GLOB_PIECES = ["*", "?", "\\", "\\*", "\\?", "http", "https://", "example.com", "/", "a", "é", "%41", "\ud800", "*.", "//"]


def interesting_points() -> list[int]:
    pool = []
    for cp in list(range(0x80, 0x3400)) + list(range(0xa000, 0xd800)) + list(range(0xf900, 0x10000)) + list(range(0x10000, 0x11000)) + \
            list(range(0x1d400, 0x1d800)) + list(range(0xe0000, 0xe0080)):
        char = chr(cp)
        if (stringprep.in_table_b1(char) or stringprep.map_table_b2(char) != char or ucd_3_2_0.decomposition(char) or
                ucd_3_2_0.combining(char) or stringprep.in_table_d1(char) or stringprep.in_table_c12(char) or
                stringprep.in_table_c22(char) or stringprep.in_table_c9(char) or ucd_3_2_0.category(char) == "Cn"):
            pool.append(cp)
    return pool


POOL = interesting_points()


def unicode_text(draw: random.Random, low: int = 1, high: int = 8) -> str:
    out = []
    for _ in range(draw.randint(low, high)):
        roll = draw.random()
        if roll < 0.5:
            out.append(chr(draw.choice(POOL)))
        elif roll < 0.65:
            out.append(draw.choice("abcxyz-019"))
        elif roll < 0.75:
            out.append(chr(draw.randint(0xac00, 0xd7a3)))
        elif roll < 0.82:
            out.append(draw.choice([".", "。", "．", "｡"]))
        elif roll < 0.9:
            out.append(chr(draw.randint(0x300, 0x36f)))
        else:
            out.append(chr(draw.randint(0x80, 0x10ffff)))
    return "".join(out)


def host(draw: random.Random) -> str:
    roll = draw.random()
    if roll < 0.25:
        return draw.choice(ASCII_HOSTS)
    if roll < 0.45:
        return draw.choice(IP_HOSTS)
    if roll < 0.65:
        return draw.choice(UNICODE_HOSTS)
    if roll < 0.9:
        return ".".join(unicode_text(draw, 1, 5) for _ in range(draw.randint(1, 3)))
    return draw.choice(ASCII_HOSTS) + draw.choice(["", "."]) + unicode_text(draw, 1, 3)


def pattern(draw: random.Random) -> str:
    roll = draw.random()
    if roll < 0.03:
        return "<all_urls>"
    if roll < 0.08:
        return draw.choice(["", "http:/x/", "*://", "http://", "file://", "file:///", "file://localhost/x", "file://host/x", "http://x",
                            "http:///x", "*://*/*", "*://*:80/*", "http://[::1/x", "http://[]/x", "http://[::1]x/", "http://a\0/"])
    scheme = draw.choice(SCHEMES)
    path = "".join(draw.choice(PATHS) for _ in range(draw.randint(1, 3)))
    return f"{scheme}://{host(draw)}{draw.choice(PORTS) if draw.random() < 0.3 else ''}{path}"


def url(draw: random.Random) -> str:
    port = draw.choice(["", "", ":80", ":443", ":8080", ":", ":x", ":99999", ":21", ":-1"])
    tail = "".join(draw.choice(URL_TAILS) for _ in range(draw.randint(1, 2)))
    return f"{draw.choice(URL_PARTS)}{draw.choice(USERINFO)}{host(draw).lstrip('*.')}{port}{tail}"


def raw_bytes(draw: random.Random) -> list[int]:
    out = []
    for _ in range(draw.randint(0, 24)):
        roll = draw.random()
        if roll < 0.3:
            out.extend(b"%" + draw.choice([b"41", b"e2", b"82", b"ac", b"c3", b"a9", b"f0", b"9f", b"98", b"80", b"ed", b"a0", b"zz", b"7e", b"2", b"c2", b"a0", b"ef", b"bb", b"bf"]))
        elif roll < 0.6:
            out.append(draw.randint(0, 255))
        else:
            out.extend(draw.choice(["é", "€", "😀", "a", "*", "?", "\\", "/"]).encode())
    return out


def glob(draw: random.Random) -> str:
    return "".join(draw.choice(GLOB_PIECES) for _ in range(draw.randint(0, 6)))


GENERATORS = {
    "urlmatch.decode": lambda draw: [raw_bytes(draw)],
    "urlmatch.unescape": lambda draw: [raw_bytes(draw)],
    "urlmatch.match_pattern": lambda draw: [[ord(c) if draw.random() > 0.05 else -1 for c in glob(draw)], [ord(c) for c in glob(draw)]],
    "urlmatch.glob_points": lambda draw: [glob(draw)],
    "urlmatch.ipv4": lambda draw: [draw.choice(IP_HOSTS + ASCII_HOSTS).strip("[]") or "x"],
    "urlmatch.canonical_host": lambda draw: [host(draw) or "x"],
    "urlmatch.parse": lambda draw: [pattern(draw)],
    "urlmatch.split": lambda draw: [url(draw)],
    "urlmatch.matches": lambda draw: [pattern(draw), url(draw)],
    "urlmatch.glob_matches": lambda draw: [glob(draw), url(draw)],
    "idna.encode": lambda draw: [unicode_text(draw, 1, 12)],
    "idna.nameprep": lambda draw: [unicode_text(draw, 1, 10)],
    "punycode.decodes": lambda draw: ["".join(draw.choice("abcxyz0129-") for _ in range(draw.randint(0, 20)))],
    "punycode.encode": lambda draw: [unicode_text(draw, 1, 12)],
    "ipv6.compressed": lambda draw: [draw.choice([h.strip("[]") for h in IP_HOSTS if h.startswith("[")] + ["::", "1::", "::1:2", "a:b:c:d:e:f:1:2"])],
}
STRINGPREP_DRIFT_HOSTS = ["\ub642\u10c2", "\u2241\U00010028\ua796\u0328\ucc74", "\u10a0", "\ua7c0"]


FIXED = {
    "urlmatch.js": [[]],
    "urlmatch.ipv4": [[h] for h in IP_HOSTS if not h.startswith("[")],
    "urlmatch.canonical_host": [[h] for h in ASCII_HOSTS + IP_HOSTS + UNICODE_HOSTS if h],
    "idna.encode": [[h] for h in UNICODE_HOSTS + STRINGPREP_DRIFT_HOSTS],
    "urlmatch.parse": [[f"http://{h}/*"] for h in STRINGPREP_DRIFT_HOSTS],
    "ipv6.compressed": [[h.strip("[]")] for h in IP_HOSTS if h.startswith("[")],
}


SPACES = [" ", "  ", "\t", "　", "\xa0", "\x1f", " ", "", "﻿"]
BREAKS = ["\n", "\r\n", "\r", "\x85", " ", "\x0b", "\x1c"]
KEYS = ["name", "namespace", "version", "description", "match", "exclude-match", "include", "exclude", "run-at", "inject-into",
        "noframes", "grant", "require", "resource", "author", "name:fr", "match:", "näme", "na_me", "x-y", "", "icon", "homepageURL"]
RUN_AT_VALUES = ["document-start", "document-end", "document-idle", "document_end", "", "Document-End", "context-menu"]
INJECT_VALUES = ["page", "content", "auto", "Page", "", "isolated", "__proto__", "constructor"]
GRANTS = ["none", "GM_xmlhttpRequest", "GM.getValue", "", "unsafeWindow"]
GLOBS = ["https://example.com/*", "*", "http://a.b/?", "/regex/", "//", "/a/", "", "a\tb", "a\x7fb", "https://x.com/\\*", "https://exact.com/page",
         "http://exact.org", "ftp://x/y"]


def entry_line(draw: random.Random) -> str:
    key = draw.choice(KEYS)
    if key in ("match", "exclude-match"):
        value = pattern(draw) if draw.random() < 0.6 else draw.choice(["https://example.com/*", "*://*.example.org/path*", "<all_urls>", "file:///*"])
    elif key in ("include", "exclude"):
        value = draw.choice(GLOBS) if draw.random() < 0.7 else glob(draw)
    elif key == "run-at":
        value = draw.choice(RUN_AT_VALUES)
    elif key == "inject-into":
        value = draw.choice(INJECT_VALUES)
    elif key == "grant":
        value = draw.choice(GRANTS)
    else:
        value = draw.choice(["Hello", "Hide Sidebar", "", "x" * 80, "Ünïcödé name", "a  b", "1.0.0", "-lead-", "日本", "\U0001f600 emoji", "KK"])
    lead = draw.choice(["//", "// ", "//\t", " // ", "/ /", "#"])
    middle = draw.choice(SPACES) if draw.random() < 0.9 else draw.choice(["=", ":", "!"])
    return f"{draw.choice(SPACES[:3])}{lead}@{key}{middle}{value}{draw.choice(SPACES)}"


def userscript_source(draw: random.Random) -> str:
    lines = []
    if draw.random() < 0.2:
        lines.append("console.log(1);")
    roll = draw.random()
    header = draw.choice(["// ==UserScript==", "//==UserScript==", "  //   ==UserScript==  ", "// ==UserScript", "// == UserScript =="]) if roll < 0.95 else ""
    if header:
        lines.append(header)
    for _ in range(draw.randint(0, 8)):
        lines.append(entry_line(draw))
    if draw.random() < 0.92:
        lines.append(draw.choice(["// ==/UserScript==", "//==/UserScript==", " // ==/UserScript== ", "// ==/UserScript"]))
    lines.append("document.body.dataset.x = 1;")
    return draw.choice(["", "﻿"]) + "".join(line + draw.choice(BREAKS) for line in lines)


def sourcemap_case(draw: random.Random) -> list:
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    rows = []
    for _ in range(draw.randint(0, 6)):
        segments = []
        for _ in range(draw.randint(0, 4)):
            count = draw.choice([1, 4, 4, 5])
            segments.append("".join(draw.choice("ACEGIKMOQSUWYacegikmoqsuwy024") + ("" if draw.random() < 0.8 else draw.choice("gkoswhlptx") + draw.choice("ACEG")) for _ in range(count)))
        rows.append(",".join(segments))
    data = {"version": 3, "sources": draw.sample(["a.ts", "b.ts", "../c.ts"], draw.randint(0, 3)), "mappings": ";".join(rows)}
    queries = [[draw.randint(-1, 8), draw.randint(0, 40)] for _ in range(draw.randint(1, 6))]
    return [data if draw.random() < 0.95 else None, draw.randint(0, 3), queries]


GENERATORS.update({
    "userscript.parse_meta": lambda draw: [userscript_source(draw), draw.choice(["x.user.ts", "hide-sidebar.user.js", ".hidden.ts", "a.b.c", "..", "", "日本.ts"])],
    "userscript.slug": lambda draw: [draw.choice(["Hello World", "  --x--  ", "", "日本", "KK", "İstanbul", "a" * 100 + "-b", "-" * 70 + "z"]) + unicode_text(draw, 0, 4)],
    "userscript.check_glob": lambda draw: [draw.choice(GLOBS) if draw.random() < 0.5 else glob(draw), draw.choice(["include", "exclude", "include_globs"])],
    "userscript.rules": lambda draw: [userscript_source(draw)],
    "userscript.url_runs": lambda draw: [userscript_source(draw), url(draw)],
    "userscript.default_url": lambda draw: [userscript_source(draw)],
    "userscript.manifest_entries": lambda draw: [userscript_source(draw), draw.choice(["js/x.js", "js/hide.js"])],
    "userscript.vlq": lambda draw: ["".join(draw.choice("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/") for _ in range(draw.randint(0, 8)))],
    "userscript.sourcemap": sourcemap_case,
})
