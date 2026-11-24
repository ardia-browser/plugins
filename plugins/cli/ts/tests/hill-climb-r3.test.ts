import { describe, expect, test } from "bun:test";
import { preferLabelFirst } from "../src/browse/commands/act.ts";
import { compactBatchLines, trimSupersededChanges } from "../src/browse/commands/batch.ts";
import { liveFormLabelUpdate } from "../src/browse/act/drift.ts";
import { dedupeChrome } from "../src/browse/read/chrome.ts";
import { deltaRead } from "../src/browse/read/delta.ts";
import { extractHtml } from "../src/browse/read/readurl.ts";

describe("preferLabelFirst", () => {
  test("prefers label lookup for plain words including HTML tag names that are not form controls", () => {
    expect(preferLabelFirst("Title")).toBe(true);
    expect(preferLabelFirst("title")).toBe(true);
    expect(preferLabelFirst("Summary")).toBe(true);
    expect(preferLabelFirst("Time")).toBe(true);
    expect(preferLabelFirst("Address")).toBe(true);
    expect(preferLabelFirst("Full name")).toBe(true);
  });

  test("keeps CSS-first for actual form control tags, explicit -s selectors, and CSS/ref selectors", () => {
    expect(preferLabelFirst("input")).toBe(false);
    expect(preferLabelFirst("TEXTAREA")).toBe(false);
    expect(preferLabelFirst("select")).toBe(false);
    expect(preferLabelFirst("Title", true)).toBe(false);
    expect(preferLabelFirst("@e5")).toBe(false);
    expect(preferLabelFirst("#title")).toBe(false);
    expect(preferLabelFirst("input[name=title]")).toBe(false);
    expect(preferLabelFirst(".field input")).toBe(false);
  });
});

describe("extractHtml table formatting", () => {
  test("separates adjacent table cells with pipes instead of concatenating them", () => {
    const html = `<html><body><table>
      <thead><tr><th>Plan</th><th>Price</th><th>Burst</th></tr></thead>
      <tbody>
        <tr><td>Starter</td><td>Free</td><td>10/s</td></tr>
        <tr><td>Team</td><td>$99</td><td>50/s</td></tr>
      </tbody>
    </table></body></html>`;
    const { content } = extractHtml(html, true);
    expect(content).toBe("Plan | Price | Burst\nStarter | Free | 10/s\nTeam | $99 | 50/s");
  });

  test("preserves column alignment for empty cells, collapses cell paragraphs, and supports keepChrome", () => {
    const html = `<html><body><nav><table><tr><td>NavA</td><td>NavB</td></tr></table></nav><table><tr><td></td><td>100</td></tr><tr><td><p>Line 1</p><p>Line 2</p></td><td>200</td></tr></table></body></html>`;
    const { content } = extractHtml(html, true);
    expect(content).toBe("| 100\nLine 1 Line 2 | 200");
    const footer = extractHtml(`<footer id="contact"><p>Support: 555-0100</p></footer>`, true, true);
    expect(footer.content).toBe("Support: 555-0100");
    const nested = extractHtml(`<table><tr><td>Account A</td><td><table><tr><td>Detail</td><td>Extra</td></tr></table></td><td>$100</td></tr></table>`, true);
    expect(nested.content).toBe("Account A | Detail Extra | $100");
  });
});

describe("Codex review hardening regressions", () => {
  test("deltaRead returns full text instead of claiming removal when middle exceeds LCS budget", () => {
    const end = Array.from({ length: 180 }, (_, i) => `Shared edge ${i}`);
    const middle = Array.from({ length: 500 }, (_, i) => `Row ${i}`);
    const before = [...end, "Heading A", ...middle, "Total A", ...end].join("\n");
    const after = [...end, "Heading B", ...middle, "Total B", ...end].join("\n");
    const result = deltaRead(before, after);
    expect(result.omitted).toBe(0);
    expect(result.text).toBe(after);
    expect(result.text).not.toContain("removed");
  });
  test("deltaRead preserves order and never suppresses reversed lines", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `Line ${i + 1} with distinct content`);
    const forward = lines.join("\n");
    const reversed = [...lines].reverse().join("\n");
    const result = deltaRead(forward, reversed);
    expect(result.omitted).toBe(0);
    expect(result.text).toBe(reversed);
  });

  test("deltaRead reports middle deletions instead of hiding them in an unchanged run", () => {
    const before = [
      "Header 1", "Header 2", "Header 3", "Header 4", "Header 5", "Header 6",
      "Balance: $420.00",
      "Footer 1", "Footer 2", "Footer 3", "Footer 4", "Footer 5", "Footer 6",
    ].join("\n");
    const after = [
      "Header 1", "Header 2", "Header 3", "Header 4", "Header 5", "Header 6",
      "Footer 1", "Footer 2", "Footer 3", "Footer 4", "Footer 5", "Footer 6",
    ].join("\n");
    const result = deltaRead(before, after);
    expect(result.text).toContain("1 line removed");
  });

  test("deltaRead reports opening line replacements instead of hiding them", () => {
    const shared = Array.from({ length: 10 }, (_, i) => `Stable row ${i + 1}`);
    const before = ["Old headline", ...shared].join("\n");
    const after = ["New headline", ...shared].join("\n");
    const result = deltaRead(before, after);
    expect(result.text).toContain("New headline");
    expect(result.text).toContain("1 line removed");
  });

  test("liveFormLabelUpdate refuses purpose swaps and passenger slot swaps", () => {
    expect(liveFormLabelUpdate("Primary contact email", "Primary contact phone")).toBe(false);
    expect(liveFormLabelUpdate("Billing email — required", "Recovery phone — required")).toBe(false);
    expect(liveFormLabelUpdate("Passenger 1 — no seat yet", "Passenger 2 — no seat yet")).toBe(false);
    expect(liveFormLabelUpdate("Guest 1 — required", "Billing address — required")).toBe(false);
    expect(liveFormLabelUpdate("Guest 1 — no seat yet", "Billing address — no seat yet")).toBe(false);
    expect(liveFormLabelUpdate("Email", "Email (password)")).toBe(false);
    expect(liveFormLabelUpdate("Email", "Email password")).toBe(false);
    expect(liveFormLabelUpdate("Passenger 1 — no seat yet", "Jordan Lee — no seat yet")).toBe(true);
    expect(liveFormLabelUpdate("Guests", "Guests (2 selected)")).toBe(true);
  });

  test("dedupeChrome preserves repeated body lines, short identical pages, and cross-origin pages", () => {
    const shortPages = [
      ["Header Brand", "Invoice #101", "Status: approved", "Total: $120", "Footer Co"].join("\n"),
      ["Header Brand", "Invoice #102", "Status: approved", "Total: $240", "Footer Co"].join("\n"),
      ["Header Brand", "Invoice #103", "Status: approved", "Total: $360", "Footer Co"].join("\n"),
    ];
    const sameOrigin = dedupeChrome(shortPages, ["https://a.example", "https://a.example", "https://a.example"]);
    expect(sameOrigin.omitted).toBe(2);
    expect(sameOrigin.texts.every((t) => t.includes("Status: approved"))).toBe(true);
    expect(sameOrigin.texts.every((t) => !t.includes("Header Brand") && !t.includes("Footer Co"))).toBe(true);
    const identicalShort = ["Line A\nLine B", "Line A\nLine B", "Line A\nLine B"];
    const kept = dedupeChrome(identicalShort, ["https://a.example", "https://a.example", "https://a.example"]);
    expect(kept.omitted).toBe(0);
    expect(kept.texts).toEqual(identicalShort);
    const crossOrigin = dedupeChrome(shortPages, ["https://a.example", "https://b.example", "https://c.example"]);
    expect(crossOrigin.omitted).toBe(0);
    const invoices = [
      ["Payment status: overdue", "Invoice #101", "Amount: $120"].join("\n"),
      ["Payment status: overdue", "Invoice #102", "Amount: $240"].join("\n"),
      ["Payment status: overdue", "Invoice #103", "Amount: $360"].join("\n"),
    ];
    const keptInvoices = dedupeChrome(invoices, ["https://a.example", "https://a.example", "https://a.example"]);
    expect(keptInvoices.omitted).toBe(0);
    expect(keptInvoices.texts).toEqual(invoices);
  });

  test("trimSupersededChanges preserves text confirmations before form", () => {
    const output = "✓ Done\nchanges:\n+ textbox \"Name\" [ref=e2]\ntext:\n  Saved successfully";
    const trimmed = trimSupersededChanges(output, false, false, true);
    expect(trimmed).toContain("Saved successfully");
    expect(trimmed).not.toContain('textbox "Name"');
  });

  test("compactBatchLines preserves change reports before depth-limited, interactive, or scoped snapshots", () => {
    const initial = "✓ Clicked\nchanges:\n+ button \"Confirm\" [ref=e9]\ntext:\n  Order ready";
    for (const followCmd of [
      ["snapshot", "-d", "1"],
      ["snapshot", "--depth=2"],
      ["snapshot", "-i"],
      ["snapshot", "--diff"],
      ["snapshot", "find", "Confirm"],
      ["snapshot", "--out", "/tmp/snap.txt"],
    ]) {
      const outcomes = [
        { command: ["click", "@e1"], success: true, text: initial, result: null, error: null },
        { command: followCmd, success: true, text: "partial snapshot", result: null, error: null },
      ];
      compactBatchLines(outcomes);
      expect(outcomes[0]?.text).toBe(initial);
    }
    const fullOutcomes = [
      { command: ["click", "@e1"], success: true, text: initial, result: null, error: null },
      { command: ["snapshot", "-c"], success: true, text: "full snapshot", result: null, error: null },
    ];
    compactBatchLines(fullOutcomes);
    expect(fullOutcomes[0]?.text).toBe("✓ Clicked");
    for (const [cmd, res] of [
      [["snapshot"], { fit: true }],
      [["snapshot"], { modal: { name: "Dialog" } }],
      [["form"], { more: true }],
      [["read"], { truncated: true }],
    ] as const) {
      const partial = [
        { command: ["click", "@e1"], success: true, text: initial, result: null, error: null },
        { command: [...cmd], success: true, text: "partial", result: res as Record<string, unknown>, error: null },
      ];
      compactBatchLines(partial);
      expect(partial[0]?.text).toBe(initial);
    }
    const overCapRead = [
      { command: ["click", "@e1"], success: true, text: initial, result: null, error: null },
      { command: ["read"], success: true, text: "x".repeat(13_000), result: { truncated: false, source: "active-tab-html" }, error: null },
    ];
    compactBatchLines(overCapRead);
    expect(overCapRead[0]?.text).toBe(initial);
  });
});
