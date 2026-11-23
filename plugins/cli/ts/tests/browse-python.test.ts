import assert from "node:assert/strict";
import { test } from "bun:test";
import "./libc-loaded.ts";
import { parseDuration, pythonFloat, pythonInt } from "../src/browse/args.ts";
import { formatG, PythonCrash } from "../src/browse/errors.ts";
import { loadAnswer } from "../src/browse/pyjson.ts";
import { Secrets } from "../src/redact.ts";
import { decodeStdin } from "../src/browse/stdio.ts";
import { oracle } from "./oracle-fixtures.ts";

type Pairs<I, O> = [I, O][];
const FROZEN = oracle<{
  numbers: Pairs<string, [string | null, string | null]>;
  durations: Pairs<string, string>;
  general: Pairs<number, string>;
  answers: Pairs<string, string | null>;
  bytes: Pairs<string, [string | null, string, number[]]>;
  redacted: Pairs<string, string>;
}>("browse-python");

function frozen<I, O>(rows: Pairs<I, O>, size: number): [I[], O[]] {
  assert.equal(rows.length, size);
  return [rows.map(([given]) => given), rows.map(([, want]) => want)];
}

test("int() and float() read text exactly as Python does", () => {
  const [numbers, expected] = frozen(FROZEN.numbers, 36);
  numbers.forEach((text, index) => {
    const parsed = pythonInt(text);
    const asFloat = pythonFloat(text);
    const [wantInt, wantFloat] = expected[index] as [string | null, string | null];
    assert.equal("value" in parsed ? String(parsed.value) : null, wantInt, `int(${JSON.stringify(text)})`);
    const shown = asFloat === undefined || Number.isNaN(asFloat) ? null : asFloat === Infinity ? "inf" : asFloat === -Infinity ? "-inf" : asFloat;
    const want = wantFloat === null ? null : wantFloat === "inf" || wantFloat === "-inf" ? wantFloat : Number(wantFloat);
    assert.equal(shown, want, `float(${JSON.stringify(text)})`);
  });
});

test("--idle-timeout durations are read as parse_duration reads them", () => {
  const [durations, expected] = frozen(FROZEN.durations, 11);
  durations.forEach((text, index) => {
    const parsed = parseDuration(text);
    const shown = "ms" in parsed ? String(parsed.ms) : "invalid" in parsed ? "invalid" : "infinite";
    assert.equal(shown, expected[index], text);
  });
});

test("seconds are shown as Python's :g shows them", () => {
  const [general, expected] = frozen(FROZEN.general, 12);
  general.forEach((value, index) => assert.equal(formatG(value), expected[index], String(value)));
});

test("a malformed answer fails with Python's exception line", () => {
  const [answers, expected] = frozen(FROZEN.answers, 38);
  answers.forEach((text, index) => {
    const loaded = loadAnswer(Buffer.from(text, "utf8"), 9991);
    assert.equal(loaded instanceof PythonCrash ? loaded.line : null, expected[index], text.slice(0, 40));
  });
});

test("undecodable answers and stdin fail as Python's decoders do", () => {
  const [bytes, expected] = frozen(FROZEN.bytes, 9);
  bytes.forEach((hexed, index) => {
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

test("redaction masks exactly what redact.py masks", () => {
  const [redacted, expected] = frozen(FROZEN.redacted, 9);
  const secrets = new Secrets();
  secrets.add("ab/c");
  secrets.add("SECRET12345678");
  redacted.forEach((text, index) => assert.equal(secrets.redact(text), expected[index], text));
});
