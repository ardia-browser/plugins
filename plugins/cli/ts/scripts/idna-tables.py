"""Writes ts/src/urlmatch/idna-data.ts: the stringprep and Unicode 3.2 tables behind Python's "idna" codec.

  python3.13 ts/scripts/idna-tables.py [OUT]

Each table is read from the running Python (stringprep and unicodedata.ucd_3_2_0), one code point at a time, so
the TypeScript nameprep maps, normalizes and refuses exactly the characters the bundled CPython does. As in
CPython, ucd_3_2_0's NFKC decomposes with Unicode 3.2 but orders and composes with the current Unicode's tables.
"""
import stringprep
import sys
import unicodedata
from pathlib import Path
from unicodedata import ucd_3_2_0 as ucd

LAST = 0x10FFFF
HANGUL = range(0xAC00, 0xD7A4)


def points():
    return range(LAST + 1)


def ranges(test) -> str:
    out, start, previous, last = [], None, None, 0
    for cp in points():
        if test(chr(cp)):
            if start is None:
                start = cp
            previous = cp
        elif start is not None:
            out.append(f"{start - last:x}+{previous - start:x}")
            last, start = previous, None
    if start is not None:
        out.append(f"{start - last:x}+{previous - start:x}")
    return " ".join(out)


def hexes(text: str) -> str:
    return ".".join(f"{ord(char):x}" for char in text)


def mapping(produce) -> str:
    out, last = [], 0
    for cp in points():
        value = produce(chr(cp))
        if value is not None:
            out.append(f"{cp - last:x}:{hexes(value)}")
            last = cp
    return " ".join(out)


def mapped(char: str):
    if stringprep.in_table_b1(char):
        return ""
    value = stringprep.map_table_b2(char)
    return value if value != char else None


def decomposed(char: str):
    if ord(char) in HANGUL:
        return None
    value = ucd.normalize("NFKD", char)
    return value if value != char else None


def composites(char: str):
    parts = unicodedata.decomposition(char).split()
    if len(parts) != 2 or parts[0].startswith("<"):
        return None
    pair = "".join(chr(int(part, 16)) for part in parts)
    return pair if ucd.normalize("NFC", pair) == char else None


def prohibited(char: str) -> bool:
    return any(test(char) for test in (stringprep.in_table_c12, stringprep.in_table_c22, stringprep.in_table_c3, stringprep.in_table_c4,
                                       stringprep.in_table_c5, stringprep.in_table_c6, stringprep.in_table_c7, stringprep.in_table_c8,
                                       stringprep.in_table_c9))


def combining() -> str:
    out, last = [], 0
    for cp in points():
        value = unicodedata.combining(chr(cp))
        if value:
            out.append(f"{cp - last:x}:{value:x}")
            last = cp
    return " ".join(out)


def main(argv: list[str]) -> int:
    if argv and argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    out = Path(argv[0]) if argv else Path(__file__).resolve().parents[1] / "src" / "urlmatch" / "idna-data.ts"
    tables = {
        "MAPPED": mapping(mapped),
        "DECOMPOSED": mapping(decomposed),
        "COMPOSED": mapping(composites),
        "COMBINING": combining(),
        "PROHIBITED": ranges(prohibited),
        "RAND_AL": ranges(stringprep.in_table_d1),
        "LEFT_TO_RIGHT": ranges(stringprep.in_table_d2),
    }
    lines = [f'export const {name} = "{value}";' for name, value in tables.items()]
    out.write_text("\n".join(lines) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
