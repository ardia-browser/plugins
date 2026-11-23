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
const PAGE = `<!doctype html><title>Themes</title><main>
<h1>Prompt themes</h1>
<p id="price">Themes are free.</p>
<button onclick="this.textContent = 'chosen'">agnoster</button>
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

function browse(...args: string[]): { status: number | null; out: string; err: string } {
  const env = { ...process.env, HOME: path.join(root, "home"), ARDIA_DATA_DIR: path.join(root, "data"), ARDIA_TELEMETRY: "off" };
  const done = spawnSync(PROGRAM, ["browse", "--port", String(PORT), "--session", "guesses", ...args], { env, cwd: root, encoding: "utf8", timeout: 45_000 });
  return { status: done.status, out: done.stdout, err: done.stderr };
}

describe.skipIf(!CHROME)("text and one-word find run their canonical forms against headless Chrome (plugins#126)", () => {
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ardia-guesses-"));
    fs.mkdirSync(path.join(root, "home"));
    fs.mkdirSync(path.join(root, "data"), { mode: 0o700 });
    chrome = spawn(CHROME as string, ["--headless", "--no-first-run", `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(root, "profile")}`, "about:blank"], {
      stdio: "ignore",
      detached: true,
    });
    const deadline = performance.now() + 30_000;
    while (performance.now() < deadline && !(await answers())) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await answers()).toBe(true);
    expect(browse("open", `data:text/html,${encodeURIComponent(PAGE)}`).status).toBe(0);
  }, 60_000);

  afterAll(() => {
    if (root) browse("close");
    if (chrome?.pid) {
      try {
        process.kill(-chrome.pid, "SIGKILL");
      } catch {}
    }
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  test("text prints the page like read, and names read", () => {
    const text = browse("text");
    expect(text.status).toBe(0);
    expect(text.out).toContain("Themes are free.");
    expect(text.err).toContain("text ran as `read`");
  });

  test("text <selector> prints that element like get text", () => {
    const text = browse("text", "#price");
    expect(text.status).toBe(0);
    expect(text.out.trim()).toBe("Themes are free.");
    expect(text.err).toContain("text #price ran as `get text #price`");
  });

  test("a one-word find reads the match without clicking it", () => {
    const found = browse("find", "agnoster");
    expect(found.status).toBe(0);
    expect(found.out).toContain("agnoster");
    expect(found.err).toContain("find agnoster ran as `find text agnoster text`");
    expect(browse("get", "text", "button").out.trim()).toBe("agnoster");
  });
});
