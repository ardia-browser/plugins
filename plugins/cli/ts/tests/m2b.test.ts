import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { getCloseMatches } from "../src/difflib.ts";
import type { Value } from "../src/json.ts";
import { JsonDecodeError, loads } from "../src/pyjson.ts";
import { search, translate } from "../src/pyregex.ts";
import { validate } from "../src/schema-check.ts";
import { split } from "../src/shlex.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const oracle = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", "m2b-oracle.json"), "utf8"));
const WORDS = ["tabLayout", "selectedTabGlow", "warnBeforeQuitting", "glassTintAmount", "sidebarWidth", "searchEngine", "cmd", "command", "opt", "option", "alt", "ctrl", "control", "shift", "fn", "pagedown", "pageup", "escape", "return"];

test("difflib: close matches agree with CPython's", () => {
    for (const [word, expected] of oracle.difflib.slice(0, -1)) assert.deepEqual([word, getCloseMatches(word, WORDS)], [word, expected]);
    const [word, expected] = oracle.difflib.at(-1);
    assert.deepEqual(getCloseMatches(word, ["ab".repeat(150), "x".repeat(300)]), expected);
});

test("pyjson: errors read as CPython's", () => {
    for (const [text, expected] of oracle.json) {
      let got: string | null = null;
      try {
        loads(text);
      } catch (error) {
        if (!(error instanceof JsonDecodeError)) throw error;
        got = error.message;
      }
      assert.deepEqual([text, got], [text, expected]);
    }
});

test("shlex: splits as CPython's posix shlex", () => {
    for (const [text, expected] of oracle.shlex) assert.deepEqual([text, split(text)], [text, expected]);
});

test("pyregex: ASCII classes stay ASCII and dot skips only newline", () => {
    assert.equal(search("^\\s$", true, " "), false);
    assert.equal(search("^\\s$", false, " "), true);
    assert.equal(search("^.$", true, "\r"), true);
    assert.equal(search("^.$", true, "\n"), false);
    assert.equal(search("^a{,2}$", true, "aa"), true);
    assert.equal(search("^[\\s\\S]$", true, "x"), true);
});

test("pyregex: Python-only syntax hands back", () => {
    assert.throws(() => translate("(?P<x>a)", true));
});

test("uniqueItems: a list naming a value twice is refused once per value, at its second appearance", () => {
  const schema = loads('{"type": "object", "properties": {"fields": {"type": "array", "uniqueItems": true}}}');
  const messages = validate(loads('{"fields": ["login", "code", "login", 1, 1.0, "login"]}'), schema).map((problem) => problem.message);
  assert.deepEqual(messages, ["fields has login twice", "fields has 1.0 twice"]);
  assert.deepEqual(validate(loads('{"fields": ["login", "code"]}'), schema), []);
});
