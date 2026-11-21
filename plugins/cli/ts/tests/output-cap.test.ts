import { expect, test } from "bun:test";
import "./libc-loaded.ts";
import { regionNarrower, render, Result } from "../src/browse/daemon/render.ts";
import { commandHelp } from "../src/browse/help.ts";

function snapshotText(): string {
  const lines = ["- navigation"];
  for (let index = 0; index < 300; index += 1) lines.push(`  - link "Link number ${index}" [ref=e${index + 1000}]`);
  lines.push("- main");
  for (let index = 0; index < 600; index += 1) lines.push(`  - button "Button number ${index}" [ref=e${index + 2}]`);
  lines.push("- contentinfo", "  - link \"Privacy\" [ref=e999]");
  return lines.join("\n");
}

test("a capped output prints its notice once, on stderr, with the saved file named last and never as advice", () => {
  const [, out, err] = render({}, new Result({}, snapshotText()), null, "snapshot");
  expect(`${out}${err}`.split("[output capped at ").length - 1).toBe(1);
  expect(out).not.toContain("[output capped at ");
  expect(err.startsWith("[output capped at ")).toBe(true);
  expect(err).not.toContain("all of it is in");
  expect(err).toMatch(/; or --max-output \d+ for every line \(full output: [^)]*output-[a-z0-9_]{8}\.txt\)\]\n$/u);
});

test("a capped snapshot leads with the -s of its biggest region", () => {
  const [, , err] = render({}, new Result({}, snapshotText()), null, "snapshot");
  expect(err).toContain('Narrow it: snapshot -i -s "[role=main]" (the main, 601 of 904 lines)');
  expect(err.indexOf("Narrow it:")).toBeLessThan(err.indexOf("--max-output"));
  expect(regionNarrower("- list\n  - listitem\n- list\n  - listitem")).toBe(null);
  expect(regionNarrower("- button \"a\"\n- button \"b\"")).toBe(null);
  expect(regionNarrower(["- main", ...Array.from({ length: 50 }, () => "  - button")].join("\n"))).toBe(null);
  expect(regionNarrower(["- banner", ...Array.from({ length: 5 }, () => "  - link"), "- main", ...Array.from({ length: 5 }, () => "  - button")].join("\n"))).toContain('"[role=main]"');
});

test("a capped read points at --match, and the help gives one default limit", () => {
  const [, , err] = render({}, new Result({}, "x\n".repeat(20000)), null, "read");
  expect(err).toContain("read --scroll -s <list> --match <text>");
  expect(commandHelp(undefined)).toContain("Cap text output (default 12000, 20000 for script");
  expect(commandHelp(undefined)).not.toContain("default 6000");
  expect(commandHelp("read")).not.toContain("saved whole to a file");
});

test("with --content-boundaries the notice stays outside the page's markers", () => {
  const [, out, err] = render({ content_boundaries: true }, new Result({}, "y\n".repeat(20000), true), null, "get");
  expect(out.trimEnd().endsWith(">>>")).toBe(true);
  expect(out).not.toContain("[output capped at ");
  expect(err.startsWith("[output capped at ")).toBe(true);
});
