import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import "./libc-loaded.ts";
import { splitGlobals } from "../src/browse/args.ts";
import { ardiaChainLines } from "../src/browse/capture/console.ts";
import { ardiaIssueLine, ardiaIssues, ardiaStyleLines, issueFingerprint, kindKey, sanitizedIssue } from "../src/browse/capture/devtools.ts";
import { ardiaPlace, bookListener } from "../src/browse/capture/logpoints.ts";
import { inspectionUnavailable, refusedBy } from "../src/browse/capture/inspect.ts";
import { ardiaFieldLines, ardiaPerfLines, earliest, sessionWindowCls } from "../src/browse/capture/perf.ts";
import { isInlineMap, MAX_CACHED_MAPS, MAX_INLINE_MAP_BYTES, inlineMapText, ScriptBook } from "../src/browse/capture/sourcemaps.ts";
import { failedText, failureLine } from "../src/browse/commands/batch.ts";
import { takeOut as daemonTakeOut } from "../src/browse/commands/batch.ts";
import { takeOut } from "../src/browse/outfile.ts";
import { ControlRefused, MethodUnknown } from "../src/browse/state/apptabs.ts";
import { ControlLink } from "../src/browse/state/controllink.ts";
import { subcommandFlagProblem } from "../src/browse/subcommand-flags.ts";
import { commandRoute } from "../src/commands-e.ts";
import { checkCommand } from "../src/skill-examples.ts";

function serve(file: string, answer: (request: Record<string, unknown>) => string[]): Promise<{ server: Server; connections: () => number }> {
  let count = 0;
  const server = createServer((connection) => {
    count += 1;
    let buffer = "";
    connection.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const request = JSON.parse(buffer.slice(0, at)) as Record<string, unknown>;
        buffer = buffer.slice(at + 1);
        for (const line of answer(request)) connection.write(`${line}\n`);
      }
    });
  });
  return new Promise((resolve) => server.listen(file, () => resolve({ server, connections: () => count })));
}

test("one control link carries several calls on one connection and says when it closes", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "link-"));
  const file = path.join(root, "ArdiaControl.sock");
  const { server, connections } = await serve(file, (request) => {
    const id = request["id"];
    if (request["method"] === "hello") return [JSON.stringify({ id, result: { app: "Ardia", protocol: 4 } })];
    if (request["method"] === "devtools.logpoint") return [JSON.stringify({ id, result: { id: "lp-7", label: "[logpoint lp-7]", matchedScript: "https://site/app.js" } })];
    if (request["method"] === "devtools.styles") return [JSON.stringify({ id, error: { code: "failed", message: "This Ardia can't open a DevTools inspection session on a tab yet." } })];
    return [JSON.stringify({ id, error: { code: "unknown_method", message: "unknown method" } })];
  });
  try {
    const link = await ControlLink.open(file, null);
    assert.deepEqual(await link.call("devtools.logpoint", { tab: "tab-1" }, 5), { id: "lp-7", label: "[logpoint lp-7]", matchedScript: "https://site/app.js" });
    await assert.rejects(link.call("devtools.clearLogpoint", { id: "lp-7" }, 5), (error: Error) => error instanceof MethodUnknown);
    await assert.rejects(link.call("devtools.styles", {}, 5), (error: Error) => inspectionUnavailable(error));
    assert.equal(connections(), 1);
    let closed = false;
    link.onClose(() => {
      closed = true;
    });
    const pending = link.call("devtools.never", {}, 5);
    link.close();
    await assert.rejects(pending, (error: Error) => error instanceof ControlRefused);
    assert.equal(closed, true);
    assert.equal(link.closed, true);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the engine's missing inspection session, an unknown method and no socket fall back; other refusals don't", () => {
  assert.equal(inspectionUnavailable(new MethodUnknown("unknown method")), true);
  assert.equal(inspectionUnavailable(new ControlRefused("not_connected", "gone")), true);
  assert.equal(inspectionUnavailable(new ControlRefused("failed", "This Ardia can't open a DevTools inspection session on a tab yet.")), true);
  assert.equal(inspectionUnavailable(new ControlRefused("failed", "the selector matched nothing")), false);
  assert.equal(inspectionUnavailable(new ControlRefused("refused", "Only a tab the ardia command opened can be reloaded for a trace.")), false);
  assert.equal(refusedBy("devtools.logpoint", new ControlRefused("refused", "Logpoints go only on a tab the ardia command opened."), "not_own_tab").code, "not_own_tab");
  assert.equal(refusedBy("devtools.perfTrace", new ControlRefused("timeout", "slow")).code, "timeout");
});

test("issues never carry a raw cookie line or a cookie value", () => {
  const raw = {
    code: "CookieIssue",
    details: { cookieIssueDetails: { cookie: { name: "sid", domain: "site", path: "/", value: "SECRET" }, rawCookieLine: "sid=SECRET; SameSite=None", cookieWarningReasons: ["WarnSameSiteNoneInsecure"] } },
  };
  const clean = JSON.stringify(sanitizedIssue(raw));
  assert.equal(clean.includes("SECRET"), false);
  assert.equal(clean.includes("sid"), true);
  const line = ardiaIssueLine({ code: "CookieIssue", kind: "cookie", title: "Cookie blocked", explanation: "SameSite=None needs Secure", fix: "Add Secure", affected: { cookie: { name: "sid", domain: "site" } } });
  assert.equal(line, "[cookie] Cookie blocked (cookie sid (site)): SameSite=None needs Secure Fix: Add Secure");
});

test("Ardia's perf, styles and stack answers read as lines", () => {
  const perf = ardiaPerfLines({
    metrics: { fcp: 800, lcp: { value: 2600, rating: "needs-improvement" }, cls: 0.02, tbt: 120 },
    insights: [{ id: "lcp-breakdown", title: "LCP breakdown", rating: "poor", summary: "render delay is most of it", savingsMs: 900 }],
    fieldData: { skipped: "The trace has no page load to tie field data to; record with reload." },
    rating: "needs-improvement",
  });
  assert.deepEqual(perf, [
    "FCP 800 ms (good)  LCP 2,600 ms (needs-improvement)  TBT 120 ms (good)  CLS 0.02 (good)",
    "[poor] LCP breakdown: render delay is most of it (could save 900 ms)",
    "field data: skipped: The trace has no page load to tie field data to; record with reload.",
    "overall: needs-improvement",
  ]);
  const styles = ardiaStyleLines(
    {
      properties: [
        {
          property: "color",
          computed: "rgb(255, 0, 0)",
          winner: { value: "red", important: true, selector: ".primary", source: { url: "https://site/a.css", line: 3 } },
          overridden: [{ value: "blue", selector: "#go", source: "https://site/a.css:2", reason: "lost to !important" }],
        },
      ],
    },
    true,
  );
  assert.deepEqual(styles, ["color: red !important  ← .primary (https://site/a.css:3)  [computed rgb(255, 0, 0)]", "  overridden: blue  ← #go (https://site/a.css:2) (lost to !important)"]);
  const chain = ardiaChainLines({
    chain: [
      { name: "Error", message: "outer", frames: [{ functionName: "boom", url: "https://site/app.js", line: 8, column: 3, original: { source: "src/app.ts", line: 7, column: 3 } }] },
      { name: "Error", message: "inner", frames: [] },
    ],
  });
  assert.deepEqual(chain, ["Error: outer", "    at boom (src/app.ts:7:3)  [https://site/app.js:8:3]", "  caused by: Error: inner"]);
});

test("only bounded inline source maps are read; nothing points at the network", () => {
  const map = JSON.stringify({ version: 3, sources: ["a.ts"], mappings: "AAAA" });
  const inline = `data:application/json;base64,${Buffer.from(map).toString("base64")}`;
  assert.equal(isInlineMap(inline), true);
  assert.equal(inlineMapText(inline), map);
  assert.equal(isInlineMap("https://site/app.js.map"), false);
  assert.equal(inlineMapText("https://site/app.js.map"), null);
  const huge = `data:application/json,${"x".repeat(MAX_INLINE_MAP_BYTES + 10)}`;
  assert.equal(inlineMapText(huge), null);
});

test("flags that belong to one subcommand are refused on another, by the command and by the example checker", () => {
  assert.match(subcommandFlagProblem("perf", "trace", ["trace", "--crux"]) ?? "", /goes with perf insight/u);
  assert.equal(subcommandFlagProblem("perf", "insight", ["insight", "--crux", "--reload"]), undefined);
  assert.match(subcommandFlagProblem("logpoint", "list", ["list", "--condition", "x"]) ?? "", /logpoint list doesn't take --condition/u);
  assert.match(checkCommand("ardia browse perf trace --crux")[0] ?? "", /goes with perf insight/u);
  assert.deepEqual(checkCommand("ardia browse perf insight --reload --crux"), []);
});

test("aliases keep their command's --out and owned flags", () => {
  assert.deepEqual(takeOut(["js", "document.title", "--out", "t.json"], "js"), [["js", "document.title"], "t.json"]);
  assert.deepEqual(takeOut(["snap", "-i", "--out=s.txt"], "snap"), [["snap", "-i"], "s.txt"]);
  assert.deepEqual(daemonTakeOut(["js", "1", "--out", "o.json"], "eval"), [["js", "1"], "o.json"]);
  const { found, rest } = splitGlobals(["shot", "--full", "a.png"]);
  assert.deepEqual(rest, ["shot", "--full", "a.png"]);
  assert.equal(found.flag("full"), undefined);
});

test("a failed batch line gets its code and remedy, in text and in its row", () => {
  const outcome: Parameters<typeof failureLine>[0] = { command: ["click", "@e9"], success: false, result: null, error: "Stale ref @e9: gone", code: "stale_ref" };
  assert.equal(failureLine(outcome), "✗ Stale ref @e9: gone (stale_ref)\n  remedy: ardia browse snapshot -i");
  assert.equal(outcome.remedy, "ardia browse snapshot -i");
  const usage: Parameters<typeof failureLine>[0] = { command: ["fill"], success: false, result: null, error: "Usage: ardia browse fill <sel> <text>", code: null };
  assert.equal(failureLine(usage), "✗ Usage: ardia browse fill <sel> <text> (usage)\n  remedy: ardia browse fill --help");
});

test("skills status --help is served by its own route, and a linked file in a copy reads as edited", async () => {
  assert.equal(commandRoute(["skills", "status", "--help"])?.label, "skills status");
  assert.equal(commandRoute(["skills", "status", "-h"])?.label, "skills status");
  const home = mkdtempSync(path.join(tmpdir(), "skill-status-"));
  const saved = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    const skills = await import("../src/skills.ts");
    assert.equal((await skills.install(["claude-code"], false, false)).status, 0);
    const folder = path.join(home, ".claude/skills/ardia");
    assert.equal(skills.copyState(folder).state, "current");
    const outside = path.join(home, "outside.md");
    writeFileSync(outside, "x");
    rmSync(path.join(folder, "SKILL.md"));
    symlinkSync(outside, path.join(folder, "SKILL.md"));
    assert.equal(skills.copyState(folder).state, "edited");
    assert.equal(skills.SKILLS_STATUS_HELP[0], "usage: ardia skills status [-h]");
  } finally {
    if (saved === undefined) delete process.env["HOME"];
    else process.env["HOME"] = saved;
    rmSync(home, { recursive: true, force: true });
  }
});

test("a control socket that isn't Ardia's fails the link's open instead of hanging", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "link-"));
  const file = path.join(root, "ArdiaControl.sock");
  const { server } = await serve(file, (request) => [JSON.stringify({ id: request["id"], result: { app: "Something else" } })]);
  try {
    await assert.rejects(ControlLink.open(file, null, 2), (error: Error) => error instanceof ControlRefused && error.code === "unreachable");
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Ardia's field data reads p75, good and poor; a logpoint's place comes from url, line and column", () => {
  assert.deepEqual(ardiaFieldLines({ origin: "https://site", metrics: { largest_contentful_paint: { p75: 3200, good: 0.61, poor: 0.12 }, cumulative_layout_shift: { p75: 0.05, good: 0.9, poor: 0.02 } } }), [
    "field data (28 days, real users): LCP p75 3,200 ms (needs improvement; 61% good, 12% poor)  CLS p75 0.05 (good; 90% good, 2% poor)",
  ]);
  assert.deepEqual(ardiaFieldLines({ origin: "https://site", found: false }), ["field data: none for this origin"]);
  assert.equal(ardiaPlace({ url: "https://site/app.js", line: 5, column: 3, matchedScript: true }, "src/app.ts:4"), "https://site/app.js:5:3");
  assert.equal(ardiaPlace({ matchedScript: false }, "src/app.ts:4"), "src/app.ts:4");
});

test("issue kinds match either way they're spelled, and cleared issues stay cleared", () => {
  assert.equal(kindKey("mixed"), kindKey("mixed-content"));
  assert.equal(kindKey("heavy-ad"), kindKey("heavyad"));
  const answer = { issues: [{ code: "MixedContentIssue", kind: "mixed-content", title: "Mixed content", affected: { request: "http://x/a.png" } }, { code: "CorsIssue", kind: "cors", title: "CORS", affected: { request: "https://api/x" } }] };
  assert.equal(ardiaIssues(answer, new Set(["mixed"])).length, 1);
  const cleared = new Set([issueFingerprint(answer.issues[0] as Record<string, unknown>)]);
  assert.deepEqual(ardiaIssues(answer, null, cleared).map((issue) => issue["kind"]), ["cors"]);
});

test("the script book keeps at most 16 inline maps and forgets every script when the main frame navigates", () => {
  const book = new ScriptBook();
  const inline = (n: number) => `data:application/json,${encodeURIComponent(JSON.stringify({ version: 3, sources: [`s${n}.ts`], mappings: "AAAA" }))}`;
  for (let n = 0; n < 40; n += 1) book.add(String(n), `https://site/${n}.js`, inline(n));
  assert.equal(book.mapCount, MAX_CACHED_MAPS);
  assert.equal(book.size, 40);
  book.add("x", "https://site/x.js", "https://site/x.js.map");
  assert.equal([...book.values()].find((script) => script.url === "https://site/x.js")?.sourceMapURL, null);
  const page = {} as Parameters<typeof bookListener>[0];
  const listener = bookListener(page, book);
  listener(page, "Page.frameNavigated", { frame: { id: "child", parentId: "main" } });
  assert.equal(book.size, 41);
  listener(page, "Page.frameNavigated", { frame: { id: "main" } });
  assert.equal(book.size, 0);
  assert.equal(book.mapBytes, 0);
});

test("CLS is the worst session window, and a million timestamps don't overflow the stack", () => {
  const second = 1_000_000;
  assert.equal(sessionWindowCls([{ ts: 0, score: 0.1 }, { ts: 0.5 * second, score: 0.1 }, { ts: 3 * second, score: 0.15 }]), 0.2);
  const steady = Array.from({ length: 12 }, (_, index) => ({ ts: index * 0.9 * second, score: 0.05 }));
  assert.ok(Math.abs(sessionWindowCls(steady) - 0.3) < 1e-9);
  const many = Array.from({ length: 1_000_000 }, (_, index) => ({ ts: 1_000 + index }));
  assert.equal(earliest(many), 1_000);
});

test("a failed batch row that already has text still gets its remedy, and its code", () => {
  const row: Parameters<typeof failedText>[0] = { command: ["click", "@e9"], success: false, result: null, error: "Stale ref @e9", code: "stale_ref", text: "→ changes\n✗ Stale ref @e9" };
  assert.equal(failedText(row), "→ changes\n✗ Stale ref @e9\n  remedy: ardia browse snapshot -i");
  const usage: Parameters<typeof failedText>[0] = { command: ["fill"], success: false, result: null, error: "Usage: ardia browse fill <sel> <text>", code: null };
  failedText(usage);
  assert.equal(usage.code, "usage");
});

test("skills status is read-only: it never recovers an aside copy, skips a FIFO record and a linked references folder", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "skill-ro-"));
  const saved = { home: process.env["HOME"], cli: process.env["ARDIA_CLI_HOME"] };
  process.env["HOME"] = home;
  process.env["ARDIA_CLI_HOME"] = path.join(home, "cli");
  try {
    const skills = await import("../src/skills.ts");
    assert.equal((await skills.install(["claude-code"], false, false)).status, 0);
    const parent = path.join(home, ".claude/skills");
    const aside = path.join(parent, ".ardia.old");
    mkdirSync(aside);
    writeFileSync(path.join(aside, "SKILL.md"), "old");
    const record = path.join(home, "cli", "skills.json");
    rmSync(record, { force: true });
    assert.equal(spawnSync("mkfifo", [record]).status, 0);
    const status = skills.skillStatus();
    assert.equal(existsSync(aside), true);
    assert.ok(status.out.some((line) => line.startsWith("current ")));
    const folder = path.join(parent, "ardia");
    const references = path.join(folder, "references");
    const moved = path.join(home, "elsewhere");
    spawnSync("mv", [references, moved]);
    symlinkSync(moved, references);
    assert.equal(skills.copyState(folder).state, "edited");
  } finally {
    if (saved.home === undefined) delete process.env["HOME"];
    else process.env["HOME"] = saved.home;
    if (saved.cli === undefined) delete process.env["ARDIA_CLI_HOME"];
    else process.env["ARDIA_CLI_HOME"] = saved.cli;
    rmSync(home, { recursive: true, force: true });
  }
});
