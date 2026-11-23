import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PROGRAM } from "./daemon-helpers.ts";

setDefaultTimeout(60_000);

const CHROME = process.env["ARDIA_M3_CHROME"];
const PORT = Number(process.env["ARDIA_M3_PORT_BASE"] ?? "9400") + 17;
const PEOPLE = `<!doctype html><meta charset="utf-8"><title>People directory</title><button id="ana">Ana Ruiz</button>`;
const CALENDAR = `<!doctype html><meta charset="utf-8"><title>Team calendar</title><button id="mon">Monday</button>`;
const url = (page: string) => `data:text/html,${encodeURIComponent(page)}`;

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
  const done = spawnSync(PROGRAM, ["browse", "--port", String(PORT), "--session", "opens", ...args], { env, cwd: root, encoding: "utf8", timeout: 45_000 });
  return { status: done.status, out: done.stdout, err: done.stderr };
}

describe.skipIf(!CHROME)("open and tabs against headless Chrome", () => {
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
    expect(browse("open", url(PEOPLE)).status).toBe(0);
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

  test("a ref from a page a second open replaced names both pages and says how to keep both", () => {
    const snap = browse("snapshot", "-i");
    const ref = /button "Ana Ruiz" \[ref=(e\d+)\]/u.exec(snap.out)?.[1];
    expect(ref).toBeDefined();
    expect(browse("open", url(CALENDAR)).status).toBe(0);
    const stale = browse("click", `@${ref}`);
    expect(stale.status).toBe(1);
    expect(stale.err).toContain('it was on "People directory"; `open` replaced it in this tab with "Team calendar"');
    expect(stale.err).toContain("To keep both pages, open the second with `ardia browse tab new <url>`");
  });

  test("open --here without a picked tab is a usage error that says what to run", () => {
    const here = browse("open", "--here", url(PEOPLE));
    expect(here.status).toBe(1);
    expect(here.err).toContain("run `ardia browse tab active` first");
  });

  test("after tab active, open leaves the picked tab alone and says so first; --here navigates it", () => {
    expect(browse("tab", "active").status).toBe(0);
    const picked = browse("tab", "list").out;
    const own = browse("open", url(CALENDAR));
    expect(own.status).toBe(0);
    expect(own.out.split("\n")[0]).toMatch(/^→ Opened in a new background tab \[t\d+\]; the tab you picked with `tab active` \[t\d+\] is unchanged/u);
    const here = browse("open", "--here", url(PEOPLE));
    expect(here.status).toBe(0);
    expect(here.out).toContain("People directory");
    expect(picked.length).toBeGreaterThan(0);
    const literal = browse("open", url(CALENDAR), "--", "--here");
    expect(literal.out.split("\n")[0]).toMatch(/^→ Opened in a new background tab/u);
    const hereRead = browse("open", "--here", "--read", url(PEOPLE));
    expect(hereRead.status).toBe(0);
    expect(hereRead.out).toContain("Ana Ruiz");
    expect(hereRead.out).not.toContain("Monday");
    expect(browse("open", "--here=true", url(PEOPLE)).out).toContain("People directory");
    expect(browse("open", "--here", "--enable", "react-devtools", url(PEOPLE)).err).toContain("doesn't add init scripts");
    const marker = path.join(root, "marker.js");
    fs.writeFileSync(marker, "window.__marked = true;");
    const scripted = browse("--init-script", marker, "open", "--here", url(PEOPLE));
    expect(scripted.status).toBe(1);
    expect(scripted.err).toContain("doesn't add init scripts");
    const bare = browse("open", "--here");
    expect(bare.status).toBe(1);
    expect(bare.err).toContain("open --here takes the URL");
    const mine = /\[(t\d+)\]/u.exec(browse("open", url(CALENDAR)).out)?.[1] as string;
    expect(browse("tab", mine).status).toBe(0);
    const away = browse("open", "--here", url(PEOPLE));
    expect(away.status).toBe(1);
    expect(away.err).toContain("run `ardia browse tab active` first");
    expect(browse("tab", "active").status).toBe(0);
    const before = browse("tab", "list").out;
    const notHere = browse("open", "--here=false", url(CALENDAR));
    expect(notHere.status).toBe(1);
    expect(notHere.err).toContain("--here takes no value");
    expect(browse("tab", "list").out).toBe(before);
  });
});

