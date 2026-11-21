import assert from "node:assert/strict";
import { test } from "node:test";
import { codeLine } from "../src/browse/commands/batch-line.ts";

test("an eval line keeps its JavaScript quotes", () => {
  assert.deepEqual(codeLine('eval document.querySelectorAll("[title]").length'), ["eval", 'document.querySelectorAll("[title]").length']);
  assert.deepEqual(codeLine(`eval document.querySelector("a[href='x']").textContent`), ["eval", `document.querySelector("a[href='x']").textContent`]);
  assert.deepEqual(codeLine(`eval "document.querySelectorAll('[title]').length"`), ["eval", "document.querySelectorAll('[title]').length"]);
  assert.deepEqual(codeLine(`eval 'document.querySelectorAll("[title]").length'`), ["eval", 'document.querySelectorAll("[title]").length']);
  assert.deepEqual(codeLine(`eval document.title.replace(/'/g, "")`), ["eval", `document.title.replace(/'/g, "")`]);
});

test("eval and script flags still work before and after the code", () => {
  assert.deepEqual(codeLine('eval --main-world --timeout 5s document.querySelectorAll("[title]").length'), ["eval", "--main-world", "--timeout", "5s", 'document.querySelectorAll("[title]").length']);
  assert.deepEqual(codeLine('eval document.querySelectorAll("[title]").length --timeout 5s'), ["eval", 'document.querySelectorAll("[title]").length', "--timeout", "5s"]);
  assert.deepEqual(codeLine("eval 'document.title' --out t.txt"), ["eval", "document.title", "--out", "t.txt"]);
  assert.deepEqual(codeLine('script return [...document.querySelectorAll("[title]")].length'), ["script", 'return [...document.querySelectorAll("[title]")].length']);
  assert.equal(codeLine('click "[title]"'), null);
});
