import os
from pathlib import Path

from cases import PIECES, generator, many, noise

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
SPIKES = Path(os.environ.get("ARDIA_M3_SPIKES", "/Users/barreloflube/ardia-scratch/ts-port/m3-spikes"))


def recorded_html(count: int) -> list[str]:
    pages = sorted(FIXTURES.rglob("*.html"))
    if count >= 1000:
        pages += [path for path in (SPIKES / "mid.html", SPIKES / "big.html") if path.exists()]
    return [path.read_text(errors="surrogateescape") for path in pages]

SHELL = [" ", "  ", "\t", "\n", "\r", "a", "bc", "'", '"', "\\", "\\\\", "#", "x=y", "😀", "\ud800", "é", "$HOME", "*", "--flag", "''", '""', "\\'", '\\"', ";", "|"]


@generator("shlex.split")
def gen_split(rng, count, corpus):
    fixed = [["a 'b c' \"d\\\"e\""], ["'unterminated"], ["trailing\\"], ["\"\\a\\\\\\$\""], [""], ["   "], ["''"], ["a''b"]]
    return many(rng, count, fixed, lambda: [noise(rng, SHELL, 10)])


@generator("shlex.quote")
def gen_quote(rng, count, corpus):
    return many(rng, count, [[""], ["safe-path/x.y"], ["it's"]], lambda: [noise(rng, SHELL + ["@", "%", "+", "=", ":", ",", ".", "/", "-", "ß"], 6)])


WORDS = ["Save", "save", "Submit", "Cancel", "a", "b", "the", " ", "x", "😀", "\ud800"]


def text_pair(rng):
    if rng.random() < 0.15:
        base = "".join(rng.choice("abcde ") for _ in range(rng.randint(150, 400)))
        other = list(base)
        for _ in range(rng.randint(0, 30)):
            other[rng.randrange(len(other))] = rng.choice("abcxyz")
        return [base, "".join(other)]
    a = noise(rng, WORDS + list("abcd"), 12)
    b = a if rng.random() < 0.1 else noise(rng, WORDS + list("abcd"), 12)
    return [a, b]


@generator("difflib.ratio")
def gen_ratio(rng, count, corpus):
    return many(rng, count, [["", ""], ["a", ""]], lambda: text_pair(rng) if rng.random() < 0.8 else [[rng.choice(WORDS) for _ in range(rng.randint(0, 8))],
                                                                                                   [rng.choice(WORDS) for _ in range(rng.randint(0, 8))]])


@generator("difflib.opcodes")
def gen_opcodes(rng, count, corpus):
    return gen_ratio(rng, count, corpus)


def page(rng):
    lines = [rng.choice(["heading", "button Save", "link Home", "text one", "text two", ""]) + str(rng.randint(0, 3)) for _ in range(rng.randint(0, 30))]
    return "\n".join(lines) + rng.choice(["", "\n", "\r\n"])


@generator("difflib.unified")
def gen_unified(rng, count, corpus):
    def make():
        before = page(rng)
        after_lines = before.splitlines()
        for _ in range(rng.randint(0, 5)):
            roll = rng.random()
            if roll < 0.4 and after_lines:
                del after_lines[rng.randrange(len(after_lines))]
            elif roll < 0.7:
                after_lines.insert(rng.randint(0, len(after_lines)), "new " + str(rng.randint(0, 9)))
            elif after_lines:
                after_lines[rng.randrange(len(after_lines))] = "changed"
        return [before, "\n".join(after_lines)]
    return many(rng, count, [["", ""], ["a", "a"]], make)


@generator("str.splitlines")
def gen_splitlines(rng, count, corpus):
    breaks = ["\n", "\r", "\r\n", "\v", "\f", "\x1c", "\x1d", "\x1e", "\x1f", "\x85", " ", " ", "a", "b", " "]
    return many(rng, count, [], lambda: [noise(rng, breaks, 10), rng.random() < 0.5])


ENTITIES = ["&amp;", "&amp", "&ampx", "&AMP;", "&lt", "&#65;", "&#65", "&#x41;", "&#X41", "&#0;", "&#13;", "&#128;", "&#x9f;", "&#xD800;", "&#99999999999;",
            "&#1114112;", "&#xfffe;", "&#11;", "&notit;", "&notin;", "&NotEqualTilde;", "&#", "&#x", "&;", "& ", "&&", "&" + "a" * 40, "&a😀b;", "&\r", "&frac12x",
            "&#0000065;", "&#x0000000000041;", "&ensp;", "&nbsp", "&zwj;", "&grave;"]


@generator("html.unescape")
def gen_unescape(rng, count, corpus):
    return many(rng, count, [], lambda: ["".join(rng.choice(ENTITIES + ["x", " ", "<", "#", ";", "é"]) for _ in range(rng.randint(0, 6)))])


TAGS = ["<p>", "</p>", "<div class='a'>", "<DIV CLASS=\"b\">", "<br/>", "<br />", "<img src=x alt='a&amp;b'>", "<a href=\"/x?a=1&b=2\">", "</a>",
        "<script>", "if (a < b) { x = '</div>'; }", "</script>", "</SCRIPT >", "<style>p{}</style>", "<title>T &amp; t</title>", "<textarea>&lt;x</textarea>",
        "<!-- comment -->", "<!--->", "<!---->", "<!-- a --!>", "<!DOCTYPE html>", "<!doctype x", "<![CDATA[x]]>", "<?php x ?>", "<!bogus>", "</ >", "</>",
        "<h1>", "</h1>", "<h7>", "<li>", "<ul>", "</ul>", "<input disabled value=a>", "<x y z=1 w='2' v=\"3\" u>", "< p>", "<1>", "<a/b>", "text", " ", "\n",
        "&amp;", "&", "&#65", "<", ">", "é", "😀", "<plaintext>", "<xmp>a</p></xmp>", "<p\ttitle=\"x\"\n>", "<p =x>", "<p a=>", "<p a = 'b' / >", "<svg><path/></svg>",
        "<nav>menu</nav>", "<head><title>H</title></head>", "<template>t</template>", "<noscript>n</noscript>", "<footer>f</footer>", "</p\n>", "<p/>"]


def html_doc(rng, most=25):
    return "".join(rng.choice(TAGS) for _ in range(rng.randint(0, most)))


@generator("html.parse")
def gen_parse(rng, count, corpus):
    def make():
        doc = html_doc(rng)
        if rng.random() < 0.3 and doc:
            doc = doc[: rng.randint(0, len(doc))]
        chunks = [doc]
        if rng.random() < 0.3 and len(doc) > 2:
            cut = rng.randint(1, len(doc) - 1)
            chunks = [doc[:cut], doc[cut:]]
        return [chunks, rng.random() < 0.5]
    return many(rng, count, [[[page], True] for page in recorded_html(count)], make)


@generator("readurl.extract")
def gen_extract(rng, count, corpus):
    return many(rng, count, [[page] for page in recorded_html(count)], lambda: [html_doc(rng, 40)])


MARKDOWN = ["# Title", "## Install", "### Usage", "####### seven", "#nospace", "text line", "  indented", "", "- [Guide](/guide.md)", "[Home](https://a.example/)",
            "[Bad](no space)", "Filter me", "\r", "## Install again"]


def markdown(rng):
    return "\n".join(rng.choice(MARKDOWN) for _ in range(rng.randint(0, 15)))


@generator("readurl.sections")
def gen_sections(rng, count, corpus):
    return many(rng, count, [], lambda: [markdown(rng)])


@generator("readurl.post_process")
def gen_post(rng, count, corpus):
    return many(rng, count, [], lambda: [markdown(rng), rng.random() < 0.4, rng.choice([None, "", "install", "INSTALL", "zzz", "guide"])])


SOURCES = ["https://a.example/llms.txt", "https://a.example/docs/llms.txt", "http://h/", "https://h/a/b?q#f"]
HREFS = ["/guide.md", "guide.md", "../up.md", "./x", "https://other.example/x", "//cdn/x", "?q=1", "#frag", "", "a/../b/./c", "g;x?y#s", "mailto:x@y",
         "..", ".", "../../../../g", "http:g", "//g"]


@generator("readurl.llms_links")
def gen_links(rng, count, corpus):
    def make():
        text = "\n".join(f"- [{rng.choice(['Guide', 'API', 'a]b', ''])}]({rng.choice(HREFS)})" + rng.choice(["", " extra", "]"]) for _ in range(rng.randint(0, 8)))
        return [text, rng.choice(SOURCES), rng.choice([None, "", "guide", "API"])]
    return many(rng, count, [], make)


@generator("readurl.candidates")
def gen_candidates(rng, count, corpus):
    urls = ["https://a.example/", "https://a.example", "https://a.example/docs/page", "https://a.example/docs/page/", "https://a.example/a//b?q=1#f",
            "http://h:8080/x/y/z.html", "https://u@h/p"]
    return many(rng, count, [], lambda: [rng.choice(urls), rng.choice(["llms.txt", "llms-full.txt"])])


@generator("urllib.urljoin")
def gen_urljoin(rng, count, corpus):
    bases = ["http://a/b/c/d;p?q", "https://a.example/docs/", "https://a.example/docs", "", "http://a", "ftp://h/x/", "mailto:x", "http://a/b/c/../d"]
    return many(rng, count, [], lambda: [rng.choice(bases), rng.choice(HREFS + ["g", "./g", "g/", "/g", "?y", "g?y", "#s", "g#s", ";x", "g;x", "../g", "../..",
                                                                                 "http://other/x", "https:g"])])


@generator("format.comma")
def gen_comma(rng, count, corpus):
    return many(rng, count, [[0], [-1], [999], [1000], [-1000000], [10**30]], lambda: [rng.randint(-10**12, 10**12) * rng.choice([1, 1, 10**rng.randint(0, 9)])])
