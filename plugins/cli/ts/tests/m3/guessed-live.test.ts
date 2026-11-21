import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PROGRAM } from "./daemon-helpers.ts";

setDefaultTimeout(60_000);

const CHROME = process.env["ARDIA_M3_CHROME"];
const PORT = Number(process.env["ARDIA_M3_PORT_BASE"] ?? "9400") + 15;
const PAGE = `<!doctype html><title>guesses</title>
<p id="intro">Hello agents</p>
<a id="lnk" href="https://example.com/a" data-kind="plain">A</a>
<a href="https://example.com/docs/b">B</a>
<input id="name" aria-label="Name">
<button id="go" onclick="document.getElementById('out').textContent='clicked'">Go</button>
<p id="out"></p>
<label><input type="checkbox" class="mid" aria-label="No middle name">one</label>
<label><input type="checkbox" class="mid" aria-label="No middle name">two</label>`;

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

describe.skipIf(!CHROME)("guessed commands and flags against headless Chrome", () => {
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

  test("get attribute works as get attr, and get takes -s/--selector", () => {
    expect(browse("get", "attribute", "#lnk", "data-kind").out.trim()).toBe("plain");
    expect(browse("get", "attr", "-s", "#lnk", "data-kind").out.trim()).toBe("plain");
    expect(browse("get", "text", "--selector", "#intro").out.trim()).toBe("Hello agents");
  });

  test("click and fill take -s/--selector", () => {
    expect(browse("click", "-s", "#go").status).toBe(0);
    expect(browse("get", "text", "#out").out.trim()).toBe("clicked");
    expect(browse("fill", "--selector", "#name", "Ana Ruiz").status).toBe(0);
    expect(browse("get", "value", "#name").out.trim()).toBe("Ana Ruiz");
  });

  test("screenshot takes -s/--selector for the element", () => {
    const shot = path.join(root, "intro.png");
    const done = browse("screenshot", "-s", "#intro", shot);
    expect(done.status).toBe(0);
    expect(fs.statSync(shot).size).toBeGreaterThan(0);
  });

  test("links lists the matching links, every link without a pattern", () => {
    const docs = browse("links", "docs");
    expect(docs.status).toBe(0);
    expect(docs.out).toContain("https://example.com/docs/b");
    expect(docs.out).not.toContain("https://example.com/a\n");
    const all = browse("links");
    expect(all.out).toContain("https://example.com/a");
    expect(all.out).toContain("https://example.com/docs/b");
  });

  test("find role … --nth picks one of several matches, from 0", () => {
    const ambiguous = browse("find", "role", "checkbox", "check", "--name", "No middle name");
    expect(ambiguous.status).toBe(1);
    expect(ambiguous.err).toContain("--nth <n>, from 0");
    expect(browse("find", "role", "checkbox", "check", "--name", "No middle name", "--nth", "1").status).toBe(0);
    expect(browse("eval", "[...document.querySelectorAll('.mid')].map((box) => box.checked).join(',')").out.trim()).toBe('"false,true"');
    const beyond = browse("find", "role", "checkbox", "check", "--name", "No middle name", "--nth", "2");
    expect(beyond.status).toBe(1);
    expect(beyond.err).toContain("--nth 2 asks for match 3, and only 2 checkbox elements match (--nth counts from 0)");
    expect(browse("find", "text", "Go", "--nth", "0").err).toContain("--nth works with find role");
  });
});
