#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { launchBrowser, quitBrowser } from "./cdp";
import { ROWS, type RowContext } from "./rows";
import { startServer } from "./server";
import { Tab, type Mode } from "./tab";

const HELP = `Drives the human test pages (ardia#2812) over a full DevTools connection.

  bun drive.ts --app <Browser.app> [--headed] [--rows 1,2,3] [--modes full,naive] [--flags "--enable-automation"] [--out results.json] [--scratch dir]

--app      a Chromium-family .app started with --remote-debugging-port and no --enable-automation
--headed   run a visible window, opened in the background with open -g; default is --headless=new
--rows     rows to run; default all
--modes    full (trusted input, isolated worlds, no Runtime.enable), naive (main-world Runtime.evaluate after
           Runtime.enable, element.click()), naive-debugger (naive plus Debugger.enable), gesture-eval
           (isolated-world evaluate with userGesture); default every mode a row lists
--flags    extra browser flags, e.g. --flags=--enable-automation for the control run
--out      write every result as JSON here
--reference  row 11: the browser-UI height of a run without --enable-automation, to compare against`;

const { values } = parseArgs({
  options: {
    app: { type: "string" },
    headed: { type: "boolean", default: false },
    rows: { type: "string" },
    modes: { type: "string" },
    flags: { type: "string" },
    out: { type: "string" },
    scratch: { type: "string" },
    reference: { type: "string" },
    help: { type: "boolean", default: false },
  },
});

if (values.help || !values.app) {
  console.log(HELP);
  process.exit(values.help ? 0 : 2);
}

const scratchRoot = values.scratch ?? join(import.meta.dir, ".scratch");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, "run-"));
const wantedRows = values.rows ? new Set(values.rows.split(",").map(Number)) : null;
const wantedModes = values.modes ? new Set(values.modes.split(",") as Mode[]) : null;
const headless = !values.headed;
const extraFlags = values.flags ? values.flags.split(" ").filter(Boolean) : [];

const server = startServer();
const base = `http://127.0.0.1:${server.port}`;
const launch = await launchBrowser(values.app, { headless, extraFlags, scratch });
const version = await launch.cdp.send("Browser.getVersion");
const results: any[] = [];
const baselines: Record<string, unknown> = values.reference ? { reference: Number(values.reference) } : {};

try {
  for (const row of ROWS) {
    if (wantedRows && !wantedRows.has(row.row)) continue;
    if (!headless && row.headed === false) continue;
    for (const mode of row.modes) {
      if (wantedModes && !wantedModes.has(mode)) continue;
      const { browserContextId } = await launch.cdp.send("Target.createBrowserContext", { disposeOnDetach: true });
      const rowBase = row.host ? base.replace("127.0.0.1", row.host) : base;
      const context: RowContext = { launch, cdp: launch.cdp, base: rowBase, mode, scratch, browserContextId, notes: {}, baselines };
      const started = Date.now();
      let tab: Tab | undefined;
      let entry: any;
      try {
        tab = row.open ? await row.open(context) : await Tab.open(launch.cdp, mode, { browserContextId });
        if (row.before) await row.before(tab, context);
        const { targetInfo } = await launch.cdp.send("Target.getTargetInfo", { targetId: tab.targetId });
        if (!targetInfo.url.includes(row.page)) await tab.goto(`${rowBase}/${row.page}`);
        await row.act(tab, context);
        const result = await tab.finish();
        entry = { row: row.row, mode, pass: result.pass, measured: result.measured, driver: context.notes };
      } catch (error) {
        entry = { row: row.row, mode, pass: false, error: String((error as Error).stack ?? error).slice(0, 600), driver: context.notes };
      }
      entry.ms = Date.now() - started;
      entry.flags = extraFlags;
      entry.headless = headless;
      results.push(entry);
      console.log(`${entry.pass ? "PASS" : "FAIL"} row ${String(row.row).padStart(2)} ${mode.padEnd(14)} ${entry.ms}ms${entry.error ? "  " + entry.error.split("\n")[0] : ""}`);
      await tab?.close();
      await launch.cdp.send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
    }
  }
} finally {
  await quitBrowser(launch);
  server.stop();
}

const report = { browser: version.product, userAgent: version.userAgent, headless, flags: extraFlags, at: new Date().toISOString(), results };
if (values.out) writeFileSync(values.out, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ summary: results.map(entry => `${entry.row}:${entry.mode}:${entry.pass ? "PASS" : "FAIL"}`) }));
