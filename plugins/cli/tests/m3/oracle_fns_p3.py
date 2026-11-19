import difflib
import html
import html.parser
import shlex
from urllib.parse import urljoin, urlunsplit

from ardia_cli.browse import readurl


class Recorder(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.events = []

    def handle_starttag(self, tag, attrs):
        self.events.append(["start", tag, [list(pair) for pair in attrs]])

    def handle_endtag(self, tag):
        self.events.append(["end", tag])

    def handle_data(self, data):
        self.events.append(["data", data])

    def handle_comment(self, data):
        self.events.append(["comment", data])

    def handle_decl(self, decl):
        self.events.append(["decl", decl])

    def handle_pi(self, data):
        self.events.append(["pi", data])

    def unknown_decl(self, data):
        self.events.append(["unknown", data])


def parse(chunks: list, close: bool):
    parser = Recorder()
    for chunk in chunks:
        parser.feed(chunk)
    if close:
        parser.close()
    return {"events": parser.events, "rest": parser.rawdata, "lasttag": parser.lasttag}


def extract(text: str):
    extractor = readurl.TextExtractor()
    extractor.feed(text)
    content = extractor.text()
    return {"content": content, "title": readurl.re.sub(r"\s+", " ", extractor.title).strip()}


def candidates(url: str, name: str):
    out = []
    parts = readurl.urlsplit(url)
    path = parts.path.rstrip("/")
    while True:
        out.append(urlunsplit((parts.scheme, parts.netloc, (path or "") + "/" + name, "", "")))
        if not path:
            return out
        path = path.rsplit("/", 1)[0]


def register(oracle):
    oracle("shlex.split")(shlex.split)
    oracle("shlex.quote")(shlex.quote)
    oracle("difflib.ratio")(lambda a, b: difflib.SequenceMatcher(None, a, b).ratio())
    oracle("difflib.opcodes")(lambda a, b: [list(code) for code in difflib.SequenceMatcher(None, a, b).get_opcodes()])
    oracle("difflib.unified")(lambda before, after: list(difflib.unified_diff(before.splitlines(), after.splitlines(), "before", "after", lineterm="")))
    oracle("str.splitlines")(lambda text, keep: text.splitlines(keep))
    oracle("html.unescape")(html.unescape)
    oracle("html.parse")(parse)
    oracle("readurl.extract")(extract)
    oracle("readurl.sections")(lambda text: [[heading, lines] for heading, lines in readurl.sections(text)])
    oracle("readurl.post_process")(lambda content, outline, filter_: readurl.post_process(content, {"outline": outline, "filter": filter_}))
    oracle("readurl.llms_links")(lambda text, source, filter_: [f"- {title}: {urljoin(source, href)}" for title, href in readurl.LINK.findall(text)
                                                                if not filter_ or filter_.lower() in f"- {title}: {urljoin(source, href)}".lower()])
    oracle("readurl.candidates")(candidates)
    oracle("urllib.urljoin")(urljoin)
    oracle("format.comma")(lambda value: f"{value:,}")
