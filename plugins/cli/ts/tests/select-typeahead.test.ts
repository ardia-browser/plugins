import { expect, test } from "bun:test";
import "./libc-loaded.ts";
import { exactPick, matchLevel, pickSuggestion, wholeWords, WORDS } from "../src/browse/act/fields.ts";

const PRIYA = { text: "PR Priya Raman priya.raman@northwind.dev · Engineering Manager", pieces: [] };
const CHEN = { text: "MC Marcus Chen marcus.chen@northwind.dev · Sales Lead", pieces: [] };
const CHENG = { text: "MC Marcus Cheng marcus.cheng@northwind.dev · Product Designer", pieces: [] };

test("a suggestion holding the text as whole words ranks above one that only contains it, for typeaheads only", () => {
  expect(matchLevel("Priya Raman", PRIYA)).toBe(WORDS);
  expect(matchLevel("Marcus Chen", CHEN)).toBe(WORDS);
  expect(matchLevel("Marcus Chen", CHENG)).toBe(1);
  expect(matchLevel("Marcus Chen", CHEN, false)).toBe(1);
  expect(pickSuggestion("Marcus Chen", [CHENG, CHEN], "Guests", true)).toBe(1);
  expect(() => pickSuggestion("Marcus Chen", [CHENG, CHEN], "Guests")).toThrow("matches 2 suggestions");
});

test("whole words respect emails, accents and combining marks", () => {
  expect(wholeWords("sam@example.com", "contact sam@example.com.au")).toBe(false);
  expect(wholeWords("sam@example.com", "contact sam@example.com, today")).toBe(true);
  expect(wholeWords("cafe", "café royal")).toBe(false);
  expect(wholeWords("café", "café royal")).toBe(true);
  expect(wholeWords("priya ram", "pr priya raman")).toBe(false);
  expect(wholeWords("brien", "o'brien")).toBe(false);
  expect(wholeWords("brien", "o\u2019brien")).toBe(false);
  expect(wholeWords("luc", "jean\u2011luc")).toBe(false);
  expect(wholeWords("sam@example.com", "tag+sam@example.com")).toBe(false);
  expect(matchLevel("Jos\u00e9 Silva", { text: "Directory Jose\u0301 Silva · Sales", pieces: [] })).toBe(WORDS);
});

test("an unchanged list is picked from only by an exact match", () => {
  expect(exactPick("Priya Raman", [PRIYA])).toBe(null);
  expect(exactPick("priya.raman@northwind.dev", [PRIYA])).toBe(0);
});

test("several equal matches stay ambiguous and name each one's full text", () => {
  expect(() => pickSuggestion("Marcus", [CHEN, CHENG], "Guests", true)).toThrow('"Marcus" matches 2 suggestions in Guests: "MC Marcus Chen marcus.chen@northwind.dev · Sales Lead", "MC Marcus Cheng');
});

test("an exact match keeps its exact form: a decomposed query picks its identical option over a precomposed one", () => {
  const decomposed = { text: "José Silva", pieces: [] };
  const precomposed = { text: "José Silva", pieces: [] };
  expect(exactPick("José Silva", [precomposed, decomposed])).toBe(1);
  expect(matchLevel("José Silva", precomposed, false)).toBe(0);
});

test("a joiner after a combining mark still joins the word", () => {
  expect(wholeWords("brien", "x̂'brien")).toBe(false);
  expect(wholeWords("luc", "jeax́-luc")).toBe(false);
});
