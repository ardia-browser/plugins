import assert from "node:assert/strict";
import { test } from "node:test";
import { dumps, parse } from "../src/json.ts";
import { inert, shown } from "../src/printable.ts";
import { charCount } from "../src/py.ts";
import { codePoints, utf8 } from "../src/pystr.ts";

const ESCAPED_HIGH = Buffer.from("\\ud800");
const RAW_HIGH = Buffer.from([0xed, 0xa0, 0x80]);
const RAW_LOW = Buffer.from([0xed, 0xb0, 0x80]);
const ASTRAL = Buffer.from([0xf0, 0x90, 0x80, 0x80]);
const RAW_FFFF = Buffer.from([0xef, 0xbf, 0xbf]);

function stringOf(...parts: Buffer[]): string {
  const value = parse(Buffer.concat([Buffer.from('"'), ...parts, Buffer.from('"')]), 100);
  assert.equal(typeof value, "string");
  return value as string;
}

test("a surrogate Python read on its own stays apart from its neighbour", () => {
  const astral = stringOf(ASTRAL);
  assert.notEqual(stringOf(ESCAPED_HIGH, RAW_LOW), astral);
  assert.notEqual(stringOf(RAW_HIGH, RAW_LOW), astral);
  assert.notEqual(stringOf(RAW_HIGH, Buffer.from("\\udc00")), astral);
  assert.equal(stringOf(Buffer.from("\\ud800\\udc00")), astral);
  assert.equal(stringOf(ESCAPED_HIGH, RAW_LOW), stringOf(RAW_HIGH, RAW_LOW));
  assert.equal(stringOf(ESCAPED_HIGH, RAW_FFFF), stringOf(Buffer.from("\\ud800\\uffff")));
  assert.deepEqual(codePoints(stringOf(ESCAPED_HIGH, RAW_LOW)), ["\ud800", "\udc00"]);
  assert.equal(charCount(stringOf(ESCAPED_HIGH, RAW_LOW)), 2);
  assert.equal(charCount(astral), 1);
});

test("both keys survive a parse and print as Python prints them", () => {
  const doc = parse(Buffer.concat([Buffer.from('{"'), ESCAPED_HIGH, RAW_LOW, Buffer.from('":1,"'), ASTRAL, Buffer.from('":2}')]), 100);
  assert.ok(doc instanceof Map);
  assert.equal(doc.size, 2);
  assert.equal(utf8(dumps(doc, "compact")).toString("utf8"), '{"\u{10000}":1,"\u{10000}":2}');
  assert.equal(dumps(doc, "compact", true), '{"\\ud800\\udc00":1,"\\ud800\\udc00":2}');
});

test("a real U+FFFF after a lone high surrogate is printed once, however often the text is escaped", () => {
  const text = stringOf(ESCAPED_HIGH, RAW_FFFF);
  assert.equal(utf8(inert(shown(text))).toString("utf8"), "�￿");
  assert.equal(utf8(inert(shown(dumps(text, "spaced")))).toString("utf8"), '"�￿"');
});
