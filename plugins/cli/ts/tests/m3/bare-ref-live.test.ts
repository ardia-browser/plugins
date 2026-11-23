import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PROGRAM } from "./daemon-helpers.ts";

setDefaultTimeout(60_000);

const CHROME = process.env["ARDIA_M3_CHROME"];
const PORT = Number(process.env["ARDIA_M3_PORT_BASE"] ?? "9400") + 16;
const PAGE = `<!doctype html><title>Bare refs</title><main>
<button id="go" onclick="document.querySelector('#out').textContent = 'clicked ' + document.querySelector('#name').value">Go</button>
<input id="name" aria-label="Name">
<p id="out">waiting</p>
<div style="height: 3000px"></div>
<a id="far" href="#far">Far link</a>
</main>`;

let root = "";
let chrome: ChildProcess | null = null;

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

function browse(args: string[], input?: string): { status: number | null; out: string; err: string; ms: number } {
  const env = { ...process.env, HOME: path.join(root, "home"), ARDIA_DATA_DIR: path.join(root, "data"), ARDIA_TELEMETRY: "off" };
  const started = performance.now();
  const done = spawnSync(PROGRAM, ["browse", "--port", String(PORT), "--session", "bare-refs", ...args], { env, cwd: root, encoding: "utf8", timeout: 45_000, input });
  return { status: done.status, out: done.stdout, err: done.stderr, ms: performance.now() - started };
}

function refOf(snapshot: string, label: string): string {
  const line = snapshot.split("\n").find((row) => row.includes(`"${label}"`) && row.includes("[ref="));
  const found = line ? /\[ref=(e[0-9]+)\]/u.exec(line) : null;
  if (!found) throw new Error(`no ref for ${label} in:\n${snapshot}`);
  return found[1] as string;
}

describe.skipIf(!CHROME)("a bare eN works as its @eN ref against headless Chrome (plugins#114)", () => {
  let snapshot = "";

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ardia-bare-ref-"));
    fs.mkdirSync(path.join(root, "home"));
    fs.mkdirSync(path.join(root, "data"), { mode: 0o700 });
    chrome = spawn(CHROME as string, ["--headless", "--no-first-run", `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(root, "profile")}`, "about:blank"], {
      stdio: "ignore",
      detached: true,
    });
    const deadline = performance.now() + 30_000;
    while (performance.now() < deadline && !(await answers())) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await answers()).toBe(true);
    expect(browse(["open", `data:text/html,${encodeURIComponent(PAGE)}`]).status).toBe(0);
    const taken = browse(["snapshot", "-i"]);
    expect(taken.status).toBe(0);
    snapshot = taken.out;
  }, 60_000);

  afterAll(() => {
    if (root) browse(["close"]);
    if (chrome?.pid) {
      try {
        process.kill(-chrome.pid, "SIGKILL");
      } catch {}
    }
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  test("fill, click, get, hover, wait, is and scrollintoview take the bare ref", () => {
    const name = refOf(snapshot, "Name");
    const go = refOf(snapshot, "Go");
    const far = refOf(snapshot, "Far link");
    expect(browse(["fill", name, "Ana"]).status).toBe(0);
    const clicked = browse(["click", go]);
    expect(clicked.status).toBe(0);
    expect(clicked.err).not.toContain("Element not found");
    expect(browse(["get", "text", "#out"]).out.trim()).toBe("clicked Ana");
    expect(browse(["get", "text", go]).out.trim()).toBe("Go");
    expect(browse(["hover", go]).status).toBe(0);
    expect(browse(["wait", go]).status).toBe(0);
    expect(browse(["is", "visible", go]).out.trim()).toBe("true");
    expect(browse(["scrollintoview", far]).status).toBe(0);
    expect(browse(["click", `@${go}`]).status).toBe(0);
  });

  test("a script's page.click takes the bare ref too", () => {
    const go = refOf(snapshot, "Go");
    const ran = browse(["script"], `await page.fill("#name", "Bo"); await page.click("${go}"); return await page.text("#out");`);
    expect(ran.status).toBe(0);
    expect(ran.out).toContain("clicked Bo");
  });

  test("a bare eN no snapshot gave fails at once, naming @eN and snapshot -i", () => {
    const missing = browse(["click", "e9999"]);
    expect(missing.status).toBe(1);
    expect(missing.err).toContain("Unknown ref: e9999");
    expect(missing.err).toContain("use an @eN ref from the latest `ardia browse snapshot -i`");
    expect(missing.err).not.toContain("waited");
    expect(missing.ms).toBeLessThan(2500);
  });
});
