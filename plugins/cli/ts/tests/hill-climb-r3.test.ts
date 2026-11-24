import { describe, expect, test } from "bun:test";
import { preferLabelFirst } from "../src/browse/commands/act.ts";
import { trimSupersededChanges } from "../src/browse/commands/batch.ts";
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

  test("does not emit leading pipes for empty first cells or skipped nav tables", () => {
    const html = `<html><body><nav><table><tr><td>NavA</td><td>NavB</td></tr></table></nav><table><tr><td></td><td>Only</td></tr></table></body></html>`;
    const { content } = extractHtml(html, true);
    expect(content).toBe("Only");
  });
});

describe("Codex review hardening regressions", () => {
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
  });

  test("trimSupersededChanges preserves text confirmations before form", () => {
    const output = "✓ Done\nchanges:\n+ textbox \"Name\" [ref=e2]\ntext:\n  Saved successfully";
    const trimmed = trimSupersededChanges(output, false, false, true);
    expect(trimmed).toContain("Saved successfully");
    expect(trimmed).not.toContain('textbox "Name"');
  });
});
