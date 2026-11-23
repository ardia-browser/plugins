import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { PROGRAM } from "./daemon-helpers.ts";

setDefaultTimeout(90_000);

const CHROME = process.env["ARDIA_M3_CHROME"];
const PORT = Number(process.env["ARDIA_M3_PORT_BASE"] ?? "9400") + 19;

const ORIGINAL = [
  "let count = 0;",
  "function bump() {",
  "  count += 1;",
  "  document.querySelector('#out').textContent = 'count ' + count;",
  "}",
  "document.querySelector('#go').addEventListener('click', bump);",
  "document.querySelector('#boom').addEventListener('click', () => setTimeout(() => { throw new Error('outer failure', { cause: new Error('inner cause') }); }, 0));",
  "document.querySelector('#halt').addEventListener('click', () => { debugger; document.querySelector('#out').textContent = 'after debugger'; });",
  "document.cookie = 'secretcookie=SHOULD_NOT_LEAK; SameSite=None';",
];
const MAP = JSON.stringify({ version: 3, sources: ["src/app.ts"], names: [], mappings: `;AAAA${";AACA".repeat(ORIGINAL.length - 1)}` });
const SCRIPT = ['"use strict";', ...ORIGINAL, `//# sourceMappingURL=data:application/json;base64,${Buffer.from(MAP).toString("base64")}`].join("\n");
const STYLE = "button { color: green; }\n#go { color: blue; }\n.primary { color: red !important; padding: 4px; }\n";
const PAGE = `<!doctype html><title>DevTools</title><link rel="stylesheet" href="/style.css"><main>
<button id="go" class="primary" style="margin: 2px">Go</button>
<button id="boom">Boom</button>
<button id="halt">Halt</button>
<p id="out">waiting</p>
<img src="/blocked.png" alt="blocked">
</main><script src="/app.js"></script>`;

let root = "";
let chrome: ChildProcess | null = null;
let server: http.Server | null = null;
let site = "";

function answers(): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get({ host: "127.0.0.1", port: PORT, path: "/json/version", timeout: 500, agent: false }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on("error", () => resolve(false));
    request.on("timeout", () => request.destroy());
  });
}

function browse(args: string[], extra: Record<string, string> = {}): Promise<{ status: number | null; out: string; err: string }> {
  const env = { ...process.env, HOME: path.join(root, "home"), ARDIA_DATA_DIR: path.join(root, "data"), ARDIA_TELEMETRY: "off", AGENT_BROWSER_CONTENT_BOUNDARIES: "0", ...extra };
  return new Promise((resolve) => {
    const child = spawn(PROGRAM, ["browse", "--port", String(PORT), "--session", "devtools", ...args], { env, cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
    const timer = setTimeout(() => child.kill("SIGKILL"), 80_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, out, err });
    });
  });
}

function refOf(snapshot: string, label: string): string {
  const line = snapshot.split("\n").find((row) => row.includes(`"${label}"`) && row.includes("[ref="));
  const found = line ? /\[ref=(e[0-9]+)\]/u.exec(line) : null;
  if (!found) throw new Error(`no ref for ${label} in:\n${snapshot}`);
  return found[1] as string;
}

describe.skipIf(!CHROME)("the DevTools commands against headless Chrome (plugins#137)", () => {
  let snapshot = "";

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ardia-devtools-"));
    fs.mkdirSync(path.join(root, "home"));
    fs.mkdirSync(path.join(root, "data"), { mode: 0o700 });
    server = http.createServer((request, response) => {
      const files: Record<string, [string, string]> = {
        "/page.html": ["text/html", PAGE],
        "/app.js": ["text/javascript", SCRIPT],
        "/style.css": ["text/css", STYLE],
      };
      const found = files[request.url ?? ""];
      if (found === undefined) {
        response.writeHead(404).end();
        return;
      }
      const headers: Record<string, string> = { "content-type": found[0], "cache-control": "no-store" };
      if (request.url === "/page.html") headers["content-security-policy"] = "img-src 'none'";
      response.writeHead(200, headers).end(found[1]);
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    chrome = spawn(CHROME as string, ["--headless", "--no-first-run", `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(root, "profile")}`, "about:blank"], {
      stdio: "ignore",
      detached: true,
    });
    const deadline = performance.now() + 30_000;
    while (performance.now() < deadline && !(await answers())) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await answers()).toBe(true);
    const opened = await browse(["open", `${site}/page.html`]);
    expect(opened.status, opened.err + opened.out).toBe(0);
    const taken = await browse(["snapshot", "-i"]);
    expect(taken.status).toBe(0);
    snapshot = taken.out;
  }, 90_000);

  afterAll(async () => {
    if (root) await browse(["close"]);
    if (chrome?.pid) {
      try {
        process.kill(-chrome.pid, "SIGKILL");
      } catch {}
    }
    server?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  test("styles names the winning rule, its stylesheet line and, with --all, what it beat", async () => {
    const go = refOf(snapshot, "Go");
    const styles = await browse(["styles", `@${go}`, "--property", "color,margin-top,padding-top", "--all"]);
    expect(styles.status).toBe(0);
    expect(styles.out).toContain("color: red !important  ← .primary (");
    expect(styles.out).toContain("style.css:3)");
    expect(styles.out).toContain("overridden: blue  ← #go (");
    expect(styles.out).toContain("margin-top: 2px  ← style attribute");
  });

  test("issues reports the page's CSP violation with what it blocked", async () => {
    let shown = await browse(["issues"]);
    expect(shown.status).toBe(0);
    if (!shown.out.includes("[csp]")) {
      expect((await browse(["reload"])).status).toBe(0);
      shown = await browse(["issues", "--kind", "csp"]);
    }
    expect(shown.out).toContain("[csp]");
    expect(shown.out).toContain("blocked.png");
    const all = await browse(["issues"]);
    const json = await browse(["--json", "issues"]);
    expect(all.out + json.out).not.toContain("SHOULD_NOT_LEAK");
  });

  test("a logpoint on the original source logs through the source map and never pauses", async () => {
    const added = await browse(["logpoint", "add", "src/app.ts:4", "'clicks:'", "+", "count"]);
    expect(added.status, added.err).toBe(0);
    expect(added.out).toContain("source-mapped to");
    expect(added.out).toContain("app.js:5");
    const go = refOf((await browse(["snapshot", "-i"])).out, "Go");
    expect((await browse(["click", `@${go}`])).status).toBe(0);
    expect((await browse(["get", "text", "#out"])).out.trim()).toBe("count 1");
    const logged = await browse(["console"]);
    expect(logged.out).toContain("[logpoint lp1 src/app.ts:4] clicks:1");
    const halt = refOf((await browse(["snapshot", "-i"])).out, "Halt");
    expect((await browse(["click", `@${halt}`])).status).toBe(0);
    expect((await browse(["get", "text", "#out"])).out.trim()).toBe("after debugger");
    expect((await browse(["logpoint", "list"])).out).toContain("lp1  src/app.ts:4");
    expect((await browse(["logpoint", "clear"])).out).toContain("Removed lp1");
  });

  test("errors --uncaught maps the stack to the original file and follows Error.cause", async () => {
    expect((await browse(["errors", "--uncaught"])).status).toBe(0);
    const boom = refOf((await browse(["snapshot", "-i"])).out, "Boom");
    expect((await browse(["click", `@${boom}`])).status).toBe(0);
    let shown = await browse(["errors", "--uncaught"]);
    for (let tries = 0; tries < 10 && !shown.out.includes("outer failure"); tries += 1) shown = await browse(["errors", "--uncaught"]);
    expect(shown.out).toContain("outer failure");
    expect(shown.out).toContain("src/app.ts:7:");
    expect(shown.out).toContain("caused by: Error: inner cause");
    expect((await browse(["errors"])).out).not.toContain("caused by");
  });

  test("perf insight from a reload rates the load, and perf trace saves a trace file", async () => {
    const insight = await browse(["perf", "insight", "--reload"]);
    expect(insight.status, insight.err).toBe(0);
    expect(insight.out).toMatch(/TBT \d/u);
    expect(insight.out).toContain("long tasks:");
    const file = path.join(root, "perf.json");
    const traced = await browse(["perf", "trace", "--duration", "1s", "--out", file]);
    expect(traced.status, traced.err).toBe(0);
    expect(traced.out).toContain("✓ Trace saved to");
    expect(JSON.parse(fs.readFileSync(file, "utf8")).traceEvents.length).toBeGreaterThan(0);
  });

  test("a mistyped flag and command name the closest one, with the code and a remedy", async () => {
    const flagged = await browse(["snapshot", "--interactiv"]);
    expect(flagged.status).toBe(1);
    expect(flagged.err).toContain("Did you mean");
    expect(flagged.err).toContain("(usage)");
    expect(flagged.err).toContain("remedy: ardia browse snapshot --help");
    const typo = await browse(["clik", "#go"]);
    expect(typo.status).toBe(1);
    expect(typo.err).toContain("Did you mean `ardia browse click`?");
    expect(typo.err).toContain("(unknown_command)");
    const json = await browse(["--json", "clik", "#go"]);
    expect(JSON.parse(json.out).remedy).toBe("ardia browse --help");
    expect((await browse(["visit", `${site}/page.html`])).status).toBe(0);
    const saved = path.join(root, "title.json");
    expect((await browse(["js", "document.title", "--out", saved])).status).toBe(0);
    expect(fs.readFileSync(saved, "utf8")).toContain("DevTools");
    const misplaced = await browse(["perf", "trace", "--crux"]);
    expect(misplaced.err).toContain("goes with perf insight");
  });

  test("perf --reload refuses the user's own tab, as reload does", async () => {
    expect((await browse(["tab", "active"])).status).toBe(0);
    const refused = await browse(["perf", "insight", "--reload"]);
    expect(refused.status).toBe(1);
    expect(refused.err).toContain("(borrowed_tab)");
    expect((await browse(["open", `${site}/page.html`])).status).toBe(0);
  });

  test("--crux over --port skips field data before any lookup: nothing can vouch the tab isn't private", async () => {
    const insight = await browse(["perf", "insight", "--reload", "--crux"], { ARDIA_CRUX_API_KEY: "" });
    expect(insight.status, insight.err).toBe(0);
    expect(insight.out).toContain("field data: skipped: this session talks to a DevTools endpoint named with --port or --ws");
    const json = await browse(["--json", "perf", "insight", "--reload", "--crux"], { ARDIA_CRUX_API_KEY: "" });
    expect(json.status, json.err).toBe(0);
    expect(String(JSON.parse(json.out).data.fieldData.skipped)).toContain("--port or --ws");
  });
});
