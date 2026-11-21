import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import "./libc-loaded.ts";
import { parseDuration, pythonFloat, pythonInt } from "../src/browse/args.ts";
import { formatG, PythonCrash } from "../src/browse/errors.ts";
import { loadAnswer } from "../src/browse/pyjson.ts";
import { Secrets } from "../src/redact.ts";
import { decodeStdin } from "../src/browse/stdio.ts";

const CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const PYTHON = process.env.ARDIA_TEST_PYTHON ?? "python3";

function python(program: string, input: unknown): unknown {
  const run = spawnSync(PYTHON, ["-I", "-c", program, CLI], { input: JSON.stringify(input), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

const NUMBERS = ["7", " 7 ", "+007", "-0", "1_000", "1__0", "_1", "abc", "", "1.5", "٣", "١٢٣", "²", "9".repeat(4301), "1e3", ".5", "5.", "inf", "-Infinity", "nan", "1_0.5", "1e1_0", "e5", "0x10", " 　 42 ", "\x1c7", "7\x1f", "\x1d7\x1e", "\x857", "7\u2028", "\u00a07\u00a0", "\x1c1.5", "1.5\x1f", "\x851.5", "\u30001.5\u2029", "\x0b7\x0c"];

test("int() and float() read text exactly as Python does", () => {
  const expected = python(
    `import json, sys
def attempt(kind, text):
    try:
        value = kind(text)
    except ValueError:
        return None
    if isinstance(value, float):
        return None if value != value else repr(value)
    return str(value)
print(json.dumps([[attempt(int, t), attempt(float, t)] for t in json.load(sys.stdin)]))`,
    NUMBERS,
  ) as [string | null, string | null][];
  NUMBERS.forEach((text, index) => {
    const parsed = pythonInt(text);
    const asFloat = pythonFloat(text);
    const [wantInt, wantFloat] = expected[index] as [string | null, string | null];
    assert.equal("value" in parsed ? String(parsed.value) : null, wantInt, `int(${JSON.stringify(text)})`);
    const shown = asFloat === undefined || Number.isNaN(asFloat) ? null : asFloat === Infinity ? "inf" : asFloat === -Infinity ? "-inf" : asFloat;
    const want = wantFloat === null ? null : wantFloat === "inf" || wantFloat === "-inf" ? wantFloat : Number(wantFloat);
    assert.equal(shown, want, `float(${JSON.stringify(text)})`);
  });
});

const DURATIONS = ["10", "10ms", "1.5s", " 3m ", "2h", "1.", "ms", "10x", "٣s", "9".repeat(400) + "s", "0.0001s"];

test("--idle-timeout durations are read as parse_duration reads them", () => {
  const expected = python(
    `import json, sys
sys.path.insert(0, sys.argv[1])
from ardia_cli.browse.cli import parse_duration
from ardia_cli.browse.errors import Usage
out = []
for text in json.load(sys.stdin):
    try:
        out.append(str(parse_duration(text)))
    except Usage:
        out.append("invalid")
    except OverflowError:
        out.append("infinite")
print(json.dumps(out))`,
    DURATIONS,
  ) as string[];
  DURATIONS.forEach((text, index) => {
    const parsed = parseDuration(text);
    const shown = "ms" in parsed ? String(parsed.ms) : "invalid" in parsed ? "invalid" : "infinite";
    assert.equal(shown, expected[index], text);
  });
});

const GENERAL = [450, 560, 0.25, 1234565, 1234575, 0.0001, 0.00001, 123456789, 1e21, 2.5, 30.000001, 9223372036.854774];

test("seconds are shown as Python's :g shows them", () => {
  const expected = python(`import json, sys\nprint(json.dumps([f"{v:g}" for v in json.load(sys.stdin)]))`, GENERAL) as string[];
  GENERAL.forEach((value, index) => assert.equal(formatG(value), expected[index], String(value)));
});

const ANSWERS = ["", " ", "{", '{"a"', '{"a":', '{"a": }', '{"a":1,}', "[1,]", "[1 2]", '{"a" 1}', "{1:2}", '"abc', '"a\\x"', '"\\u12"', '"\\u12',
  '"\\u1234', '"\\ud800\\u12"', '"a\u0001"', "-", "-a", "01", "1.", "1e", "nul", "[", "[1", '{"a":1 "b"', "1 2", "Infinityx", "\n\n  x",
  '{"a":[1,{"b":}]}', '"\\uZZZZ"', '"\\ud800\\u"', '{"a":1,,}', "[,]", '"ab\\', "1".repeat(4301), '{"out": "x"}'];

test("a malformed answer fails with Python's exception line", () => {
  const expected = python(
    `import json, sys
out = []
for text in json.load(sys.stdin):
    try:
        json.loads(text.encode())
        out.append(None)
    except Exception as error:
        kind = type(error)
        name = kind.__name__ if kind.__module__ == "builtins" else f"{kind.__module__}.{kind.__name__}"
        out.append(f"{name}: {error}")
print(json.dumps(out))`,
    ANSWERS,
  ) as (string | null)[];
  ANSWERS.forEach((text, index) => {
    const loaded = loadAnswer(Buffer.from(text, "utf8"), 9991);
    assert.equal(loaded instanceof PythonCrash ? loaded.line : null, expected[index], text.slice(0, 40));
  });
});

const BYTES = ["ff", "7b2261223a22ff227d", "7b2261223a22e282227d", "efbbbf7b7d", "eda080", "e282", "f09f98", "c0af", "f4908080"];

test("undecodable answers and stdin fail as Python's decoders do", () => {
  const expected = python(
    `import json, sys
out = []
for hexed in json.load(sys.stdin):
    raw = bytes.fromhex(hexed)
    row = []
    try:
        json.loads(raw)
        row.append(None)
    except UnicodeDecodeError as error:
        row.append(f"UnicodeDecodeError: {error}")
    except ValueError:
        row.append("json")
    try:
        row.append(raw.decode("utf-8"))
    except UnicodeDecodeError as error:
        row.append(f"UnicodeDecodeError: {error}")
    row.append([ord(c) for c in raw.decode("utf-8", "surrogateescape")])
    out.append(row)
print(json.dumps(out))`,
    BYTES,
  ) as [string | null, string, number[]][];
  BYTES.forEach((hexed, index) => {
    const raw = Buffer.from(hexed, "hex");
    const [answer, strict, escaped] = expected[index] as [string | null, string, number[]];
    const loaded = loadAnswer(raw, 9991);
    if (answer !== "json") assert.equal(loaded instanceof PythonCrash ? loaded.line : null, answer, `answer ${hexed}`);
    const decoded = decodeStdin(raw, "strict");
    assert.equal(decoded instanceof PythonCrash ? decoded.line : decoded, strict, `stdin ${hexed}`);
    const loose = decodeStdin(raw, "surrogateescape") as string;
    assert.deepEqual([...loose].map((ch) => ch.codePointAt(0)), escaped, `surrogateescape ${hexed}`);
  });
});

const REDACTED = ["ws://h/x?token=abc123&b=1", 'say "token=abc123" there', '{"u":"/n?page_token=abc123"}', "token= token=\"q\" token=token=p",
  "token=é　x", "x token=a b", "a ab/c ab%2Fc SECRET12345678 b", "token=abc\\\"", "\u0085token=z\u0085"];

test("redaction masks exactly what redact.py masks", () => {
  const expected = python(
    `import json, sys
sys.path.insert(0, sys.argv[1])
from ardia_cli import redact
redact.add_secret("ab/c")
redact.add_secret("SECRET12345678")
print(json.dumps([redact.redact(t) for t in json.load(sys.stdin)]))`,
    REDACTED,
  ) as string[];
  const secrets = new Secrets();
  secrets.add("ab/c");
  secrets.add("SECRET12345678");
  REDACTED.forEach((text, index) => assert.equal(secrets.redact(text), expected[index], text));
});
