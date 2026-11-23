import json
import math
import random
import sys

random.seed(int(sys.argv[1]) if len(sys.argv) > 1 else 7)

ATOMS = ['"', "\\", "u", "d83d", "de00", "ud800", "1234", "12g4", "{", "}", "[", "]", ",", ":", " ", "\n", "\r", "\t", "\x01",
         "a", "é", "😀", "0", "-", "1", "e", "E", "+", ".", "5", "NaN", "Infinity", "-Infinity", "null", "true", "false",
         '"k"', '"v"', "1e400", "﻿", "x", "/", "b", "n", "\\u", "\\ud83d\\ude00", "\\ud800", '"a":1', "99999999999999999999"]


class Refused(Exception):
    pass


def strict(text):
    def unique(pairs):
        found = {}
        for key, value in pairs:
            if key in found:
                raise Refused(f"--params has the key {json.dumps(key)} twice")
            found[key] = value
        return found

    def no_constant(name):
        raise Refused(f"--params has {name}, which isn't JSON")

    def finite_float(literal):
        value = float(literal)
        if not math.isfinite(value):
            raise Refused(f"--params has the number {literal[:24]}, which is too large for JSON")
        return value

    def bounded_int(literal):
        value = int(literal)
        try:
            float(value)
        except OverflowError:
            raise Refused(f"--params has the number {literal[:24]}…, which is too large for JSON") from None
        return value

    try:
        value = json.loads(text, object_pairs_hook=unique, parse_constant=no_constant, parse_float=finite_float, parse_int=bounded_int)
        return {"ok": json.dumps(value, ensure_ascii=True, allow_nan=True)}
    except Refused as error:
        return {"refused": str(error)}
    except ValueError as error:
        return {"error": str(error)}


def lenient(text):
    try:
        return {"ok": json.dumps(json.loads(text), ensure_ascii=True)}
    except ValueError as error:
        return {"error": str(error)}


fixed = ['{"a": "\\u1234', '"\\u1234', '"\\u123', '"\\ud83d\\ude00', '"\\ud83d\\ude00"', '"\\ud83d\\ude0"', '"\\ud83d\\u"', '"\\ud83d\\', '"\\ud83d\\x"',
         '"\\ud83d\\ude00x"', '"\\ud83d\\ud83d\\ude00"', '"\\', '"ab\\', '"\\u"', '"\\uzzzz"', "[1,]", "{,}", "[,]", '{"a":1,}', "-", "-x", "01",
         "1.", "1e", "1e+", ".5", "1.5e3", "-0", "-0.0", "1E400", "[1 2]", '{"a" 1}', '{"a":}', "", " ", "﻿[]", "[NaN]", "[-Infinity]",
         '{"a":1,"a":2}', '{"a":{"b":1,"b":2},"a":3}', "9" * 400, "-" + "9" * 400, "1" * 4301, "[" + "1" * 4301 + "]", "[1.5e999]", "tru", "nul",
         '"\x1f"', '"\x7f"', "[1]x", "[1] ", "\n[1]\n\t", "{\n\"a\" :\r\n 1 }", '"\\/\\b\\f\\n\\r\\t\\"\\\\"']
cases = list(fixed)
for _ in range(4000):
    cases.append("".join(random.choice(ATOMS) for _ in range(random.randint(1, 10))))
for text in cases:
    print(json.dumps({"text": text, "strict": strict(text), "lenient": lenient(text)}))
