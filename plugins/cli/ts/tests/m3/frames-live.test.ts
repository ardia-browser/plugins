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
const PORT = Number(process.env["ARDIA_M3_PORT_BASE"] ?? "9400") + 12;

const OUTER = (style: string) => `<!doctype html><meta charset="utf-8"><title>Frames</title>
<style>body{margin:0;font:16px sans-serif} .spacer{height:1400px;background:linear-gradient(#eee,#ccc)} iframe{border:0;width:600px;height:300px;margin-left:120px;display:block} ${style}</style>
<div class="spacer">top</div><iframe id="outer" src="/inner.html"></iframe><div class="veil"></div><div class="spacer">bottom</div>`;
const INNER = `<!doctype html><meta charset="utf-8"><title>Inner</title>
<style>body{margin:0;font:16px sans-serif} .pad{height:500px;background:#def} .alert{padding:10px;background:#fee} iframe{border:0;width:400px;height:120px;margin-left:60px;display:block}</style>
<div class="alert alert-help">Help text up here</div><div class="pad">inner pad</div>
<button id="ib" onclick="document.getElementById('res').textContent='inner clicked'">Inner button</button><p id="res"></p>
<iframe id="nested" src="/nested.html"></iframe><div class="pad">inner bottom</div>`;
const NESTED = `<!doctype html><meta charset="utf-8"><title>Nested</title>
<style>body{margin:0;font:16px sans-serif;zoom:1.25} .pad{height:200px;background:#efe}</style>
<div class="pad">nested pad</div><button id="nb" onclick="document.getElementById('nres').textContent='nested clicked'">Nested button</button><p id="nres"></p><div class="pad">x</div>`;

const LAYOUTS: Record<string, string> = {
  plain: "",
  zoomed: "body{zoom:0.8}",
  bordered: "iframe#outer{border:12px solid #333;padding:30px 10px 5px 40px}",
  scaled: "iframe#outer{transform:scale(0.75);transform-origin:0 0}",
  everything: "body{zoom:0.9} iframe#outer{border:6px solid #333;padding:20px;transform:scale(0.8);transform-origin:10px 20px}",
  rotatedUnderVeil:
    "iframe#outer{transform:rotate(3deg)} .veil{position:absolute;left:0;top:1300px;width:900px;height:600px;background:rgba(0,0,0,0.05);pointer-events:none}",
};

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

function browse(...args: string[]): Promise<{ status: number | null; out: string; err: string }> {
  const env = { ...process.env, HOME: path.join(root, "home"), ARDIA_DATA_DIR: path.join(root, "data"), ARDIA_TELEMETRY: "off" };
  return new Promise((resolve) => {
    const child = spawn(PROGRAM, ["browse", "--port", String(PORT), "--session", "frames", ...args], { env, cwd: root, timeout: 45_000 });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
    child.on("close", (status) => resolve({ status, out, err }));
  });
}

describe.skipIf(!CHROME)("clicks inside same-origin frames land where the frame is drawn", () => {
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ardia-frames-"));
    fs.mkdirSync(path.join(root, "home"));
    fs.mkdirSync(path.join(root, "data"), { mode: 0o700 });
    server = http.createServer((request, response) => {
      const name = (request.url ?? "/").split("?")[0] as string;
      const layout = name.startsWith("/outer-") ? LAYOUTS[name.slice("/outer-".length, -".html".length)] : undefined;
      const body = layout !== undefined ? OUTER(layout) : name === "/inner.html" ? INNER : name === "/nested.html" ? NESTED : null;
      response.writeHead(body === null ? 404 : 200, { "content-type": "text/html; charset=utf-8" });
      response.end(body ?? "");
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
  }, 60_000);

  afterAll(async () => {
    if (root) await browse("close");
    if (chrome?.pid) {
      try {
        process.kill(-chrome.pid, "SIGKILL");
      } catch {}
    }
    server?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  for (const layout of Object.keys(LAYOUTS)) {
    test(`${layout}: the frame's button and its nested frame's button take the click`, async () => {
      expect((await browse("open", `${site}/outer-${layout}.html`)).status).toBe(0);
      expect((await browse("frame", "main")).status).toBe(0);
      expect((await browse("frame", "#outer")).status).toBe(0);
      const inner = await browse("click", "#ib");
      expect(inner.err + inner.out).not.toContain("covered");
      expect(inner.status).toBe(0);
      expect((await browse("get", "text", "#res")).out.trim()).toBe("inner clicked");
      expect((await browse("frame", "#nested")).status).toBe(0);
      const nested = await browse("click", "#nb");
      expect(nested.err + nested.out).not.toContain("covered");
      expect(nested.status).toBe(0);
      expect((await browse("get", "text", "#nres")).out.trim()).toBe("nested clicked");
    });
  }
});
