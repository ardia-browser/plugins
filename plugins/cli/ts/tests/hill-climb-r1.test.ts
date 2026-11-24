import { expect, test } from "bun:test";
import { trimSupersededChanges } from "../src/browse/commands/batch.ts";
import { fieldLine } from "../src/browse/commands/extract.ts";
import { dedupeChrome } from "../src/browse/read/chrome.ts";
import { linkMatcher } from "../src/browse/read/pages.ts";

test("dedupeChrome removes repeated site chrome across 3+ pages while keeping unique content", () => {
  const pages = [
    "Skip to content\nFree standard shipping over $99\n# Harbor H12\nPrice: $149.99\n© 2026 Kestrel Supply",
    "Skip to content\nFree standard shipping over $99\n# Sable Dual\nPrice: $169.99\n© 2026 Kestrel Supply",
    "Skip to content\nFree standard shipping over $99\n# Anvil Dock\nPrice: $189.99\n© 2026 Kestrel Supply",
  ];
  const { texts, omitted } = dedupeChrome(pages);
  expect(omitted).toBe(3);
  expect(texts[0]).toBe("# Harbor H12\nPrice: $149.99");
  expect(texts[1]).toBe("# Sable Dual\nPrice: $169.99");
  expect(texts[2]).toBe("# Anvil Dock\nPrice: $189.99");
  expect(dedupeChrome(pages.slice(0, 2)).omitted).toBe(0);
});

test("linkMatcher supports | alternation alongside substring and glob patterns", () => {
  const match = linkMatcher("pricing|security|changelog");
  expect(match("http://127.0.0.1:8891/pricing")).toBe(true);
  expect(match("http://127.0.0.1:8891/security")).toBe(true);
  expect(match("http://127.0.0.1:8891/changelog")).toBe(true);
  expect(match("http://127.0.0.1:8891/about")).toBe(false);
  const glob = linkMatcher("/v3/*|/docs/*");
  expect(glob("http://x.test/v3/plans")).toBe(true);
  expect(glob("http://x.test/docs/intro")).toBe(true);
  expect(glob("http://x.test/v2/plans")).toBe(false);
});

test("trimSupersededChanges drops redundant text and diffs before read, snapshot and form", () => {
  const report = [
    "✓ Done",
    "changes:",
    "url: http://x/a → http://x/b",
    "new document, 4 interactive nodes:",
    "+ textbox \"Email\" [ref=e1]",
    "+ button \"Save\" [ref=e2]",
    "text:",
    "  Long page prose line 1",
    "  Long page prose line 2",
    "POST /api/save → 200",
  ].join("\n");
  const beforeRead = trimSupersededChanges(report, true, false, false);
  expect(beforeRead).not.toContain("Long page prose");
  expect(beforeRead).toContain('+ button "Save" [ref=e2]');
  expect(beforeRead).toContain("POST /api/save → 200");
  const beforeForm = trimSupersededChanges(report, false, false, true);
  expect(beforeForm).not.toContain('+ textbox "Email"');
  expect(beforeForm).toContain('+ button "Save" [ref=e2]');
  expect(beforeForm).toContain("Long page prose");
  const beforeSnap = trimSupersededChanges(report, false, true, false);
  expect(beforeSnap).not.toContain('+ button "Save"');
  expect(beforeSnap).toContain("url: http://x/a → http://x/b");
  expect(beforeSnap).toContain("POST /api/save → 200");
});

test("fieldLine displays inline select option labels when provided", () => {
  const line = fieldLine({
    ref: "e32",
    role: "combobox",
    label: "Source article",
    type: "select",
    name: "source",
    value: "Choose an article…",
    checked: null,
    disabled: false,
    required: true,
    readonly: false,
    invalid: "",
    options: 3,
    optionLabels: ["Choose an article…", "Arclight X2 review", "Battery retest"],
  });
  expect(line).toContain('[options: "Choose an article…", "Arclight X2 review", "Battery retest"]');
  expect(line).not.toContain("(of 3)");
});
