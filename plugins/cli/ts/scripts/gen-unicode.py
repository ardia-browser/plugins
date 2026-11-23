import argparse
import html.entities
import json
import sys
import unicodedata
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "src" / "pylib" / "unicode-data.ts"


def ranges(test) -> list[tuple[int, int]]:
    found: list[tuple[int, int]] = []
    start = None
    for code in range(0x110000 + 1):
        inside = code <= 0x10FFFF and test(chr(code))
        if inside and start is None:
            start = code
        elif not inside and start is not None:
            found.append((start, code - 1))
            start = None
    return found


def packed(spans: list[tuple[int, int]]) -> str:
    return " ".join(f"{start:x}" if start == end else f"{start:x}-{end:x}" for start, end in spans)


def decimal_starts() -> list[int]:
    starts = []
    for code in range(0x110000):
        char = chr(code)
        if char.isdecimal():
            value = unicodedata.decimal(char)
            if value == 0:
                starts.append(code)
            elif code - value not in starts:
                raise SystemExit(f"decimal digit U+{code:04X} doesn't follow its zero")
    return starts


def casefolds() -> str:
    pairs = []
    for code in range(0x110000):
        char = chr(code)
        if 0xD800 <= code < 0xE000:
            continue
        folded = char.casefold()
        if folded != char:
            pairs.append(f"{code:x}:" + ",".join(f"{ord(part):x}" for part in folded))
    return " ".join(pairs)


def source() -> str:
    tables = {
        "UNICODE_VERSION": unicodedata.unidata_version,
        "NOT_PRINTABLE": packed(ranges(lambda char: not char.isprintable())),
        "DIGIT": packed(ranges(str.isdigit)),
        "WORD": packed(ranges(lambda char: char.isalnum() or char == "_")),
        "ALPHA": packed(ranges(str.isalpha)),
        "DECIMAL_ZEROS": " ".join(f"{code:x}" for code in decimal_starts()),
        "CASEFOLD": casefolds(),
    }
    tables["HTML5_ENTITIES"] = json.dumps(html.entities.html5, ensure_ascii=True, separators=(",", ":"))
    lines = [f"export const {name} = {json_string(value)};" for name, value in tables.items()]
    return "\n".join(lines) + "\n"


def json_string(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def main() -> int:
    parser = argparse.ArgumentParser(description="Writes ts/src/pylib/unicode-data.ts from this Python's str methods "
                                     "(isprintable, isdigit, isalnum, isalpha, isdecimal, casefold) and html.entities.html5. --check compares instead.")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    text = source()
    if args.check:
        if not OUT.exists() or OUT.read_text() != text:
            print(f"gen-unicode: {OUT.name} differs from Python {sys.version.split()[0]}'s tables", file=sys.stderr)
            return 1
        return 0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text)
    print(f"gen-unicode: wrote {OUT.name} ({len(text)} bytes, Unicode {unicodedata.unidata_version})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
