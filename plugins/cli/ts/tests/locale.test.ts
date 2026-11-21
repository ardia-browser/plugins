import assert from "node:assert/strict";
import { test } from "node:test";
import { stdioErrorsFor } from "../src/browse/stdio.ts";

test("plugin browse reads the locale on Linux as on macOS; other Linux browse goes to Python", () => {
  const installed = () => true;
  assert.equal(stdioErrorsFor("linux", "en_US.UTF-8", true, installed), "strict");
  assert.equal(stdioErrorsFor("linux", "C.UTF-8", true, installed), "surrogateescape");
  assert.equal(stdioErrorsFor("linux", "", true, installed), "surrogateescape");
  assert.equal(stdioErrorsFor("linux", "en_US.ISO-8859-1", true, installed), undefined);
  assert.equal(stdioErrorsFor("linux", "en_US.UTF-8", false, installed), undefined);
  assert.equal(stdioErrorsFor("darwin", "en_US.UTF-8", false, installed), "strict");
  assert.equal(stdioErrorsFor("darwin", "en_US.UTF-8", false, () => false), "surrogateescape");
  assert.equal(stdioErrorsFor("darwin", "../x", true, installed), undefined);
});
