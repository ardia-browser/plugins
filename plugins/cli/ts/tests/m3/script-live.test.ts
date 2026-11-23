import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { PROGRAM } from "./daemon-helpers.ts";

setDefaultTimeout(60_000);

const CHROME = process.env["ARDIA_M3_CHROME"];
const PORT = Number(process.env["ARDIA_M3_PORT_BASE"] ?? "9400") + 18;
const ROWS = Array.from({ length: 30 }, (_, i) => `<article data-task="${i % 3 === 0 ? "text" : "image"}"><h4>model-${i}</h4><span class="dl">${(i + 1) * 100}</span></article>`).join("");
const PAGE = `<!doctype html><title>Models</title><button id="filter" onclick="fetch('/ok.json').then(() => { for (const a of document.querySelectorAll('article')) a.hidden = a.dataset.task !== 'text'; document.body.insertAdjacentHTML('beforeend', '<p id=done>filtered</p>'); })">Text only</button>
<main>${ROWS}</main><iframe src="/frame.html"></iframe>`;
const FRAME = "<!doctype html><ul><li>params: 7B</li><li>license: apache-2.0</li></ul>";

let root = "";
let chrome: ChildProcess | null = null;
let server: http.Server | null = null;
let origin = "";

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

type Ran = { status: number | null; out: string; err: string; ms: number };

async function browse(args: string[], input?: string, session = "scripts"): Promise<Ran> {
  const env = { ...process.env, HOME: path.join(root, "home"), ARDIA_DATA_DIR: path.join(root, "data"), ARDIA_TELEMETRY: "off" };
  const started = performance.now();
  const child = Bun.spawn([PROGRAM, "browse", "--port", String(PORT), "--session", session, ...args], {
    env,
    cwd: root,
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 45_000,
  });
  const [out, err, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { status, out, err, ms: performance.now() - started };
}

function script(source: string, ...flags: string[]): Promise<Ran> {
  return browse(["script", ...flags], source);
}

describe.skipIf(!CHROME)("browse script against headless Chrome", () => {
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ardia-script-live-"));
    fs.mkdirSync(path.join(root, "home"));
    fs.mkdirSync(path.join(root, "data"), { mode: 0o700 });
    server = http.createServer((request, response) => {
      const body = request.url === "/frame.html" ? FRAME : request.url === "/ok.json" ? "{}" : PAGE;
      response.writeHead(200, { "content-type": request.url === "/ok.json" ? "application/json" : "text/html" });
      response.end(body);
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    chrome = spawn(CHROME as string, ["--headless", "--no-first-run", `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(root, "profile")}`, "about:blank"], {
      stdio: "ignore",
      detached: true,
    });
    const deadline = performance.now() + 30_000;
    while (performance.now() < deadline && !(await answers())) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await answers()).toBe(true);
    const opened = await browse(["open", `${origin}/`]);
    expect(opened.err).toBe("");
    expect(opened.status).toBe(0);
  }, 60_000);

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

  test("reads under Promise.all all come back, in order", async () => {
    const done = await script(`
      const n = await page.count('article');
      const rows = await Promise.all(Array.from({ length: n }, (_, i) => page.text(\`article:nth-child(\${i + 1}) h4\`)));
      return rows;
    `, "--json");
    expect(done.status).toBe(0);
    expect(JSON.parse(done.out).data.value).toEqual(Array.from({ length: 30 }, (_, i) => `model-${i}`));
  });

  test("$$eval, $eval and evaluate take arguments", async () => {
    const done = await script(`
      return [
        await page.$$eval('article h4', (hs, from, to) => hs.slice(from, to).map((h) => h.textContent), 2, 4),
        await page.$eval('article .dl', (el, times) => Number(el.textContent) * times, 3),
        await page.evaluate((a, b, c) => [a + b, c.k], 1, 2, { k: 'v' }),
      ];
    `, "--json");
    expect(done.status).toBe(0);
    expect(JSON.parse(done.out).data.value).toEqual([["model-2", "model-3"], 300, [3, "v"]]);
  });

  test("frames list the iframe and read inside it", async () => {
    const done = await script(`
      const frames = await page.frames();
      const child = frames.find((f) => !f.main);
      return [frames.length, child.url.endsWith('/frame.html'), await child.$$eval('li', (items) => items.map((li) => li.textContent))];
    `, "--json");
    expect(done.status).toBe(0);
    expect(JSON.parse(done.out).data.value).toEqual([2, true, ["params: 7B", "license: apache-2.0"]]);
  });

  test("a click waits for the page to settle, and reports changes only when asked", async () => {
    const light = await script(`
      const answer = await page.click('#filter');
      return [answer, await page.$$eval('article:not([hidden]) h4', (hs) => hs.length)];
    `, "--json");
    expect(light.status).toBe(0);
    const [answer, shown] = JSON.parse(light.out).data.value as [string, number];
    expect(shown).toBe(10);
    expect(answer).not.toContain("changes:");
    expect((await browse(["open", `${origin}/`])).status).toBe(0);
    const receipt = await script("return await page.click('#filter', { receipt: true });", "--json");
    expect(receipt.status).toBe(0);
    expect(JSON.parse(receipt.out).data.value).toContain("changes:");
  });

  test("an action the script didn't await still finishes after it returns", async () => {
    expect((await browse(["open", `${origin}/`])).status).toBe(0);
    const returned = await script("page.click('#filter');\nawait sleep(30);\nreturn 'returned';");
    expect(returned.status).toBe(0);
    expect(returned.out).toContain("returned");
    expect(returned.out).not.toContain("stopped");
    const after = await script("return await page.$$eval('article:not([hidden])', (rows) => rows.length);", "--json");
    expect(JSON.parse(after.out).data.value).toBe(10);
    expect((await browse(["open", `${origin}/`])).status).toBe(0);
    const unstarted = await script("page.click('#filter');\npage.click('#filter');\nreturn 'returned';");
    expect(unstarted.status).toBe(0);
    const rows = JSON.parse((await script("return await page.$$eval('article:not([hidden])', (rows) => rows.length);", "--json")).out).data.value;
    const reported = /\[(\d) commands? the script didn't await never ran\]/u.exec(unstarted.out);
    expect(Number(reported?.[1] ?? 0) + (rows === 10 ? 1 : 0)).toBeGreaterThanOrEqual(1);
  });

  test("an action still running after the script returns stays inside its timeout", async () => {
    const slow = await script("browse('wait', '4000');\nawait sleep(30);\nreturn 'returned';", "--timeout", "1s");
    expect(slow.status).toBe(1);
    expect(slow.err).toContain("The script timed out after 1s");
    expect(slow.ms).toBeLessThan(3_500);
  });

  test("a failed page call names its line and call", async () => {
    const done = await script("const a = 1;\nawait page.$eval('#missing', (el) => el.id);");
    expect(done.status).toBe(1);
    expect(done.err).toContain("line 2: Evaluation error: Error: page.$eval: no element matches #missing");
    expect(done.err).toContain("(in call 1, `eval`)");
  });

  test("a page method the API lacks says what to use", async () => {
    const done = await script("await page.locator('h4').first();");
    expect(done.status).toBe(1);
    expect(done.err).toContain("page.locator isn't part of ardia's script API");
  });

  test("a script that fails keeps its own error, even with a call it never awaited", async () => {
    const failed = await script("sleep(60000);\nthrow new Error('first failure');", "--timeout", "10s");
    expect(failed.status).toBe(1);
    expect(failed.err).toContain("line 2: first failure");
    expect(failed.err).not.toContain("timed out");
    expect(failed.ms).toBeLessThan(8_000);
  });

  test("a page call without a tab fails in a way the script can catch", async () => {
    const caught = await browse(["script", "--json"], "try { await page.frames(); return 'no error'; } catch (e) { return e.code; }", "no-tab-yet");
    expect(caught.status).toBe(0);
    expect(JSON.parse(caught.out).data.value).toBe("no_session_tab");
  });

  test("a script stopped by a fatal error keeps the state it had saved", async () => {
    const flooded = await script("state.kept = 'before the flood';\nawait page.title();\nfor (let i = 0; i < 1500; i++) page.title();\nawait sleep(5000);");
    expect(flooded.status).toBe(1);
    expect(flooded.err).toContain("calls waiting at once");
    const next = await script("return state.kept;", "--json");
    expect(JSON.parse(next.out).data.value).toBe("before the flood");
  });

  test("a busy loop is stopped at its timeout, keeps its state, and the session goes on", async () => {
    const stopped = await script("state.rows = [1, 2];\nawait page.title();\nfor (;;) {}", "--timeout", "2s");
    expect(stopped.status).toBe(1);
    expect(stopped.err).toContain("The script timed out after 2s");
    expect(stopped.err).toContain("state.rows (2 items)");
    expect(stopped.ms).toBeLessThan(15_000);
    const next = await script("return [state.rows, await page.title()];", "--json");
    expect(next.status).toBe(0);
    expect(JSON.parse(next.out).data.value).toEqual([[1, 2], "Models"]);
  });
});
