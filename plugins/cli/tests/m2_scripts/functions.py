import ipaddress

from ardia_cli import urlmatch, userscript

UNWORDED = {"UnicodeError", "UnicodeEncodeError", "UnicodeDecodeError", "AddressValueError"}
FUNCTIONS: dict = {}


def failure(error: Exception) -> dict:
    kind = type(error).__name__
    if kind in UNWORDED:
        return {"error": "UnicodeError" if kind.startswith("Unicode") else kind}
    return {"error": f"{kind}: {error}"}


def oracle(name: str):
    def register(function):
        FUNCTIONS[name] = function
        return function

    return register


oracle("urlmatch.decode")(lambda data: urlmatch.decode(bytes(data)))
oracle("urlmatch.unescape")(lambda data: list(urlmatch.unescape(bytes(data))))
oracle("urlmatch.match_pattern")(urlmatch.match_pattern)
oracle("urlmatch.glob_points")(urlmatch.glob_points)
oracle("urlmatch.ipv4")(urlmatch.ipv4)
oracle("urlmatch.canonical_host")(urlmatch.canonical_host)
oracle("urlmatch.parse")(urlmatch.parse)
oracle("urlmatch.split")(urlmatch.split)
oracle("urlmatch.js")(lambda: urlmatch.JS)


@oracle("urlmatch.matches")
def matches(pattern: str, url: str) -> bool:
    return urlmatch.matches(urlmatch.parse(pattern), urlmatch.split(url))


@oracle("urlmatch.glob_matches")
def glob_matches(glob: str, url: str) -> bool:
    return urlmatch.glob_matches(urlmatch.glob_points(glob), url)


@oracle("idna.encode")
def idna_encode(text: str) -> str:
    return text.encode("idna").decode("ascii")


@oracle("idna.nameprep")
def idna_nameprep(text: str) -> str:
    from encodings.idna import nameprep

    return nameprep(text)


@oracle("punycode.decodes")
def punycode_decodes(text: str) -> bool:
    try:
        text.encode("ascii").decode("punycode")
    except (UnicodeError, ValueError):
        return False
    return True


oracle("punycode.encode")(lambda text: text.encode("punycode").decode("ascii"))
oracle("ipv6.compressed")(lambda text: ipaddress.IPv6Address(text).compressed)


def meta_of(source: str):
    return userscript.parse_meta(source, "probe.user.ts")


oracle("userscript.parse_meta")(lambda source, filename: userscript.parse_meta(source, filename).to_dict())
oracle("userscript.slug")(userscript.slug)
oracle("userscript.check_glob")(userscript.check_glob)
oracle("userscript.rules")(lambda source: userscript.rules(meta_of(source)))
oracle("userscript.url_runs")(lambda source, url: userscript.url_runs(meta_of(source), url))
oracle("userscript.default_url")(lambda source: userscript.default_url(meta_of(source)))
oracle("userscript.manifest_entries")(lambda source, js: userscript.manifest_entries(meta_of(source), js))
oracle("userscript.vlq")(userscript._vlq)


@oracle("userscript.sourcemap")
def sourcemap(data, offset: int, queries: list) -> list:
    found = userscript.SourceMap(data, offset)
    return [list(hit) if hit else None for hit in (found.lookup(line, column) for line, column in queries)]
