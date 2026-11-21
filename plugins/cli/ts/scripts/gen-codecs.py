"""Writes src/browse/read/codecs.gen.json from this CPython's codec registry.

  python3 ts/scripts/gen-codecs.py [--check]

It lists every name bytes.decode() accepts (the encodings package's aliases and modules) with the codec it resolves to,
and the 256-entry decoding table of every single-byte codec, so `read --http` decodes a page's charset as Python does.
"""
import codecs
import encodings
import encodings.aliases
import json
import pkgutil
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "src" / "browse" / "read" / "codecs.gen.json"
SKIP_MODULES = {"aliases", "mbcs", "oem", "cp65001"}


def resolved(name: str):
    try:
        return codecs.lookup(name)
    except LookupError:
        return None


def single_byte(info) -> str | None:
    try:
        decoded = [bytes([value]).decode(info.name, errors="replace") for value in range(256)]
    except Exception:
        return None
    if any(len(text) != 1 for text in decoded):
        return None
    try:
        whole = bytes(range(256)).decode(info.name, errors="replace")
    except Exception:
        return None
    return whole if whole == "".join(decoded) and len(whole) == 256 else None


def main() -> int:
    if "--help" in sys.argv or "-h" in sys.argv:
        print(__doc__.strip())
        return 0
    names = set(encodings.aliases.aliases) | set(encodings.aliases.aliases.values())
    names |= {module.name for module in pkgutil.iter_modules(encodings.__path__)} - SKIP_MODULES
    codec_of = {}
    text = {}
    tables = {}
    for name in sorted(names):
        info = resolved(name)
        if info is None:
            continue
        codec_of[name] = info.name
        text[info.name] = bool(getattr(info, "_is_text_encoding", True))
        if text[info.name] and info.name not in tables and not info.name.startswith(("utf", "unicode")):
            table = single_byte(info)
            if table is not None:
                tables[info.name] = table
    payload = {"python": sys.version.split()[0], "names": codec_of, "text": text, "tables": tables}
    rendered = json.dumps(payload, ensure_ascii=True, sort_keys=True, separators=(",", ":")) + "\n"
    if "--check" in sys.argv:
        return 0 if OUT.read_text() == rendered else 1
    OUT.write_text(rendered)
    return 0


if __name__ == "__main__":
    sys.exit(main())
