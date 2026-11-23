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
const PAGE = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "fixtures", "browse", "typeahead.html"), "utf8");

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
  const done = spawnSync(PROGRAM, ["browse", "--port", String(PORT), "--session", "typeahead", ...args], { env, cwd: root, encoding: "utf8", timeout: 45_000 });
  return { status: done.status, out: done.stdout, err: done.stderr };
}

describe.skipIf(!CHROME)("select on a typeahead against headless Chrome", () => {
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ardia-guessed-"));
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

  function guests(): string {
    return browse("eval", "[...document.querySelectorAll('#guests li')].map((li) => li.textContent).join('|')").out.trim();
  }

  test("select retypes when the field already holds the text", () => {
    expect(browse("fill", "#guest-input", "Alex Morgan").status).toBe(0);
    const picked = browse("select", "#guest-input", "Alex Morgan");
    expect(picked.status).toBe(0);
    expect(picked.out).toContain('✓ Picked "');
    expect(guests()).toContain("Alex Morgan");
  });

  test("a suggestion that turns into another person as the pointer reaches it isn't clicked", () => {
    const swap =
      "const swap = (event) => { const row = event.target.closest && event.target.closest('[role=option]'); " +
      "if (!row || !row.textContent.includes('Marcus Chen') || row.textContent.includes('Cheng')) return; " +
      "row.querySelector('.o-name').textContent = 'Marcus Cheng'; document.removeEventListener('mouseover', swap, true); }; " +
      "document.addEventListener('mouseover', swap, true); 'armed'";
    expect(browse("mouse", "move", "5", "5").status).toBe(0);
    expect(browse("eval", swap).status).toBe(0);
    const refused = browse("select", "#guest-input", "Marcus Chen");
    expect(refused.status).toBe(1);
    expect(refused.err).toContain('became "MC Marcus Cheng');
    expect(refused.err).toContain("wasn't clicked");
    expect(guests()).not.toContain("Marcus");
  });

  test("a suggestion that moves out from under the pointer as it arrives isn't clicked, and no other row is", () => {
    const move =
      "const move = (event) => { const row = event.target.closest && event.target.closest('[role=option]'); " +
      "if (!row || row.querySelector('.o-name').textContent !== 'Marcus Chen') return; " +
      "document.removeEventListener('mouseover', move, true); row.parentElement.append(row); }; " +
      "document.addEventListener('mouseover', move, true); 'armed'";
    expect(browse("mouse", "move", "5", "5").status).toBe(0);
    expect(browse("eval", move).status).toBe(0);
    const refused = browse("select", "#guest-input", "Marcus Chen");
    expect(refused.status).toBe(1);
    expect(refused.err).toContain("moved out from under the pointer");
    expect(guests()).not.toContain("Marcus");
  });

  test("select picks the one suggestion that has the text as whole words, and says which", () => {
    const picked = browse("select", "#guest-input", "Marcus Chen");
    expect(picked.status).toBe(0);
    expect(picked.out).toContain("Marcus Chen");
    expect(guests()).toContain("Marcus Chen");
    expect(guests()).not.toContain("Marcus Cheng");
  });

  test("several whole-word matches are ambiguous and name each one in full", () => {
    const many = browse("select", "#guest-input", "Sam");
    expect(many.status).toBe(1);
    expect(many.err).toContain('"Sam" matches 2 suggestions');
    expect(many.err).toMatch(/"[^"]*Sam Ortiz[^"]*"/u);
    expect(many.err).toMatch(/"[^"]*Sam Patel[^"]*"/u);
  });
});
