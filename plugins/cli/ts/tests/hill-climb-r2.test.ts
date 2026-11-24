import { expect, test } from "bun:test";
import { liveFormLabelUpdate } from "../src/browse/act/drift.ts";
import { diff, type Row, type View } from "../src/browse/changes/report.ts";
import { renderReport } from "../src/browse/changes/text.ts";
import { deltaRead } from "../src/browse/read/delta.ts";

test("deltaRead omits unchanged runs on same-tab re-reads while keeping new content", () => {
  const shared = Array.from({ length: 12 }, (_, i) => `- Conversation ${i + 1}: routine update`);
  const before = ["# Inbox", ...shared].join("\n");
  const after = ["# Inbox", ...shared, "## Kontor kickoff next week", "Meet Wednesday at 2:00 PM"].join("\n");
  const res = deltaRead(before, after);
  expect(res.omitted).toBeGreaterThanOrEqual(8);
  expect(res.text).toContain("unchanged lines omitted");
  expect(res.text).toContain("## Kontor kickoff next week");
  expect(res.text).toContain("Meet Wednesday at 2:00 PM");
  const same = deltaRead(after, after);
  expect(same.unchanged).toBe(true);
  expect(same.text).toContain("unchanged since last read");
});

test("liveFormLabelUpdate allows live composite and dynamic passenger labels but refuses unrelated swaps", () => {
  expect(
    liveFormLabelUpdate(
      "Battery life measured Signal's own test, as published h min",
      "Battery life measured Signal's own test, as published h 0 min",
    ),
  ).toBe(true);
  expect(liveFormLabelUpdate("Passenger 1 — no seat yet", "Jordan Lee — no seat yet")).toBe(true);
  expect(liveFormLabelUpdate("Email", "Credit card number")).toBe(false);
  expect(liveFormLabelUpdate("First name", "Password")).toBe(false);
});

function row(ref: string, role: string, name: string): Row {
  return { ref, level: 0, role, name, value: "", attrs: [], line: `${role} "${name}" [ref=${ref}]` };
}

test("diff folds unchanged same-origin header and footer chrome on new-document navigation", () => {
  const header = [row("e1", "link", "Home"), row("e2", "link", "Docks"), row("e3", "link", "Cart"), row("e4", "link", "Account")];
  const footer = [row("e9", "link", "Privacy"), row("e10", "link", "Terms")];
  const before: View = { target: "t1", loader: "L1", url: "http://shop.test/c/docks", title: "Docks", entries: [...header, row("e5", "link", "Harbor H12"), ...footer], containers: new Set() };
  const afterHeader = [row("e11", "link", "Home"), row("e12", "link", "Docks"), row("e13", "link", "Cart"), row("e14", "link", "Account")];
  const afterFooter = [row("e19", "link", "Privacy"), row("e20", "link", "Terms")];
  const after: View = { target: "t1", loader: "L2", url: "http://shop.test/p/harbor", title: "Harbor", entries: [...afterHeader, row("e15", "button", "Add to cart"), ...afterFooter], containers: new Set() };
  const report = diff(before, after, null, true);
  expect((report.chromePrefix ?? 0) + (report.chromeSuffix ?? 0)).toBe(6);
  expect(report.added.length).toBe(7);
  const text = renderReport(report);
  expect(text).toContain("6 unchanged site header/footer refs");
  expect(text).toContain('+ button "Add to cart" [ref=e15]');
  expect(text).not.toContain('+ link "Home"');
});
