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
const LICENSES = Array.from({ length: 40 }, (_, n) => `license-${n}`);
const RESULTS = Array.from({ length: 10 }, (_, n) => `Model ${n + 1}`);

function page(): string {
  const facets = LICENSES.map((name) => `<div><a href="/models?license=${name}&sort=likes">${name}</a></div>`).join("");
  const short = ["Text", "Image", "Audio"].map((name) => `<div><a href="/models?task=${name}">${name}</a></div>`).join("");
  const results = RESULTS.map((name) => `<article><h4>${name}</h4><p>${name} is a model trained on a large corpus of text, updated last week, with many downloads and likes from the community.</p></article>`).join("");
  return `<!doctype html><title>Models</title><main style="display:flex"><section id="facets" style="width:300px">${facets}</section>` +
    `<div><section id="tasks">${short}</section><section id="results"><h1>Models</h1>${results}</section></div></main>`;
}

let root = "";
let chrome: ChildProcess | null = null;
let server: ChildProcess | null = null;
let base = "";

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
  const done = spawnSync(PROGRAM, ["browse", "--port", String(PORT), "--session", "facets", ...args], { env, cwd: root, encoding: "utf8", timeout: 45_000 });
  return { status: done.status, out: done.stdout, err: done.stderr };
}

describe.skipIf(!CHROME)("a long filter list reads as one line against headless Chrome (plugins#118)", () => {
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ardia-facets-"));
    fs.mkdirSync(path.join(root, "home"));
    fs.mkdirSync(path.join(root, "data"), { mode: 0o700 });
    fs.writeFileSync(path.join(root, "page.html"), page());
    const serve = `const html = require("fs").readFileSync(${JSON.stringify(path.join(root, "page.html"))}, "utf8"); ` +
      `const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }) }); console.log(s.port);`;
    server = spawn(process.execPath, ["-e", serve], { stdio: ["ignore", "pipe", "ignore"] });
    const port = await new Promise<string>((resolve) => (server as ChildProcess).stdout?.once("data", (chunk) => resolve(String(chunk).trim())));
    base = `http://127.0.0.1:${port}`;
    chrome = spawn(CHROME as string, ["--headless", "--no-first-run", "--window-size=1440,900", `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(root, "profile")}`, "about:blank"], {
      stdio: "ignore",
      detached: true,
    });
    const deadline = performance.now() + 30_000;
    while (performance.now() < deadline && !(await answers())) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await answers()).toBe(true);
    expect(browse("open", `${base}/models?license=license-7&sort=likes`).status).toBe(0);
  }, 60_000);

  afterAll(() => {
    if (root) browse("close");
    if (chrome?.pid) {
      try {
        process.kill(-chrome.pid, "SIGKILL");
      } catch {}
    }
    server?.kill("SIGKILL");
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  test("the 40 options collapse to one line naming the selected one; a short filter list and the results stay", () => {
    const read = browse("read");
    expect(read.status).toBe(0);
    const lines = read.out.split("\n");
    const summary = lines.findIndex((line) => line.startsWith("[filters hidden, 40 options: license-0 · license-1"));
    expect(summary).toBeGreaterThanOrEqual(0);
    expect(lines[summary]).toContain("selected: license-7");
    expect(lines[summary]).toContain("read --nav shows them, snapshot -i gives their refs");
    expect(read.out).not.toContain("license-23");
    for (const name of ["Text", "Image", "Audio", ...RESULTS]) expect(read.out).toContain(name);
    expect(lines.findIndex((line) => line.includes("Model 1"))).toBeLessThan(20);
  });

  test("read --nav, read -s on the list and snapshot -i still show every option", () => {
    expect(browse("read", "--nav").out).toContain("license-23");
    expect(browse("read", "-s", "#facets").out).toContain("license-23");
    const snapshot = browse("snapshot", "-i").out;
    expect(snapshot).toMatch(/"license-23"[^\n]*\[ref=e[0-9]+\]/u);
  });
});
