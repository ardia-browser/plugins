import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cascade, describeIssue, issueKind, sanitizedIssue } from "../src/browse/capture/devtools.ts";
import { logpointCondition, splitLocation } from "../src/browse/capture/logpoints.ts";
import { analyze, cruxLines, insightLines, rate } from "../src/browse/capture/perf.ts";
import { generatedPosition, mappingUrlOf, originalPosition, parseMap, sourceMatches } from "../src/browse/capture/sourcemaps.ts";

function rule(selector: string, origin: string, properties: Record<string, unknown>[], line = 0) {
  return { rule: { selectorList: { text: selector }, origin, styleSheetId: "s1", style: { cssProperties: properties, range: { startLine: line } } } };
}

test("the cascade: later beats earlier, !important beats later, the style attribute beats rules", () => {
  const matched = {
    matchedCSSRules: [
      rule("button", "user-agent", [{ name: "color", value: "buttontext" }]),
      rule(".primary", "regular", [{ name: "color", value: "red !important", important: true }, { name: "color", value: "red", important: true }, { name: "padding-top", value: "4px" }], 2),
      rule("#go", "regular", [{ name: "color", value: "blue" }, { name: "padding-top", value: "8px" }], 1),
    ],
    inlineStyle: { cssProperties: [{ name: "padding-top", value: "1px" }, { name: "margin-top", value: "2px" }] },
  };
  const { winners, losers } = cascade(matched, new Map([["s1", "https://site/a.css"]]));
  expect(winners.get("color")).toMatchObject({ value: "red", important: true, origin: ".primary (https://site/a.css:3)" });
  expect(losers.get("color")?.map((lost) => lost.value)).toEqual(["buttontext", "blue"]);
  expect(winners.get("padding-top")).toMatchObject({ value: "1px", origin: "style attribute" });
  expect(winners.get("margin-top")?.value).toBe("2px");
  expect(winners.get("color")?.agent).toBe(false);
});

test("issues read as one line with the reason in words", () => {
  expect(issueKind("CookieIssue")).toBe("cookie");
  expect(issueKind("ContentSecurityPolicyIssue")).toBe("csp");
  const cookie = describeIssue({
    code: "CookieIssue",
    details: { cookieIssueDetails: { cookie: { name: "sid", domain: "example.com" }, cookieExclusionReasons: ["ExcludeSameSiteNoneInsecure"], request: { url: "https://example.com/api" } } },
  });
  expect(cookie).toBe("[cookie] sid (example.com) on https://example.com/api: it says SameSite=None without Secure, so the browser drops it; add Secure");
  const cors = describeIssue({ code: "CorsIssue", details: { corsIssueDetails: { corsErrorStatus: { corsError: "MissingAllowOriginHeader" }, request: { url: "https://api/x" }, initiatorOrigin: "https://site" } } });
  expect(cors).toBe("[cors] https://api/x from https://site: MissingAllowOriginHeader");
  const csp = describeIssue({ code: "ContentSecurityPolicyIssue", details: { contentSecurityPolicyIssueDetails: { blockedURL: "https://site/a.png", violatedDirective: "img-src", contentSecurityPolicyViolationType: "kURLViolation" } } });
  expect(csp).toBe("[csp] kURLViolation: https://site/a.png broke img-src");
  expect(describeIssue({ code: "HeavyAdIssue", details: { heavyAdIssueDetails: { reason: "NetworkTotalLimit" } } })).toBe("[heavyad] HeavyAdIssue: NetworkTotalLimit");
});

test("a logpoint's condition logs in the paused scope and always answers false", () => {
  const condition = logpointCondition("lp1", "src/app.ts:4", "count * 2", null);
  const logged: unknown[][] = [];
  const console = { log: (...args: unknown[]) => logged.push(args) };
  const run = new Function("console", "count", `return ${condition};`);
  expect(run(console, 21)).toBe(false);
  expect(logged).toEqual([["[logpoint lp1 src/app.ts:4]", 42]]);
  const guarded = new Function("console", "count", `return ${logpointCondition("lp2", "a.js:1", "count", "count > 5")};`);
  logged.length = 0;
  expect(guarded(console, 1)).toBe(false);
  expect(logged).toEqual([]);
  const broken = new Function("console", `return ${logpointCondition("lp3", "a.js:1", "missing.value", null)};`);
  expect(broken(console)).toBe(false);
  expect(String(logged[0]?.[1])).toBe("logpoint error:");
  expect(splitLocation("src/app.ts:42")).toEqual({ file: "src/app.ts", line: 42, column: null });
  expect(splitLocation("https://site/app.js:3:9")).toEqual({ file: "https://site/app.js", line: 3, column: 9 });
  expect(splitLocation("app.js")).toBeNull();
  expect(splitLocation("app.js:0")).toBeNull();
});

test("source maps map both ways", () => {
  const loaded = parseMap(JSON.stringify({ version: 3, sources: ["src/app.ts"], sourceRoot: "", mappings: ";AAAA;AACA,MAAM;AACA" }));
  expect(loaded).not.toBeNull();
  if (loaded === null) return;
  expect(originalPosition(loaded, 1, 0)).toEqual({ url: "src/app.ts", line: 1, column: 1 });
  expect(originalPosition(loaded, 2, 7)).toEqual({ url: "src/app.ts", line: 2, column: 7 });
  expect(generatedPosition(loaded, "app.ts", 3, null)).toEqual({ line: 3, column: 0, source: "src/app.ts" });
  expect(generatedPosition(loaded, "other.ts", 1, null)).toBeNull();
  expect(sourceMatches("webpack:///./src/app.ts", "src/app.ts")).toBe(true);
  expect(sourceMatches("src/app.tsx", "app.ts")).toBe(false);
  expect(mappingUrlOf("var x;\n//# sourceMappingURL=app.js.map\n")).toBe("app.js.map");
  expect(parseMap("not json")).toBeNull();
});

test("a trace turns into load metrics, long tasks, main-thread time and render-blocking requests", () => {
  const main = { pid: 7, tid: 1 };
  const events = [
    { ph: "M", name: "thread_name", pid: 7, tid: 1, args: { name: "CrRendererMain" } },
    { ph: "R", name: "navigationStart", ts: 1_000_000, ...main },
    { ph: "R", name: "firstContentfulPaint", ts: 1_800_000, ...main },
    { ph: "R", name: "largestContentfulPaint::Candidate", ts: 2_000_000, ...main },
    { ph: "R", name: "largestContentfulPaint::Candidate", ts: 3_100_000, ...main },
    { ph: "I", name: "LayoutShift", ts: 2_100_000, ...main, args: { data: { weighted_score_delta: 0.08, had_recent_input: false } } },
    { ph: "I", name: "LayoutShift", ts: 2_200_000, ...main, args: { data: { weighted_score_delta: 0.5, had_recent_input: true } } },
    { ph: "X", name: "RunTask", ts: 1_900_000, dur: 250_000, ...main },
    { ph: "X", name: "RunTask", ts: 1_200_000, dur: 120_000, ...main },
    { ph: "X", name: "RunTask", ts: 2_500_000, dur: 30_000, ...main },
    { ph: "X", name: "EvaluateScript", ts: 1_900_000, dur: 200_000, ...main },
    { ph: "X", name: "Layout", ts: 2_000_000, dur: 40_000, ...main },
    { ph: "X", name: "RunTask", ts: 1_900_000, dur: 900_000, pid: 9, tid: 1 },
    { ph: "I", name: "ResourceSendRequest", ts: 1_100_000, pid: 7, tid: 1, args: { data: { url: "https://site/app.css", renderBlocking: "blocking" } } },
    { ph: "I", name: "ResourceSendRequest", ts: 1_100_000, pid: 7, tid: 1, args: { data: { url: "https://site/lazy.js", renderBlocking: "non_blocking" } } },
  ];
  const insights = analyze(events);
  expect(insights.metrics).toEqual([
    { name: "FCP", value: 800, unit: "ms", rating: "good" },
    { name: "LCP", value: 2100, unit: "ms", rating: "good" },
    { name: "CLS", value: 0.08, unit: "", rating: "good" },
    { name: "TBT", value: 200, unit: "ms", rating: "good" },
  ]);
  expect(insights.longTasks).toEqual({ count: 2, longestMs: 250, totalBlockingMs: 200, top: [{ startMs: 900, durationMs: 250 }, { startMs: 200, durationMs: 120 }] });
  expect(insights.mainThread).toEqual({ scripting: 200, rendering: 40 });
  expect(insights.renderBlocking).toEqual(["https://site/app.css"]);
  expect(insightLines(insights)).toEqual([
    "FCP 800 ms (good)  LCP 2,100 ms (good)  CLS 0.08 (good)  TBT 200 ms (good)",
    "long tasks: 2 over 50 ms (250 ms at 0.9 s, 120 ms at 0.2 s)",
    "main thread: scripting 200 ms, rendering 40 ms",
    "render-blocking: https://site/app.css",
  ]);
  expect(rate("LCP", 4100)).toBe("poor");
  expect(rate("CLS", 0.2)).toBe("needs improvement");
});

test("field data reads the 75th percentiles", () => {
  const lines = cruxLines({
    record: { metrics: { largest_contentful_paint: { percentiles: { p75: 3200 } }, cumulative_layout_shift: { percentiles: { p75: "0.05" } }, interaction_to_next_paint: { percentiles: { p75: 90 } } } },
  });
  expect(lines).toEqual(["field data (28 days, real users): LCP p75 3,200 ms (needs improvement)  INP p75 90 ms (good)  CLS p75 0.05 (good)"]);
  expect(cruxLines({})).toEqual(["field data: none for this origin"]);
});

test("installed skills are stamped and their state is told apart", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "skill-stamp-"));
  const saved = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    const skills = await import("../src/skills.ts");
    expect((await skills.install(["claude-code"], false, false)).status).toBe(0);
    const folder = path.join(home, ".claude/skills/ardia");
    const marker = JSON.parse(readFileSync(path.join(folder, ".ardia-skill"), "utf8"));
    expect(marker.hash).toBe(skills.packHash());
    expect(skills.copyState(folder).state).toBe("current");
    marker.hash = skills.contentHash([["SKILL.md", Buffer.from("old")]]);
    marker.files = ["SKILL.md"];
    writeFileSync(path.join(folder, ".ardia-skill"), JSON.stringify(marker));
    writeFileSync(path.join(folder, "SKILL.md"), "old");
    expect(skills.copyState(folder).state).toBe("stale");
    writeFileSync(path.join(folder, "SKILL.md"), "edited by hand");
    expect(skills.copyState(folder).state).toBe("edited");
    const status = skills.skillStatus();
    expect(status.out.some((line) => line.startsWith("edited   ") && line.includes(folder))).toBe(true);
    expect(status.out.at(-1)).toContain(`skill ${skills.packHash().slice(0, 12)}`);
  } finally {
    if (saved === undefined) delete process.env["HOME"];
    else process.env["HOME"] = saved;
    rmSync(home, { recursive: true, force: true });
  }
});
